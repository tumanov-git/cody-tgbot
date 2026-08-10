import { randomUUID } from "node:crypto";

import { InlineKeyboard, type Bot, type Context } from "grammy";

import { contextKeyFromCtx, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { escapeHTML } from "./format.js";
import { safeEditMessage, sendTextMessage, type TelegramChatId } from "./telegram-api.js";

type UserInputOption = { label: string; description: string };
type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
  isOther: boolean;
  isSecret: boolean;
};

type UserInputPending = {
  kind: "input";
  id: string;
  contextKey: TelegramContextKey;
  chatId: TelegramChatId;
  messageId?: number;
  questions: UserInputQuestion[];
  answers: Record<string, { answers: string[] }>;
  questionIndex: number;
  awaitingCustom: boolean;
  timer?: NodeJS.Timeout;
  resolve: (value: unknown) => void;
};

type ApprovalPending = {
  kind: "approval";
  id: string;
  contextKey: TelegramContextKey;
  chatId: TelegramChatId;
  messageId?: number;
  method: string;
  params: Record<string, unknown>;
  resolve: (value: unknown) => void;
};

type PendingInteraction = UserInputPending | ApprovalPending;

export class TelegramInteractionController {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly customByContext = new Map<TelegramContextKey, string>();

  constructor(private readonly bot: Bot<Context>) {}

  register(): void {
    this.bot.callbackQuery(/^cody_int:([a-f0-9]{8}):(.*)$/, async (ctx) => {
      const id = ctx.match?.[1];
      const action = ctx.match?.[2];
      const interaction = id ? this.pending.get(id) : undefined;
      const contextKey = contextKeyFromCtx(ctx);
      if (!interaction || !action || interaction.contextKey !== contextKey) {
        await ctx.answerCallbackQuery({ text: "Этот вопрос уже закрыт" }).catch(() => {});
        return;
      }
      if (interaction.kind === "approval") {
        await this.answerApproval(ctx, interaction, action);
      } else {
        await this.answerQuestion(ctx, interaction, action);
      }
    });

    this.bot.on("message:text", async (ctx, next) => {
      const contextKey = contextKeyFromCtx(ctx);
      const id = contextKey ? this.customByContext.get(contextKey) : undefined;
      const interaction = id ? this.pending.get(id) : undefined;
      if (!contextKey || !interaction || interaction.kind !== "input" || !interaction.awaitingCustom) {
        await next();
        return;
      }
      const answer = ctx.message.text.trim();
      if (!answer || answer.startsWith("/")) {
        await next();
        return;
      }
      const question = interaction.questions[interaction.questionIndex];
      if (!question) return;
      interaction.answers[question.id] = { answers: [answer] };
      interaction.awaitingCustom = false;
      this.customByContext.delete(contextKey);
      if (question.isSecret) {
        await ctx.deleteMessage().catch(() => {});
      }
      await this.advanceQuestion(interaction);
    });
  }

  async requestUserInput(
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const questions = readQuestions(params.questions);
    if (questions.length === 0) return { answers: {} };
    return new Promise<unknown>((resolve) => {
      const interaction: UserInputPending = {
        kind: "input",
        id: shortId(),
        contextKey,
        chatId,
        questions,
        answers: {},
        questionIndex: 0,
        awaitingCustom: false,
        resolve,
      };
      const autoResolutionMs = typeof params.autoResolutionMs === "number"
        ? params.autoResolutionMs
        : null;
      if (autoResolutionMs && autoResolutionMs > 0) {
        interaction.timer = setTimeout(() => {
          void this.finishInput(interaction);
        }, autoResolutionMs);
      }
      this.pending.set(interaction.id, interaction);
      void this.showQuestion(interaction).catch(() => this.finishInput(interaction));
    });
  }

