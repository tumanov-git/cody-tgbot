import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import path from "node:path";

import {
  buildMainMenuKeyboard,
  MAIN_MENU_DESCRIPTION,
  MAIN_MENU_TITLE,
  pickMainMenuImageName,
  renderDialogs,
  renderProjects,
} from "./bot-ui.js";
import type { AutomationScheduler } from "./automation-scheduler.js";
import type { AutomationStore } from "./automation-store.js";
import { registerAutomationUi } from "./automation-ui.js";
import type { CodyConfig } from "./config.js";
import { CodexAuthUi } from "./codex-auth-ui.js";
import { registerCodexSettingsUi } from "./codex-settings-ui.js";
import { contextKeyFromCtx } from "./context-key.js";
import { escapeHTML } from "./format.js";
import type { ManagedBotService } from "./managed-bots.js";
import type { ProjectWorkLock } from "./project-work-lock.js";
import { ProjectStore, type ProjectRecord } from "./project-store.js";
import {
  buildPublicAccessKeyboard,
  PUBLIC_ACCESS_CAPTION,
  PUBLIC_ACCESS_FALLBACK,
  PublicAccessCooldown,
} from "./public-access.js";
import { SessionRegistry } from "./session-registry.js";
import { TaskController } from "./task-controller.js";
import { registerTelegramInputRoutes } from "./telegram-input-router.js";
import type { MediaGroupController } from "./media-groups.js";
import { safeEditMessage, safeReply } from "./telegram-api.js";

const MENU_CALLBACK_PREFIX = "menu:";
const MENU_ASSET_DIRECTORY = path.resolve(process.cwd(), "assets/cody/menu");
const DIALOGS_MENU_IMAGE = path.join(MENU_ASSET_DIRECTORY, "dialogs.png");
const PROJECTS_MENU_IMAGE = path.join(MENU_ASSET_DIRECTORY, "projects.png");
const PUBLIC_ACCESS_IMAGE = path.join(MENU_ASSET_DIRECTORY, "home-2.png");

export type CodyBot = Bot<Context> & {
  codyTasks: TaskController;
  codyMediaGroups: MediaGroupController;
  codyAuth: CodexAuthUi;
};

