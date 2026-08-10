import { randomUUID } from "node:crypto";

import { InlineKeyboard, type Bot, type Context } from "grammy";

import { outboxPath } from "./attachments.js";
import type { CodexPromptInput, CodexSessionService } from "./codex-session.js";
import type { CodyConfig } from "./config.js";
import { contextKeyFromCtx, parseContextKey, type TelegramContextKey } from "./context-key.js";
import type { ManagedBotService } from "./managed-bots.js";
import { ProjectWorkLock } from "./project-work-lock.js";
import { newRuntimeJobId, RuntimeJobStore, type RuntimeJob } from "./runtime-jobs.js";
import { cleanupOrphanedAttachments } from "./runtime-cleanup.js";
import { SessionRegistry } from "./session-registry.js";
import {
  normalizeQueueDisplayText,
  promptTextForQueue,
  renderQueueMessage,
} from "./task-queue-ui.js";
import { cleanupRuntimeJob, retainRuntimeJobAttachments } from "./task-recovery.js";
import { TaskRunner } from "./task-runner.js";
import { TaskScheduler, type TaskReceipt } from "./task-scheduler.js";
import { TelegramInteractionController } from "./telegram-interactions.js";
import {
  formatError,
  sendTextMessage,
  type TelegramChatId,
} from "./telegram-api.js";

export type ContextSession = {
  contextKey: TelegramContextKey;
  session: CodexSessionService;
};

export type EnqueuePromptOptions = {
  turnId?: string;
  outDir?: string;
  resumeThreadId?: string;
  queueDisplayText?: string;
  cleanupPaths?: string[];
  executionMode?: "default" | "plan" | "review";
};

export { renderQueueMessage } from "./task-queue-ui.js";
export { buildRestartRecoveryInput } from "./task-recovery.js";

type PendingQueuedPrompt = {
  job: RuntimeJob;
  session: CodexSessionService;
};

type BusyState = { processing: boolean; transcribing: boolean };

