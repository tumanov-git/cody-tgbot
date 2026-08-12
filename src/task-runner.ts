import type { Bot, Context } from "grammy";

import { deliverArtifacts } from "./artifact-delivery.js";
import { buildOutputInstructions, outboxPath } from "./attachments.js";
import { ensureOutDir } from "./artifacts.js";
import {
  type AgentMessagePhase,
  type CodexPromptInput,
  type CodexSessionCallbacks,
  type CodexSessionService,
} from "./codex-session.js";
import type { CodyConfig } from "./config.js";
import { parseContextKey, type TelegramContextKey } from "./context-key.js";
import { dialogTitleSource } from "./dialog-title.js";
import { friendlyErrorText } from "./error-messages.js";
import { FinalAnswerStream } from "./final-answer-stream.js";
import { escapeHTML, PREMIUM_EMOJI, renderPremiumEmojiMarkdown } from "./format.js";
import { LiveTurnMessage } from "./live-turn-message.js";
import type { ManagedBotService } from "./managed-bots.js";
import type { RuntimeJob, RuntimeJobStore } from "./runtime-jobs.js";
import { requireWithinDirectory } from "./security.js";
import type { SessionRegistry } from "./session-registry.js";
import { buildRestartRecoveryInput } from "./task-recovery.js";
import { formatError, sendTextMessage } from "./telegram-api.js";
import type { TelegramInteractionController } from "./telegram-interactions.js";

export interface TaskRunnerOptions {
  bot: Bot<Context>;
  config: CodyConfig;
  registry: SessionRegistry;
  runtimeJobs: RuntimeJobStore;
  managedBots?: ManagedBotService;
  setProcessing: (contextKey: TelegramContextKey, processing: boolean) => void;
  isShuttingDown: () => boolean;
  interactions: TelegramInteractionController;
}

export class TaskRunner {
  private readonly activeSteerWorklogs = new Map<TelegramContextKey, () => void>();

  constructor(private readonly options: TaskRunnerOptions) {}

  markSteered(contextKey: TelegramContextKey): void {
    this.activeSteerWorklogs.get(contextKey)?.();
  }

