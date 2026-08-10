import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { InlineKeyboard, type Bot, type Context } from "grammy";

import {
  type CodexAccount,
  type CodexAuthService,
  type CodexAuthState,
  type CodexLoginCompletion,
} from "./codex-auth.js";
import type { CodyConfig } from "./config.js";
import { escapeHTML } from "./format.js";
import { safeEditMessage, safeReply } from "./telegram-api.js";

type ShowTextScreen = (
  ctx: Context,
  html: string,
  plain: string,
  keyboard: InlineKeyboard,
) => Promise<void>;

interface PendingLoginMessage {
  loginId: string;
  chatId: number;
  messageId: number;
  startedAt: string;
}

export interface AccountView {
  html: string;
  plain: string;
  keyboard: InlineKeyboard;
}

export class CodexAuthUi {
  private readonly journalPath: string;
  private pending: PendingLoginMessage | null = null;
  private readonly unsubscribeLogin: () => void;

  constructor(private readonly options: {
    bot: Bot<Context>;
    config: CodyConfig;
    auth: CodexAuthService;
    showTextScreen: ShowTextScreen;
    isBusy: () => boolean;
  }) {
    this.journalPath = path.join(
      options.config.workspace,
      ".cody-tgbot",
      "runtime",
      "auth-login.json",
    );
    this.unsubscribeLogin = options.auth.onLoginCompleted((completion) => {
      void this.handleLoginCompletion(completion);
    });
    this.registerCallbacks();
  }

  async isReady(): Promise<boolean> {
    return this.options.auth.isReady();
  }

  async showAccount(ctx: Context, mode: "reply" | "edit" = "edit"): Promise<void> {
    const isOwner = ctx.from?.id === this.options.config.telegramOwnerUserId;
    try {
      const state = await this.options.auth.read();
      const view = renderAccountView(state, isOwner);
      await this.show(ctx, view, mode);
    } catch (error) {
      await this.show(ctx, renderAccountError(error, isOwner), mode);
    }
  }

  async requireReady(ctx: Context): Promise<boolean> {
    try {
      if (await this.isReady()) return true;
    } catch {
      // The account screen below owns the retry UX.
    }
    if (ctx.chat?.type === "private") {
      await this.showAccount(ctx, ctx.callbackQuery?.message ? "edit" : "reply");
    } else {
      await safeReply(ctx, "Подключи Codex в личном чате с Коди", {
        fallbackText: "Подключи Codex в личном чате с Коди",
      });
    }
    return false;
  }

  async recover(): Promise<void> {
    const pending = await this.readJournal();
    if (!pending) return;
    await safeEditMessage(
      this.options.bot,
      pending.chatId,
      pending.messageId,
      "<b>Вход в Codex</b>\n\nВход прерван перезапуском. Попробуй ещё раз",
      {
        fallbackText: "Вход в Codex\n\nВход прерван перезапуском. Попробуй ещё раз",
        replyMarkup: new InlineKeyboard()
          .text({ text: "Войти через ChatGPT", style: "primary" }, "auth:login")
          .row()
          .text("Назад", "menu:settings"),
      },
    ).catch(() => {});
    await this.clearJournal();
  }

  dispose(): void {
    this.unsubscribeLogin();
  }

  private registerCallbacks(): void {
    const { bot } = this.options;

    bot.callbackQuery("settings:account", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.showAccount(ctx);
    });

