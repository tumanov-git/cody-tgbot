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
import { LiveTurnMessage } from "./live-turn-message.js";
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
  liveMessageId?: number;
};

export { renderQueueMessage } from "./task-queue-ui.js";
export { buildRestartRecoveryInput } from "./task-recovery.js";

type PendingQueuedPrompt = {
  job: RuntimeJob;
  session: CodexSessionService;
};

type BusyState = { processing: boolean; transcribing: boolean };

type BatchedUserInput = {
  origin: { updateId: number; privateChat: boolean };
  replyContext?: Context;
  session: CodexSessionService;
  userInput: CodexPromptInput;
  options?: EnqueuePromptOptions;
};

type PendingUserInputBatch = {
  contextKey: TelegramContextKey;
  chatId: TelegramChatId;
  openedAt: number;
  items: BatchedUserInput[];
  timer?: NodeJS.Timeout;
  liveMessageId?: number;
  statusPromise: Promise<void>;
};

const USER_INPUT_SETTLE_MS = 1_000;
const USER_INPUT_MAX_WAIT_MS = 3_000;

export class TaskController {
  private readonly contextBusy = new Map<TelegramContextKey, BusyState>();
  private readonly pendingQueuedPrompts = new Map<string, PendingQueuedPrompt>();
  private readonly activeJobs = new Map<TelegramContextKey, RuntimeJob>();
  private readonly pendingUserInputBatches = new Map<TelegramContextKey, PendingUserInputBatch>();
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
    for (const batch of this.pendingUserInputBatches.values()) {
      if (batch.timer) clearTimeout(batch.timer);
    }
    this.pendingUserInputBatches.clear();
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
      || this.pendingUserInputBatches.size > 0
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

