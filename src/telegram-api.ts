import { randomUUID } from "node:crypto";
import { copyFile, open, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Bot, type Context, type InlineKeyboard } from "grammy";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const RICH_MESSAGE_CHUNK_TARGET = 30_000;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;

export type TelegramChatId = number | string;
type TelegramParseMode = "HTML";

export interface TelegramDownloadOptions {
  apiRoot?: string;
  maxBytes?: number;
}

export type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

export async function safeReply(
  ctx: Context,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const parseMode = options.parseMode !== undefined ? options.parseMode : "HTML";
  const messageThreadId =
    options.messageThreadId ??
    ctx.message?.message_thread_id ??
    ctx.callbackQuery?.message?.message_thread_id;
  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
    });
  }
}

export async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode")
    ? options.parseMode
    : "HTML";
  const safeText = redactSecrets(text);
  const safeFallbackText =
    options.fallbackText === undefined ? undefined : redactSecrets(options.fallbackText);

  try {
    return await api.sendMessage(chatId, safeText, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (parseMode && safeFallbackText !== undefined && isTelegramParseError(error)) {
      return api.sendMessage(chatId, safeFallbackText, {
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      });
    }
    throw error;
  }
}

export async function sendRichFinalMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  markdown: string,
  options: Pick<TextOptions, "messageThreadId" | "replyMarkup"> = {},
): Promise<{ message_id: number }> {
  return api.sendRichMessage(
    chatId,
    { markdown: redactSecrets(markdown) },
    {
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    },
  );
}

export async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode")
    ? options.parseMode
    : "HTML";
  const safeText = redactSecrets(text);
  const safeFallbackText =
    options.fallbackText === undefined ? undefined : redactSecrets(options.fallbackText);

  try {
    await bot.api.editMessageText(chatId, messageId, safeText, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) return;
    if (parseMode && safeFallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(chatId, messageId, safeFallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }
    throw error;
  }
}

export async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  options: TelegramDownloadOptions = { maxBytes: MAX_AUDIO_FILE_SIZE },
): Promise<string> {
  const maxBytes = options.maxBytes === undefined ? MAX_AUDIO_FILE_SIZE : options.maxBytes;
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram не вернул путь к файлу");
  if (maxBytes > 0 && file.file_size && file.file_size > maxBytes) {
    throw fileTooLargeError(file.file_size);
  }

  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `cody-tgbot-file-${randomUUID()}${extension}`);
  if (path.isAbsolute(file.file_path)) {
    const sourceSize = (await stat(file.file_path)).size;
    if (maxBytes > 0 && sourceSize > maxBytes) throw fileTooLargeError(sourceSize);
    await copyFile(file.file_path, tempPath);
    return tempPath;
  }

  const apiRoot = (options.apiRoot ?? "https://api.telegram.org").replace(/\/$/, "");
  const response = await fetch(`${apiRoot}/file/bot${token}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`Не удалось скачать файл из Telegram: ${response.status}`);
  }
  if (!response.body) throw new Error("Telegram вернул пустой файл");

  const handle = await open(tempPath, "wx", 0o600);
  let receivedBytes = 0;
  let complete = false;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (maxBytes > 0 && receivedBytes > maxBytes) {
        await reader.cancel();
        throw fileTooLargeError(receivedBytes);
      }
      await handle.write(value);
    }
    complete = true;
    return tempPath;
  } finally {
    await handle.close();
    if (!complete) await unlink(tempPath).catch(() => {});
  }
}

function fileTooLargeError(sizeBytes: number): Error {
  return new Error(
    `Файл Telegram превышает настроенный предел (${Math.ceil(sizeBytes / 1024 / 1024)} MB)`,
  );
}

export function splitRichMarkdownForTelegram(markdown: string): string[] {
  if (!markdown) return [];

  const chunks: string[] = [];
  let remaining = markdown;
  while (remaining) {
    const maxLength = Math.min(remaining.length, RICH_MESSAGE_CHUNK_TARGET);
    const initialCut = findPreferredSplitIndex(remaining, maxLength);
    const chunk = remaining.slice(0, initialCut).trimEnd() || remaining.slice(0, 1);
    chunks.push(chunk);
    remaining = remaining.slice(initialCut).trimStart();
  }
  return chunks;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\b\d{6,14}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-secret]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted-secret]")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[redacted-secret]");
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) cut = TELEGRAM_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length > 0 ? chunks : [""];
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) return Math.max(1, text.length);
  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) return Math.max(1, newlineIndex);
  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) return Math.max(1, spaceIndex);
  return Math.max(1, maxLength);
}

function isMessageNotModifiedError(error: unknown): boolean {
  return formatError(error).includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}
