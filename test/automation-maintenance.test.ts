import { access, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { maintainAutomations } from "../src/automation-maintenance.js";
import { AutomationStore } from "../src/automation-store.js";
import { ProjectStore } from "../src/project-store.js";

describe("automation maintenance", () => {
  it("removes old completed run files but preserves pending delivery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cody-automation-maintenance-test-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const projectStore = new ProjectStore({
      rootDirectory: path.join(root, "projects"),
      approvedDirectories: [root],
    });
    await projectStore.create({
      id: "cody",
      name: "Коди",
      description: "Telegram-интерфейс",
      workspace,
    });
    const store = new AutomationStore(path.join(root, "automations.db"));
    const automation = store.create({
      projectId: "cody",
      name: "Обзор",
      description: "Собирает изменения",
      instruction: "Собери изменения.",
      schedule: { kind: "interval", everyMinutes: 60 },
      scheduleDescription: "каждый час",
      contextKey: "100",
      chatId: 100,
    }, new Date("2026-08-06T10:00:00.000Z"));

    const completed = store.claimNow(automation.id, new Date("2026-08-06T10:01:00.000Z"), "runner");
    store.markRunning(completed.execution.id, "runner");
    store.finish(
      completed.execution.id,
      { status: "silent", result: "[SILENT]" },
      new Date("2026-08-06T10:02:00.000Z"),
      { runnerId: "runner", deliveryRequired: false },
    );
    const pending = store.claimNow(automation.id, new Date("2026-08-06T11:01:00.000Z"), "runner");
    store.markRunning(pending.execution.id, "runner");
    store.finish(
      pending.execution.id,
      { status: "success", result: "Отчёт" },
      new Date("2026-08-06T11:02:00.000Z"),
      { runnerId: "runner" },
    );
    const turns = path.join(workspace, ".cody-tgbot", "turns");
    const completedDirectory = path.join(turns, completed.execution.id);
    const pendingDirectory = path.join(turns, pending.execution.id);
    await mkdir(completedDirectory, { recursive: true });
    await mkdir(pendingDirectory, { recursive: true });
    const old = new Date("2026-08-06T12:00:00.000Z");
    await utimes(completedDirectory, old, old);
    await utimes(pendingDirectory, old, old);

    const result = await maintainAutomations(store, projectStore, new Date("2026-08-07T12:01:00.000Z"));

    expect(result.runDirectoriesRemoved).toBe(1);
    await expect(access(completedDirectory)).rejects.toThrow();
    await expect(access(pendingDirectory)).resolves.toBeUndefined();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
});
