import {
  buildPublicAccessKeyboard,
  PUBLIC_ACCESS_CAPTION,
  PUBLIC_ACCESS_FALLBACK,
  PublicAccessCooldown,
} from "../src/public-access.js";

describe("public access screen", () => {
  it("points visitors to the public Cody product", () => {
    expect(PUBLIC_ACCESS_CAPTION.split("\n")[0]).toBe("<b>Это версия Коди для @tematumanov</b>");
    expect(PUBLIC_ACCESS_CAPTION).not.toContain("Подробнее");
    expect(PUBLIC_ACCESS_FALLBACK).toContain("Публичная версия — на cody.build");
    expect(buildPublicAccessKeyboard().inline_keyboard[0]?.[0]).toMatchObject({
      text: "Открыть cody.build",
      url: "https://cody.build",
      style: "primary",
    });
  });

  it("shows the screen at most once a minute per visitor", () => {
    const cooldown = new PublicAccessCooldown(60_000);
    expect(cooldown.shouldSend(101, 1_000)).toBe(true);
    expect(cooldown.shouldSend(101, 60_999)).toBe(false);
    expect(cooldown.shouldSend(101, 61_000)).toBe(true);
    expect(cooldown.shouldSend(202, 61_001)).toBe(true);
  });
});
