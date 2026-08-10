import { escapeHTML, PREMIUM_EMOJI, renderPremiumEmoji } from "./format.js";
import type { CodexPromptInput } from "./codex-session.js";

export function renderQueueMessage(
  displayText: string,
): { html: string; plain: string } {
  const title = "Поставил в очередь:";
  const normalized = normalizeQueueDisplayText(displayText);
  return {
    html: [
      `${renderPremiumEmoji(PREMIUM_EMOJI.queue, "👕")} <b>${title}</b>`,
      "",
      `<blockquote>${escapeHTML(normalized)}</blockquote>`,
    ].join("\n"),
    plain: `${title}\n\n${normalized}`,
  };
}

export function promptTextForQueue(input: CodexPromptInput): string {
  if (typeof input === "string") return input;
  return input.text?.trim() || (input.imagePaths?.length ? "Фотография" : "Файл");
}

export function normalizeQueueDisplayText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim() || "Запрос без текста";
  return normalized.length <= 3000 ? normalized : `${normalized.slice(0, 2999)}…`;
}
