import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Bot, Context } from "grammy";

import { inboxPath, outboxPath, stageFile } from "./attachments.js";
import type { CodyConfig } from "./config.js";
import { parseContextKey, type TelegramContextKey } from "./context-key.js";
import { PREMIUM_EMOJI, renderPremiumEmoji } from "./format.js";
import type { TaskController } from "./task-controller.js";
import { downloadTelegramFile, sendTextMessage } from "./telegram-api.js";
import { withTelegramMessageContext } from "./telegram-message-context.js";
import {
  extractTelegramMessageContent,
  renderTelegramRichContent,
  stageTelegramCustomEmoji,
  type TelegramRichContent,
} from "./telegram-rich-content.js";

const MEDIA_GROUP_SETTLE_MS = 700;
const MEDIA_GROUP_RECOVERY_SETTLE_MS = 2_000;

interface MediaGroupItem {
  messageId: number;
  updateId: number;
  fileId: string;
  caption?: string;
  contextualText?: string;
  richContent?: TelegramRichContent;
}

interface PendingMediaGroup {
  key: string;
  mediaGroupId: string;
  contextKey: TelegramContextKey;
  chatId: number;
  privateChat: boolean;
  createdAt: string;
  items: MediaGroupItem[];
}

interface StoredMediaGroups {
  version: 1;
  groups: PendingMediaGroup[];
}

export class MediaGroupController {
  private readonly statePath: string;
  private groups: PendingMediaGroup[] = [];
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(
    private readonly bot: Bot<Context>,
    private readonly config: CodyConfig,
    private readonly tasks: TaskController,
  ) {
    this.statePath = path.join(config.workspace, ".cody-tgbot", "runtime", "media-groups.json");
  }

  async accept(ctx: Context, contextKey: TelegramContextKey, mediaGroupId: string, fileId: string): Promise<void> {
    const richContent = ctx.message ? extractTelegramMessageContent(ctx.message) : undefined;
    const caption = richContent?.plainText.trim();
    const renderedCaption = richContent ? renderTelegramRichContent(richContent) : caption;
    const contextual = ctx.message
      ? withTelegramMessageContext(renderedCaption ?? "", ctx.message, { attachmentLabel: "фотоальбом" })
      : renderedCaption;
    const key = `${contextKey}:${mediaGroupId}`;
    await this.withMutationLock(async () => {
      await this.ensureLoaded();
      let group = this.groups.find((candidate) => candidate.key === key);
      if (!group) {
        group = {
          key,
          mediaGroupId,
          contextKey,
          chatId: ctx.chat!.id,
          privateChat: ctx.chat?.type === "private",
          createdAt: new Date().toISOString(),
          items: [],
        };
        this.groups.push(group);
      }
      const item: MediaGroupItem = {
        messageId: ctx.message!.message_id,
        updateId: ctx.update.update_id,
        fileId,
        ...(caption ? { caption } : {}),
        ...(richContent && (richContent.customEmojis.length > 0 || richContent.links.length > 0)
          ? { richContent }
          : {}),
        ...(typeof contextual === "string" && contextual.trim()
          ? { contextualText: contextual.trim() }
          : {}),
      };
      const index = group.items.findIndex((candidate) => candidate.messageId === item.messageId);
      if (index >= 0) group.items[index] = item;
      else group.items.push(item);
      group.items.sort((left, right) => left.messageId - right.messageId);
      await this.persist();
    });
    this.schedule(key, MEDIA_GROUP_SETTLE_MS);
  }

