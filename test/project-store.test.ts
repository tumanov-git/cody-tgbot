import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProjectStore } from "../src/project-store.js";

describe("ProjectStore", () => {
  let root: string;
  let workspace: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cody-projects-test-"));
    workspace = path.join(root, "weather-bot");
    await mkdir(workspace);
    store = new ProjectStore({
      rootDirectory: path.join(root, "registry"),
      approvedDirectories: [root],
      memoryCharLimit: 180,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates one project per canonical workspace", async () => {
    const first = await store.create({
      id: "weather-bot",
      name: "Погода",
      description: "Короткий прогноз в Telegram",
      workspace,
    });
    const duplicate = await store.create({
      id: "another-id",
      name: "Дубль",
      description: "Не должен появиться",
      workspace,
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.project.id).toBe("weather-bot");
    expect(await store.list()).toHaveLength(1);
  });

  it("applies memory changes atomically and builds discussion context", async () => {
    await store.create({
      id: "weather-bot",
      name: "Погода",
      description: "Короткий прогноз в Telegram",
      workspace,
      services: ["weather-bot.service"],
    });

    expect((await store.applyMemory("weather-bot", [
      { action: "add", content: "Прогноз должен помещаться в одно сообщение." },
      { action: "add", content: "Не показывать технические данные API." },
    ])).success).toBe(true);
    expect((await store.applyMemory("weather-bot", [
      {
        action: "replace",
        oldText: "одно сообщение",
        content: "Прогноз должен помещаться в одно короткое сообщение.",
      },
      { action: "remove", oldText: "технические данные" },
    ])).success).toBe(true);

    expect(await store.readMemory("weather-bot")).toEqual([
      "Прогноз должен помещаться в одно короткое сообщение.",
    ]);
    const context = await store.renderDiscussionContext("weather-bot");
    expect(context).toContain("project_id: weather-bot");
    expect(context).toContain("Диалог не принадлежит проекту");
    expect(context).toContain("weather-bot.service");
  });

  it("rejects an overflowing batch without changing memory", async () => {
    await store.create({
      id: "weather-bot",
      name: "Погода",
      description: "Короткий прогноз в Telegram",
      workspace,
    });
    await store.applyMemory("weather-bot", [{ action: "add", content: "Короткая запись" }]);

    const result = await store.applyMemory("weather-bot", [
      { action: "remove", oldText: "Короткая" },
      { action: "add", content: "Слишком длинная запись ".repeat(20) },
    ]);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(await store.readMemory("weather-bot")).toEqual(["Короткая запись"]);
  });

  it("persists the avatar lifecycle without changing project identity", async () => {
    await store.create({
      id: "weather-bot",
      name: "Погода",
      description: "Короткий прогноз в Telegram",
      workspace,
      avatarBrief: "Коди ловит облако маленьким сачком.",
    });

    await store.updateAvatar("weather-bot", {
      status: "ready",
      scene: "Коди ловит облако маленьким сачком.",
      prompt: "Square black ink avatar.",
      error: null,
      telegramFileId: "telegram-file-id",
    });

    expect(await store.get("weather-bot")).toMatchObject({
      id: "weather-bot",
      avatar: {
        status: "ready",
        brief: "Коди ловит облако маленьким сачком.",
        telegramFileId: "telegram-file-id",
        version: 1,
      },
    });
    expect(store.avatarTelegramPath("weather-bot")).toBe(
      path.join(root, "registry", "weather-bot", "avatar", "telegram.jpg"),
    );
  });

  it("restores a corrupted project card from its backup", async () => {
    await store.create({
      id: "weather-bot",
      name: "Погода",
      description: "Короткий прогноз в Telegram",
      workspace,
    });
    await writeFile(path.join(root, "registry", "weather-bot", "project.json"), "{broken");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await store.get("weather-bot")).toMatchObject({
      id: "weather-bot",
      name: "Погода",
    });
    expect(warning).toHaveBeenCalledWith("Project weather-bot restored from backup");
    warning.mockRestore();
  });

  it("reports project cards that cannot be restored", async () => {
    const brokenDirectory = path.join(root, "registry", "broken-project");
    await mkdir(brokenDirectory, { recursive: true });
    await writeFile(path.join(brokenDirectory, "project.json"), "{broken");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await store.listWithIssues();

    expect(result.projects).toEqual([]);
    expect(result.unreadableIds).toEqual(["broken-project"]);
    warning.mockRestore();
  });
});