    bot.callbackQuery("auth:login", async (ctx) => {
      if (!await this.requireOwnerPrivate(ctx)) return;
      if (this.options.isBusy()) {
        await ctx.answerCallbackQuery({ text: "Сначала закончу текущую работу" }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery({ text: "Готовлю вход…" }).catch(() => {});
      try {
        const login = await this.options.auth.startDeviceLogin();
        const chatId = ctx.chat?.id;
        const messageId = ctx.callbackQuery.message?.message_id;
        if (!chatId || !messageId) {
          await this.options.auth.cancelPendingLogin().catch(() => {});
          return;
        }
        this.pending = {
          loginId: login.loginId,
          chatId,
          messageId,
          startedAt: new Date().toISOString(),
        };
        await this.writeJournal(this.pending);
        const view = renderDeviceLoginView(login.verificationUrl, login.userCode);
        await this.options.showTextScreen(ctx, view.html, view.plain, view.keyboard);
      } catch (error) {
        await this.show(ctx, renderLoginError(error), "edit");
      }
    });

    bot.callbackQuery("auth:cancel", async (ctx) => {
      if (!await this.requireOwnerPrivate(ctx)) return;
      await this.options.auth.cancelPendingLogin().catch(() => {});
      await this.clearJournal();
      await ctx.answerCallbackQuery({ text: "Вход отменён" }).catch(() => {});
      await this.showAccount(ctx);
    });

    bot.callbackQuery("auth:logout", async (ctx) => {
      if (!await this.requireOwnerPrivate(ctx)) return;
      await ctx.answerCallbackQuery();
      const view = renderLogoutConfirmation();
      await this.options.showTextScreen(ctx, view.html, view.plain, view.keyboard);
    });

    bot.callbackQuery("auth:logout:confirm", async (ctx) => {
      if (!await this.requireOwnerPrivate(ctx)) return;
      if (this.options.isBusy()) {
        await ctx.answerCallbackQuery({ text: "Сначала закончу текущую работу" }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery({ text: "Отключаю Codex…" }).catch(() => {});
      try {
        await this.options.auth.logout();
        await this.showAccount(ctx);
      } catch (error) {
        await this.show(ctx, renderAccountError(error, true), "edit");
      }
    });
  }

  private async requireOwnerPrivate(ctx: Context): Promise<boolean> {
    if (ctx.from?.id !== this.options.config.telegramOwnerUserId) {
      await ctx.answerCallbackQuery({ text: "Аккаунтом управляет владелец Коди" }).catch(() => {});
      return false;
    }
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({ text: "Вход доступен только в личном чате" }).catch(() => {});
      return false;
    }
    return true;
  }

  private async handleLoginCompletion(completion: CodexLoginCompletion): Promise<void> {
    const pending = this.pending ?? await this.readJournal();
    if (!pending || (completion.loginId && completion.loginId !== pending.loginId)) return;
    this.pending = null;
    await this.clearJournal();

    if (completion.success) {
      try {
        const state = await this.options.auth.read();
        const view = renderAccountView(state, true);
        await safeEditMessage(this.options.bot, pending.chatId, pending.messageId, view.html, {
          fallbackText: view.plain,
          replyMarkup: view.keyboard,
        });
        return;
      } catch {
        // Fall through to a generic success message: the account is still stored by Codex.
      }
    }

    const view = completion.success
      ? renderLoginSuccess()
      : renderLoginError(completion.error ?? "Не удалось завершить вход");
    await safeEditMessage(this.options.bot, pending.chatId, pending.messageId, view.html, {
      fallbackText: view.plain,
      replyMarkup: view.keyboard,
    }).catch(() => {});
  }

  private async show(ctx: Context, view: AccountView, mode: "reply" | "edit"): Promise<void> {
    if (mode === "edit" && ctx.callbackQuery?.message) {
      await this.options.showTextScreen(ctx, view.html, view.plain, view.keyboard);
      return;
    }
    await safeReply(ctx, view.html, { fallbackText: view.plain, replyMarkup: view.keyboard });
  }

  private async writeJournal(pending: PendingLoginMessage): Promise<void> {
    const directory = path.dirname(this.journalPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.auth-login.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
    await rename(temporary, this.journalPath);
  }

  private async readJournal(): Promise<PendingLoginMessage | null> {
    try {
      const parsed = JSON.parse(await readFile(this.journalPath, "utf8")) as PendingLoginMessage;
      if (
        typeof parsed.loginId !== "string"
        || !Number.isSafeInteger(parsed.chatId)
        || !Number.isSafeInteger(parsed.messageId)
      ) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async clearJournal(): Promise<void> {
    this.pending = null;
    await unlink(this.journalPath).catch(() => {});
  }
}

export function renderAccountView(state: CodexAuthState, isOwner: boolean): AccountView {
  if (!state.ready) {
    const description = isOwner
      ? "Войди через ChatGPT, чтобы Коди мог выполнять задачи"
      : "Codex ещё не подключён. Это может сделать владелец Коди";
    const keyboard = new InlineKeyboard();
    if (isOwner) {
      keyboard.text({ text: "Войти через ChatGPT", style: "primary" }, "auth:login").row();
    }
    keyboard.text("Назад", "menu:settings");
    return {
      html: `<b>Аккаунт Codex</b>\n\n${escapeHTML(description)}`,
      plain: `Аккаунт Codex\n\n${description}`,
      keyboard,
    };
  }

  const account = state.account;
  const details = account
    ? accountDetails(account, state.managedByApiKey)
    : ["Codex готов к работе", "Вход для выбранного провайдера не требуется"];
  const keyboard = new InlineKeyboard();
  if (isOwner && account && !state.managedByApiKey) {
    keyboard.text({ text: "Выйти", style: "danger" }, "auth:logout").row();
  }
  keyboard.text("Назад", "menu:settings");
  return {
    html: ["<b>Аккаунт Codex</b>", "", ...details.map(escapeHTML)].join("\n"),
    plain: ["Аккаунт Codex", "", ...details].join("\n"),
    keyboard,
  };
}

export function renderDeviceLoginView(verificationUrl: string, userCode: string): AccountView {
  const html = [
    "<b>Вход в Codex</b>",
    "",
    "Открой OpenAI и введи код",
    `<code>${escapeHTML(userCode)}</code>`,
  ].join("\n");
  const plain = `Вход в Codex\n\nОткрой OpenAI и введи код\n${userCode}`;
  const keyboard = new InlineKeyboard()
    .url({ text: "Открыть OpenAI", style: "primary" }, verificationUrl)
    .row()
    .text("Отменить", "auth:cancel");
  return { html, plain, keyboard };
}

function renderLogoutConfirmation(): AccountView {
  const text = "Коди не сможет выполнять задачи и автоматизации до следующего входа";
  return {
    html: `<b>Выйти из Codex?</b>\n\n${text}`,
    plain: `Выйти из Codex?\n\n${text}`,
    keyboard: new InlineKeyboard()
      .text({ text: "Выйти", style: "danger" }, "auth:logout:confirm")
      .row()
      .text("Назад", "settings:account"),
  };
}

function renderLoginSuccess(): AccountView {
  return {
    html: "<b>Готово</b>\n\nCodex подключён к ChatGPT",
    plain: "Готово\n\nCodex подключён к ChatGPT",
    keyboard: new InlineKeyboard().text("Настройки", "menu:settings"),
  };
}

function renderLoginError(error: unknown): AccountView {
  const message = error instanceof Error ? error.message : String(error);
  return {
    html: `<b>Не удалось войти в Codex</b>\n\n${escapeHTML(message)}`,
    plain: `Не удалось войти в Codex\n\n${message}`,
    keyboard: new InlineKeyboard()
      .text({ text: "Попробовать ещё раз", style: "primary" }, "auth:login")
      .row()
      .text("Назад", "settings:account"),
  };
}

function renderAccountError(error: unknown, isOwner: boolean): AccountView {
  const message = error instanceof Error ? error.message : String(error);
  const keyboard = new InlineKeyboard();
  if (isOwner) keyboard.text({ text: "Повторить", style: "primary" }, "settings:account").row();
  keyboard.text("Назад", "menu:settings");
  return {
    html: `<b>Аккаунт Codex</b>\n\nНе удалось проверить вход\n${escapeHTML(message)}`,
    plain: `Аккаунт Codex\n\nНе удалось проверить вход\n${message}`,
    keyboard,
  };
}

function accountDetails(account: CodexAccount, managedByApiKey: boolean): string[] {
  if (managedByApiKey || account.type === "apiKey") {
    return ["OpenAI API", "Авторизация управляется настройками сервера"];
  }
  const plan = account.planType ? formatPlan(account.planType) : "ChatGPT";
  return [plan, ...(account.email ? [account.email] : [])];
}

function formatPlan(planType: string): string {
  const normalized = planType.trim().toLowerCase();
  const labels: Record<string, string> = {
    free: "ChatGPT Free",
    plus: "ChatGPT Plus",
    pro: "ChatGPT Pro",
    team: "ChatGPT Team",
    business: "ChatGPT Business",
    enterprise: "ChatGPT Enterprise",
    edu: "ChatGPT Edu",
  };
  return labels[normalized] ?? `ChatGPT ${planType}`;
}
