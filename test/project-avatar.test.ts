import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildAvatarPrompt,
  ProjectAvatarService,
  type ProjectAvatarGenerator,
} from "../src/project-avatar.js";
import { ProjectStore } from "../src/project-store.js";

describe("project avatars", () => {
  let root: string;
  let workspace: string;
  let store: ProjectStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cody-avatar-test-"));
    workspace = path.join(root, "weather-bot");
    await mkdir(workspace);
    store = new ProjectStore({
      rootDirectory: path.join(root, "registry"),
      approvedDirectories: [root],
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the Cody canon outside the creative scene", () => {
    const prompt = buildAvatarPrompt({
      scene: "Коди ловит облако маленьким сачком.",
      objects: ["облако", "сачок"],
    });

    expect(prompt).toContain("Коди ловит облако");
    expect(prompt).toContain("rectangular black-outline glasses");
    expect(prompt).toContain("No words, letters, numbers");
    expect(prompt).toContain("No color, gray fills, shading");
    expect(prompt).toContain("one simple visual metaphor");
  });

  it("keeps the previous avatar visible when regeneration fails", async () => {
    await store.create({
      id: "weather-bot",
      name: "Погода",
      description: "Короткий прогноз в Telegram",
      workspace,
    });
    await mkdir(store.avatarDirectory("weather-bot"), { recursive: true });
    await writeFile(store.avatarTelegramPath("weather-bot"), "previous-avatar");
    await store.updateAvatar("weather-bot", {
      status: "ready",
      telegramFileId: "previous-file-id",
    });
    const service = new ProjectAvatarService(store, {
      generator: {
        generate: async () => {
          throw new Error("image service unavailable");
        },
      },
    });

    await service.request("weather-bot");
    await service.whenIdle();

    expect(await store.get("weather-bot")).toMatchObject({
      avatar: {
        status: "failed",
        telegramFileId: "previous-file-id",
        error: "image service unavailable",
      },
    });
    expect(await readFile(store.avatarTelegramPath("weather-bot"), "utf8"))
      .toBe("previous-avatar");
  });

  it("persists a failed background generation without breaking the project", async () => {
    await store.create({
      id: "weather-bot",
      name: "Погода",
      description: "Короткий прогноз в Telegram",
      workspace,
    });
    const generator: ProjectAvatarGenerator = {
      generate: async () => {
        throw new Error("image service unavailable");
      },
    };
    const service = new ProjectAvatarService(store, { generator });

    await service.start();
    await service.whenIdle();

    expect(await store.get("weather-bot")).toMatchObject({
      name: "Погода",
      avatar: {
        status: "failed",
        error: "image service unavailable",
      },
    });
  });

  it("returns an interrupted generation to the queue during shutdown", async () => {
    await store.create({
      id: "weather-bot",
      name: "Погода",
      description: "Короткий прогноз в Telegram",
      workspace,
    });
    let rejectGeneration: ((error: Error) => void) | undefined;
    let generationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });
    const generator: ProjectAvatarGenerator = {
      generate: async () => new Promise((_, reject) => {
        rejectGeneration = reject;
        generationStarted?.();
      }),
      dispose: () => rejectGeneration?.(new Error("Codex остановлен сигналом SIGTERM")),
    };
    const service = new ProjectAvatarService(store, { generator });

    await service.start();
    await started;
    service.dispose();
    await service.whenIdle();

    expect(await store.get("weather-bot")).toMatchObject({
      avatar: {
        status: "pending",
      },
    });
    expect((await store.get("weather-bot"))?.avatar?.error).toBeUndefined();
  });
});
