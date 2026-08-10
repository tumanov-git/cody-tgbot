import {
  MESSAGE_REACTION_CHANCE,
  MESSAGE_REACTIONS,
  maybeReactToMessage,
  normalizeMessageReaction,
} from "../src/message-reaction.js";

describe("message reactions", () => {
  it("accepts only one reaction from the configured Telegram set", () => {
    expect(normalizeMessageReaction("🤯\n")).toBe("🤯");
    expect(normalizeMessageReaction("Выбираю 🤯")).toBe("🤯");
    expect(normalizeMessageReaction("🚀")).toBeNull();
    expect(MESSAGE_REACTIONS).not.toContain("🖕");
  });

  it("does not start background work outside the ten-percent sample", () => {
    const react = vi.fn(async () => true);
    maybeReactToMessage({ react } as never, "обычное сообщение", () => MESSAGE_REACTION_CHANCE);
    expect(react).not.toHaveBeenCalled();
  });
});
