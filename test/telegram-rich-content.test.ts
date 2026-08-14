import type { Message, RichMessage } from "grammy/types";

import {
  extractTelegramMessageContent,
  extractTelegramRichContent,
  renderTelegramRichContent,
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
    expect(renderTelegramRichContent(content)).toContain(
      "«🙂» → tg://emoji?id=emoji-1 (custom_emoji_id: emoji-1)",
    );
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
    expect(content.richMessage).toBe(richMessage);
    const rendered = renderTelegramRichContent(content);
    expect(rendered).toContain('"type": "custom_emoji"');
    expect(rendered).toContain('"custom_emoji_id": "emoji-2"');
    expect(rendered).toContain('"url": "https://example.com"');
  });

  it("prefers the exact rich message JSON over a flattened text fallback", () => {
    const richMessage = {
      blocks: [{
        type: "table",
        rows: [
          { cells: [{ text: "A" }, { text: "B" }] },
          { cells: [{ text: "1" }, { text: "2" }] },
        ],
      }],
    } as unknown as RichMessage;
    const content = extractTelegramMessageContent({
      text: "A B\n1 2",
      rich_message: richMessage,
    } as unknown as Message);

    expect(content.richMessage).toBe(richMessage);
    expect(renderTelegramRichContent(content)).toContain('"type": "table"');
    expect(renderTelegramRichContent(content)).toContain('"cells"');
  });

  it("passes a reusable custom emoji id without downloading an image", () => {
    expect(renderTelegramRichContent({
      plainText: "🙂",
      customEmojis: [{ id: "5368324170671202286", alternativeText: "🙂" }],
      links: [],
    })).toContain(
      "tg://emoji?id=5368324170671202286 (custom_emoji_id: 5368324170671202286)",
    );
  });
});
