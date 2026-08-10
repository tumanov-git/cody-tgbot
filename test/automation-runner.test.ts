import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Context } from "grammy";

import { outboxPath } from "../src/attachments.js";
import { AutomationRunner } from "../src/automation-runner.js";
import { AutomationStore } from "../src/automation-store.js";
import type { CodexSessionCallbacks, CodexSessionService } from "../src/codex-session.js";
import { CodexSessionService as CodexSession } from "../src/codex-session.js";
import type { CodyConfig } from "../src/config.js";
import type { ProjectToolRuntime } from "../src/project-tools.js";
import { ProjectStore } from "../src/project-store.js";
import { ProjectWorkLock } from "../src/project-work-lock.js";

describe("AutomationRunner", () => {
  let root: string;
  let workspace: string;
  let automationStore: AutomationStore;
  let projectStore: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cody-automation-runner-test-"));
    workspace = path.join(root, "cody");
    await mkdir(workspace);
    automationStore = new AutomationStore(path.join(root, "automations.db"));
    projectStore = new ProjectStore({
      rootDirectory: path.join(root, "projects"),
      approvedDirectories: [root],
    });
    await projectStore.create({
      id: "cody",
      name: "Коди",
      description: "Telegram-интерфейс",
      workspace,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    automationStore.close();
    await rm(root, { recursive: true, force: true });
  });

  it("runs in an isolated session and returns the result to the originating topic", async () => {
    const automation = automationStore.create({
      projectId: "cody",
      name: "Недельный обзор",
      description: "Собирает важные изменения",
      instruction: "Собери итоги.",
      schedule: { kind: "once", at: "2026-08-07T12:01:00.000Z" },
      scheduleDescription: "через минуту",
      contextKey: "100:7",
      chatId: 100,
      messageThreadId: 7,
    }, new Date("2026-08-07T12:00:00.000Z"));
    const [claim] = automationStore.claimDue(new Date("2026-08-07T12:01:00.000Z"));
    const dispose = vi.fn();
    vi.spyOn(CodexSession, "create").mockResolvedValue({
      prompt: vi.fn(async (_input, callbacks: CodexSessionCallbacks) => {
        callbacks.onAgentMessageComplete?.("final-1", "Проект в порядке", "final_answer");
        callbacks.onAgentEnd("completed");
      }),
      dispose,
    } as unknown as CodexSessionService);
    const api = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 3 }),
    } as unknown as Context["api"];
    const runner = new AutomationRunner({
      api,
      config: config(root),
      store: automationStore,
      projectStore,
      projectTools: { handle: vi.fn() } as unknown as ProjectToolRuntime,
      projectWorkLock: new ProjectWorkLock(),
    });

    await runner.run(claim!);

    expect(api.sendRichMessage).toHaveBeenCalledWith(
      100,
      { markdown: "Проект в порядке" },
      expect.objectContaining({ message_thread_id: 7 }),
    );
    expect(automationStore.require(automation.id)).toMatchObject({
      state: "completed",
      lastStatus: "success",
      lastResult: "Проект в порядке",
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("interrupts an inactive run and records timeout separately from delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
    const automation = automationStore.create({
      projectId: "cody",
      name: "Долгая проверка",
      description: "Проверяет проект",
      instruction: "Проверь проект.",
      schedule: { kind: "interval", everyMinutes: 60 },
      scheduleDescription: "каждый час",
      contextKey: "100",
      chatId: 100,
    });
    const claim = automationStore.claimNow(automation.id);
    const abort = vi.fn().mockResolvedValue(undefined);
    const createSession = vi.spyOn(CodexSession, "create").mockResolvedValue({
      prompt: vi.fn(() => new Promise<void>(() => {})),
      abort,
      dispose: vi.fn(),
    } as unknown as CodexSessionService);
    const api = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 10 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 12 }),
    } as unknown as Context["api"];
    const runner = new AutomationRunner({
      api,
      config: config(root),
      store: automationStore,
      projectStore,
      projectTools: { handle: vi.fn() } as unknown as ProjectToolRuntime,
      projectWorkLock: new ProjectWorkLock(),
    });

    const running = runner.run(claim);
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    await running;

    expect(abort).toHaveBeenCalledOnce();
    expect(automationStore.listExecutions(automation.id)[0]).toMatchObject({
      status: "timed_out",
      deliveryStatus: "delivered",
    });
    expect(api.sendRichMessage).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ markdown: expect.stringContaining("15 минут") }),
      expect.any(Object),
    );
  });

  it("pauses an automation when its project disappears", async () => {
    const automation = automationStore.create({
      projectId: "cody",
      name: "Проверка проекта",
      description: "Проверяет проект",
      instruction: "Проверь проект.",
      schedule: { kind: "interval", everyMinutes: 60 },
      scheduleDescription: "каждый час",
      contextKey: "100",
      chatId: 100,
    });
    const claim = automationStore.claimNow(automation.id);
    await rm(path.join(root, "projects", "cody"), { recursive: true, force: true });
    const api = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 20 }),
    } as unknown as Context["api"];
    const runner = new AutomationRunner({
      api,
      config: config(root),
      store: automationStore,
      projectStore,
      projectTools: { handle: vi.fn() } as unknown as ProjectToolRuntime,
      projectWorkLock: new ProjectWorkLock(),
    });

    await runner.run(claim);

    expect(automationStore.require(automation.id)).toMatchObject({
      state: "paused",
      pausedReason: expect.stringContaining("больше не существует"),
      lastStatus: "failed",
    });
    expect(automationStore.listExecutions(automation.id)[0]).toMatchObject({
      status: "failed",
      deliveryStatus: "delivered",
    });
  });

  it("pauses a one-shot that is more than a day late", async () => {
    const automation = automationStore.create({
      projectId: "cody",
      name: "Старый запуск",
      description: "Должен был выполниться один раз",
      instruction: "Выполни действие.",
      schedule: { kind: "once", at: "2026-08-07T12:01:00.000Z" },
      contextKey: "100",
      chatId: 100,
    }, new Date("2026-08-07T12:00:00.000Z"));
    const [claim] = automationStore.claimDue(new Date("2026-08-09T12:01:00.000Z"));
    const api = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 30 }),
    } as unknown as Context["api"];
    const createSession = vi.spyOn(CodexSession, "create");
    const runner = new AutomationRunner({
      api,
      config: config(root),
      store: automationStore,
      projectStore,
      projectTools: { handle: vi.fn() } as unknown as ProjectToolRuntime,
      projectWorkLock: new ProjectWorkLock(),
    });

    await runner.run(claim!);

    expect(automationStore.require(automation.id)).toMatchObject({
      state: "paused",
      pausedReason: expect.stringContaining("больше чем на сутки"),
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("stops a run waiting for its project without counting a failure", async () => {
    const automation = automationStore.create({
      projectId: "cody",
      name: "Остановка",
      description: "Проверяет остановку",
      instruction: "Работай долго.",
      schedule: { kind: "interval", everyMinutes: 60 },
      contextKey: "100",
      chatId: 100,
    });
    const claim = automationStore.claimNow(automation.id, new Date(), "runner");
    const lock = new ProjectWorkLock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = lock.runExclusive(workspace, () => gate);
    const api = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 40 }),
    } as unknown as Context["api"];
    const runner = new AutomationRunner({
      api,
      config: config(root),
      store: automationStore,
      projectStore,
      projectTools: { handle: vi.fn() } as unknown as ProjectToolRuntime,
      projectWorkLock: lock,
    });

    const running = runner.run(claim, "runner");
    await vi.waitFor(() => expect(lock.isLocked(workspace)).toBe(true));
    expect(await runner.stop(claim.execution.id)).toBe(true);
    await running;
    release();
    await blocker;

    expect(automationStore.require(automation.id)).toMatchObject({
      state: "scheduled",
      consecutiveFailures: 0,
      lastError: "Остановлено пользователем",
    });
  });

  it("retries a transient session startup before any agent action", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
    const automation = automationStore.create({
      projectId: "cody",
      name: "Временный сбой",
      description: "Проверяет безопасный повтор",
      instruction: "Проверь проект.",
      schedule: { kind: "interval", everyMinutes: 60 },
      contextKey: "100",
      chatId: 100,
    });
    const claim = automationStore.claimNow(automation.id, new Date(), "runner");
    const createSession = vi.spyOn(CodexSession, "create")
      .mockRejectedValueOnce(new Error("429 too many requests"))
      .mockRejectedValueOnce(new Error("service unavailable"))
      .mockResolvedValue({
        prompt: vi.fn(async (_input, callbacks: CodexSessionCallbacks) => {
          callbacks.onAgentMessageComplete?.("final", "Всё работает", "final_answer");
          callbacks.onAgentEnd("completed");
        }),
        dispose: vi.fn(),
      } as unknown as CodexSessionService);
    const api = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 50 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 51 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 52 }),
    } as unknown as Context["api"];
    const runner = new AutomationRunner({
      api,
      config: config(root),
      store: automationStore,
      projectStore,
      projectTools: { handle: vi.fn() } as unknown as ProjectToolRuntime,
      projectWorkLock: new ProjectWorkLock(),
    });

    const running = runner.run(claim, "runner");
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_001);
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5_001);
    await running;

    expect(createSession).toHaveBeenCalledTimes(3);
    expect(automationStore.require(automation.id)).toMatchObject({
      lastStatus: "success",
      lastSuccessfulResult: "Всё работает",
    });
  });

  it("pauses immediately when Codex configuration is invalid", async () => {
    const automation = automationStore.create({
      projectId: "cody",
      name: "Сломанная авторизация",
      description: "Проверяет preflight ошибок запуска",
      instruction: "Проверь проект.",
      schedule: { kind: "interval", everyMinutes: 60 },
      contextKey: "100",
      chatId: 100,
    });
    const claim = automationStore.claimNow(automation.id, new Date(), "runner");
    const createSession = vi.spyOn(CodexSession, "create")
      .mockRejectedValue(new Error("invalid API key"));
    const api = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 55 }),
    } as unknown as Context["api"];
    const runner = new AutomationRunner({
      api,
      config: config(root),
      store: automationStore,
      projectStore,
      projectTools: { handle: vi.fn() } as unknown as ProjectToolRuntime,
      projectWorkLock: new ProjectWorkLock(),
    });

    await runner.run(claim, "runner");

    expect(createSession).toHaveBeenCalledOnce();
    expect(automationStore.require(automation.id)).toMatchObject({
      state: "paused",
      consecutiveFailures: 0,
      pausedReason: expect.stringContaining("Codex не авторизован"),
    });
  });

  it("retries only the artifact that was not confirmed by Telegram", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
    const automation = automationStore.create({
      projectId: "cody",
      name: "Файлы",
      description: "Отправляет два файла",
      instruction: "Собери файлы.",
      schedule: { kind: "interval", everyMinutes: 60 },
      contextKey: "100",
      chatId: 100,
    });
    const claim = automationStore.claimNow(automation.id, new Date(), "runner");
    automationStore.markRunning(claim.execution.id, "runner");
    automationStore.finish(
      claim.execution.id,
      { status: "success", result: "Файлы готовы" },
      new Date(),
      { runnerId: "runner" },
    );
    const outDir = outboxPath(workspace, claim.execution.id);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "a.txt"), "a");
    await writeFile(path.join(outDir, "b.txt"), "b");
    const sendDocument = vi.fn()
      .mockResolvedValueOnce({ message_id: 61 })
      .mockRejectedValueOnce(new Error("Telegram недоступен"))
      .mockResolvedValueOnce({ message_id: 62 });
    const api = {
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 60 }),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 63 }),
      sendDocument,
    } as unknown as Context["api"];
    const runner = new AutomationRunner({
      api,
      config: config(root),
      store: automationStore,
      projectStore,
      projectTools: { handle: vi.fn() } as unknown as ProjectToolRuntime,
      projectWorkLock: new ProjectWorkLock(),
    });

    await runner.deliver(claim.execution.id, "delivery-1");
    await vi.advanceTimersByTimeAsync(61_000);
    await runner.deliver(claim.execution.id, "delivery-2");

    expect(api.sendRichMessage).toHaveBeenCalledOnce();
    expect(sendDocument).toHaveBeenCalledTimes(3);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(automationStore.listArtifactDeliveries(claim.execution.id)).toEqual([
      expect.objectContaining({ artifactName: "a.txt", status: "delivered", attempts: 1 }),
      expect.objectContaining({ artifactName: "b.txt", status: "delivered", attempts: 2 }),
    ]);
    expect(automationStore.listExecutions(automation.id)[0]).toMatchObject({
      deliveryStatus: "delivered",
      artifactSummaryMessageId: 63,
    });
  });
});

function config(root: string): CodyConfig {
  return {
    telegramBotToken: "token",
    telegramApiRoot: "https://api.telegram.org",
    telegramLocalMode: false,
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: root,
    approvedDirectories: [root],
    maxFileSize: 20 * 1024 * 1024,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    maxParallelCodexTasks: 2,
    automationTimezone: "Europe/Moscow",
    automationMinIntervalMinutes: 15,
    maxActiveAutomations: 20,
    maxParallelAutomations: 2,
  };
}