  async enqueueUserInput(
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
    options?: EnqueuePromptOptions,
  ): Promise<void> {
    this.enqueueUserInputFromOrigin(
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

  enqueueUserInputFromOrigin(
    origin: { updateId: number; privateChat: boolean },
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
    options?: EnqueuePromptOptions,
    replyContext?: Context,
  ): void {
    let batch = this.pendingUserInputBatches.get(contextKey);
    if (!batch) {
      const openedAt = Date.now();
      batch = {
        contextKey,
        chatId,
        openedAt,
        items: [],
        statusPromise: Promise.resolve(),
      };
      this.pendingUserInputBatches.set(contextKey, batch);
      batch.statusPromise = this.startBatchStatus(batch, replyContext);
    }

    batch.items.push({
      origin,
      replyContext,
      session,
      userInput,
      options,
    });
    this.scheduleUserInputBatch(batch);
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
      liveMessageId: options?.liveMessageId,
    };
    await this.runtimeJobs.put(job);
    const receipt = this.scheduleJob(job, session, false);

    if (!receipt.startedImmediately) {
      if (job.liveMessageId) {
        await this.bot.api.deleteMessage(job.chatId, job.liveMessageId).catch(() => {});
        job.liveMessageId = undefined;
        await this.runtimeJobs.patch(job.id, { liveMessageId: undefined });
      }
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

  private scheduleUserInputBatch(batch: PendingUserInputBatch): void {
    if (batch.timer) clearTimeout(batch.timer);
    const remaining = Math.max(0, USER_INPUT_MAX_WAIT_MS - (Date.now() - batch.openedAt));
    const delay = Math.min(USER_INPUT_SETTLE_MS, remaining);
    batch.timer = setTimeout(() => {
      void this.flushUserInputBatch(batch.contextKey);
    }, delay);
  }

  private async startBatchStatus(
    batch: PendingUserInputBatch,
    replyContext?: Context,
  ): Promise<void> {
    if (this.isBusy(batch.contextKey)) return;
    const liveMessage = new LiveTurnMessage({
      bot: this.bot,
      chatId: batch.chatId,
      contextKey: batch.contextKey,
      messageThreadId: parseContextKey(batch.contextKey).messageThreadId,
      initialStatus: "working",
      startedAt: batch.openedAt,
      onMessageReady: (messageId) => {
        batch.liveMessageId = messageId;
      },
    });
    try {
      await liveMessage.start();
    } catch (error) {
      console.warn("Failed to send immediate batch status:", formatError(error));
      await replyContext?.api.sendChatAction(batch.chatId, "typing").catch(() => {});
    } finally {
      liveMessage.dispose();
    }
  }

  private async flushUserInputBatch(contextKey: TelegramContextKey): Promise<void> {
    const batch = this.pendingUserInputBatches.get(contextKey);
    if (!batch) return;
    this.pendingUserInputBatches.delete(contextKey);
    if (batch.timer) clearTimeout(batch.timer);

    try {
      await batch.statusPromise;
      const merged = mergeBatchedUserInputs(batch.items);
      await this.enqueueFromOrigin(
        merged.origin,
        batch.contextKey,
        batch.chatId,
        merged.session,
        merged.userInput,
        {
          ...merged.options,
          liveMessageId: batch.liveMessageId,
        },
        merged.replyContext,
      );
    } catch (error) {
      if (batch.liveMessageId) {
        await this.bot.api.deleteMessage(Number(batch.chatId), batch.liveMessageId).catch(() => {});
      }
      console.error(`Failed to flush Telegram input batch for ${contextKey}:`, formatError(error));
    }
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

function mergeBatchedUserInputs(items: BatchedUserInput[]): {
  origin: { updateId: number; privateChat: boolean };
  replyContext?: Context;
  session: CodexSessionService;
  userInput: CodexPromptInput;
  options: EnqueuePromptOptions;
} {
  const latest = items.at(-1)!;
  const outputItem = items.find((item) => item.options?.outDir);
  const selectedOutDir = outputItem?.options?.outDir;
  const normalizedInputs = items.map((item) => {
    if (
      typeof item.userInput === "string"
      || !selectedOutDir
      || !item.options?.outDir
      || item.options.outDir === selectedOutDir
      || !item.userInput.stagedFileInstructions
    ) {
      return item.userInput;
    }
    return {
      ...item.userInput,
      stagedFileInstructions: item.userInput.stagedFileInstructions.replaceAll(
        item.options.outDir,
        selectedOutDir,
      ),
    };
  });
  const cleanupPaths = [...new Set(items.flatMap((item) => item.options?.cleanupPaths ?? []))];
  const displayText = items
    .map((item) => item.options?.queueDisplayText ?? promptTextForQueue(item.userInput))
    .filter(Boolean)
    .join("\n");

  return {
    origin: {
      updateId: Math.max(...items.map((item) => item.origin.updateId)),
      privateChat: latest.origin.privateChat,
    },
    replyContext: latest.replyContext,
    session: items[0]!.session,
    userInput: mergeCodexPromptInputs(normalizedInputs),
    options: {
      turnId: outputItem?.options?.turnId ?? items.find((item) => item.options?.turnId)?.options?.turnId,
      outDir: selectedOutDir,
      resumeThreadId: [...items].reverse().find((item) => item.options?.resumeThreadId)?.options?.resumeThreadId,
      queueDisplayText: displayText,
      cleanupPaths: cleanupPaths.length > 0 ? cleanupPaths : undefined,
      executionMode: items.find((item) => item.options?.executionMode)?.options?.executionMode,
    },
  };
}

export function mergeCodexPromptInputs(inputs: CodexPromptInput[]): CodexPromptInput {
  if (inputs.length === 1) return inputs[0]!;
  const text = inputs
    .map((input) => typeof input === "string" ? input : input.text)
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
  const imagePaths = inputs.flatMap((input) => typeof input === "string" ? [] : input.imagePaths ?? []);
  const stagedFileInstructions = inputs
    .map((input) => typeof input === "string" ? undefined : input.stagedFileInstructions)
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");

  return {
    ...(text ? { text } : {}),
    ...(imagePaths.length > 0 ? { imagePaths } : {}),
    ...(stagedFileInstructions ? { stagedFileInstructions } : {}),
  };
}
