import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AutomationStore } from "../src/automation-store.js";

describe("AutomationStore", () => {
  let root: string;
  let store: AutomationStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cody-automations-test-"));
    store = new AutomationStore(path.join(root, "automations.db"));
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("persists a project-bound one-shot and claims it only once", () => {
    const created = store.create({
      projectId: "cody",
      name: "Проверка релиза",
      description: "Проверяет состояние проекта после обновления",
      instruction: "Проверь статус сервиса и свежие ошибки.",
      schedule: { kind: "once", at: "2026-08-07T12:05:00.000Z" },
      scheduleDescription: "сегодня в 12:05",
      contextKey: "100:5",
      chatId: 100,
      messageThreadId: 5,
    }, new Date("2026-08-07T12:00:00.000Z"));

    expect(created).toMatchObject({
      projectId: "cody",
      repeatLimit: 1,
      runCount: 0,
      state: "scheduled",
    });
    expect(store.claimDue(new Date("2026-08-07T12:04:59.000Z"))).toHaveLength(0);
    const [claim] = store.claimDue(new Date("2026-08-07T12:05:01.000Z"));
    expect(claim?.automation.runCount).toBe(1);
    expect(claim?.automation.nextRunAt).toBeUndefined();
    expect(store.claimDue(new Date("2026-08-07T13:00:00.000Z"))).toHaveLength(0);

    const finished = store.finish(claim!.execution.id, {
      status: "success",
      result: "Сервис работает",
    }, new Date("2026-08-07T12:06:00.000Z"));
    expect(finished).toMatchObject({
      state: "completed",
      lastStatus: "success",
      lastResult: "Сервис работает",
    });
  });

  it("collapses missed interval runs into one current run", () => {
    store.create({
      projectId: "cody",
      name: "Обзор",
      description: "Регулярно собирает изменения",
      instruction: "Собери изменения.",
      schedule: { kind: "interval", everyMinutes: 30 },
      scheduleDescription: "каждые 30 минут",
      contextKey: "100",
      chatId: 100,
    }, new Date("2026-08-07T10:00:00.000Z"));

    const [claim] = store.claimDue(new Date("2026-08-07T13:00:00.000Z"));
    expect(claim?.execution.scheduledFor).toBe("2026-08-07T10:30:00.000Z");
    expect(claim?.automation.nextRunAt).toBe("2026-08-07T13:30:00.000Z");
    expect(store.claimDue(new Date("2026-08-07T13:29:59.000Z"))).toHaveLength(0);
  });

  it("marks an interrupted attempt unknown without replaying a consumed one-shot", () => {
    const created = store.create({
      projectId: "cody",
      name: "Одно действие",
      description: "Выполняется один раз",
      instruction: "Выполни действие.",
      schedule: { kind: "once", at: "2026-08-07T12:01:00.000Z" },
      scheduleDescription: "через минуту",
      contextKey: "100",
      chatId: 100,
    }, new Date("2026-08-07T12:00:00.000Z"));
    const [claim] = store.claimDue(new Date("2026-08-07T12:01:00.000Z"));
    store.markRunning(claim!.execution.id);

    expect(store.recoverInterrupted(new Date("2026-08-07T12:02:00.000Z"))).toMatchObject({
      requeued: [],
      unknown: 1,
    });
    const recovered = store.require(created.id);
    expect(recovered).toMatchObject({
      state: "completed",
      lastStatus: "unknown",
    });
    expect(recovered.claimToken).toBeUndefined();
    expect(store.claimDue(new Date("2026-08-07T13:00:00.000Z"))).toHaveLength(0);
  });

  it("keeps a manual run separate from the recurring schedule", () => {
    const created = store.create({
      projectId: "cody",
      name: "Недельный обзор",
      description: "Собирает итоги недели",
      instruction: "Собери итоги.",
      schedule: { kind: "interval", everyMinutes: 60 },
      scheduleDescription: "каждый час",
      contextKey: "100",
      chatId: 100,
    }, new Date("2026-08-07T12:00:00.000Z"));
    const scheduledFor = created.nextRunAt;
    const claim = store.claimNow(created.id, new Date("2026-08-07T12:10:00.000Z"));
    store.finish(claim.execution.id, { status: "silent", result: "[SILENT]" });

    expect(store.require(created.id)).toMatchObject({
      nextRunAt: scheduledFor,
      runCount: 0,
      lastStatus: "silent",
    });
  });

  it("can reschedule a completed one-shot", () => {
    const created = store.create({
      projectId: "cody",
      name: "Проверка",
      description: "Проверяет проект один раз",
      instruction: "Проверь проект.",
      schedule: { kind: "once", at: "2026-08-07T12:01:00.000Z" },
      scheduleDescription: "через минуту",
      contextKey: "100",
      chatId: 100,
    }, new Date("2026-08-07T12:00:00.000Z"));
    const [claim] = store.claimDue(new Date("2026-08-07T12:01:00.000Z"));
    store.finish(claim!.execution.id, { status: "success", result: "Готово" });

    const updated = store.update(created.id, {
      schedule: { kind: "once", at: "2026-08-08T12:00:00.000Z" },
      scheduleDescription: "завтра в 12:00",
    }, new Date("2026-08-07T13:00:00.000Z"));

    expect(updated).toMatchObject({
      state: "scheduled",
      nextRunAt: "2026-08-08T12:00:00.000Z",
    });
  });

  it("separates a successful run from Telegram delivery and retries only delivery", () => {
    const created = createRecurring(store);
    const claim = store.claimNow(created.id, new Date("2026-08-07T12:01:00.000Z"), "runner-a");
    store.markRunning(claim.execution.id, "runner-a");
    store.finish(
      claim.execution.id,
      { status: "success", result: "Готовый обзор" },
      new Date("2026-08-07T12:02:00.000Z"),
      { runnerId: "runner-a" },
    );

    expect(store.listExecutions(created.id)[0]).toMatchObject({
      status: "success",
      result: "Готовый обзор",
      deliveryStatus: "pending",
      deliveryAttempts: 0,
    });
    const delivery = store.claimDelivery(claim.execution.id, "runner-a", new Date("2026-08-07T12:02:00.000Z"));
    expect(delivery).not.toBeNull();
    store.markDeliveryMainSent(claim.execution.id, "runner-a", 777);
    store.finishDelivery(
      claim.execution.id,
      "runner-a",
      "Telegram недоступен",
      new Date("2026-08-07T12:02:01.000Z"),
    );
    expect(store.listDueDeliveryIds(new Date("2026-08-07T12:02:30.000Z"))).toEqual([]);
    expect(store.listDueDeliveryIds(new Date("2026-08-07T12:03:02.000Z"))).toEqual([claim.execution.id]);

    const retry = store.claimDelivery(claim.execution.id, "runner-b", new Date("2026-08-07T12:03:02.000Z"));
    expect(retry?.execution.telegramMessageId).toBe(777);
    store.finishDelivery(claim.execution.id, "runner-b", undefined, new Date("2026-08-07T12:03:03.000Z"));
    expect(store.listExecutions(created.id)[0]).toMatchObject({
      status: "success",
      deliveryStatus: "delivered",
      deliveryAttempts: 2,
      telegramMessageId: 777,
    });
  });

  it("allows only one live scheduler lease", () => {
    expect(store.tryAcquireLease("runner-a", new Date("2026-08-07T12:00:00.000Z"))).toBe(true);
    expect(store.tryAcquireLease("runner-b", new Date("2026-08-07T12:00:20.000Z"))).toBe(false);
    expect(store.heartbeatLease("runner-a", new Date("2026-08-07T12:00:21.000Z"))).toBe(true);
    expect(store.tryAcquireLease("runner-b", new Date("2026-08-07T12:00:40.000Z"))).toBe(false);
    expect(store.tryAcquireLease("runner-b", new Date("2026-08-07T12:00:52.000Z"))).toBe(true);
    expect(store.heartbeatLease("runner-a", new Date("2026-08-07T12:00:53.000Z"))).toBe(false);
  });

  it("requeues a claimed run but never repeats one that had started", () => {
    const created = createRecurring(store);
    const queued = store.claimNow(created.id, new Date("2026-08-07T12:01:00.000Z"), "old-runner");
    const recovery = store.recoverInterrupted(new Date("2026-08-07T12:02:00.000Z"), "new-runner");
    expect(recovery.requeued).toHaveLength(1);
    expect(recovery.requeued[0]?.execution).toMatchObject({
      id: queued.execution.id,
      status: "claimed",
      runnerId: "new-runner",
    });
    store.markRunning(queued.execution.id, "new-runner");
    const secondRecovery = store.recoverInterrupted(new Date("2026-08-07T12:03:00.000Z"), "third-runner");
    expect(secondRecovery).toMatchObject({ requeued: [], unknown: 1 });
    expect(store.listExecutions(created.id)[0]).toMatchObject({
      status: "unknown",
      deliveryStatus: "pending",
    });
  });

  it("prunes old terminal history but preserves pending delivery", () => {
    const created = createRecurring(store);
    for (let index = 0; index < 4; index += 1) {
      const now = new Date(Date.UTC(2026, 4 + index, 1));
      const claim = store.claimNow(created.id, now, `runner-${index}`);
      store.markRunning(claim.execution.id, `runner-${index}`, now);
      store.finish(
        claim.execution.id,
        { status: "success", result: `Результат ${index}` },
        now,
        { runnerId: `runner-${index}`, deliveryRequired: index === 0 },
      );
    }

    expect(store.pruneHistory(new Date("2026-08-07T12:00:00.000Z"), 2, 30 * 24 * 60 * 60 * 1_000)).toBe(2);
    const history = store.listExecutions(created.id, 10);
    expect(history).toHaveLength(2);
    expect(history.some((execution) => execution.result === "Результат 0")).toBe(true);
    expect(history.filter((execution) => execution.deliveryStatus === "not_required")).toHaveLength(1);
  });

  it("rejects noisy schedules and deduplicates accidental creation", () => {
    const input = {
      projectId: "cody",
      name: "Частая проверка",
      description: "Проверяет изменения",
      instruction: "Проверь изменения.",
      schedule: { kind: "interval" as const, everyMinutes: 15 },
      contextKey: "100" as const,
      chatId: 100,
    };
    const first = store.create(input, new Date("2026-08-07T12:00:00.000Z"));
    const duplicate = store.create(input, new Date("2026-08-07T12:01:00.000Z"));

    expect(duplicate.id).toBe(first.id);
    expect(() => store.create({
      ...input,
      name: "Слишком часто",
      instruction: "Проверяй слишком часто.",
      schedule: { kind: "interval", everyMinutes: 5 },
    })).toThrow("не чаще раза в 15 минут");
  });

  it("limits active work per chat", () => {
    store.close();
    store = new AutomationStore(path.join(root, "limited.db"), { maxActivePerChat: 2 });
    const create = (index: number) => store.create({
      projectId: "cody",
      name: `Проверка ${index}`,
      description: "Проверяет проект",
      instruction: `Проверь проект ${index}.`,
      schedule: { kind: "interval", everyMinutes: 60 },
      contextKey: "100",
      chatId: 100,
    });

    create(1);
    create(2);
    expect(() => create(3)).toThrow("не больше 2 активных автоматизаций");
  });

  it("pauses after three failed runs and resets the streak after success", () => {
    const automation = createRecurring(store);
    for (let index = 0; index < 2; index += 1) {
      const runnerId = `runner-${index}`;
      const claim = store.claimNow(automation.id, new Date(), runnerId);
      store.markRunning(claim.execution.id, runnerId);
      store.finish(
        claim.execution.id,
        { status: "failed", error: "Сломалось" },
        new Date(),
        { runnerId, deliveryRequired: false },
      );
    }
    expect(store.require(automation.id).consecutiveFailures).toBe(2);

    const success = store.claimNow(automation.id, new Date(), "success-runner");
    store.markRunning(success.execution.id, "success-runner");
    store.finish(
      success.execution.id,
      { status: "success", result: "Исправилось" },
      new Date(),
      { runnerId: "success-runner", deliveryRequired: false },
    );
    expect(store.require(automation.id).consecutiveFailures).toBe(0);

    for (let index = 0; index < 3; index += 1) {
      const runnerId = `final-runner-${index}`;
      const claim = store.claimNow(automation.id, new Date(), runnerId);
      store.markRunning(claim.execution.id, runnerId);
      store.finish(
        claim.execution.id,
        { status: "failed", error: "Опять сломалось" },
        new Date(),
        { runnerId, deliveryRequired: false },
      );
    }
    expect(store.require(automation.id)).toMatchObject({
      state: "paused",
      consecutiveFailures: 3,
      pausedReason: expect.stringContaining("трёх неудачных запусков"),
    });
  });

  it("pauses recurring work after terminal Telegram delivery failure", () => {
    const automation = createRecurring(store);
    const claim = store.claimNow(automation.id, new Date("2026-08-07T12:00:00.000Z"), "runner");
    store.markRunning(claim.execution.id, "runner");
    store.finish(
      claim.execution.id,
      { status: "success", result: "Готово" },
      new Date("2026-08-07T12:01:00.000Z"),
      { runnerId: "runner" },
    );
    const attempts = [
      new Date("2026-08-07T12:01:00.000Z"),
      new Date("2026-08-07T12:02:01.000Z"),
      new Date("2026-08-07T12:07:02.000Z"),
    ];
    attempts.forEach((now, index) => {
      const runnerId = `delivery-${index}`;
      expect(store.claimDelivery(claim.execution.id, runnerId, now)).not.toBeNull();
      store.finishDelivery(claim.execution.id, runnerId, "Telegram недоступен", now);
    });

    expect(store.require(automation.id)).toMatchObject({
      state: "paused",
      pausedReason: expect.stringContaining("не удалось доставить"),
    });
  });

  it("keeps the last successful result when a later attempt fails", () => {
    const automation = createRecurring(store);
    const success = store.claimNow(automation.id, new Date("2026-08-07T12:01:00.000Z"), "success");
    store.markRunning(success.execution.id, "success");
    store.finish(
      success.execution.id,
      { status: "success", result: "Надёжная база сравнения" },
      new Date("2026-08-07T12:02:00.000Z"),
      { runnerId: "success", deliveryRequired: false },
    );
    const failure = store.claimNow(automation.id, new Date("2026-08-07T13:01:00.000Z"), "failure");
    store.markRunning(failure.execution.id, "failure");
    const failed = store.finish(
      failure.execution.id,
      { status: "failed", error: "Сеть недоступна" },
      new Date("2026-08-07T13:02:00.000Z"),
      { runnerId: "failure", deliveryRequired: false },
    );

    expect(failed).toMatchObject({
      lastStatus: "failed",
      lastSuccessfulAt: "2026-08-07T12:02:00.000Z",
      lastSuccessfulResult: "Надёжная база сравнения",
    });
    expect(failed.lastResult).toBeUndefined();
  });

  it("persists scheduler health and detects a stale tick", () => {
    const started = new Date("2026-08-07T12:00:00.000Z");
    store.recordSchedulerTickStarted(started);
    store.recordSchedulerTickCompleted(new Date("2026-08-07T12:00:01.000Z"));
    expect(store.readSchedulerHealth(new Date("2026-08-07T12:00:30.000Z"))).toMatchObject({
      status: "healthy",
      healthy: true,
      lastSuccessfulTickAt: "2026-08-07T12:00:01.000Z",
    });
    expect(store.readSchedulerHealth(new Date("2026-08-07T12:02:00.000Z"))).toMatchObject({
      status: "degraded",
      healthy: false,
    });
  });

  it("tracks every artifact independently across delivery retries", () => {
    const automation = createRecurring(store);
    const claim = store.claimNow(automation.id, new Date(), "runner");
    store.markRunning(claim.execution.id, "runner");
    store.finish(
      claim.execution.id,
      { status: "success", result: "Готово" },
      new Date(),
      { runnerId: "runner" },
    );
    expect(store.claimDelivery(claim.execution.id, "delivery")).not.toBeNull();
    store.syncArtifactDeliveries(claim.execution.id, [
      { name: "a.txt", sizeBytes: 10 },
      { name: "b.txt", sizeBytes: 20 },
    ]);
    expect(store.claimArtifactDelivery(claim.execution.id, "a.txt")).toMatchObject({ attempts: 1 });
    store.finishArtifactDelivery(claim.execution.id, "a.txt", 101);
    expect(store.claimArtifactDelivery(claim.execution.id, "b.txt")).toMatchObject({ attempts: 1 });
    store.finishArtifactDelivery(claim.execution.id, "b.txt", undefined, "Telegram недоступен");

    expect(store.listArtifactDeliveries(claim.execution.id)).toEqual([
      expect.objectContaining({ artifactName: "a.txt", status: "delivered", telegramMessageId: 101 }),
      expect.objectContaining({ artifactName: "b.txt", status: "failed", attempts: 1 }),
    ]);
    expect(store.claimArtifactDelivery(claim.execution.id, "a.txt")).toBeNull();
    expect(store.claimArtifactDelivery(claim.execution.id, "b.txt")).toMatchObject({ attempts: 2 });
  });
});

function createRecurring(store: AutomationStore) {
  return store.create({
    projectId: "cody",
    name: "Обзор",
    description: "Собирает изменения",
    instruction: "Собери изменения.",
    schedule: { kind: "interval", everyMinutes: 60 },
    scheduleDescription: "каждый час",
    contextKey: "100",
    chatId: 100,
  }, new Date("2026-08-07T12:00:00.000Z"));
}