  async run(
    job: RuntimeJob,
    session: CodexSessionService,
    recovering: boolean,
  ): Promise<void> {
    const { contextKey, chatId } = job;
    const messageThreadId = parseContextKey(contextKey).messageThreadId;
    const requestedOutDir = job.outDir ?? outboxPath(job.workspace, job.turnId ?? job.id);
    const outDir = requireWithinDirectory(requestedOutDir, job.workspace, "output directory");
    try {
      await ensureOutDir(outDir);
    } catch (error) {
      await sendTextMessage(
        this.options.bot.api,
        chatId,
        `<b>Не удалось подготовить выдачу файлов:</b> ${escapeHTML(friendlyErrorText(error))}`,
        {
          fallbackText: `Не удалось подготовить выдачу файлов: ${friendlyErrorText(error)}`,
          messageThreadId,
        },
      );
      return;
    }

    this.options.setProcessing(contextKey, true);
    const userInput = recovering ? buildRestartRecoveryInput(job) : job.userInput;
    const titleSource = dialogTitleSource(job.userInput);
    const promptInput = withOutputInstructions(userInput, outDir);
    const draftChatId = job.privateChat && !recovering ? chatId : undefined;
    const liveMessage = new LiveTurnMessage({
      bot: this.options.bot,
      chatId,
      contextKey,
      messageThreadId,
      existingMessageId: job.liveMessageId,
      initialStatus: job.liveMessageId ? "working" : undefined,
      startedAt: job.liveMessageId
        ? Date.parse(job.createdAt)
        : job.startedAt ? Date.parse(job.startedAt) : undefined,
      onMessageReady: async (messageId) => {
        job.liveMessageId = messageId;
        await this.options.runtimeJobs.patch(job.id, { liveMessageId: messageId });
      },
    });
    if (recovering) {
      liveMessage.commentary(
        "restart-recovery",
        "Коди перезапустился. Восстанавливаю задачу и продолжаю с места остановки.",
      );
    }
    const finalAnswer = new FinalAnswerStream({
      bot: this.options.bot,
      chatId,
      messageThreadId,
      draftChatId,
      draftId: Math.max(1, job.updateId),
    });
    let finalized = false;
    let interrupted = false;
    let managedBotAction: Awaited<ReturnType<ManagedBotService["prepareFinalAction"]>>;
    const appendSteerWorklog = (): void => liveMessage.markSteered();
    this.activeSteerWorklogs.set(contextKey, appendSteerWorklog);

    const callbacks: CodexSessionCallbacks = {
      onTextDelta: () => {},
      onAgentMessageDelta: (messageId, _delta, fullText, phase: AgentMessagePhase) => {
        if (phase === "final_answer") finalAnswer.update(fullText);
        else liveMessage.commentary(messageId, fullText);
      },
      onAgentMessageComplete: (messageId, text, phase: AgentMessagePhase) => {
        if (phase === "final_answer" || phase === null) {
          finalAnswer.update(text);
          if (phase === null) liveMessage.removeCommentary(messageId);
        } else {
          liveMessage.commentary(messageId, text);
        }
      },
      onToolStart: (toolName, toolCallId) => liveMessage.toolStarted(toolName, toolCallId),
      onToolEnd: (toolCallId, isError) => liveMessage.toolFinished(toolCallId, isError),
      onAgentEnd: (status) => {
        interrupted = status === "interrupted";
      },
      onRequestUserInput: async (params) => {
        liveMessage.setWaiting("answer");
        try {
          return await this.options.interactions.requestUserInput(contextKey, chatId, params);
        } finally {
          liveMessage.resumeWorking();
        }
      },
      onRequestApproval: async (method, params) => {
        liveMessage.setWaiting("approval");
        try {
          return await this.options.interactions.requestApproval(contextKey, chatId, method, params);
        } finally {
          liveMessage.resumeWorking();
        }
      },
      onSubagentCount: (count) => liveMessage.setSubagentCount(count),
    };

    try {
      await liveMessage.start();
      if (job.resumeThreadId && session.getInfo().threadId !== job.resumeThreadId) {
        await session.resumeThread(job.resumeThreadId, job.workspace);
        this.options.registry.updateMetadata(contextKey, session);
      }
      if (!(await this.ensureActiveThread(job, session))) return;
      const threadId = await session.ensureThreadId();
      if (job.resumeThreadId !== threadId) {
        job.resumeThreadId = threadId;
        await this.options.runtimeJobs.patch(job.id, { resumeThreadId: threadId });
        this.options.registry.updateMetadata(contextKey, session);
      }
      if (job.executionMode === "review") {
        await session.review(callbacks, promptText(job.userInput));
      } else {
        await session.prompt(
          promptInput,
          callbacks,
          job.executionMode === "plan" ? { collaborationMode: "plan" } : {},
        );
      }
      this.options.registry.updateMetadata(contextKey, session, { titleSource });
      const activeThreadId = session.getInfo().threadId;
      if (activeThreadId) {
        managedBotAction = await this.options.managedBots?.prepareFinalAction(activeThreadId);
        void this.options.registry.ensureDialogTitle(contextKey, activeThreadId, titleSource)
          .catch((error) => {
            console.warn(
              `Failed to generate title for dialog ${activeThreadId}:`,
              error instanceof Error ? error.message : String(error),
            );
          });
      }
      finalized = true;
      await liveMessage.finish(interrupted);
      const finalText = finalAnswer.getText().trim()
        || (managedBotAction ? "Бот готов к созданию. Нажми кнопку ниже." : "");
      const messageIds = await finalAnswer.deliver(finalText, managedBotAction?.keyboard);
      const buttonMessageId = messageIds.at(-1);
      if (managedBotAction && buttonMessageId) {
        await this.options.managedBots?.markDelivered(managedBotAction.requestId, buttonMessageId);
      }
    } catch (error) {
      if (this.options.isShuttingDown()) throw error;
      if (finalized) {
        console.error("Codex prompt error after finalization:", formatError(error));
      } else {
        finalized = true;
        try {
          await liveMessage.fail();
          await finalAnswer.deliver(renderPromptFailure(finalAnswer.getText(), error).trim());
        } catch (telegramError) {
          console.error("Failed to send error message to Telegram:", telegramError);
        }
      }
    } finally {
      liveMessage.dispose();
      await finalAnswer.stopDraftUpdates();
      if (this.activeSteerWorklogs.get(contextKey) === appendSteerWorklog) {
        this.activeSteerWorklogs.delete(contextKey);
      }
      if (!this.options.isShuttingDown()) {
        try {
          await deliverArtifacts(
            this.options.bot.api,
            this.options.config,
            chatId,
            outDir,
            messageThreadId,
          );
        } catch (artifactError) {
          console.error("Failed to deliver artifacts:", artifactError);
        }
      }
      this.options.setProcessing(contextKey, false);
    }
  }

  private async ensureActiveThread(
    job: RuntimeJob,
    session: CodexSessionService,
  ): Promise<boolean> {
    if (session.hasActiveThread()) return true;
    try {
      await session.newThread();
      this.options.registry.updateMetadata(job.contextKey, session);
      return true;
    } catch (error) {
      await sendTextMessage(
        this.options.bot.api,
        job.chatId,
        escapeHTML(`Не удалось создать тред: ${friendlyErrorText(error)}`),
        {
          fallbackText: `Не удалось создать тред: ${friendlyErrorText(error)}`,
          messageThreadId: parseContextKey(job.contextKey).messageThreadId,
        },
      );
      return false;
    }
  }
}

function withOutputInstructions(input: CodexPromptInput, outDir: string): CodexPromptInput {
  const outputInstructions = buildOutputInstructions(outDir);
  if (typeof input === "string") return { text: input, stagedFileInstructions: outputInstructions };
  if (input.stagedFileInstructions?.includes(outDir)) return input;
  return {
    ...input,
    stagedFileInstructions: [input.stagedFileInstructions, outputInstructions]
      .filter((value): value is string => Boolean(value))
      .join("\n\n"),
  };
}

function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  const marker = renderPremiumEmojiMarkdown(PREMIUM_EMOJI.sad, "😕");
  return accumulatedText.trim()
    ? `${accumulatedText.trim()}\n\n${marker} ${message}`
    : `${marker} ${message}`;
}

function promptText(input: CodexPromptInput): string | undefined {
  return typeof input === "string" ? input : input.text;
}
