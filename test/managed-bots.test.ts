import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ManagedBotService } from "../src/managed-bots.js";
import { ProjectStore } from "../src/project-store.js";

describe("ManagedBotService", () => {
  let root: string;
  let workspace: string;
  let projectStore: ProjectStore;
  let getManagedBotToken: ReturnType<typeof vi.fn>;
  let editMessageReplyMarkup: ReturnType<typeof vi.fn>;
  let service: ManagedBotService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cody-managed-bots-test-"));
    workspace = path.join(root, "weather-bot");
    await mkdir(workspace);
    projectStore = new ProjectStore({
      rootDirectory: path.join(root, "projects"),
      approvedDirectories: [root],
    });
    await projectStore.create({
      id: "weather-bot",
      name: "Погодный бот",
      description: "Отвечает на вопросы о погоде",
      workspace,
    });
    getManagedBotToken = vi.fn().mockResolvedValue("123456:secret-test-token");
    editMessageReplyMarkup = vi.fn().mockResolvedValue(undefined);
    service = new ManagedBotService({
      rootDirectory: path.join(root, "managed-bots"),
      api: {
        getMe: vi.fn().mockResolvedValue({
          username: "cody_manager_bot",
          can_manage_bots: true,
        }),
        getManagedBotToken,
        editMessageReplyMarkup,
      },
      projectStore,
      resolveContext: (threadId) => (
        threadId === "thread-1" ? { contextKey: "123" } : undefined
      ),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("attaches a blue creation button and stores the resulting token outside model state", async () => {
    const toolResult = await service.handleTool({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "request_managed_bot",
      arguments: {
        project_id: "weather-bot",
        suggested_name: "Погодный Кот",
        suggested_username: "weather_cat_bot",
      },
    });

    expect(toolResult.success).toBe(true);
    expect(JSON.parse(toolResult.text)).toMatchObject({
      success: true,
      awaiting_user: true,
      suggested_username: "weather_cat_bot",
    });

    const action = await service.prepareFinalAction("thread-1");
    expect(action).toBeDefined();
    expect(action!.keyboard.inline_keyboard[0]?.[0]).toMatchObject({
      text: "＋ Создать бота",
      style: "primary",
    });
    expect(action!.keyboard.inline_keyboard[0]?.[0]).toHaveProperty(
      "url",
      "https://t.me/newbot/cody_manager_bot/weather_cat_bot?name=%D0%9F%D0%BE%D0%B3%D0%BE%D0%B4%D0%BD%D1%8B%D0%B9+%D0%9A%D0%BE%D1%82",
    );

    await service.markDelivered(action!.requestId, 777);
    service = new ManagedBotService({
      rootDirectory: path.join(root, "managed-bots"),
      api: {
        getMe: vi.fn().mockResolvedValue({
          username: "cody_manager_bot",
          can_manage_bots: true,
        }),
        getManagedBotToken,
        editMessageReplyMarkup,
      },
      projectStore,
      resolveContext: () => ({ contextKey: "123" }),
    });
    const completion = await service.complete({
      user: { id: 123 },
      bot: { id: 456, username: "weather_cat_bot" },
    });

    expect(completion).toMatchObject({
      projectId: "weather-bot",
      contextKey: "123",
      threadId: "thread-1",
      botId: 456,
      botUsername: "weather_cat_bot",
      buttonMessageId: 777,
    });
    expect(getManagedBotToken).toHaveBeenCalledWith(456);
    expect(await readFile(completion!.secretFilePath, "utf8")).toContain(
      "TELEGRAM_BOT_TOKEN=123456:secret-test-token",
    );
    expect((await stat(completion!.secretFilePath)).mode & 0o777).toBe(0o600);
    expect(completion!.secretFilePath).toBe(
      path.join(root, "managed-bots", "secrets", "weather-bot", "456.env"),
    );

    const state = await readFile(path.join(root, "managed-bots", "requests.json"), "utf8");
    expect(state).not.toContain("secret-test-token");
    expect(JSON.parse(state)).toEqual({ requests: [] });
    expect(await projectStore.get("weather-bot")).toMatchObject({
      services: ["telegram:@weather_cat_bot"],
      urls: ["https://t.me/weather_cat_bot"],
    });
  });

  it("refuses to prepare a request when Bot Management Mode is disabled", async () => {
    service = new ManagedBotService({
      rootDirectory: path.join(root, "managed-bots-disabled"),
      api: {
        getMe: vi.fn().mockResolvedValue({
          username: "cody_manager_bot",
          can_manage_bots: false,
        }),
        getManagedBotToken,
        editMessageReplyMarkup,
      },
      projectStore,
      resolveContext: () => ({ contextKey: "123" }),
    });

    const result = await service.handleTool({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "request_managed_bot",
      arguments: {
        project_id: "weather-bot",
        suggested_name: "Погодный Кот",
        suggested_username: "weather_cat_bot",
      },
    });

    expect(result.success).toBe(false);
    expect(JSON.parse(result.text).error).toContain("Bot Management Mode");
  });

  it("keeps only one pending bot request per user", async () => {
    const first = await service.handleTool({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "request_managed_bot",
      arguments: {
        project_id: "weather-bot",
        suggested_name: "Первый бот",
        suggested_username: "first_weather_bot",
      },
    });
    const firstAction = await service.prepareFinalAction("thread-1");
    await service.markDelivered(firstAction!.requestId, 111);

    const secondWorkspace = path.join(root, "notes-bot");
    await mkdir(secondWorkspace);
    await projectStore.create({
      id: "notes-bot",
      name: "Бот заметок",
      description: "Сохраняет заметки",
      workspace: secondWorkspace,
    });

    const second = await service.handleTool({
      threadId: "thread-1",
      turnId: "turn-2",
      callId: "call-2",
      namespace: null,
      tool: "request_managed_bot",
      arguments: {
        project_id: "notes-bot",
        suggested_name: "Второй бот",
        suggested_username: "second_weather_bot",
      },
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(editMessageReplyMarkup).toHaveBeenCalledWith(
      123,
      111,
      { reply_markup: expect.anything() },
    );
    expect((await service.prepareFinalAction("thread-1"))?.keyboard.inline_keyboard[0]?.[0])
      .toHaveProperty("url", expect.stringContaining("second_weather_bot"));
  });

  it("does not attach an unrelated created bot to the latest request", async () => {
    await service.handleTool({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "request_managed_bot",
      arguments: {
        project_id: "weather-bot",
        suggested_name: "Погодный бот",
        suggested_username: "expected_weather_bot",
      },
    });

    expect(await service.complete({
      user: { id: 123 },
      bot: { id: 999, username: "some_other_bot" },
    })).toBeUndefined();
    expect(getManagedBotToken).not.toHaveBeenCalled();
  });
});
