import type { Bot, Context, InlineKeyboard } from "grammy";

import {
  formatError,
  redactSecrets,
  sendRichFinalMessage,
  splitRichMarkdownForTelegram,
  type TelegramChatId,
} from "./telegram-api.js";

const RICH_DRAFT_DEBOUNCE_MS = 1_500;
const RICH_MESSAGE_CHUNK_TARGET = 30_000;

type FinalAnswerStreamOptions = {
  bot: Bot<Context>;
  chatId: TelegramChatId;
  messageThreadId?: number;
  draftChatId?: number;
  draftId: number;
};

export class FinalAnswerStream {
  private text = "";
  private draftTimer: NodeJS.Timeout | undefined;
  private draftRequest: Promise<void> | undefined;
  private draftPending = false;
  private lastDraftText = "";
  private finalized = false;
  private nextDraftAllowedAt = 0;

  constructor(private readonly options: FinalAnswerStreamOptions) {}

  getText(): string {
    return this.text;
  }

  isFinalized(): boolean {
    return this.finalized;
  }

  update(text: string): void {
    this.text = text;
    this.scheduleDraft();
  }

  async deliver(text = this.text, replyMarkup?: InlineKeyboard): Promise<number[]> {
    if (this.finalized) return [];
    this.finalized = true;
    await this.stopDraftUpdates();

    const finalText = text.trim();
    if (!finalText) return [];

    const chunks = splitRichMarkdownForTelegram(finalText);
    const messageIds: number[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const message = await sendRichFinalMessage(this.options.bot.api, this.options.chatId, chunk, {
        messageThreadId: this.options.messageThreadId,
        replyMarkup: index === chunks.length - 1 ? replyMarkup : undefined,
      });
      messageIds.push(message.message_id);
    }
    return messageIds;
  }

  async stopDraftUpdates(): Promise<void> {
    this.clearDraftTimer();
    this.draftPending = false;
    if (this.draftRequest) {
      await this.draftRequest.catch((error) => {
        console.error(
          "Rich final draft stopped after Telegram error:",
          redactSecrets(formatError(error)),
        );
      });
    }
  }

  private scheduleDraft(): void {
    if (this.options.draftChatId === undefined || this.finalized || this.draftTimer) return;

    const delay = Math.max(
      RICH_DRAFT_DEBOUNCE_MS,
      this.nextDraftAllowedAt - Date.now(),
    );
    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined;
      void this.flushDraft().catch((error) => {
        console.error("Failed to stream rich final draft:", redactSecrets(formatError(error)));
        const retryAfterMs = readRetryAfterMs(error);
        if (retryAfterMs !== undefined && !this.finalized) {
          this.nextDraftAllowedAt = Date.now() + retryAfterMs;
          this.scheduleDraft();
        }
      });
    }, delay);
  }

  private async flushDraft(): Promise<void> {
    if (this.options.draftChatId === undefined || this.finalized) return;
    if (this.draftRequest) {
      this.draftPending = true;
      await this.draftRequest;
      return;
    }

    const nextText = redactSecrets(this.text).slice(0, RICH_MESSAGE_CHUNK_TARGET);
    if (!nextText || nextText === this.lastDraftText) return;

    const request = this.options.bot.api
      .sendRichMessageDraft(this.options.draftChatId, this.options.draftId, { markdown: nextText })
      .then(() => {
        this.lastDraftText = nextText;
      })
      .finally(() => {
        this.draftRequest = undefined;
        if (this.draftPending) {
          this.draftPending = false;
          this.scheduleDraft();
        }
      });
    this.draftRequest = request;
    await request;
  }

  private clearDraftTimer(): void {
    if (!this.draftTimer) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
  }
}

function readRetryAfterMs(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const parameters = "parameters" in error ? error.parameters : undefined;
    if (typeof parameters === "object" && parameters !== null && "retry_after" in parameters) {
      const seconds = Number(parameters.retry_after);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;
    }
  }
  const match = formatError(error).match(/retry after\s+(\d+)/i);
  return match?.[1] ? Number(match[1]) * 1_000 : undefined;
}
