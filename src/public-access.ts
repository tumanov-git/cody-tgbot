import { InlineKeyboard } from "grammy";

export const PUBLIC_ACCESS_CAPTION = [
  "<b>Это личная версия Коди для @tematumanov</b>",
  "",
  "Подробнее и публичная версия — на cody.build",
].join("\n");

export const PUBLIC_ACCESS_FALLBACK = [
  "Это личная версия Коди для @tematumanov",
  "",
  "Подробнее и публичная версия — на cody.build",
].join("\n");

export function buildPublicAccessKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .url({ text: "Открыть cody.build", style: "primary" }, "https://cody.build");
}

export class PublicAccessCooldown {
  private readonly sentAt = new Map<number, number>();

  constructor(private readonly cooldownMs = 60_000) {}

  shouldSend(userId: number, now = Date.now()): boolean {
    const previous = this.sentAt.get(userId);
    if (previous !== undefined && now - previous < this.cooldownMs) return false;
    this.sentAt.set(userId, now);
    if (this.sentAt.size > 10_000) this.removeExpired(now);
    return true;
  }

  private removeExpired(now: number): void {
    for (const [userId, sentAt] of this.sentAt) {
      if (now - sentAt >= this.cooldownMs) this.sentAt.delete(userId);
    }
  }
}
