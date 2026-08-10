import {
  renderAccountView,
  renderDeviceLoginView,
} from "../src/codex-auth-ui.js";

describe("Codex auth UI", () => {
  it("offers ChatGPT login only to the owner", () => {
    const signedOut = {
      account: null,
      requiresOpenaiAuth: true,
      ready: false,
      managedByApiKey: false,
    };

    expect(renderAccountView(signedOut, true).keyboard.inline_keyboard.flat())
      .toContainEqual(expect.objectContaining({
        text: "Войти через ChatGPT",
        callback_data: "auth:login",
        style: "primary",
      }));
    expect(renderAccountView(signedOut, false).keyboard.inline_keyboard.flat()
      .map((button) => button.text)).not.toContain("Войти через ChatGPT");
  });

  it("shows a signed-in ChatGPT account and a destructive logout button", () => {
    const view = renderAccountView({
      account: { type: "chatgpt", email: "cody@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
      ready: true,
      managedByApiKey: false,
    }, true);

    expect(view.plain).toContain("ChatGPT Pro");
    expect(view.plain).toContain("cody@example.com");
    expect(view.keyboard.inline_keyboard.flat()).toContainEqual(expect.objectContaining({
      text: "Выйти",
      callback_data: "auth:logout",
      style: "danger",
    }));
  });

  it("renders the official device-code URL and code", () => {
    const view = renderDeviceLoginView(
      "https://auth.openai.com/codex/device",
      "ABCD-1234",
    );

    expect(view.html).toContain("<code>ABCD-1234</code>");
    expect(view.keyboard.inline_keyboard[0]?.[0]).toMatchObject({
      text: "Открыть OpenAI",
      url: "https://auth.openai.com/codex/device",
      style: "primary",
    });
  });

  it("does not expose logout for a server-managed API key", () => {
    const view = renderAccountView({
      account: { type: "apiKey" },
      requiresOpenaiAuth: true,
      ready: true,
      managedByApiKey: true,
    }, true);

    expect(view.plain).toContain("управляется настройками сервера");
    expect(view.keyboard.inline_keyboard.flat().map((button) => button.text)).not.toContain("Выйти");
  });
});