  async recover(): Promise<void> {
    await this.ensureLoaded();
    for (const group of this.groups) this.schedule(group.key, MEDIA_GROUP_RECOVERY_SETTLE_MS);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(key: string, delay: number): void {
    if (this.disposed) return;
    const current = this.timers.get(key);
    if (current) clearTimeout(current);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.process(key).catch((error) => {
        console.error(`Failed to process Telegram media group ${key}:`, error);
      });
    }, delay));
  }

  private async process(key: string): Promise<void> {
    if (this.disposed) return;
    await this.ensureLoaded();
    const group = this.groups.find((candidate) => candidate.key === key);
    if (!group || group.items.length === 0) return;

    const session = await this.tasks.getSession(group.contextKey);
    const workspace = session.getCurrentWorkspace();
    const turnId = randomUUID().slice(0, 12);
    const stagedPaths: string[] = [];
    const temporaryPaths: string[] = [];
    try {
      for (const [index, item] of group.items.entries()) {
        const temporary = await downloadTelegramFile(
          this.bot.api,
          this.config.telegramBotToken,
          item.fileId,
          { apiRoot: this.config.telegramApiRoot, maxBytes: this.config.maxFileSize },
        );
        temporaryPaths.push(temporary);
        const extension = path.extname(temporary) || ".jpg";
        const staged = await stageFile(
          temporary,
          `photo-${index + 1}${extension}`,
          "image/jpeg",
          { workspace, turnId, maxFileSize: this.config.maxFileSize },
        );
        stagedPaths.push(staged.localPath);
      }

      const captionItem = group.items.find((item) => item.contextualText || item.caption);
      let promptText = captionItem?.contextualText || captionItem?.caption;
      if (captionItem?.richContent) {
        const stagedEmoji = await stageTelegramCustomEmoji(
          this.bot.api,
          this.config.telegramBotToken,
          captionItem.richContent,
          {
            workspace,
            turnId,
            maxFileSize: this.config.maxFileSize,
            apiRoot: this.config.telegramApiRoot,
          },
        );
        stagedPaths.push(...stagedEmoji.map((emoji) => emoji.localPath));
        const original = renderTelegramRichContent(captionItem.richContent);
        const enriched = renderTelegramRichContent(captionItem.richContent, stagedEmoji);
        promptText = promptText?.includes(original)
          ? promptText.replace(original, enriched)
          : enriched;
      }
      const prompt = {
        ...(promptText ? { text: promptText } : {}),
        imagePaths: stagedPaths,
      };
      const latestUpdateId = Math.max(...group.items.map((item) => item.updateId));
      await this.tasks.enqueueUserInputFromOrigin(
        { updateId: latestUpdateId, privateChat: group.privateChat },
        group.contextKey,
        group.chatId,
        session,
        prompt,
        {
          turnId,
          outDir: outboxPath(workspace, turnId),
          queueDisplayText: captionItem?.caption || `Фотоальбом · ${group.items.length} фото`,
          cleanupPaths: [inboxPath(workspace, turnId)],
        },
      );
      await this.remove(key);
    } catch (error) {
      await sendTextMessage(
        this.bot.api,
        group.chatId,
        `${renderPremiumEmoji(PREMIUM_EMOJI.sad, "😕")} Не удалось обработать фотоальбом. Попробуй отправить его ещё раз.`,
        {
          fallbackText: "Не удалось обработать фотоальбом. Попробуй отправить его ещё раз.",
          messageThreadId: parseContextKey(group.contextKey).messageThreadId,
        },
      ).catch(() => {});
      await this.remove(key);
      await rm(inboxPath(workspace, turnId), { recursive: true, force: true }).catch(() => {});
      console.error(`Media group ${key} failed:`, error);
    } finally {
      await Promise.all(temporaryPaths.map((temporary) => unlink(temporary).catch(() => {})));
    }
  }

  private async remove(key: string): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureLoaded();
      this.groups = this.groups.filter((candidate) => candidate.key !== key);
      await this.persist();
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<StoredMediaGroups>;
      this.groups = Array.isArray(parsed.groups) ? parsed.groups.filter(isPendingMediaGroup) : [];
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.groups = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.statePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.media-groups.${randomUUID()}.tmp`);
    try {
      const data: StoredMediaGroups = { version: 1, groups: this.groups };
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.statePath);
      await chmod(this.statePath, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isPendingMediaGroup(value: unknown): value is PendingMediaGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as Partial<PendingMediaGroup>;
  return (
    typeof group.key === "string"
    && typeof group.mediaGroupId === "string"
    && typeof group.contextKey === "string"
    && typeof group.chatId === "number"
    && typeof group.privateChat === "boolean"
    && typeof group.createdAt === "string"
    && Array.isArray(group.items)
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