export class TaskController {
  private readonly contextBusy = new Map<TelegramContextKey, BusyState>();
  private readonly pendingQueuedPrompts = new Map<string, PendingQueuedPrompt>();
  private readonly activeJobs = new Map<TelegramContextKey, RuntimeJob>();
  private readonly scheduler: TaskScheduler;
  private readonly runtimeJobs: RuntimeJobStore;
  private readonly runner: TaskRunner;
  readonly interactions: TelegramInteractionController;
  private shuttingDown = false;
  private orphanCleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly bot: Bot<Context>,
    private readonly config: CodyConfig,
    private readonly registry: SessionRegistry,
    managedBots?: ManagedBotService,
    runtimeJobs?: RuntimeJobStore,
    private readonly projectWorkLock = new ProjectWorkLock(),
  ) {
    this.interactions = new TelegramInteractionController(bot);
    this.runtimeJobs = runtimeJobs ?? new RuntimeJobStore(`${config.workspace}/.cody-tgbot/runtime`);
    this.runner = new TaskRunner({
      bot,
      config,
      registry,
      runtimeJobs: this.runtimeJobs,
      managedBots,
      setProcessing: (contextKey, processing) => {
        this.getBusyState(contextKey).processing = processing;
      },
      isShuttingDown: () => this.shuttingDown,
      interactions: this.interactions,
    });
    this.scheduler = new TaskScheduler({
      maxParallel: config.maxParallelCodexTasks,
      onTaskError: (error, task) => {
        if (this.shuttingDown) return;
        console.error(`Queued Codex task ${task.id} failed for ${task.contextKey}:`, error);
      },
    });
  }

  prepareShutdown(): void {
    this.shuttingDown = true;
    if (this.orphanCleanupTimer) clearInterval(this.orphanCleanupTimer);
    this.orphanCleanupTimer = undefined;
  }

  async recover(): Promise<void> {
    const jobs = (await this.runtimeJobs.list()).sort((left, right) => {
      if (left.status !== right.status) return left.status === "running" ? -1 : 1;
      return Date.parse(left.createdAt) - Date.parse(right.createdAt);
    });
    await cleanupOrphanedAttachments(this.config.workspace, jobs);
    this.orphanCleanupTimer = setInterval(() => {
      void this.runtimeJobs.list()
        .then((currentJobs) => cleanupOrphanedAttachments(this.config.workspace, currentJobs))
        .catch((error) => console.warn("Runtime attachment cleanup failed:", error));
    }, 6 * 60 * 60 * 1_000);
    if (jobs.length === 0) return;

    let recovered = 0;
    for (const job of jobs) {
      try {
        const session = await this.registry.getOrCreate(job.contextKey, { deferThreadStart: true });
        const recovering = job.status === "running";
        const receipt = this.scheduleJob(job, session, recovering);
        if (!receipt.startedImmediately) {
          this.pendingQueuedPrompts.set(job.id, { job, session });
          if (!recovering && !job.queueMessageId) {
            const messageId = await this.sendQueuedReply(
              undefined,
              job.chatId,
              parseContextKey(job.contextKey).messageThreadId,
              job.id,
              job.displayText,
            );
            if (messageId) {
              job.queueMessageId = messageId;
              await this.runtimeJobs.patch(job.id, { queueMessageId: messageId });
            }
          }
        }
        recovered += 1;
      } catch (error) {
        console.error(`Failed to recover runtime job ${job.id}:`, formatError(error));
      }
    }
    console.log(`Recovered runtime jobs: ${recovered}/${jobs.length}`);
  }

  getBusyState(contextKey: TelegramContextKey): BusyState {
    let state = this.contextBusy.get(contextKey);
    if (!state) {
      state = { processing: false, transcribing: false };
      this.contextBusy.set(contextKey, state);
    }
    return state;
  }

  isBusy(contextKey: TelegramContextKey): boolean {
    const state = this.contextBusy.get(contextKey);
    const session = this.registry.get(contextKey);
    return Boolean(
      state?.processing ||
        state?.transcribing ||
        session?.isProcessing() ||
        this.scheduler.hasPending(contextKey),
    );
  }

  hasAnyWork(): boolean {
    return this.scheduler.getActiveCount() > 0
      || this.pendingQueuedPrompts.size > 0
      || [...this.contextBusy.values()].some((state) => state.processing || state.transcribing);
  }

  async getContextSession(
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<ContextSession | null> {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) return null;
    const session = await this.registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  }

  async getSession(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean },
  ): Promise<CodexSessionService> {
    return this.registry.getOrCreate(contextKey, options);
  }

  async enqueue(
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
    options?: EnqueuePromptOptions,
  ): Promise<TaskReceipt> {
    return this.enqueueFromOrigin(
      {
        updateId: ctx.update.update_id,
        privateChat: ctx.chat?.type === "private",
      },
      contextKey,
      chatId,
      session,
      userInput,
      options,
      ctx,
    );
  }

  async enqueueFromOrigin(
    origin: { updateId: number; privateChat: boolean },
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
    options?: EnqueuePromptOptions,
    replyContext?: Context,
  ): Promise<TaskReceipt> {
    const workspace = session.getCurrentWorkspace();
    const turnId = options?.turnId ?? randomUUID().slice(0, 12);
    const job: RuntimeJob = {
      id: newRuntimeJobId(),
      status: "queued",
      contextKey,
      chatId: typeof chatId === "number" ? chatId : Number(chatId),
      userInput,
      displayText: normalizeQueueDisplayText(
        options?.queueDisplayText ?? promptTextForQueue(userInput),
      ),
      workspace,
      createdAt: new Date().toISOString(),
      updateId: origin.updateId,
      privateChat: origin.privateChat,
      turnId,
      outDir: options?.outDir ?? outboxPath(workspace, turnId),
      resumeThreadId: options?.resumeThreadId ?? session.getInfo().threadId ?? undefined,
      cleanupPaths: options?.cleanupPaths,
      executionMode: options?.executionMode,
    };
    await this.runtimeJobs.put(job);
    const receipt = this.scheduleJob(job, session, false);

    if (!receipt.startedImmediately) {
      const pending: PendingQueuedPrompt = { job, session };
      this.pendingQueuedPrompts.set(receipt.id, pending);
      const messageId = await this.sendQueuedReply(
        replyContext,
        job.chatId,
        parseContextKey(contextKey).messageThreadId,
        receipt.id,
        job.displayText,
      );
      if (messageId) {
        job.queueMessageId = messageId;
        await this.runtimeJobs.patch(job.id, { queueMessageId: messageId });
      }
    }
    return receipt;
  }

  private scheduleJob(
    job: RuntimeJob,
    session: CodexSessionService,
    recovering: boolean,
  ): TaskReceipt {
    return this.scheduler.enqueue(job.contextKey, async () => this.projectWorkLock.runExclusive(job.workspace, async () => {
      this.pendingQueuedPrompts.delete(job.id);
      if (!recovering && job.queueMessageId) {
        await this.bot.api.deleteMessage(job.chatId, job.queueMessageId).catch((error) => {
          console.error("Failed to delete launched queue message:", error);
        });
      }
      const startedAt = job.startedAt ?? new Date().toISOString();
      job.status = "running";
      job.startedAt = startedAt;
      await this.runtimeJobs.patch(job.id, { status: "running", startedAt });
      this.activeJobs.set(job.contextKey, job);

      let finished = false;
      try {
        await this.runner.run(job, session, recovering);
        finished = true;
      } finally {
        if (finished) {
          await this.runtimeJobs.remove(job.id);
          await retainRuntimeJobAttachments(job, this.config.workspace);
        }
        if (this.activeJobs.get(job.contextKey)?.id === job.id) {
          this.activeJobs.delete(job.contextKey);
        }
      }
    }), job.id);
  }

  async steerQueued(ctx: Context, taskId: string, contextKey: TelegramContextKey): Promise<void> {
    const pending = this.pendingQueuedPrompts.get(taskId);
    if (!pending || pending.job.contextKey !== contextKey) {
      await ctx.answerCallbackQuery({ text: "Эта задача уже запущена или устарела" }).catch(() => {});
      return;
    }
    if (!this.scheduler.remove(contextKey, taskId)) {
      this.pendingQueuedPrompts.delete(taskId);
      await ctx.answerCallbackQuery({ text: "Задача уже запущена" }).catch(() => {});
      return;
    }

    this.pendingQueuedPrompts.delete(taskId);
    await ctx.answerCallbackQuery({ text: "Отправляю в текущую задачу..." }).catch(() => {});
    const messageId = pending.job.queueMessageId ?? ctx.callbackQuery?.message?.message_id;
    try {
      await pending.session.steer(pending.job.userInput);
      this.runner.markSteered(contextKey);
      if (pending.job.cleanupPaths?.length) {
        const activeJob = this.activeJobs.get(contextKey);
        if (activeJob) {
          activeJob.cleanupPaths = [...new Set([
            ...(activeJob.cleanupPaths ?? []),
            ...pending.job.cleanupPaths,
          ])];
          await this.runtimeJobs.patch(activeJob.id, { cleanupPaths: activeJob.cleanupPaths });
        }
      }
      await this.runtimeJobs.remove(taskId);
      if (messageId) {
        await this.bot.api.deleteMessage(pending.job.chatId, messageId).catch((error) => {
          console.error("Failed to delete steered queue message:", error);
        });
      }
    } catch {
      if (messageId) {
        await this.bot.api.deleteMessage(pending.job.chatId, messageId).catch(() => {});
      }
      pending.job.queueMessageId = undefined;
      const receipt = this.scheduleJob(pending.job, pending.session, false);
      if (!receipt.startedImmediately) {
        this.pendingQueuedPrompts.set(taskId, pending);
        const nextMessageId = await this.sendQueuedReply(
          ctx,
          pending.job.chatId,
          parseContextKey(pending.job.contextKey).messageThreadId,
          taskId,
          pending.job.displayText,
        );
        if (nextMessageId) {
          pending.job.queueMessageId = nextMessageId;
          await this.runtimeJobs.patch(taskId, { queueMessageId: nextMessageId });
        }
      }
    }
  }

  async cancelQueued(ctx: Context, taskId: string, contextKey: TelegramContextKey): Promise<void> {
    const pending = this.pendingQueuedPrompts.get(taskId);
    if (!pending || pending.job.contextKey !== contextKey || !this.scheduler.remove(contextKey, taskId)) {
      await ctx.answerCallbackQuery({ text: "Задача уже запущена или отменена" }).catch(() => {});
      return;
    }

    this.pendingQueuedPrompts.delete(taskId);
    await this.runtimeJobs.remove(taskId);
    await cleanupRuntimeJob(pending.job, this.config.workspace);
    await ctx.answerCallbackQuery().catch(() => {});

    const messageId = pending.job.queueMessageId ?? ctx.callbackQuery?.message?.message_id;
    if (!messageId) return;
    await this.bot.api.deleteMessage(pending.job.chatId, messageId)
      .catch((error) => console.error("Failed to delete canceled queue message:", error));
  }

  private async sendQueuedReply(
    ctx: Context | undefined,
    chatId: number,
    messageThreadId: number | undefined,
    taskId: string,
    displayText: string,
  ): Promise<number | undefined> {
    const rendered = renderQueueMessage(displayText);
    const keyboard = new InlineKeyboard()
      .text({ text: "Отправить сейчас", style: "primary" }, `queue_steer:${taskId}`)
      .row()
      .text({ text: "Отменить", style: "danger" }, `queue_cancel:${taskId}`);
    const message = await sendTextMessage(ctx?.api ?? this.bot.api, chatId, rendered.html, {
      fallbackText: rendered.plain,
      replyMarkup: keyboard,
      messageThreadId,
    });
    return message.message_id;
  }
}
