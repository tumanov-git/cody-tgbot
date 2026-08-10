import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AutomationStore } from "../src/automation-store.js";
import { AutomationToolRuntime } from "../src/automation-tools.js";
import { ProjectStore } from "../src/project-store.js";

describe("AutomationToolRuntime", () => {
  let root: string;
  let workspace: string;
  let automationStore: AutomationStore;
  let projectStore: ProjectStore;
  const scheduler = {
    wake: vi.fn(),
    runNow: vi.fn(),
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cody-automation-tools-test-"));
    workspace = path.join(root, "cody");
    await mkdir(workspace);
    automationStore = new AutomationStore(path.join(root, "automations.db"));
    projectStore = new ProjectStore({
      rootDirectory: path.join(root, "projects"),
      approvedDirectories: [root],
    });
    scheduler.wake.mockClear();
    scheduler.runNow.mockClear();
  });

  afterEach(async () => {
    automationStore.close();
    await rm(root, { recursive: true, force: true });
  });

  it("creates an automation only for an existing project and captures its dialog", async () => {
    await projectStore.create({
      id: "cody",
      name: "Коди",
      description: "Telegram-интерфейс для Codex",
      workspace,
    });
    const runtime = new AutomationToolRuntime({
      store: automationStore,
      scheduler,
      projectStore,
      resolveContext: () => ({ contextKey: "100:7" }),
      defaultTimezone: "Europe/Moscow",
    });
    const response = await runtime.handle(toolCall({
      action: "create",
      project_id: "cody",
      name: "Недельный обзор",
      description: "По пятницам собирает важные изменения проекта и молчит без новостей",
      instruction: "Изучи изменения проекта за неделю и подготовь короткий отчёт.",
      schedule_type: "cron",
      cron_expression: "0 18 * * 5",
    }));

    expect(response.success).toBe(true);
    expect(JSON.parse(response.text)).toMatchObject({ success: true, done: true });
    expect(automationStore.list()).toEqual([
      expect.objectContaining({
        projectId: "cody",
        contextKey: "100:7",
        chatId: 100,
        messageThreadId: 7,
        schedule: expect.objectContaining({ timezone: "Europe/Moscow" }),
        scheduleDescription: "По пятницам в 18:00",
      }),
    ]);
    expect(scheduler.wake).toHaveBeenCalledOnce();
  });

  it("returns the available projects instead of creating an unbound automation", async () => {
    await projectStore.create({
      id: "cody",
      name: "Коди",
      description: "Telegram-интерфейс для Codex",
      workspace,
    });
    const runtime = new AutomationToolRuntime({
      store: automationStore,
      scheduler,
      projectStore,
      resolveContext: () => ({ contextKey: "100" }),
      defaultTimezone: "Europe/Moscow",
    });
    const response = await runtime.handle(toolCall({
      action: "create",
      project_id: "missing",
      name: "Обзор",
      description: "Собирает изменения",
      instruction: "Собери изменения.",
      schedule_type: "once",
      run_at: "2099-01-01T12:00:00.000Z",
    }));

    expect(response.success).toBe(false);
    expect(JSON.parse(response.text)).toMatchObject({
      success: false,
      projects: [{ id: "cody", name: "Коди" }],
    });
    expect(automationStore.list()).toHaveLength(0);
  });
});

function toolCall(argumentsValue: Record<string, unknown>) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: null,
    tool: "automation",
    arguments: argumentsValue,
  };
}
