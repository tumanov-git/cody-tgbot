import { describe, expect, it, vi } from "vitest";

import { TaskScheduler } from "../src/task-scheduler.js";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

describe("TaskScheduler", () => {
  it("runs one task per context while respecting the global parallel limit", async () => {
    const started: string[] = [];
    const finishers: Array<() => void> = [];
    const scheduler = new TaskScheduler({ maxParallel: 2 });

    scheduler.enqueue("vasya", () => new Promise<void>((resolve) => {
      started.push("vasya-1");
      finishers.push(resolve);
    }));
    scheduler.enqueue("vasya", () => new Promise<void>((resolve) => {
      started.push("vasya-2");
      finishers.push(resolve);
    }));
    scheduler.enqueue("petya", () => new Promise<void>((resolve) => {
      started.push("petya-1");
      finishers.push(resolve);
    }));

    await flushMicrotasks();

    expect(started).toEqual(["vasya-1", "petya-1"]);
    expect(scheduler.getActiveCount()).toBe(2);
    expect(scheduler.pendingCountForContext("vasya")).toBe(2);

    finishers[0]?.();
    await flushMicrotasks();

    expect(started).toEqual(["vasya-1", "petya-1", "vasya-2"]);
  });

  it("reports queued position and clears pending tasks for a context", async () => {
    const scheduler = new TaskScheduler({ maxParallel: 1 });

    const first = scheduler.enqueue("chat", () => new Promise<void>(() => {}));
    const second = scheduler.enqueue("chat", () => {});
    const third = scheduler.enqueue("chat", () => {});

    await flushMicrotasks();

    expect(first.startedImmediately).toBe(true);
    expect(second.startedImmediately).toBe(false);
    expect(second.position).toBe(2);
    expect(third.position).toBe(3);
    expect(scheduler.clear("chat")).toBe(2);
    expect(scheduler.pendingCountForContext("chat")).toBe(1);
  });

  it("passes task errors to the error callback and continues draining", async () => {
    const onTaskError = vi.fn();
    const started: string[] = [];
    const scheduler = new TaskScheduler({ maxParallel: 1, onTaskError });

    scheduler.enqueue("one", () => {
      started.push("bad");
      throw new Error("boom");
    });
    scheduler.enqueue("two", () => {
      started.push("good");
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(onTaskError).toHaveBeenCalledOnce();
    expect(started).toEqual(["bad", "good"]);
  });

  it("removes one selected queued task without touching its neighbors", async () => {
    const started: string[] = [];
    let finishFirst!: () => void;
    const scheduler = new TaskScheduler({ maxParallel: 1 });

    scheduler.enqueue("chat", () => new Promise<void>((resolve) => {
      started.push("first");
      finishFirst = resolve;
    }));
    const second = scheduler.enqueue("chat", () => {
      started.push("second");
    });
    scheduler.enqueue("chat", () => {
      started.push("third");
    });

    await flushMicrotasks();
    expect(scheduler.remove("chat", second.id)).toBe(true);
    expect(scheduler.remove("chat", second.id)).toBe(false);

    finishFirst();
    await flushMicrotasks();
    expect(started).toEqual(["first", "third"]);
  });

  it("keeps a persisted task id when restoring a queued job", () => {
    const scheduler = new TaskScheduler({ maxParallel: 1 });
    const receipt = scheduler.enqueue(
      "chat",
      () => new Promise<void>(() => {}),
      "task-11111111-1111-4111-8111-111111111111",
    );

    expect(receipt.id).toBe("task-11111111-1111-4111-8111-111111111111");
  });
});
