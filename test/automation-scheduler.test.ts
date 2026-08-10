import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AutomationScheduler } from "../src/automation-scheduler.js";
import { AutomationStore } from "../src/automation-store.js";

describe("AutomationScheduler", () => {
  let root: string;
  let store: AutomationStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
    root = await mkdtemp(path.join(os.tmpdir(), "cody-automation-scheduler-test-"));
    store = new AutomationStore(path.join(root, "automations.db"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("fires a due job once and persists its result", async () => {
    const automation = store.create({
      projectId: "cody",
      name: "Проверка",
      description: "Проверяет проект",
      instruction: "Проверь проект.",
      schedule: { kind: "once", at: "2026-08-07T12:00:30.000Z" },
      scheduleDescription: "через 30 секунд",
      contextKey: "100",
      chatId: 100,
    });
    const runner = {
      run: vi.fn(async (claim, runnerId: string) => {
        store.markRunning(claim.execution.id, runnerId);
        store.finish(
          claim.execution.id,
          { status: "success", result: "Готово" },
          new Date(),
          { runnerId, deliveryRequired: false },
        );
      }),
      deliver: vi.fn(async () => {}),
    };
    const scheduler = new AutomationScheduler({
      store,
      runner,
      tickIntervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(scheduler.getHealth()).toMatchObject({
      status: "healthy",
      healthy: true,
      runningCount: 0,
    });
    scheduler.dispose();

    expect(runner.run).toHaveBeenCalledOnce();
    expect(store.require(automation.id)).toMatchObject({
      state: "completed",
      runCount: 1,
      lastStatus: "success",
      lastResult: "Готово",
    });
  });

  it("keeps due work unclaimed while account-backed launches are disabled", async () => {
    const automation = store.create({
      projectId: "cody",
      name: "Отложенная проверка",
      description: "Ждёт входа",
      instruction: "Проверь проект.",
      schedule: { kind: "once", at: "2026-08-07T12:00:01.000Z" },
      scheduleDescription: "через секунду",
      contextKey: "100",
      chatId: 100,
    });
    const runner = { run: vi.fn(async () => {}), deliver: vi.fn(async () => {}) };
    const scheduler = new AutomationScheduler({ store, runner, tickIntervalMs: 1_000 });
    scheduler.setLaunchEnabled(false);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runner.run).not.toHaveBeenCalled();
    expect(store.require(automation.id).state).toBe("scheduled");

    scheduler.setLaunchEnabled(true);
    await vi.advanceTimersByTimeAsync(1_001);
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledOnce());
    scheduler.dispose();
  });

  it("lets only one scheduler instance claim work", async () => {
    store.create({
      projectId: "cody",
      name: "Проверка аренды",
      description: "Проверяет один планировщик",
      instruction: "Проверь проект.",
      schedule: { kind: "once", at: "2026-08-07T12:00:30.000Z" },
      scheduleDescription: "через 30 секунд",
      contextKey: "100",
      chatId: 100,
    });
    const runs: string[] = [];
    const runner = {
      run: vi.fn(async (claim, runnerId: string) => {
        runs.push(runnerId);
        store.markRunning(claim.execution.id, runnerId);
        store.finish(
          claim.execution.id,
          { status: "silent", result: "[SILENT]" },
          new Date(),
          { runnerId, deliveryRequired: false },
        );
      }),
      deliver: vi.fn(async () => {}),
    };
    const first = new AutomationScheduler({
      store,
      runner,
      tickIntervalMs: 1_000,
      instanceId: "first",
    });
    const second = new AutomationScheduler({
      store,
      runner,
      tickIntervalMs: 1_000,
      instanceId: "second",
    });

    first.start();
    second.start();
    await vi.advanceTimersByTimeAsync(31_000);
    first.dispose();
    second.dispose();

    expect(runner.run).toHaveBeenCalledOnce();
    expect(runs).toEqual(["first"]);
  });

  it("records a failed tick and recovers on the next one", async () => {
    const claimDue = vi.spyOn(store, "claimDue")
      .mockImplementationOnce(() => { throw new Error("database temporarily busy"); });
    const scheduler = new AutomationScheduler({
      store,
      runner: { run: vi.fn(async () => {}), deliver: vi.fn(async () => {}) },
      tickIntervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(scheduler.getHealth().status).toBe("degraded"));
    expect(scheduler.getHealth().lastTickError).toContain("temporarily busy");
    await vi.advanceTimersByTimeAsync(1_001);
    await vi.waitFor(() => expect(scheduler.getHealth().status).toBe("healthy"));
    scheduler.dispose();

    expect(claimDue).toHaveBeenCalledTimes(2);
  });
});
