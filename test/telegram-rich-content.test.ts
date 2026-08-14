import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Context } from "grammy";
import type { Message, RichMessage, Sticker } from "grammy/types";

import {
  extractTelegramMessageContent,
  extractTelegramRichContent,
  renderTelegramRichContent,
  stageTelegramCustomEmoji,
} from "../src/telegram-rich-content.js";

describe("Telegram rich content", () => {
  it("reads UTF-16 custom emoji entities and hidden links without shifting Cyrillic text", () => {
    const text = "Привет 🙂 — открой сайт";
    const emojiOffset = text.indexOf("🙂");
    const linkText = "сайт";
    const linkOffset = text.indexOf(linkText);
    const message = {
      text,
      entities: [
        { type: "custom_emoji", offset: emojiOffset, length: "🙂".length, custom_emoji_id: "emoji-1" },
        { type: "text_link", offset: linkOffset, length: linkText.length, url: "https://cody.build" },
      ],
    } as unknown as Message;

    const content = extractTelegramMessageContent(message);

    expect(content).toEqual({
      plainText: text,
      customEmojis: [{ id: "emoji-1", alternativeText: "🙂" }],
      links: [{ text: "сайт", url: "https://cody.build" }],
    });
    expect(renderTelegramRichContent(content)).toContain("«сайт» → https://cody.build");
  });

  it("reads custom emoji and links from Telegram rich messages", () => {
    const richMessage = {
      blocks: [{
        type: "paragraph",
        text: [
          "Очень ",
          { type: "custom_emoji", custom_emoji_id: "emoji-2", alternative_text: "🔥" },
          " ",
          { type: "url", text: "подробности", url: "https://example.com" },
        ],
      }],
    } as unknown as RichMessage;

    const content = extractTelegramRichContent(richMessage);

    expect(content.plainText).toBe("Очень 🔥 подробности");
    expect(content.customEmojis).toEqual([{ id: "emoji-2", alternativeText: "🔥" }]);
    expect(content.links).toEqual([{ text: "подробности", url: "https://example.com" }]);
  });

  it("downloads a custom emoji preview and stages it as model-visible input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cody-premium-emoji-"));
    const source = path.join(root, "source.webp");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(source, "fake webp");
    const api = {
      getCustomEmojiStickers: vi.fn(async () => [{
        file_id: "emoji-file",
        file_unique_id: "emoji-unique",
        type: "custom_emoji",
        width: 100,
        height: 100,
        is_animated: false,
        is_video: false,
        custom_emoji_id: "emoji-1",
      } as Sticker]),
      getFile: vi.fn(async () => ({ file_id: "emoji-file", file_unique_id: "emoji-unique", file_path: source })),
    } as unknown as Context["api"];

    try {
      const staged = await stageTelegramCustomEmoji(
        api,
        "not-used-for-local-files",
        {
          plainText: "🙂",
          customEmojis: [{ id: "emoji-1", alternativeText: "🙂" }],
          links: [],
        },
        { workspace, turnId: "turn-1", maxFileSize: 1024 },
      );

      expect(staged).toHaveLength(1);
      expect(staged[0]?.localPath).toBe(
        path.join(workspace, ".cody-tgbot", "inbox", "turn-1", "premium-emoji-1.webp"),
      );
      expect(await readFile(staged[0]!.localPath, "utf8")).toBe("fake webp");
      expect(renderTelegramRichContent({
        plainText: "🙂",
        customEmojis: [{ id: "emoji-1", alternativeText: "🙂" }],
        links: [],
      }, staged)).toContain(staged[0]!.localPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

