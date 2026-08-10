import { randomUUID } from "node:crypto";

import { Bot, InlineKeyboard, type Context } from "grammy";

import type { TelegramContextKey } from "./context-key.js";
import { safeEditMessage, sendTextMessage, type TelegramChatId } from "./telegram-api.js";
import {
  formatToolLifecycleText,
  renderWorkingStatus,
  statusHasFinished,
  type WorklogEntry,
  type WorkStatus,
} from "./work-status.js";

const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;

type LiveTurnMessageOptions = {
  bot: Bot<Context>;
  chatId: TelegramChatId;
  contextKey: TelegramContextKey;
  messageThreadId?: number;
  existingMessageId?: number;
  startedAt?: number;
  onMessageReady?: (messageId: number) => void | Promise<void>;
};

export class LiveTurnMessage {
  private readonly toolNames = new Map<string, string>();
  private readonly entryOrder: string[] = [];
  private readonly entries = new Map<string, WorklogEntry>();
  private readonly startedAt: number;
  private readonly abortKeyboard: InlineKeyboard;
  private messageId: number | undefined;
  private messagePromise: Promise<void> | undefined;
  private lastRenderedText = "";
  private lastEditAt = 0;
  private flushTimer: NodeJS.Timeout | undefined;
  private elapsedTimer: NodeJS.Timeout | undefined;
  private typingTimer: NodeJS.Timeout | undefined;
  private isFlushing = false;
  private flushPending = false;
  private finalized = false;
  private status: WorkStatus = "accepted";
  private subagentCount = 0;

  constructor(private readonly options: LiveTurnMessageOptions) {
    this.startedAt = options.startedAt ?? Date.now();
    this.messageId = options.existingMessageId;
    this.abortKeyboard = new InlineKeyboard().text(
      { text: "Остановить", style: "danger" },
      `codex_abort:${options.contextKey}`,
    );
  }

  async start(): Promise<void> {
    this.sendTyping();
    this.typingTimer = setInterval(() => this.sendTyping(), TYPING_INTERVAL_MS);
    this.elapsedTimer = setInterval(() => {
      if (this.messageId) this.scheduleFlush();
    }, TYPING_INTERVAL_MS);
    if (this.messageId) {
      try {
        await this.flush(true);
        await this.options.onMessageReady?.(this.messageId);
      } catch (error) {
        console.warn("Failed to resume Telegram status message; creating a new one:", error);
        this.messageId = undefined;
        this.lastRenderedText = "";
        await this.ensureMessage();
      }
      return;
    }
    await this.ensureMessage();
  }

  commentary(messageId: string, text: string): void {
    this.status = "working";
    this.upsert({ id: `agent:${messageId}`, kind: "commentary", text });
    this.queueUpdate();
  }

  removeCommentary(messageId: string): void {
    this.remove(`agent:${messageId}`);
    this.queueUpdate();
  }

  toolStarted(toolName: string, toolCallId: string): void {
    this.toolNames.set(toolCallId, toolName);
    this.status = "working";
    this.upsert({
      id: `tool:${toolCallId}`,
      kind: "tool",
      text: formatToolLifecycleText(toolName, "running"),
    });
    this.queueUpdate();
  }

  toolFinished(toolCallId: string, isError: boolean): void {
    const toolName = this.toolNames.get(toolCallId);
    if (toolName) {
      this.upsert({
        id: `tool:${toolCallId}`,
        kind: "tool",
        text: formatToolLifecycleText(toolName, isError ? "failed" : "completed"),
      });
    }
    this.queueUpdate();
  }

  markSteered(): void {
    if (this.finalized) return;
    this.status = "working";
    this.upsert({
      id: `steer:${randomUUID()}`,
      kind: "queue",
      text: "Сообщение из очереди добавлено в текущую задачу",
    });
    this.queueUpdate();
  }

  setSubagentCount(count: number): void {
    if (this.finalized) return;
    this.subagentCount = Math.max(0, count);
    this.queueUpdate();
  }

  setWaiting(kind: "answer" | "approval"): void {
    if (this.finalized) return;
    this.status = kind === "answer" ? "waiting-answer" : "waiting-approval";
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = undefined;
    this.queueUpdate();
  }

  resumeWorking(): void {
    if (this.finalized) return;
    this.status = "working";
    if (!this.typingTimer) {
      this.sendTyping();
      this.typingTimer = setInterval(() => this.sendTyping(), TYPING_INTERVAL_MS);
    }
    this.queueUpdate();
  }

