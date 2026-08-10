import type { AppServerNotification } from "./codex-app-server.js";
import type { CodexAppServerTransport } from "./codex-session.js";

export interface CodexAccount {
  type: string;
  email?: string | null;
  planType?: string | null;
}

export interface CodexAuthState {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
  ready: boolean;
  managedByApiKey: boolean;
}

export interface CodexDeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface CodexLoginCompletion {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

interface AccountReadResponse {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}

interface DeviceLoginResponse {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

type AuthListener = (state: CodexAuthState) => void;
type LoginListener = (completion: CodexLoginCompletion) => void;

export class CodexAuthService {
  private readonly authListeners = new Set<AuthListener>();
  private readonly loginListeners = new Set<LoginListener>();
  private readonly unsubscribe: () => void;
  private pendingLoginId: string | null = null;
  private cachedState: CodexAuthState | null = null;

  constructor(
    private readonly appServer: CodexAppServerTransport,
    private readonly apiKeyConfigured: boolean,
  ) {
    this.unsubscribe = appServer.onNotification((notification) => {
      void this.handleNotification(notification);
    });
  }

  async read(): Promise<CodexAuthState> {
    const response = await this.appServer.request<AccountReadResponse>("account/read", {
      refreshToken: false,
    });
    const state = this.toState(response);
    this.cachedState = state;
    return state;
  }

  async isReady(): Promise<boolean> {
    return this.cachedState?.ready ?? (await this.read()).ready;
  }

  async startDeviceLogin(): Promise<CodexDeviceLogin> {
    if (this.apiKeyConfigured) {
      throw new Error("Авторизация управляется ключом на сервере");
    }
    await this.cancelPendingLogin();
    const response = await this.appServer.request<DeviceLoginResponse>("account/login/start", {
      type: "chatgptDeviceCode",
    });
    if (
      response.type !== "chatgptDeviceCode"
      || !response.loginId
      || !response.verificationUrl
      || !response.userCode
    ) {
      throw new Error("Codex не вернул данные для входа");
    }
    this.pendingLoginId = response.loginId;
    return response;
  }

  async cancelPendingLogin(): Promise<boolean> {
    const loginId = this.pendingLoginId;
    if (!loginId) return false;
    this.pendingLoginId = null;
    await this.appServer.request("account/login/cancel", { loginId });
    return true;
  }

  async logout(): Promise<void> {
    if (this.apiKeyConfigured) {
      throw new Error("Авторизация управляется ключом на сервере");
    }
    await this.cancelPendingLogin();
    await this.appServer.request("account/logout");
    await this.emitAuthState();
  }

  onAuthChanged(listener: AuthListener): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  onLoginCompleted(listener: LoginListener): () => void {
    this.loginListeners.add(listener);
    return () => this.loginListeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribe();
    this.authListeners.clear();
    this.loginListeners.clear();
    this.cachedState = null;
  }

  private async handleNotification(notification: AppServerNotification): Promise<void> {
    if (notification.method === "account/login/completed") {
      const completion = parseLoginCompletion(notification.params);
      if (!completion) return;
      if (!completion.loginId || completion.loginId === this.pendingLoginId) {
        this.pendingLoginId = null;
      }
      for (const listener of this.loginListeners) listener(completion);
      await this.emitAuthState();
      return;
    }
    if (notification.method === "account/updated") {
      await this.emitAuthState();
    }
  }

  private async emitAuthState(): Promise<void> {
    if (this.authListeners.size === 0) return;
    try {
      const state = await this.read();
      for (const listener of this.authListeners) listener(state);
    } catch {
      // A subsequent UI action will retry account/read and show the real error.
    }
  }

  private toState(response: AccountReadResponse): CodexAuthState {
    return {
      account: response.account,
      requiresOpenaiAuth: response.requiresOpenaiAuth,
      ready: Boolean(response.account) || !response.requiresOpenaiAuth,
      managedByApiKey: this.apiKeyConfigured,
    };
  }
}

function parseLoginCompletion(value: unknown): CodexLoginCompletion | null {
  if (!isRecord(value) || typeof value.success !== "boolean") return null;
  const loginId = typeof value.loginId === "string" ? value.loginId : null;
  const error = typeof value.error === "string" ? value.error : null;
  return { loginId, success: value.success, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
