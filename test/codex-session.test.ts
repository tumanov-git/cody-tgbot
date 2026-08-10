import { vi } from "vitest";

import {
  CodexSessionService,
  type CodexAppServerTransport,
  type CodexSessionCallbacks,
} from "../src/codex-session.js";
import type { AppServerRequest, AppServerRequestHandler } from "../src/codex-app-server.js";
import type { CodyConfig } from "../src/config.js";

class FakeAppServer implements CodexAppServerTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly listeners = new Set<(notification: { method: string; params?: unknown }) => void>();
  readonly requestListeners = new Set<AppServerRequestHandler>();
  notificationsAfterTurnStart: Array<{ method: string; params?: unknown }> = [];
  nextThreadId = "0198-thread";
  nextTurnId = "0198-turn";
  disposed = false;

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") {
      const threadId = method === "thread/resume"
        ? (params as { threadId: string }).threadId
        : this.nextThreadId;
      return { thread: { id: threadId } } as T;
    }
    if (method === "turn/start" || method === "review/start") {
      queueMicrotask(() => {
        for (const notification of this.notificationsAfterTurnStart) {
          this.emit(notification.method, notification.params);
        }
      });
      return { turn: { id: this.nextTurnId } } as T;
    }
    if (method === "turn/steer") {
      return { turnId: this.nextTurnId } as T;
    }
    if (method === "collaborationMode/list") {
      return {
        data: [
          { mode: "plan", model: null, reasoning_effort: "medium" },
          { mode: "default", model: null, reasoning_effort: null },
        ],
      } as T;
    }
    return {} as T;
  }

  onNotification(listener: (notification: { method: string; params?: unknown }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onServerRequest(listener: AppServerRequestHandler): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  async emitServerRequest(request: AppServerRequest): Promise<unknown> {
    for (const listener of this.requestListeners) {
      const result = await listener(request);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  dispose(): void {
    this.disposed = true;
  }

  emit(method: string, params?: unknown): void {
    for (const listener of this.listeners) {
      listener({ method, params });
    }
  }
}

describe("CodexSessionService with app-server", () => {
  const createConfig = (overrides: Partial<CodyConfig> = {}): CodyConfig => ({
    telegramBotToken: "bot-token",
    telegramApiRoot: "https://api.telegram.org",
    telegramLocalMode: false,
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace/base",
    approvedDirectories: ["/workspace"],
    maxFileSize: 20 * 1024 * 1024,
    codexApiKey: "codex-key",
    codexModel: "gpt-5.4",
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    maxParallelCodexTasks: 2,
    ...overrides,
  });

  const createCallbacks = (): CodexSessionCallbacks => ({
    onTextDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onAgentEnd: vi.fn(),
    onSubagentCount: vi.fn(),
    onAgentMessageDelta: vi.fn(),
    onAgentMessageComplete: vi.fn(),
  });

  it("keeps new threads lazy until the first prompt", async () => {
    const appServer = new FakeAppServer();
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);

    expect(service.hasActiveThread()).toBe(true);
    expect(service.getInfo().threadId).toBeNull();
    expect(appServer.requests).toEqual([]);
  });

  it("starts a thread and streams agent text through one long-lived transport", async () => {
    const appServer = new FakeAppServer();
    const callbacks = createCallbacks();
    appServer.notificationsAfterTurnStart = [
      { method: "turn/started", params: { threadId: "0198-thread", turn: { id: "0198-turn" } } },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "0198-thread", turnId: "0198-turn", itemId: "msg-1", delta: "При" },
      },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "0198-thread", turnId: "0198-turn", itemId: "msg-1", delta: "вет" },
      },
      {
        method: "item/completed",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          item: { id: "msg-1", type: "agentMessage", text: "Привет" },
        },
      },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          tokenUsage: {
            total: {
              totalTokens: 50_000,
              inputTokens: 40_000,
              cachedInputTokens: 30_000,
              outputTokens: 10_000,
              reasoningOutputTokens: 5_000,
            },
            last: {
              totalTokens: 25_000,
              inputTokens: 20_000,
              cachedInputTokens: 15_000,
              outputTokens: 5_000,
              reasoningOutputTokens: 2_500,
            },
            modelContextWindow: 100_000,
          },
        },
      },
      {
        method: "turn/completed",
        params: { threadId: "0198-thread", turn: { id: "0198-turn", status: "completed" } },
      },
    ];
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);

    await service.prompt("hello", callbacks);

    expect(appServer.requests[0]).toEqual({
      method: "thread/start",
      params: {
        model: "gpt-5.4",
        cwd: "/workspace/base",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        serviceName: "cody-tgbot",
      },
    });
    expect(appServer.requests[1]).toEqual({
      method: "turn/start",
      params: {
        threadId: "0198-thread",
        input: [{ type: "text", text: "hello", text_elements: [] }],
        cwd: "/workspace/base",
        approvalPolicy: "never",
        model: "gpt-5.4",
        effort: null,
        serviceTier: null,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace"],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    });
    expect((callbacks.onTextDelta as ReturnType<typeof vi.fn>).mock.calls).toEqual([["При"], ["вет"]]);
    expect(callbacks.onAgentMessageComplete).toHaveBeenCalledWith("msg-1", "Привет", null);
    expect(callbacks.onAgentEnd).toHaveBeenCalledWith("completed");
    expect(service.getInfo().threadId).toBe("0198-thread");
    expect(service.getStatus()).toMatchObject({
      model: "gpt-5.4",
      tokenUsage: {
        last: { totalTokens: 25_000 },
        modelContextWindow: 100_000,
      },
    });
  });

  it("registers native dynamic tools and injects project context only into the first turn", async () => {
    const appServer = new FakeAppServer();
    appServer.notificationsAfterTurnStart = [
      {
        method: "turn/completed",
        params: { threadId: "0198-thread", turn: { id: "0198-turn", status: "completed" } },
      },
    ];
    const dynamicTools = [{
      type: "function" as const,
      name: "project",
      description: "register project",
      inputSchema: { type: "object" },
    }];
    const service = await CodexSessionService.create(createConfig(), {
      dynamicTools,
      developerInstructions: "Register durable projects.",
    }, appServer);
    await service.newThread("/workspace/base", "project_id: cody-tgbot");

    await service.prompt("first", createCallbacks());
    await service.prompt("second", createCallbacks());

    expect(appServer.requests[0]).toEqual({
      method: "thread/start",
      params: {
        model: "gpt-5.4",
        cwd: "/workspace/base",
        approvalPolicy: "never",
        sandbox: "workspace-write",
        serviceName: "cody-tgbot",
        developerInstructions: "Register durable projects.",
        dynamicTools,
      },
    });
    const turns = appServer.requests.filter((entry) => entry.method === "turn/start");
    expect(turns[0]?.params).toMatchObject({
      additionalContext: {
        "cody-project": { value: "project_id: cody-tgbot", kind: "application" },
      },
    });
    expect(turns[1]?.params).not.toHaveProperty("additionalContext");
  });

  it("reports interrupted turns separately from completed turns", async () => {
    const appServer = new FakeAppServer();
    const callbacks = createCallbacks();
    appServer.notificationsAfterTurnStart = [
      { method: "turn/started", params: { threadId: "0198-thread", turn: { id: "0198-turn" } } },
      {
        method: "turn/completed",
        params: { threadId: "0198-thread", turn: { id: "0198-turn", status: "interrupted" } },
      },
    ];
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);

    await service.prompt("stop", callbacks);

    expect(callbacks.onAgentEnd).toHaveBeenCalledWith("interrupted");
  });

  it("preserves commentary and final-answer phases across streamed agent messages", async () => {
    const appServer = new FakeAppServer();
    const callbacks = createCallbacks();
    appServer.notificationsAfterTurnStart = [
      { method: "turn/started", params: { threadId: "0198-thread", turn: { id: "0198-turn" } } },
      {
        method: "item/started",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          item: { id: "commentary-1", type: "agentMessage", text: "", phase: "commentary" },
        },
      },
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          itemId: "commentary-1",
          delta: "Проверяю",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          item: {
            id: "commentary-1",
            type: "agentMessage",
            text: "Проверяю",
            phase: "commentary",
          },
        },
      },
      {
        method: "item/started",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          item: { id: "final-1", type: "agentMessage", text: "", phase: "final_answer" },
        },
      },
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          itemId: "final-1",
          delta: "Готово",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          item: { id: "final-1", type: "agentMessage", text: "Готово", phase: "final_answer" },
        },
      },
      {
        method: "turn/completed",
        params: { threadId: "0198-thread", turn: { id: "0198-turn", status: "completed" } },
      },
    ];
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);

    await service.prompt("do it", callbacks);

    expect((callbacks.onAgentMessageDelta as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["commentary-1", "Проверяю", "Проверяю", "commentary"],
      ["final-1", "Готово", "Готово", "final_answer"],
    ]);
    expect((callbacks.onAgentMessageComplete as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["commentary-1", "Проверяю", "commentary"],
      ["final-1", "Готово", "final_answer"],
    ]);
  });

  it("resumes persisted threads with the fixed launch settings", async () => {
    const appServer = new FakeAppServer();
    const service = await CodexSessionService.create(createConfig(), {
      workspace: "/workspace/resumed",
      resumeThreadId: "0198-resumed",
    }, appServer);

    expect(appServer.requests[0]).toEqual({
      method: "thread/resume",
      params: {
        threadId: "0198-resumed",
        model: "gpt-5.4",
        cwd: "/workspace/resumed",
        approvalPolicy: "never",
        sandbox: "workspace-write",
      },
    });
    expect(service.getInfo().threadId).toBe("0198-resumed");
  });

  it("passes text, staged files, and images using app-server input names", async () => {
    const appServer = new FakeAppServer();
    appServer.notificationsAfterTurnStart = [
      {
        method: "turn/completed",
        params: { threadId: "0198-thread", turn: { id: "0198-turn", status: "completed" } },
      },
    ];
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);

    await service.prompt({
      text: "разбери",
      stagedFileInstructions: "Файл уже лежит в inbox",
      imagePaths: ["/tmp/image.png"],
    }, createCallbacks());

    expect((appServer.requests[1]!.params as { input: unknown[] }).input).toEqual([
      { type: "text", text: "Файл уже лежит в inbox\n\nразбери", text_elements: [] },
      { type: "localImage", path: "/tmp/image.png" },
    ]);
  });

  it("maps command and file-change lifecycles to tool callbacks", async () => {
    const appServer = new FakeAppServer();
    const callbacks = createCallbacks();
    appServer.notificationsAfterTurnStart = [
      {
        method: "item/started",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          item: { id: "cmd-1", type: "commandExecution", command: "ls" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          item: { id: "cmd-1", type: "commandExecution", aggregatedOutput: "a\nb\n", status: "completed" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          item: {
            id: "patch-1",
            type: "fileChange",
            changes: [{ kind: "update", path: "src/a.ts" }],
            status: "completed",
          },
        },
      },
      {
        method: "turn/completed",
        params: { threadId: "0198-thread", turn: { id: "0198-turn", status: "completed" } },
      },
    ];
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);

    await service.prompt("work", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("ls", "cmd-1");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("cmd-1", false);
    expect(callbacks.onToolStart).toHaveBeenCalledWith("file_change", "patch-1");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("patch-1", false);
  });

  it("interrupts the active app-server turn", async () => {
    const appServer = new FakeAppServer();
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);
    const promptPromise = service.prompt("stop", createCallbacks());
    await vi.waitFor(() => expect(service.isProcessing()).toBe(true));
    await vi.waitFor(() => expect(appServer.requests.some((entry) => entry.method === "turn/start")).toBe(true));

    await service.abort();

    expect(appServer.requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "0198-thread", turnId: "0198-turn" },
    });
    appServer.emit("turn/completed", {
      threadId: "0198-thread",
      turn: { id: "0198-turn", status: "interrupted" },
    });
    await promptPromise;
    expect(service.isProcessing()).toBe(false);
  });

  it("steers additional input into the active app-server turn", async () => {
    const appServer = new FakeAppServer();
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);
    const promptPromise = service.prompt("start", createCallbacks());
    await vi.waitFor(() => expect(service.isProcessing()).toBe(true));
    await vi.waitFor(() => expect(appServer.requests.some((entry) => entry.method === "turn/start")).toBe(true));

    await service.steer("focus on tests");

    expect(appServer.requests).toContainEqual({
      method: "turn/steer",
      params: {
        threadId: "0198-thread",
        input: [{ type: "text", text: "focus on tests", text_elements: [] }],
        expectedTurnId: "0198-turn",
      },
    });
    appServer.emit("turn/completed", {
      threadId: "0198-thread",
      turn: { id: "0198-turn", status: "completed" },
    });
    await promptPromise;
  });

  it("applies per-dialog model, reasoning, fast mode, access, and plan mode", async () => {
    const appServer = new FakeAppServer();
    appServer.notificationsAfterTurnStart = [
      {
        method: "turn/completed",
        params: { threadId: "0198-thread", turn: { id: "0198-turn", status: "completed" } },
      },
    ];
    const service = await CodexSessionService.create(createConfig(), {
      preferences: {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        serviceTier: "priority",
        sandboxMode: "read-only",
        approvalPolicy: "on-request",
      },
    }, appServer);

    await service.prompt("спланируй", createCallbacks(), { collaborationMode: "plan" });

    expect(appServer.requests[0]).toMatchObject({
      method: "thread/start",
      params: {
        model: "gpt-5.6-sol",
        serviceTier: "priority",
        approvalPolicy: "on-request",
        sandbox: "read-only",
      },
    });
    expect(appServer.requests.find((entry) => entry.method === "turn/start")).toMatchObject({
      method: "turn/start",
      params: {
        model: "gpt-5.6-sol",
        effort: "high",
        serviceTier: "priority",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.6-sol",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
      },
    });
  });

  it("uses the native Plan reasoning preset when the dialog has no override", async () => {
    const appServer = new FakeAppServer();
    appServer.notificationsAfterTurnStart = [
      {
        method: "turn/completed",
        params: { threadId: "0198-thread", turn: { id: "0198-turn", status: "completed" } },
      },
    ];
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);

    await service.prompt("спланируй", createCallbacks(), { collaborationMode: "plan" });

    expect(appServer.requests.find((entry) => entry.method === "turn/start")).toMatchObject({
      params: {
        collaborationMode: {
          mode: "plan",
          settings: { model: "gpt-5.4", reasoning_effort: "medium" },
        },
      },
    });
  });

  it("starts native inline reviews", async () => {
    const appServer = new FakeAppServer();
    appServer.notificationsAfterTurnStart = [
      {
        method: "turn/completed",
        params: { threadId: "0198-thread", turn: { id: "0198-turn", status: "completed" } },
      },
    ];
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);

    await service.review(createCallbacks());

    expect(appServer.requests).toContainEqual({
      method: "review/start",
      params: {
        threadId: "0198-thread",
        delivery: "inline",
        target: { type: "uncommittedChanges" },
      },
    });
  });

  it("routes agent questions and approvals to the active Telegram callbacks", async () => {
    const appServer = new FakeAppServer();
    const callbacks = createCallbacks();
    callbacks.onRequestUserInput = vi.fn(async () => ({
      answers: { mode: { answers: ["Безопасно"] } },
    }));
    callbacks.onRequestApproval = vi.fn(async () => ({ decision: "accept" }));
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);
    const prompt = service.prompt("сделай", callbacks);
    await vi.waitFor(() => expect(service.isProcessing()).toBe(true));
    await vi.waitFor(() => expect(appServer.requests.some((entry) => entry.method === "turn/start")).toBe(true));

    const answer = await appServer.emitServerRequest({
      id: 1,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "0198-thread",
        turnId: "0198-turn",
        questions: [{ id: "mode", header: "Режим", question: "Как делать?", options: [] }],
      },
    });
    const approval = await appServer.emitServerRequest({
      id: 2,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "0198-thread", turnId: "0198-turn", command: "npm test" },
    });

    expect(answer).toEqual({ answers: { mode: { answers: ["Безопасно"] } } });
    expect(approval).toEqual({ decision: "accept" });
    appServer.emit("turn/completed", {
      threadId: "0198-thread",
      turn: { id: "0198-turn", status: "completed" },
    });
    await prompt;
  });

  it("tracks a spawned subagent until it is interrupted", async () => {
    const appServer = new FakeAppServer();
    const callbacks = createCallbacks();
    appServer.notificationsAfterTurnStart = [
      {
        method: "item/started",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          item: {
            id: "sub-1-start",
            type: "subAgentActivity",
            agentThreadId: "agent-1",
            agentPath: "research",
            kind: "started",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "0198-thread",
          turnId: "0198-turn",
          item: {
            id: "sub-1-stop",
            type: "subAgentActivity",
            agentThreadId: "agent-1",
            agentPath: "research",
            kind: "interrupted",
          },
        },
      },
      {
        method: "turn/completed",
        params: { threadId: "0198-thread", turn: { id: "0198-turn", status: "completed" } },
      },
    ];
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);

    await service.prompt("исследуй", callbacks);

    expect((callbacks.onSubagentCount as ReturnType<typeof vi.fn> | undefined)?.mock.calls)
      .toEqual([[1], [0]]);
  });

  it("rejects failed turns and clears processing state", async () => {
    const appServer = new FakeAppServer();
    appServer.notificationsAfterTurnStart = [
      {
        method: "turn/completed",
        params: {
          threadId: "0198-thread",
          turn: { id: "0198-turn", status: "failed", error: { message: "boom" } },
        },
      },
    ];
    const service = await CodexSessionService.create(createConfig(), undefined, appServer);

    await expect(service.prompt("fail", createCallbacks())).rejects.toThrow("boom");
    expect(service.isProcessing()).toBe(false);
  });

});
