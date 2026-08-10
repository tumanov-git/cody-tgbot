import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProjectStore } from "../src/project-store.js";
import { ProjectToolRuntime } from "../src/project-tools.js";

describe("ProjectToolRuntime", () => {
  let root: string;
  let workspace: string;
  let store: ProjectStore;
  let runtime: ProjectToolRuntime;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cody-project-tools-test-"));
    workspace = path.join(root, "cody-app");
    await mkdir(workspace);
    store = new ProjectStore({
      rootDirectory: path.join(root, "registry"),
      approvedDirectories: [root],
      memoryCharLimit: 80,
    });
    runtime = new ProjectToolRuntime(store);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("registers a project through a native dynamic tool call", async () => {
    const schedule = vi.fn();
    runtime = new ProjectToolRuntime(store, { schedule });
    const result = await runtime.handle({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "project",
      arguments: {
        action: "create",
        id: "cody-app",
        name: "Коди",
        description: "Удобный Telegram-интерфейс для Codex",
        workspace,
        avatar_brief: "Коди управляет сообщениями и сервером из Telegram.",
      },
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ success: true, created: true });
    expect(await store.get("cody-app")).toMatchObject({
      name: "Коди",
      avatar: {
        status: "pending",
        brief: "Коди управляет сообщениями и сервером из Telegram.",
      },
    });
    expect(schedule).toHaveBeenCalledWith("cody-app");
  });

  it("stops memory retries after three failed batches in one turn", async () => {
    await store.create({
      id: "cody-app",
      name: "Коди",
      description: "Удобный Telegram-интерфейс для Codex",
      workspace,
    });
    const call = () => runtime.handle({
      threadId: "thread-1",
      turnId: "turn-overflow",
      callId: "call-memory",
      namespace: null,
      tool: "project_memory",
      arguments: {
        project_id: "cody-app",
        operations: [{ action: "add", content: "Переполнение ".repeat(30) }],
      },
    });

    expect(JSON.parse((await call()).text).done).not.toBe(true);
    expect(JSON.parse((await call()).text).done).not.toBe(true);
    expect(JSON.parse((await call()).text)).toMatchObject({ success: false, done: true });
  });
});
