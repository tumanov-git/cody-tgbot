import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import type { Bot, Context } from "grammy";

import {
  buildFileInstructions,
  inboxPath,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import { ensureOutDir } from "./artifacts.js";
import type { CodexPromptInput } from "./codex-session.js";
import type { CodyConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML, PREMIUM_EMOJI, renderPremiumEmoji } from "./format.js";
import { MediaGroupController } from "./media-groups.js";
import { maybeReactToMessage } from "./message-reaction.js";
import { TaskController } from "./task-controller.js";
import {
  downloadTelegramFile,
  safeEditMessage,
  safeReply,
  sendTextMessage,
} from "./telegram-api.js";
import {
  extractTelegramRichMessageText,
  withTelegramMessageContext,
} from "./telegram-message-context.js";
import { buildVoiceAgentPrompt, transcribeAudio } from "./voice.js";

export function registerTelegramInputRoutes(
  bot: Bot<Context>,
  config: CodyConfig,
  tasks: TaskController,
): MediaGroupController {
  const mediaGroups = new MediaGroupController(bot, config, tasks);
  let voiceQueueDepth = 0;
  let voiceQueueTail: Promise<void> = Promise.resolve();
  const voiceJobsPerContext = new Map<string, number>();

  const incrementVoiceJobs = (contextKey: string): void => {
    const count = (voiceJobsPerContext.get(contextKey) ?? 0) + 1;
    voiceJobsPerContext.set(contextKey, count);
    tasks.getBusyState(contextKey).transcribing = true;
  };

  const decrementVoiceJobs = (contextKey: string): void => {
    const count = Math.max(0, (voiceJobsPerContext.get(contextKey) ?? 1) - 1);
    if (count === 0) voiceJobsPerContext.delete(contextKey);
    else voiceJobsPerContext.set(contextKey, count);
    tasks.getBusyState(contextKey).transcribing = count > 0;
  };

  bot.on("message:text", async (ctx) => {
    const contextSession = await tasks.getContextSession(ctx);
    if (!contextSession) return;
    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) return;
    maybeReactToMessage(ctx, userText);
    const { contextKey, session } = contextSession;
    const promptInput = withTelegramMessageContext(userText, ctx.message);
    await tasks.enqueueUserInput(ctx, contextKey, ctx.chat.id, session, promptInput, {
      queueDisplayText: userText,
    });
  });

  bot.on("message:rich_message", async (ctx) => {
    const contextSession = await tasks.getContextSession(ctx);
    if (!contextSession) return;
    const userText = extractTelegramRichMessageText(ctx.message.rich_message)?.trim();
    if (!userText) {
      await safeReply(ctx, "Не смог прочитать содержимое сообщения. Попробуй отправить его обычным текстом.", {
        fallbackText: "Не смог прочитать содержимое сообщения. Попробуй отправить его обычным текстом.",
      });
      return;
    }
    maybeReactToMessage(ctx, userText);
    const { contextKey, session } = contextSession;
    const promptInput = withTelegramMessageContext(userText, ctx.message);
    await tasks.enqueueUserInput(ctx, contextKey, ctx.chat.id, session, promptInput, {
      queueDisplayText: userText,
    });
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const contextSession = await tasks.getContextSession(ctx);
    if (!contextSession) return;
    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) return;

    const queued = voiceQueueDepth > 0;
    voiceQueueDepth += 1;
    incrementVoiceJobs(contextKey);
    const previousJob = voiceQueueTail;
    let releaseSlot!: () => void;
    voiceQueueTail = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });

    const waitingText = queued ? "Голосовое в очереди." : "Расшифровываю аудио...";
    let statusMessage: { message_id: number };
    try {
      statusMessage = await sendTextMessage(
        ctx.api,
        chatId,
        `${renderPremiumEmoji(PREMIUM_EMOJI.voice, "🎤")} ${waitingText}`,
        {
          fallbackText: waitingText,
          messageThreadId: ctx.message.message_thread_id,
        },
      );
    } catch (error) {
      voiceQueueDepth -= 1;
      decrementVoiceJobs(contextKey);
      releaseSlot();
      throw error;
    }

    void (async () => {
      let tempFilePath: string | undefined;
      let transcript: string | undefined;
      await previousJob.catch(() => {});
      try {
        if (queued) {
          await safeEditMessage(
            bot,
            chatId,
            statusMessage.message_id,
            `${renderPremiumEmoji(PREMIUM_EMOJI.voice, "🎤")} Расшифровываю аудио...`,
            { fallbackText: "Расшифровываю аудио..." },
          );
        }
        await ctx.api.sendChatAction(chatId, "typing");
        tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId, {
          apiRoot: config.telegramApiRoot,
          maxBytes: config.maxFileSize,
        });
        transcript = (await transcribeAudio(tempFilePath)).text.trim();
        if (!transcript) {
          throw new Error("Распознавание вернуло пустой текст. Попробуй ещё раз или отправь текстом.");
        }
        maybeReactToMessage(ctx, transcript);
        await bot.api.deleteMessage(chatId, statusMessage.message_id).catch(() => {});
        await safeReply(
          ctx,
          [
            `${renderPremiumEmoji(PREMIUM_EMOJI.voice, "🎤")} <b>Запрос:</b>`,
            "",
            `<blockquote>${escapeHTML(transcript)}</blockquote>`,
          ].join("\n"),
          { fallbackText: `Запрос:\n\n${transcript}` },
        );
      } catch (error) {
        const message = friendlyErrorText(error);
        await safeEditMessage(
          bot,
          chatId,
          statusMessage.message_id,
          `${renderPremiumEmoji(PREMIUM_EMOJI.sad, "😕")} <b>Не удалось распознать голос:</b>\n${escapeHTML(message)}`,
          { fallbackText: `Не удалось распознать голос:\n${message}` },
        ).catch(() => {});
      } finally {
        if (tempFilePath) await unlink(tempFilePath).catch(() => {});
        voiceQueueDepth = Math.max(0, voiceQueueDepth - 1);
        decrementVoiceJobs(contextKey);
        releaseSlot();
      }

      if (!transcript) return;
      const contextualTranscript = withTelegramMessageContext(transcript, ctx.message, {
        attachmentLabel: ctx.message.voice ? "голосовое сообщение" : "аудиофайл",
      });
      await tasks.enqueueUserInput(
        ctx,
        contextKey,
        chatId,
        session,
        buildVoiceAgentPrompt(contextualTranscript),
        { queueDisplayText: transcript },
      );
    })().catch((error) => {
      console.error("Voice transcription queue failed:", friendlyErrorText(error));
    });
  });

  bot.on("message:photo", async (ctx) => {
    const contextSession = await tasks.getContextSession(ctx);
    if (!contextSession) return;
    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    if (ctx.message.media_group_id) {
      await mediaGroups.accept(ctx, contextKey, ctx.message.media_group_id, photo.file_id);
      return;
    }

    const busyState = tasks.getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;
    try {
      await ctx.api.sendChatAction(chatId, "upload_photo");
      tempFilePath = await downloadTelegramFile(
        ctx.api,
        config.telegramBotToken,
        photo.file_id,
        { apiRoot: config.telegramApiRoot, maxBytes: config.maxFileSize },
      );
    } catch (error) {
      await safeReply(ctx, `<b>Не удалось скачать фото:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Не удалось скачать фото: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }
    const promptInput: { text?: string; imagePaths: string[] } = { imagePaths: [tempFilePath] };
    const caption = ctx.message.caption?.trim();
    if (caption) promptInput.text = caption;
    const contextualPrompt = withTelegramMessageContext(promptInput, ctx.message, {
      attachmentLabel: "фотография",
    });
    await tasks.enqueueUserInput(ctx, contextKey, chatId, session, contextualPrompt, {
      queueDisplayText: caption || "Фотография",
      cleanupPaths: [tempFilePath],
    });
  });

  bot.on("message:sticker", async (ctx) => {
    const sticker = ctx.message.sticker;
    if (sticker.is_animated || sticker.is_video) {
      await safeReply(ctx, "Извини, такие стикеры я пока не вижу. Обычные понимаю.", {
        fallbackText: "Извини, такие стикеры я пока не вижу. Обычные понимаю.",
      });
      return;
    }

    const contextSession = await tasks.getContextSession(ctx);
    if (!contextSession) return;
    const { contextKey, session } = contextSession;
    const busyState = tasks.getBusyState(contextKey);
    busyState.transcribing = true;
    let temporary: string | undefined;
    try {
      temporary = await downloadTelegramFile(
        ctx.api,
        config.telegramBotToken,
        sticker.file_id,
        { apiRoot: config.telegramApiRoot, maxBytes: config.maxFileSize },
      );
    } catch (error) {
      await safeReply(ctx, `<b>Не удалось скачать стикер:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Не удалось скачать стикер: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }

    const prompt = withTelegramMessageContext(
      { imagePaths: [temporary] },
      ctx.message,
      { attachmentLabel: "статичный стикер" },
    );
    await tasks.enqueueUserInput(ctx, contextKey, ctx.chat.id, session, prompt, {
      queueDisplayText: "Стикер",
      cleanupPaths: [temporary],
    });
  });

  bot.on(["message:video", "message:video_note"], async (ctx) => {
    await safeReply(ctx, "Извини, видео я пока не смотрю. Кинь нужный кадр или голосовое — с ними разберусь.", {
      fallbackText: "Извини, видео я пока не смотрю. Кинь нужный кадр или голосовое — с ними разберусь.",
    });
  });

  bot.on("message:animation", async (ctx) => {
    await safeReply(ctx, "Извини, анимации я пока не вижу. Кинь стоп-кадр.", {
      fallbackText: "Извини, анимации я пока не вижу. Кинь стоп-кадр.",
    });
  });

  bot.on("message:document", async (ctx) => {
    const contextSession = await tasks.getContextSession(ctx);
    if (!contextSession) return;
    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    const doc = ctx.message.document;
    if (!doc) return;
    const busyState = tasks.getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;
    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(
        ctx.api,
        config.telegramBotToken,
        doc.file_id,
        { apiRoot: config.telegramApiRoot, maxBytes: config.maxFileSize },
      );
    } catch (error) {
      await safeReply(ctx, `<b>Не удалось скачать файл:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Не удалось скачать файл: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    let stagedFile: StagedFile;
    try {
      stagedFile = await stageFile(
        tempFilePath,
        doc.file_name ?? "document",
        doc.mime_type ?? "application/octet-stream",
        { workspace: config.workspace, turnId, maxFileSize: config.maxFileSize },
      );
    } catch (error) {
      await safeReply(ctx, `<b>Не удалось подготовить файл:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Не удалось подготовить файл: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      if (tempFilePath) await unlink(tempFilePath).catch(() => {});
    }

    await safeReply(ctx, `${renderPremiumEmoji(PREMIUM_EMOJI.received, "😊")} <b>Получил:</b> <code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `Получил: ${stagedFile.safeName}`,
    });
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});
    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);
    const promptInput: CodexPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile], outDir),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) promptInput.text = caption;
    const contextualPrompt = withTelegramMessageContext(promptInput, ctx.message, {
      attachmentLabel: `документ «${stagedFile.safeName}»`,
    });
    await tasks.enqueueUserInput(ctx, contextKey, chatId, session, contextualPrompt, {
      turnId,
      outDir,
      queueDisplayText: caption || doc.file_name || "Документ",
      cleanupPaths: [inboxPath(config.workspace, turnId)],
    });
  });

  return mediaGroups;
}
