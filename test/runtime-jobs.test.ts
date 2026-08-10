import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeJobStore, type RuntimeJob } from "../src/runtime-jobs.js";

describe("RuntimeJobStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cody-runtime-jobs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists queued and running jobs across store instances", async () => {
    const store = new RuntimeJobStore(root);
    const job = createJob();
    await store.put(job);
    await store.patch(job.id, {
      status: "running",
      liveMessageId: 777,
      startedAt: "2026-08-07T19:00:01.000Z",
    });

    const restored = await new RuntimeJobStore(root).list();

    expect(restored).toEqual([expect.objectContaining({
      id: job.id,
      status: "running",
      liveMessageId: 777,
      resumeThreadId: "thread-1",
    })]);
    expect((await stat(path.join(root, "jobs.json"))).mode & 0o777).toBe(0o600);
  });

  it("removes a terminal job atomically", async () => {
    const store = new RuntimeJobStore(root);
    const job = createJob();
    await store.put(job);

    expect(await store.remove(job.id)).toMatchObject({ id: job.id });
    expect(await new RuntimeJobStore(root).list()).toEqual([]);
    expect(JSON.parse(await readFile(path.join(root, "jobs.json"), "utf8"))).toEqual({
      version: 1,
      jobs: [],
    });
  });

  it("ignores malformed persisted jobs", async () => {
    await writeFile(path.join(root, "jobs.json"), JSON.stringify({
      version: 1,
      jobs: [
        createJob(),
        { ...createJob(), id: "bad-cleanup", cleanupPaths: ["/tmp/ok", 42] },
        { ...createJob(), id: "bad-input", userInput: { imagePaths: "not-an-array" } },
      ],
    }));

    expect(await new RuntimeJobStore(root).list()).toEqual([
      expect.objectContaining({ id: createJob().id }),
    ]);
  });
});

function createJob(): RuntimeJob {
  return {
    id: "task-11111111-1111-4111-8111-111111111111",
    status: "queued",
    contextKey: "123",
    chatId: 123,
    userInput: "проверь сервис",
    displayText: "проверь сервис",
    workspace: "/workspace",
    createdAt: "2026-08-07T19:00:00.000Z",
    updateId: 100,
    privateChat: true,
    turnId: "turn-1",
    outDir: "/workspace/.cody-tgbot/turns/turn-1/out",
    resumeThreadId: "thread-1",
  };
}