  async requestApproval(
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      const interaction: ApprovalPending = {
        kind: "approval",
        id: shortId(),
        contextKey,
        chatId,
        method,
        params,
        resolve,
      };
      this.pending.set(interaction.id, interaction);
      void this.showApproval(interaction).catch(() => {
        this.pending.delete(interaction.id);
        resolve(declinedApproval(method));
      });
    });
  }

  private async showQuestion(interaction: UserInputPending): Promise<void> {
    const question = interaction.questions[interaction.questionIndex];
    if (!question) {
      await this.finishInput(interaction);
      return;
    }
    const lines = [
      `<b>${escapeHTML(question.header || "Нужно уточнить")}</b>`,
      "",
      escapeHTML(question.question),
    ];
    if (question.options.length > 0) {
      const descriptions = question.options
        .filter((option) => option.description)
        .map((option) => `<b>${escapeHTML(option.label)}</b> — ${escapeHTML(option.description)}`);
      if (descriptions.length > 0) lines.push("", ...descriptions);
    } else {
      lines.push("", "Ответь следующим сообщением");
      interaction.awaitingCustom = true;
      this.customByContext.set(interaction.contextKey, interaction.id);
    }
    const keyboard = new InlineKeyboard();
    question.options.forEach((option, index) => {
      keyboard.text(option.label, `cody_int:${interaction.id}:o${index}`).row();
    });
    if (question.isOther || question.options.length === 0) {
      keyboard.text("Написать свой вариант", `cody_int:${interaction.id}:other`).row();
    }
    const plain = stripHtml(lines.join("\n"));
    if (interaction.messageId) {
      await safeEditMessage(this.bot, interaction.chatId, interaction.messageId, lines.join("\n"), {
        fallbackText: plain,
        replyMarkup: keyboard,
      });
      return;
    }
    const message = await sendTextMessage(this.bot.api, interaction.chatId, lines.join("\n"), {
      fallbackText: plain,
      replyMarkup: keyboard,
      messageThreadId: parseContextKey(interaction.contextKey).messageThreadId,
    });
    interaction.messageId = message.message_id;
  }

  private async answerQuestion(ctx: Context, interaction: UserInputPending, action: string): Promise<void> {
    const question = interaction.questions[interaction.questionIndex];
    if (!question) {
      await ctx.answerCallbackQuery({ text: "Вопрос уже закрыт" }).catch(() => {});
      return;
    }
    if (action === "other") {
      interaction.awaitingCustom = true;
      this.customByContext.set(interaction.contextKey, interaction.id);
      await ctx.answerCallbackQuery({ text: "Напиши ответ следующим сообщением" });
      await this.showQuestion(interaction);
      return;
    }
    const optionIndex = /^o(\d+)$/.exec(action)?.[1];
    const option = optionIndex === undefined ? undefined : question.options[Number(optionIndex)];
    if (!option) {
      await ctx.answerCallbackQuery({ text: "Вариант уже недоступен" }).catch(() => {});
      return;
    }
    interaction.answers[question.id] = { answers: [option.label] };
    await ctx.answerCallbackQuery();
    await this.advanceQuestion(interaction);
  }

  private async advanceQuestion(interaction: UserInputPending): Promise<void> {
    interaction.questionIndex += 1;
    if (interaction.questionIndex >= interaction.questions.length) {
      await this.finishInput(interaction);
      return;
    }
    await this.showQuestion(interaction);
  }

  private async finishInput(interaction: UserInputPending): Promise<void> {
    if (!this.pending.delete(interaction.id)) return;
    if (interaction.timer) clearTimeout(interaction.timer);
    if (this.customByContext.get(interaction.contextKey) === interaction.id) {
      this.customByContext.delete(interaction.contextKey);
    }
    if (interaction.messageId) {
      await this.bot.api.deleteMessage(interaction.chatId, interaction.messageId).catch(() => {});
    }
    interaction.resolve({ answers: interaction.answers });
  }

  private async showApproval(interaction: ApprovalPending): Promise<void> {
    const reason = readString(interaction.params, "reason");
    const command = readString(interaction.params, "command");
    const grantRoot = readString(interaction.params, "grantRoot");
    const detail = reason || command || grantRoot || "Выполнить действие за пределами текущих разрешений";
    const html = [
      "<b>Коди нужно разрешение</b>",
      "",
      `<blockquote>${escapeHTML(limit(detail, 900))}</blockquote>`,
    ].join("\n");
    const keyboard = new InlineKeyboard()
      .text({ text: "Разрешить один раз", style: "primary" }, `cody_int:${interaction.id}:once`)
      .row()
      .text("Разрешить для задачи", `cody_int:${interaction.id}:session`)
      .row()
      .text({ text: "Отклонить", style: "danger" }, `cody_int:${interaction.id}:decline`);
    const message = await sendTextMessage(this.bot.api, interaction.chatId, html, {
      fallbackText: `Коди нужно разрешение\n\n${detail}`,
      replyMarkup: keyboard,
      messageThreadId: parseContextKey(interaction.contextKey).messageThreadId,
    });
    interaction.messageId = message.message_id;
  }

  private async answerApproval(ctx: Context, interaction: ApprovalPending, action: string): Promise<void> {
    if (!this.pending.delete(interaction.id)) {
      await ctx.answerCallbackQuery({ text: "Запрос уже закрыт" }).catch(() => {});
      return;
    }
    const result = approvalResult(interaction.method, interaction.params, action);
    await ctx.answerCallbackQuery();
    if (interaction.messageId) {
      await this.bot.api.deleteMessage(interaction.chatId, interaction.messageId).catch(() => {});
    }
    interaction.resolve(result);
  }
}

function approvalResult(
  method: string,
  params: Record<string, unknown>,
  action: string,
): unknown {
  if (method === "item/permissions/requestApproval") {
    return action === "decline"
      ? { permissions: {}, scope: "turn" }
      : {
          permissions: asRecord(params.permissions),
          scope: action === "session" ? "session" : "turn",
        };
  }
  return {
    decision: action === "decline"
      ? "decline"
      : action === "session" ? "acceptForSession" : "accept",
  };
}

function declinedApproval(method: string): unknown {
  return method === "item/permissions/requestApproval"
    ? { permissions: {}, scope: "turn" }
    : { decision: "decline" };
}

function readQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): UserInputQuestion[] => {
    const item = asRecord(raw);
    const id = readString(item, "id");
    const question = readString(item, "question");
    if (!id || !question) return [];
    const options = Array.isArray(item.options)
      ? item.options.flatMap((rawOption): UserInputOption[] => {
          const option = asRecord(rawOption);
          const label = readString(option, "label");
          if (!label) return [];
          return [{ label, description: readString(option, "description") ?? "" }];
        })
      : [];
    return [{
      id,
      header: readString(item, "header") ?? "",
      question,
      options,
      isOther: item.isOther === true,
      isSecret: item.isSecret === true,
    }];
  });
}

function shortId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function limit(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
