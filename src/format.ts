export function escapeHTML(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const PREMIUM_EMOJI = {
  accepted: "5339351141631155056",
  working: "5339319045340553200",
  tool: "5339081812821957844",
  completedFirst: "5341350878404173403",
  completedSecond: "5339398905962456755",
  message: "5339062047382461917",
  voice: "5300991860997651208",
  received: "5341591044385431126",
  queue: "5449700997632925464",
  sad: "5339360882616983894",
} as const;

export function renderPremiumEmoji(emojiId: string, fallback: string): string {
  return `<tg-emoji emoji-id="${emojiId}">${fallback}</tg-emoji>`;
}

export function renderPremiumEmojiMarkdown(emojiId: string, fallback: string): string {
  return `![${fallback}](tg://emoji?id=${emojiId})`;
}
