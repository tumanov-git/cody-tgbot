import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";

import {
  extractTelegramRichMessageText,
  withTelegramMessageContext,
} from "../src/telegram-message-context.js";

const baseMessage = {
  message_id: 10,
  date: 1_785_960_000,
  chat: { id: 123, type: "private", first_name: "Артемий" },
  from: { id: 123, is_bot: false, first_name: "Артемий" },
} as unknown as Message;

describe("Telegram message context", () => {
  it("extracts a standalone rich message for the input router", () => {
    const text = extractTelegramRichMessageText({
      blocks: [
        { type: "paragraph", text: ["Собери ", { type: "bold", text: "сайт" }] },
        {
          type: "list",
          items: [
            { label: "• ", blocks: [{ type: "paragraph", text: "с каталогом" }] },
            { label: "• ", blocks: [{ type: "paragraph", text: "и формой" }] },
          ],
        },
      ],
    });

    expect(text).toBe("Собери сайт\n• \nс каталогом\n• \nи формой");
  });

  it("does not spend tokens on an ordinary message", () => {
    const input = { text: "Обычный запрос", imagePaths: ["/tmp/image.png"] };

    expect(withTelegramMessageContext(input, baseMessage)).toBe(input);
  });

  it("marks forwarded text as quoted material from a known user", () => {
    const message = {
      ...baseMessage,
      text: "Я люблю этот трек",
      forward_origin: {
        type: "user",
        date: 1_785_950_000,
        sender_user: {
          id: 456,
          is_bot: false,
          first_name: "Анна",
          username: "anna",
        },
      },
    } as unknown as Message;

    const result = withTelegramMessageContext(message.text!, message);

    expect(result).toContain("[Пересланное сообщение]");
    expect(result).toContain("Не приписывай ему авторство");
    expect(result).toContain("Источник: Анна (@anna)");
    expect(result).toContain("Содержимое:\nЯ люблю этот трек");
    expect(result).not.toContain("[Сообщение пользователя]");
  });

  it("preserves a hidden forward origin without inventing an account", () => {
    const message = {
      ...baseMessage,
      forward_origin: {
        type: "hidden_user",
        date: 1_785_950_000,
        sender_user_name: "Неизвестный эстет",
      },
    } as unknown as Message;

    const result = withTelegramMessageContext("Послушай вот это", message);

    expect(result).toContain("скрытый пользователь «Неизвестный эстет»");
  });

  it("adds the replied message before the user's current message", () => {
    const message = {
      ...baseMessage,
      text: "Да бля не про это",
      reply_to_message: {
        ...baseMessage,
        message_id: 9,
        from: {
          id: 999,
          is_bot: true,
          first_name: "Коди",
          username: "cody_manager_bot",
        },
        text: "Буду трактовать это как правило поведения.",
        reply_to_message: undefined,
      },
    } as unknown as Message;

    const result = withTelegramMessageContext(message.text!, message);

    expect(result).toContain("[Контекст ответа в Telegram]");
    expect(result).toContain("Автор: Коди (@cody_manager_bot) [бот]");
    expect(result).toContain("Буду трактовать это как правило поведения.");
    expect(result).toContain("[Сообщение пользователя]\nДа бля не про это");
  });

  it("keeps the caption of a replied media message", () => {
    const message = {
      ...baseMessage,
      text: "Что думаешь?",
      reply_to_message: {
        ...baseMessage,
        message_id: 9,
        photo: [{ file_id: "photo", file_unique_id: "photo", width: 100, height: 100 }],
        caption: "Макет первой версии",
        reply_to_message: undefined,
      },
    } as unknown as Message;

    const result = withTelegramMessageContext(message.text!, message);

    expect(result).toContain("Сообщение:\nМакет первой версии");
    expect(result).toContain("Вложение: фотография");
  });

  it("extracts text from a replied Telegram rich message", () => {
    const message = {
      ...baseMessage,
      text: "тест 2",
      reply_to_message: {
        ...baseMessage,
        message_id: 9,
        from: {
          id: 999,
          is_bot: true,
          first_name: "Коди",
          username: "cody_manager_bot",
        },
        rich_message: {
          blocks: [
            {
              type: "paragraph",
              text: ["Половина ", { type: "bold", text: "теста" }, " успешна."],
            },
            {
              type: "list",
              items: [
                {
                  label: "• ",
                  blocks: [{ type: "paragraph", text: "reply распознан" }],
                },
              ],
            },
          ],
        },
        reply_to_message: undefined,
      },
    } as unknown as Message;

    const result = withTelegramMessageContext(message.text!, message);

    expect(result).toContain("Половина теста успешна.");
    expect(result).toContain("• \nreply распознан");
    expect(result).not.toContain("Содержимое исходного сообщения недоступно");
  });

  it("keeps a selected quote and structured attachment fields", () => {
    const message = {
      ...baseMessage,
      photo: [{ file_id: "photo", file_unique_id: "photo", width: 100, height: 100 }],
      external_reply: {
        origin: {
          type: "channel",
          date: 1_785_950_000,
          chat: { id: -100123, type: "channel", title: "Музыка", username: "music" },
          message_id: 77,
          author_signature: "Редактор",
        },
        photo: [{ file_id: "old", file_unique_id: "old", width: 100, height: 100 }],
      },
      quote: { text: "трек в духе Moby", position: 0, is_manual: true },
    } as unknown as Message;
    const input = { imagePaths: ["/tmp/image.png"] };

    const result = withTelegramMessageContext(input, message, { attachmentLabel: "фотография" });

    expect(result).toMatchObject({ imagePaths: ["/tmp/image.png"] });
    expect(typeof result === "object" ? result.text : "").toContain("Музыка (@music), автор: Редактор");
    expect(typeof result === "object" ? result.text : "").toContain("Цитируемый фрагмент:\nтрек в духе Moby");
    expect(typeof result === "object" ? result.text : "").toContain("[Сообщение пользователя]\nТип: фотография");
  });
});
