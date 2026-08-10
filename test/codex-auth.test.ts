import { CodexAuthService } from "../src/codex-auth.js";
import type { AppServerNotification } from "../src/codex-app-server.js";
import type { CodexAppServerTransport } from "../src/codex-session.js";

class FakeTransport implements CodexAppServerTransport {
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  private listener?: (notification: AppServerNotification) => void;
  account: Record<string, unknown> | null = null;
  requiresOpenaiAuth = true;

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "account/read") {
      return {
        account: this.account,
        requiresOpenaiAuth: this.requiresOpenaiAuth,
      } as T;
    }
    if (method === "account/login/start") {
      return {
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      } as T;
    }
    return {} as T;
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(notification: AppServerNotification): void {
    this.listener?.(notification);
  }

  dispose(): void {}
}

describe("CodexAuthService", () => {
  it("reads signed-out and signed-in account state", async () => {
    const transport = new FakeTransport();
    const auth = new CodexAuthService(transport, false);

    expect(await auth.read()).toMatchObject({ ready: false, account: null });
    transport.account = { type: "chatgpt", email: "cody@example.com", planType: "pro" };
    expect(await auth.read()).toMatchObject({
      ready: true,
      account: { type: "chatgpt", planType: "pro" },
    });
  });

  it("starts and cancels the native device-code flow", async () => {
    const transport = new FakeTransport();
    const auth = new CodexAuthService(transport, false);

    await expect(auth.startDeviceLogin()).resolves.toMatchObject({
      loginId: "login-1",
      userCode: "ABCD-1234",
    });
    await expect(auth.cancelPendingLogin()).resolves.toBe(true);

    expect(transport.requests).toContainEqual({
      method: "account/login/start",
      params: { type: "chatgptDeviceCode" },
    });
    expect(transport.requests).toContainEqual({
      method: "account/login/cancel",
      params: { loginId: "login-1" },
    });
  });

  it("forwards login completion and refreshed account state", async () => {
    const transport = new FakeTransport();
    const auth = new CodexAuthService(transport, false);
    const completed = vi.fn();
    const changed = vi.fn();
    auth.onLoginCompleted(completed);
    auth.onAuthChanged(changed);
    await auth.startDeviceLogin();
    transport.account = { type: "chatgpt", planType: "plus" };

    transport.emit({
      method: "account/login/completed",
      params: { loginId: "login-1", success: true, error: null },
    });
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());

    expect(completed).toHaveBeenCalledWith({
      loginId: "login-1",
      success: true,
      error: null,
    });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ ready: true }));
  });

  it("does not allow Telegram logout when an environment API key owns auth", async () => {
    const auth = new CodexAuthService(new FakeTransport(), true);

    await expect(auth.startDeviceLogin()).rejects.toThrow("управляется ключом");
    await expect(auth.logout()).rejects.toThrow("управляется ключом");
  });
});