  async finish(interrupted: boolean): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.status = interrupted ? "stopped" : "completed";
    this.stopLiveUpdates();
    await this.waitForInitialMessage();
    await this.flush(true).catch((error) => {
      console.error("Failed to finalize live worklog message", error);
    });
  }

  async fail(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.status = "failed";
    this.stopLiveUpdates();
    await this.waitForInitialMessage();
    await this.flush(true).catch((error) => {
      console.error("Failed to finalize live worklog before error response", error);
    });
  }

  dispose(): void {
    this.stopLiveUpdates();
  }

  private render() {
    return renderWorkingStatus({
      status: this.status,
      entries: this.entryOrder.flatMap((id) => {
        const entry = this.entries.get(id);
        return entry ? [entry] : [];
      }),
      elapsedSeconds: Math.max(1, Math.floor((Date.now() - this.startedAt) / 1000)),
      subagentCount: this.subagentCount,
    });
  }

  private upsert(entry: WorklogEntry): void {
    if (!this.entries.has(entry.id)) this.entryOrder.push(entry.id);
    this.entries.set(entry.id, entry);
  }

  private remove(id: string): void {
    this.entries.delete(id);
    const index = this.entryOrder.indexOf(id);
    if (index >= 0) this.entryOrder.splice(index, 1);
  }

  private sendTyping(): void {
    void this.options.bot.api
      .sendChatAction(this.options.chatId, "typing", {
        ...(this.options.messageThreadId
          ? { message_thread_id: this.options.messageThreadId }
          : {}),
      })
      .catch(() => {});
  }

  private async ensureMessage(): Promise<void> {
    if (this.messageId) return;
    if (this.messagePromise) {
      await this.messagePromise;
      return;
    }

    this.messagePromise = (async () => {
      const preview = this.render();
      const message = await sendTextMessage(
        this.options.bot.api,
        this.options.chatId,
        preview.text,
        {
          parseMode: preview.parseMode,
          fallbackText: preview.fallbackText,
          replyMarkup: statusHasFinished(this.status)
            ? new InlineKeyboard()
            : this.abortKeyboard,
          messageThreadId: this.options.messageThreadId,
        },
      );
      this.messageId = message.message_id;
      await this.options.onMessageReady?.(message.message_id);
      this.lastRenderedText = preview.text;
      this.lastEditAt = Date.now();
      this.sendTyping();
    })();

    try {
      await this.messagePromise;
    } finally {
      this.messagePromise = undefined;
    }
  }

  private async waitForInitialMessage(): Promise<void> {
    if (!this.messagePromise) return;
    try {
      await this.messagePromise;
    } catch {
      // The rich final answer can still be delivered without the live status message.
    }
  }

  private async flush(force = false): Promise<void> {
    if (!this.messageId) {
      await this.ensureMessage();
      return;
    }
    if (this.isFlushing) {
      this.flushPending = true;
      return;
    }
    if (!force && Date.now() - this.lastEditAt < EDIT_DEBOUNCE_MS) return;

    const next = this.render();
    if (next.text === this.lastRenderedText) return;

    this.isFlushing = true;
    try {
      await safeEditMessage(
        this.options.bot,
        this.options.chatId,
        this.messageId,
        next.text,
        {
          parseMode: next.parseMode,
          fallbackText: next.fallbackText,
          replyMarkup: statusHasFinished(this.status)
            ? new InlineKeyboard()
            : this.abortKeyboard,
        },
      );
      this.lastRenderedText = next.text;
      this.lastEditAt = Date.now();
    } finally {
      this.isFlushing = false;
      if (this.flushPending) {
        this.flushPending = false;
        this.scheduleFlush();
      }
    }
  }

  private queueUpdate(): void {
    if (this.finalized) return;
    if (!this.messageId) {
      void this.ensureMessage()
        .then(() => this.scheduleFlush())
        .catch((error) => console.error("Failed to send initial Telegram status message", error));
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.finalized) return;
    const delay = Math.max(0, EDIT_DEBOUNCE_MS - (Date.now() - this.lastEditAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch((error) => {
        console.error("Failed to update Telegram response message", error);
      });
    }, delay);
  }

  private stopLiveUpdates(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.typingTimer = undefined;
    this.elapsedTimer = undefined;
    this.flushTimer = undefined;
  }
}
