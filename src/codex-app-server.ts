import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface DynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading?: boolean;
}

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolCallResult {
  success: boolean;
  text: string;
}

export type DynamicToolHandler = (
  params: DynamicToolCallParams,
) => Promise<DynamicToolCallResult>;

export interface AppServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export type AppServerRequestHandler = (
  request: AppServerRequest,
) => Promise<unknown | undefined>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CodexAppServerOptions {
  apiKey?: string;
  dynamicToolHandler?: DynamicToolHandler;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private initialized = false;
  private stopping = false;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();
  private readonly serverRequestListeners = new Set<AppServerRequestHandler>();

  constructor(private readonly options: CodexAppServerOptions = {}) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params);
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: AppServerRequestHandler): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  dispose(): void {
    this.stopping = true;
    this.initialized = false;
    this.startPromise = null;

    const error = new Error("Codex app-server stopped");
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized && this.child) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.stopping = false;
    this.startPromise = this.startProcess().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startProcess(): Promise<void> {
    const binary = resolveCodexBinary();
    const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: buildCodexEnv(this.options.apiKey),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        console.warn(`Codex app-server: ${truncate(trimmed, 2_000)}`);
      }
    });

    child.once("error", (error) => {
      this.handleExit(new Error(`Failed to start Codex app-server: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (this.stopping) {
        return;
      }
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.handleExit(new Error(`Codex app-server exited with ${detail}`));
    });

    await this.sendRequest("initialize", {
      clientInfo: {
        name: "cody-tgbot",
        title: "Коди Telegram",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.writeMessage({ method: "initialized" });
    this.initialized = true;
  }

  private sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextRequestId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeMessage(message: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("Codex app-server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      console.warn(`Codex app-server returned invalid JSON: ${truncate(line, 500)}`);
      return;
    }

    if (!isRecord(message)) {
      return;
    }

    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method !== "string") {
      this.handleResponse(message.id, message);
      return;
    }

    if (typeof message.method !== "string") {
      return;
    }

    if (typeof message.id === "number" || typeof message.id === "string") {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      }).catch((error) => {
        console.error(
          "Failed to answer app-server request:",
          error instanceof Error ? error.message : String(error),
        );
      });
      return;
    }

    const notification = { method: message.method, params: message.params };
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
  }

  private handleResponse(id: number | string, message: Record<string, unknown>): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    if (isRecord(message.error)) {
      const detail = typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error);
      pending.reject(new Error(detail));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(request: AppServerRequest): Promise<void> {
    for (const listener of this.serverRequestListeners) {
      const result = await listener(request);
      if (result !== undefined) {
        this.writeMessage({ id: request.id, result });
        return;
      }
    }
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.writeMessage({ id: request.id, result: { decision: "decline" } });
        return;
      case "item/tool/requestUserInput":
        this.writeMessage({ id: request.id, result: { answers: {} } });
        return;
      case "item/permissions/requestApproval":
        this.writeMessage({ id: request.id, result: { permissions: {}, scope: "turn" } });
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        this.writeMessage({ id: request.id, result: { decision: "denied" } });
        return;
      case "item/tool/call": {
        if (!this.options.dynamicToolHandler || !isDynamicToolCallParams(request.params)) {
          this.writeMessage({
            id: request.id,
            result: {
              success: false,
              contentItems: [{ type: "inputText", text: "Инструмент недоступен" }],
            },
          });
          return;
        }
        try {
          const result = await this.options.dynamicToolHandler(request.params);
          this.writeMessage({
            id: request.id,
            result: {
              success: result.success,
              contentItems: [{ type: "inputText", text: result.text }],
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.writeMessage({
            id: request.id,
            result: {
              success: false,
              contentItems: [{ type: "inputText", text: JSON.stringify({ success: false, error: message }) }],
            },
          });
        }
        return;
      }
      default:
        this.writeMessage({
          id: request.id,
          error: {
            code: -32601,
            message: `Unsupported app-server request: ${request.method}`,
          },
        });
    }
  }

  private handleExit(error: Error): void {
    if (this.child) {
      this.child = null;
    }
    this.initialized = false;

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const listener of this.notificationListeners) {
      listener({ method: "cody-tgbot/appServerExited", params: { message: error.message } });
    }
  }
}

function isDynamicToolCallParams(value: unknown): value is DynamicToolCallParams {
  if (!isRecord(value)) return false;
  return (
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.callId === "string" &&
    typeof value.tool === "string" &&
    (value.namespace === null || typeof value.namespace === "string")
  );
}

function resolveCodexBinary(): string {
  const executable = process.platform === "win32" ? "codex.cmd" : "codex";
  return path.resolve(process.cwd(), "node_modules", ".bin", executable);
}

function buildCodexEnv(apiKey?: string): NodeJS.ProcessEnv {
  if (!apiKey) {
    return { ...process.env };
  }
  return { ...process.env, CODEX_API_KEY: apiKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
