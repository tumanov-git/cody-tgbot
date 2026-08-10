import { ProjectWorkAbortedError, ProjectWorkLock } from "../src/project-work-lock.js";

describe("ProjectWorkLock", () => {
  it("serializes one project while allowing different projects in parallel", async () => {
    const lock = new ProjectWorkLock();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = lock.runExclusive("/project-a", async () => {
      events.push("a1:start");
      await firstGate;
      events.push("a1:end");
    });
    const second = lock.runExclusive("/project-a", async () => {
      events.push("a2:start");
    });
    const other = lock.runExclusive("/project-b", async () => {
      events.push("b:start");
    });

    await other;
    expect(events).toEqual(["a1:start", "b:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1:start", "b:start", "a1:end", "a2:start"]);
  });

  it("can abort work waiting for a project", async () => {
    const lock = new ProjectWorkLock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = lock.runExclusive("/project", () => gate);
    const controller = new AbortController();
    const waiting = lock.runExclusive("/project", async () => {}, controller.signal);

    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(ProjectWorkAbortedError);
    release();
    await active;
  });
});
