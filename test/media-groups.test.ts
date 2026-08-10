import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Bot, Context } from "grammy";

import type { CodyConfig } from "../src/config.js";
import { MediaGroupController } from "../src/media-groups.js";
import type { TaskController } from "../src/task-controller.js";

describe("MediaGroupController", () => {
  let root: string;
  let controller: MediaGroupController;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cody-media-groups-"));
    const config: CodyConfig = {
      telegramBotToken: "token",
      telegramApiRoot: "https://api.telegram.org",
      telegramLocalMode: false,
      telegramAllowedUserIds: [123],
      telegramAllowedUserIdSet: new Set([123]),
      workspace: root,
      approvedDirectories: [root],
      maxFileSize: 20 * 1024 * 1024,
      codexSandboxMode: "workspace-write",
      codexApprovalPolicy: "never",
      maxParallelCodexTasks: 2,
    };
    controller = new MediaGroupController(
      { api: {} } as Bot<Context>,
      config,
      {} as TaskController,
    );
  });

  afterEach(async () => {
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("persists multiple Telegram updates as one pending album", async () => {
    await controller.accept(context(20, 200, "первая"), "123", "album-1", "file-b");
    await controller.accept(context(10, 100), "123", "album-1", "file-a");
    controller.dispose();

    const state = JSON.parse(await readFile(
      path.join(root, ".cody-tgbot", "runtime", "media-groups.json"),
      "utf8",
    ));

    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]).toMatchObject({ mediaGroupId: "album-1", contextKey: "123" });
    expect(state.groups[0].items.map((item: { fileId: string }) => item.fileId))
      .toEqual(["file-a", "file-b"]);
  });
});

function context(messageId: number, updateId: number, caption?: string): Context {
  return {
    chat: { id: 123, type: "private", first_name: "Тест" },
    update: { update_id: updateId },
    message: {
      message_id: messageId,
      date: 0,
      chat: { id: 123, type: "private", first_name: "Тест" },
      photo: [{ file_id: `photo-${messageId}`, file_unique_id: `unique-${messageId}`, width: 1, height: 1 }],
      ...(caption ? { caption } : {}),
    },
  } as unknown as Context;
}
