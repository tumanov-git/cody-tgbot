import { InlineKeyboard } from "grammy";

import { FinalAnswerStream } from "../src/final-answer-stream.js";

describe("FinalAnswerStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches reply markup only to the last rich-message chunk", async () => {
    const sendRichMessage = vi.fn()
      .mockResolvedValueOnce({ message_id: 10 })
      .mockResolvedValueOnce({ message_id: 11 });
    const stream = new FinalAnswerStream({
      bot: { api: { sendRichMessage } } as never,
      chatId: 123,
      draftId: 1,
    });
    const keyboard = new InlineKeyboard().url(
      { text: "＋ Создать бота", style: "primary" },
      "https://t.me/newbot/manager/example_bot?name=Example",
    );

    const messageIds = await stream.deliver(`${"a".repeat(29_900)}\n\n${"b".repeat(500)}`, keyboard);

    expect(messageIds).toEqual([10, 11]);
    expect(sendRichMessage).toHaveBeenCalledTimes(2);
    expect(sendRichMessage.mock.calls[0]?.[2]).toMatchObject({ reply_markup: undefined });
    expect(sendRichMessage.mock.calls[1]?.[2]?.reply_markup).toEqual(keyboard);
  });

  it("backs off rich drafts when Telegram returns retry_after", async () => {
    vi.useFakeTimers();
    const sendRichMessageDraft = vi.fn()
      .mockRejectedValueOnce(new Error("429: Too Many Requests: retry after 11"))
      .mockResolvedValueOnce({ message_id: 10 });
    const stream = new FinalAnswerStream({
      bot: { api: { sendRichMessageDraft } } as never,
      chatId: 123,
      draftChatId: 123,
      draftId: 1,
    });

    stream.update("Потоковый ответ");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_999);
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendRichMessageDraft).toHaveBeenCalledTimes(2);

    await stream.stopDraftUpdates();
  });
});
