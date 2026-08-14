import { unlink } from "node:fs/promises";
import path from "node:path";

import type { Context } from "grammy";
import type { Message, MessageEntity, RichMessage, Sticker } from "grammy/types";

import { stageFile } from "./attachments.js";
import { downloadTelegramFile } from "./telegram-api.js";

const MAX_CUSTOM_EMOJI_VISUALS = 20;

export interface TelegramCustomEmoji {
  id: string;
  alternativeText: string;
}

export interface TelegramTextLink {
  text: string;
  url: string;
}

export interface TelegramRichContent {
  plainText: string;
  customEmojis: TelegramCustomEmoji[];
  links: TelegramTextLink[];
}

export interface StagedCustomEmoji {
  id: string;
  alternativeText: string;
  localPath: string;
}

export function extractTelegramMessageContent(message: Message): TelegramRichContent {
  if (message.text !== undefined) {
    return extractEntityContent(message.text, message.entities);
  }
  if (message.caption !== undefined) {
    return extractEntityContent(message.caption, message.caption_entities);
  }
  return extractTelegramRichContent(message.rich_message);
}

export function extractTelegramRichContent(value: RichMessage | undefined): TelegramRichContent {
  if (!value) return emptyContent();
  const state = emptyContent();
  state.plainText = extractRichBlocks(value.blocks, state).trim();
  state.customEmojis = uniqueCustomEmojis(state.customEmojis);
  state.links = uniqueLinks(state.links);
  return state;
}

export function renderTelegramRichContent(
  content: TelegramRichContent,
  staged: StagedCustomEmoji[] = [],
): string {
  const text = content.plainText.trim();
  if (content.customEmojis.length === 0 && content.links.length === 0) return text;
  const stagedById = new Map(staged.map((emoji) => [emoji.id, emoji]));
  const lines = [text, "", "[Оформление исходного сообщения в Telegram]"];
  if (content.customEmojis.length > 0) {
    lines.push("Premium emoji:");
    for (const emoji of content.customEmojis) {
      const visual = stagedById.get(emoji.id);
      lines.push(
        `- «${emoji.alternativeText || "эмодзи"}»${visual ? ` — изображение приложено: ${visual.localPath}` : ""}`,
      );
    }
  }
  if (content.links.length > 0) {
    lines.push("Ссылки:");
    for (const link of content.links) lines.push(`- «${link.text}» → ${link.url}`);
  }
  return lines.filter((line, index) => line || index !== 0).join("\n");
}

export async function stageTelegramCustomEmoji(
  api: Context["api"],
  token: string,
  content: TelegramRichContent,
  options: {
    workspace: string;
    turnId: string;
    maxFileSize: number;
    apiRoot?: string;
  },
): Promise<StagedCustomEmoji[]> {
  const requested = uniqueCustomEmojis(content.customEmojis).slice(0, MAX_CUSTOM_EMOJI_VISUALS);
  if (requested.length === 0) return [];

  let stickers: Sticker[];
  try {
    stickers = await api.getCustomEmojiStickers(requested.map((emoji) => emoji.id));
  } catch (error) {
    console.warn("Failed to resolve Telegram custom emoji:", errorMessage(error));
    return [];
  }
  const stickersById = new Map(
    stickers
      .filter((sticker) => sticker.custom_emoji_id)
      .map((sticker) => [sticker.custom_emoji_id!, sticker]),
  );
  const staged: StagedCustomEmoji[] = [];
  for (const [index, emoji] of requested.entries()) {
    const sticker = stickersById.get(emoji.id) ?? stickers[index];
    if (!sticker) continue;
    const fileId = sticker.thumbnail?.file_id
      ?? (!sticker.is_animated && !sticker.is_video ? sticker.file_id : undefined);
    if (!fileId) continue;
    let temporary: string | undefined;
    try {
      temporary = await downloadTelegramFile(api, token, fileId, {
        apiRoot: options.apiRoot,
        maxBytes: options.maxFileSize,
      });
      const extension = imageExtension(temporary);
      const file = await stageFile(
        temporary,
        `premium-emoji-${index + 1}${extension}`,
        mimeTypeForExtension(extension),
        options,
      );
      staged.push({ ...emoji, localPath: file.localPath });
    } catch (error) {
      console.warn(`Failed to stage Telegram custom emoji ${emoji.id}:`, errorMessage(error));
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }
  return staged;
}

function extractEntityContent(text: string, entities: MessageEntity[] | undefined): TelegramRichContent {
  const content: TelegramRichContent = { plainText: text, customEmojis: [], links: [] };
  for (const entity of entities ?? []) {
    const visible = utf16Slice(text, entity.offset, entity.length);
    if (entity.type === "custom_emoji") {
      content.customEmojis.push({ id: entity.custom_emoji_id, alternativeText: visible });
    } else if (entity.type === "text_link") {
      content.links.push({ text: visible, url: entity.url });
    } else if (entity.type === "url") {
      content.links.push({ text: visible, url: visible });
    }
  }
  content.customEmojis = uniqueCustomEmojis(content.customEmojis);
  content.links = uniqueLinks(content.links);
  return content;
}

function extractRichBlocks(blocks: unknown[], state: TelegramRichContent): string {
  return blocks
    .map((block) => extractRichNode(block, "block", state))
    .filter(Boolean)
    .join("\n");
}

function extractRichNode(
  value: unknown,
  mode: "inline" | "block",
  state: TelegramRichContent,
): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => extractRichNode(item, mode, state))
      .filter(Boolean)
      .join(mode === "inline" ? "" : "\n");
  }
  if (!isRecord(value)) return "";

  if (value.type === "custom_emoji") {
    const id = stringValue(value.custom_emoji_id);
    const alternativeText = stringValue(value.alternative_text) ?? "эмодзи";
    if (id) state.customEmojis.push({ id, alternativeText });
    return alternativeText;
  }
  if (value.type === "url") {
    const text = extractRichNode(value.text, "inline", state);
    const url = stringValue(value.url);
    if (url) state.links.push({ text: text || url, url });
    return text;
  }

  const inlineParts = ["label", "summary", "text", "caption", "credit", "expression"]
    .map((key) => extractRichNode(value[key], "inline", state))
    .filter(Boolean);
  const blockParts = ["blocks", "items", "rows", "cells"]
    .map((key) => extractRichNode(value[key], "block", state))
    .filter(Boolean);
  return [...inlineParts, ...blockParts].join(mode === "inline" ? "" : "\n");
}

function uniqueCustomEmojis(values: TelegramCustomEmoji[]): TelegramCustomEmoji[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value.id || seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

function uniqueLinks(values: TelegramTextLink[]): TelegramTextLink[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.text}\u0000${value.url}`;
    if (!value.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyContent(): TelegramRichContent {
  return { plainText: "", customEmojis: [], links: [] };
}

function utf16Slice(text: string, offset: number, length: number): string {
  return text.slice(offset, offset + length);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function imageExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp"].includes(extension) ? extension : ".webp";
}

function mimeTypeForExtension(extension: string): string {
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return "image/webp";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