export function createBot(
  config: CodyConfig,
  registry: SessionRegistry,
  projectStore?: ProjectStore,
  managedBots?: ManagedBotService,
  automationStore?: AutomationStore,
  automationScheduler?: AutomationScheduler,
  projectWorkLock?: ProjectWorkLock,
): CodyBot {
  const bot = new Bot<Context>(config.telegramBotToken, {
    client: { apiRoot: config.telegramApiRoot },
  }) as CodyBot;
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));
  const publicAccessCooldown = new PublicAccessCooldown();

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery().catch(() => {});
      }
      const publicId = fromId ?? ctx.chat?.id;
      if (ctx.chat && publicId && publicAccessCooldown.shouldSend(publicId)) {
        try {
          await ctx.replyWithPhoto(new InputFile(PUBLIC_ACCESS_IMAGE), {
            caption: PUBLIC_ACCESS_CAPTION,
            parse_mode: "HTML",
            reply_markup: buildPublicAccessKeyboard(),
          });
        } catch {
          await safeReply(ctx, PUBLIC_ACCESS_CAPTION, {
            fallbackText: PUBLIC_ACCESS_FALLBACK,
            replyMarkup: buildPublicAccessKeyboard(),
          }).catch(() => {});
        }
      }
      return;
    }

    await next();
  });

  const tasks = new TaskController(bot, config, registry, managedBots, undefined, projectWorkLock);
  bot.codyTasks = tasks;

  bot.callbackQuery(/^(?:menu:|settings:|dialog:|project:|automation:)/, async (ctx, next) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (contextKey && tasks.isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Сначала закончу текущую задачу" }).catch(() => {});
      return;
    }
    await next();
  });

  const showPhotoScreen = async (
    ctx: Context,
    imagePath: string,
    caption: string,
    keyboard: InlineKeyboard,
    mode: "reply" | "edit" = "edit",
  ): Promise<void> => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    const source = new InputFile(imagePath);
    if (mode === "edit" && chatId && messageId) {
      await bot.api.editMessageMedia(chatId, messageId, {
        type: "photo",
        media: source,
        caption,
        parse_mode: "HTML",
      }, { reply_markup: keyboard });
      return;
    }
    await ctx.replyWithPhoto(source, {
      caption,
      parse_mode: "HTML",
      reply_markup: keyboard,
      ...(ctx.message?.message_thread_id
        ? { message_thread_id: ctx.message.message_thread_id }
        : {}),
    });
  };

  const showTextScreen = async (
    ctx: Context,
    html: string,
    plain: string,
    keyboard: InlineKeyboard,
  ): Promise<void> => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (!chatId || !messageId) return;
    if (ctx.callbackQuery?.message && "photo" in ctx.callbackQuery.message) {
      await safeReply(ctx, html, { fallbackText: plain, replyMarkup: keyboard });
      await bot.api.deleteMessage(chatId, messageId).catch(() => {});
      return;
    }
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: plain,
      replyMarkup: keyboard,
    });
  };

  const showMenu = async (ctx: Context, mode: "reply" | "edit" = "reply"): Promise<void> => {
    const html = `<b>${MAIN_MENU_TITLE}</b>\n\n${MAIN_MENU_DESCRIPTION}`;
    const keyboard = buildMainMenuKeyboard();
    const imagePath = path.join(MENU_ASSET_DIRECTORY, pickMainMenuImageName());
    await showPhotoScreen(ctx, imagePath, html, keyboard, mode);
  };

  const authUi = new CodexAuthUi({
    bot,
    config,
    auth: registry.auth,
    showTextScreen,
    isBusy: () => tasks.hasAnyWork()
      || Boolean(automationScheduler && (
        automationScheduler.getHealth().activeWorkers > 0
        || automationScheduler.getHealth().queuedClaims > 0
      )),
  });
  bot.codyAuth = authUi;

  const showProjects = async (ctx: Context, requestedPage: number): Promise<void> => {
    if (!projectStore) {
      await ctx.answerCallbackQuery({ text: "Проекты пока недоступны" }).catch(() => {});
      return;
    }
    const { projects, unreadableIds } = await projectStore.listWithIssues();
    const view = renderProjects(projects, requestedPage, unreadableIds.length);
    await showPhotoScreen(ctx, PROJECTS_MENU_IMAGE, view.text.html, view.keyboard);
  };

  const showDialogs = async (ctx: Context, requestedPage: number): Promise<void> => {
    const contextKey = contextKeyFromCtx(ctx);
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (!contextKey || !chatId || !messageId) return;
    const dialogs = await registry.listDialogs(contextKey);
    const view = renderDialogs(dialogs, requestedPage);
    await showPhotoScreen(ctx, DIALOGS_MENU_IMAGE, view.text.html, view.keyboard);
  };

  const showProject = async (
    ctx: Context,
    project: ProjectRecord,
    projectsPage: number,
  ): Promise<void> => {
    const details = [
      `<b>${escapeHTML(project.name)}</b>`,
      "",
      escapeHTML(project.description),
    ];
    if (project.urls.length > 0) {
      details.push("", project.urls.map((url) => escapeHTML(url)).join("\n"));
    }
    const keyboard = new InlineKeyboard()
      .text(
        { text: "Обсудить проект", style: "primary" },
        `project:discuss:${project.id}:${projectsPage}`,
      )
      .row()
      .text(
        { text: "Автоматизации", style: "primary" },
        `project:automations:${project.id}:0`,
      )
      .row()
      .text("Назад", `${MENU_CALLBACK_PREFIX}projects:${projectsPage}`);
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (!chatId || !messageId) return;
    const hasAvatar = project.avatar?.telegramFileId
      || await projectStore!.hasTelegramAvatar(project.id);
    if (hasAvatar) {
      const source = project.avatar?.telegramFileId
        ?? new InputFile(projectStore!.avatarTelegramPath(project.id));
      try {
        const edited = await bot.api.editMessageMedia(chatId, messageId, {
          type: "photo",
          media: source,
          caption: details.join("\n"),
          parse_mode: "HTML",
        }, { reply_markup: keyboard });
        const telegramFileId = edited === true ? undefined : edited.photo?.at(-1)?.file_id;
        if (telegramFileId && telegramFileId !== project.avatar?.telegramFileId) {
          await projectStore!.updateAvatar(project.id, { telegramFileId });
        }
        return;
      } catch (error) {
        console.warn(
          `Failed to send project avatar ${project.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    await showTextScreen(
      ctx,
      details.join("\n"),
      [project.name, "", project.description, ...project.urls].join("\n"),
      keyboard,
    );
  };

  bot.command("menu", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (contextKey && tasks.isBusy(contextKey)) return;
    await showMenu(ctx);
  });

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    try {
      if (!await authUi.isReady()) {
        await authUi.showAccount(ctx, "reply");
        return;
      }
    } catch {
      await authUi.showAccount(ctx, "reply");
      return;
    }
    await showMenu(ctx);
  });

  bot.command("plan", async (ctx) => {
    if (!await authUi.requireReady(ctx)) return;
    const task = ctx.match.trim();
    if (!task) {
      await safeReply(ctx, "Напиши задачу после <code>/plan</code>", {
        fallbackText: "Напиши задачу после /plan",
      });
      return;
    }
    const contextSession = await tasks.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession || !ctx.chat) return;
    await tasks.enqueue(
      ctx,
      contextSession.contextKey,
      ctx.chat.id,
      contextSession.session,
      task,
      { executionMode: "plan", queueDisplayText: task },
    );
  });

  bot.command("review", async (ctx) => {
    if (!await authUi.requireReady(ctx)) return;
    const instructions = ctx.match.trim();
    const contextSession = await tasks.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession || !ctx.chat) return;
    await tasks.enqueue(
      ctx,
      contextSession.contextKey,
      ctx.chat.id,
      contextSession.session,
      instructions,
      {
        executionMode: "review",
        queueDisplayText: instructions || "Проверить текущие изменения",
      },
    );
  });

  registerCodexSettingsUi({ bot, registry, automationScheduler, showTextScreen });

  bot.callbackQuery(`${MENU_CALLBACK_PREFIX}home`, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMenu(ctx, "edit");
  });

  bot.callbackQuery(/^menu:projects:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showProjects(ctx, Number(ctx.match?.[1] ?? 0));
  });

  bot.callbackQuery(/^menu:dialogs:(\d+)$/, async (ctx) => {
    if (!await authUi.requireReady(ctx)) return;
    await ctx.answerCallbackQuery();
    await showDialogs(ctx, Number(ctx.match?.[1] ?? 0));
  });

  bot.callbackQuery("dialog:new", async (ctx) => {
    if (!await authUi.requireReady(ctx)) return;
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }
    await registry.startNewDialog(contextKey);
    await ctx.answerCallbackQuery({ text: "Новый диалог готов" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;
    const html = "<b>Новый диалог готов.</b>\n\nНапиши, что хочешь сделать.";
    await showTextScreen(
      ctx,
      html,
      "Новый диалог готов.\n\nНапиши, что хочешь сделать.",
      new InlineKeyboard()
        .text("К диалогам", `${MENU_CALLBACK_PREFIX}dialogs:0`)
        .row()
        .text("Меню", `${MENU_CALLBACK_PREFIX}home`),
    );
  });

  bot.callbackQuery(/^dialog:open:([a-z0-9-]+):(\d+)$/, async (ctx) => {
    if (!await authUi.requireReady(ctx)) return;
    const contextKey = contextKeyFromCtx(ctx);
    const threadId = ctx.match?.[1];
    const page = Number(ctx.match?.[2] ?? 0);
    if (!contextKey || !threadId) {
      await ctx.answerCallbackQuery();
      return;
    }
    const dialog = (await registry.listDialogs(contextKey))
      .find((candidate) => candidate.threadId === threadId);
    if (!dialog) {
      await ctx.answerCallbackQuery({ text: "Диалог не найден" }).catch(() => {});
      await showDialogs(ctx, page);
      return;
    }
    await registry.switchDialog(contextKey, threadId);
    await ctx.answerCallbackQuery({ text: "Диалог открыт" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;
    const html = `<b>${escapeHTML(dialog.title)}</b>\n\nДиалог открыт. Можно продолжать.`;
    await showTextScreen(
      ctx,
      html,
      `${dialog.title}\n\nДиалог открыт. Можно продолжать.`,
      new InlineKeyboard()
        .text("К диалогам", `${MENU_CALLBACK_PREFIX}dialogs:${page}`)
        .row()
        .text("Меню", `${MENU_CALLBACK_PREFIX}home`),
    );
  });

  bot.callbackQuery(/^project:view:([a-z0-9-]+):(\d+)$/, async (ctx) => {
    const page = Number(ctx.match?.[2] ?? 0);
    const project = projectStore ? await projectStore.get(ctx.match?.[1] ?? "") : null;
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Проект не найден" }).catch(() => {});
      await showProjects(ctx, page);
      return;
    }
    await ctx.answerCallbackQuery();
    await showProject(ctx, project, page);
  });

  bot.callbackQuery("project:new", async (ctx) => {
    if (!await authUi.requireReady(ctx)) return;
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }
    await registry.startNewDialog(contextKey);
    await ctx.answerCallbackQuery({ text: "Можно начинать" });

    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;
    const html = [
      "<b>Что хочешь сделать?</b>",
      "",
      "Расскажи идею своими словами. Когда проект появится по-настоящему, Коди добавит его в «Мои проекты».",
    ].join("\n");
    await showTextScreen(
      ctx,
      html,
      "Что хочешь сделать?\n\nРасскажи идею своими словами. Когда проект появится по-настоящему, Коди добавит его в «Мои проекты».",
      new InlineKeyboard()
        .text("К проектам", `${MENU_CALLBACK_PREFIX}projects:0`)
        .row()
        .text("Меню", `${MENU_CALLBACK_PREFIX}home`),
    );
  });

  bot.callbackQuery(/^project:discuss:([a-z0-9-]+):(\d+)$/, async (ctx) => {
    if (!await authUi.requireReady(ctx)) return;
    if (!projectStore) {
      await ctx.answerCallbackQuery({ text: "Проекты пока недоступны" }).catch(() => {});
      return;
    }
    const page = Number(ctx.match?.[2] ?? 0);
    const project = await projectStore.get(ctx.match?.[1] ?? "");
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Проект не найден" }).catch(() => {});
      return;
    }
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }
    const contextSession = await tasks.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      await ctx.answerCallbackQuery({ text: "Не удалось создать диалог" }).catch(() => {});
      return;
    }
    const initialContext = await projectStore.renderDiscussionContext(project.id);
    await contextSession.session.newThread(project.workspace, initialContext);
    registry.updateMetadata(contextKey, contextSession.session);
    await ctx.answerCallbackQuery({ text: "Новый диалог готов" });

    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) return;
    const html = [
      `<b>Диалог о «${escapeHTML(project.name)}» готов.</b>`,
      "",
      "Контекст подмешан. Напиши, что хочешь обсудить.",
    ].join("\n");
    await showTextScreen(
      ctx,
      html,
      `Диалог о «${project.name}» готов.\n\nКонтекст подмешан. Напиши, что хочешь обсудить.`,
      new InlineKeyboard()
        .text("К проекту", `project:view:${project.id}:${page}`)
        .row()
        .text("Меню", `${MENU_CALLBACK_PREFIX}home`),
    );
  });

  if (projectStore && automationStore && automationScheduler) {
    registerAutomationUi({
      bot,
      config,
      registry,
      projectStore,
      store: automationStore,
      scheduler: automationScheduler,
      menuImagePath: PROJECTS_MENU_IMAGE,
      showPhotoScreen,
      showTextScreen,
    });
  }

  bot.callbackQuery(`${MENU_CALLBACK_PREFIX}close`, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) {
      return;
    }
    await bot.api.deleteMessage(chatId, messageId).catch(() => {});
  });

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Останавливать нечего" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Останавливаю..." });
    await session.abort();
  });

  bot.callbackQuery(/^queue_steer:(task-[a-z0-9-]+)$/, async (ctx) => {
    const taskId = ctx.match?.[1];
    const contextKey = contextKeyFromCtx(ctx);
    if (!taskId || !contextKey) {
      await ctx.answerCallbackQuery({ text: "Эта задача уже запущена или устарела" }).catch(() => {});
      return;
    }
    await tasks.steerQueued(ctx, taskId, contextKey);
  });

  bot.callbackQuery(/^queue_cancel:(task-[a-z0-9-]+)$/, async (ctx) => {
    const taskId = ctx.match?.[1];
    const contextKey = contextKeyFromCtx(ctx);
    if (!taskId || !contextKey) {
      await ctx.answerCallbackQuery({ text: "Эта задача уже запущена или отменена" }).catch(() => {});
      return;
    }
    await tasks.cancelQueued(ctx, taskId, contextKey);
  });

  tasks.interactions.register();

  bot.use(async (ctx, next) => {
    const message = ctx.message;
    if (!message) {
      await next();
      return;
    }
    if (message.text?.trim().startsWith("/")) {
      await next();
      return;
    }
    if (!await authUi.requireReady(ctx)) return;
    await next();
  });

  bot.on("managed_bot", async (ctx) => {
    if (!managedBots || !ctx.managedBot) return;
    try {
      const completion = await managedBots.complete(ctx.managedBot);
      if (!completion) return;
      if (completion.buttonMessageId) {
        await bot.api.editMessageReplyMarkup(
          completion.chatId,
          completion.buttonMessageId,
          { reply_markup: new InlineKeyboard() },
        ).catch(() => {});
      }

      const session = await registry.getOrCreate(completion.contextKey, { deferThreadStart: true });
      const botLabel = completion.botUsername
        ? `@${completion.botUsername}`
        : `Telegram-бот ${completion.botId}`;
      const prompt = [
        "[Системное событие Коди]",
        `Пользователь подтвердил создание ${botLabel} для проекта «${completion.projectName}» (${completion.projectId}).`,
        `Токен безопасно сохранён приложением в ${completion.secretFilePath}.`,
        "Не выводи и не пересказывай токен. Подключи этот файл как источник секретов проекта, заверши развёртывание, проверь работу бота и сообщи пользователю результат.",
      ].join("\n");
      await tasks.enqueue(
        ctx,
        completion.contextKey,
        completion.chatId,
        session,
        prompt,
        {
          resumeThreadId: completion.threadId,
          queueDisplayText: `Подключить ${botLabel} к проекту «${completion.projectName}»`,
        },
      );
    } catch (error) {
      console.error(
        "Managed bot completion failed:",
        error instanceof Error ? error.message : String(error),
      );
      const ownerId = ctx.managedBot.user.id;
      await bot.api.sendMessage(
        ownerId,
        "Не удалось подключить созданного бота к проекту. Сам бот сохранён в Telegram; попробуй ещё раз чуть позже.",
      ).catch(() => {});
    }
  });

  bot.codyMediaGroups = registerTelegramInputRoutes(bot, config, tasks);

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.deleteMyCommands();
  await bot.api.deleteMyCommands({ scope: { type: "all_private_chats" } });
  await bot.api.deleteMyCommands({ scope: { type: "all_group_chats" } });
  await bot.api.deleteMyCommands({ scope: { type: "all_chat_administrators" } });
  await bot.api.setMyCommands([
    { command: "menu", description: "Открыть меню" },
  ]);
}
