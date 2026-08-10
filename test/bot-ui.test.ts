import {
  buildMainMenuKeyboard,
  CURRENT_DIALOG_ICON_ID,
  MAIN_MENU_IMAGE_NAMES,
  MAIN_MENU_DESCRIPTION,
  MAIN_MENU_TITLE,
  pickMainMenuImageName,
  renderAutomations,
  renderDialogs,
  renderProjects,
} from "../src/bot-ui.js";
import type { ProjectRecord } from "../src/project-store.js";
import type { AutomationRecord } from "../src/automation-types.js";

describe("bot-ui", () => {
  it("uses the approved main menu copy", () => {
    expect(MAIN_MENU_TITLE).toBe("Что делаем?");
    expect(MAIN_MENU_DESCRIPTION).toBe("Можно продолжить начатое или заняться чем-нибудь новым");
  });

  it("rotates the three main menu illustrations", () => {
    expect(pickMainMenuImageName(() => 0)).toBe("home-1.png");
    expect(pickMainMenuImageName(() => 0.5)).toBe("home-2.png");
    expect(pickMainMenuImageName(() => 0.999999)).toBe("home-3.png");
    expect(MAIN_MENU_IMAGE_NAMES).toHaveLength(3);
  });

  it("keeps projects, dialogs, and one settings entry on the main screen", () => {
    const keyboard = buildMainMenuKeyboard().inline_keyboard;

    expect(keyboard[0]?.[0]).toMatchObject({
      text: "Мои проекты",
      callback_data: "menu:projects:0",
      style: "success",
    });
    expect(keyboard[0]?.[1]).toMatchObject({
      text: "Диалоги",
      callback_data: "menu:dialogs:0",
      style: "primary",
    });
    expect(keyboard[1]?.[0]).toMatchObject({
      text: "Настройки",
      callback_data: "menu:settings",
    });
    expect(keyboard[2]?.[0]).toMatchObject({ text: "Закрыть" });
    expect(keyboard.flat().map((button) => button.text)).not.toContain("Автоматизации");
  });

  it("renders four projects per page in two columns", () => {
    const projects = Array.from({ length: 9 }, (_, index): ProjectRecord => ({
      id: `project-${index}`,
      name: `Проект ${index}`,
      description: "Описание",
      workspace: `/workspace/project-${index}`,
      services: [],
      urls: [],
      createdAt: new Date(2026, 7, index + 1).toISOString(),
      updatedAt: new Date(2026, 7, index + 1).toISOString(),
    }));
    const view = renderProjects(projects, 1);
    const keyboard = view.keyboard.inline_keyboard;

    expect(view.text.plain).toBe(
      "Мои проекты\n\nЗдесь собраны проекты, которые Коди создаёт и поддерживает",
    );

    expect(keyboard[0]?.[0]).toMatchObject({
      text: "＋ Новый проект",
      callback_data: "project:new",
      style: "success",
    });
    expect(keyboard[1]).toHaveLength(2);
    expect(keyboard[2]).toHaveLength(2);
    expect(keyboard[1]?.[0]).toMatchObject({
      text: "Проект 4",
      callback_data: "project:view:project-4:1",
      style: "primary",
    });
    expect(keyboard[3]?.map((button) => button.text)).toEqual(["←", "2/3", "→"]);
    expect(keyboard[4]?.[0]).toMatchObject({ text: "Назад", callback_data: "menu:home" });
  });

  it("omits project pagination for four projects", () => {
    const projects = Array.from({ length: 4 }, (_, index): ProjectRecord => ({
      id: `project-${index}`,
      name: `Проект ${index}`,
      description: "Описание",
      workspace: `/workspace/project-${index}`,
      services: [],
      urls: [],
      createdAt: new Date(2026, 7, index + 1).toISOString(),
      updatedAt: new Date(2026, 7, index + 1).toISOString(),
    }));

    const { keyboard } = renderProjects(projects, 0);
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).not.toContain("1/1");
  });

  it("shows unreadable project cards explicitly", () => {
    const view = renderProjects([], 0, 2);

    expect(view.text.plain).toContain("Не удалось прочитать проектов: 2");
  });

  it("renders four blue dialogs per page in one column", () => {
    const dialogs = Array.from({ length: 5 }, (_, index) => ({
      threadId: `thread-${index}`,
      workspace: "/workspace",
      title: `Диалог номер ${index}`,
      titleGenerated: true,
      createdAt: new Date(2026, 7, index + 1, 19, 39).getTime(),
      updatedAt: index,
      current: index === 0,
    }));

    const { keyboard } = renderDialogs(dialogs, 0);
    const rows = keyboard.inline_keyboard;

    expect(rows[0]?.[0]).toMatchObject({ text: "＋ Новый диалог", style: "success" });
    expect(rows[1]).toHaveLength(1);
    expect(rows[2]).toHaveLength(1);
    expect(rows[3]).toHaveLength(1);
    expect(rows[4]).toHaveLength(1);
    expect(rows[1]?.[0]).toMatchObject({
      style: "primary",
      icon_custom_emoji_id: CURRENT_DIALOG_ICON_ID,
    });
    expect(rows[2]?.[0]).not.toHaveProperty("icon_custom_emoji_id");
    expect(rows[5]?.map((button) => button.text)).toEqual(["1/2", "→"]);
  });

  it("omits pagination for four dialogs", () => {
    const dialogs = Array.from({ length: 4 }, (_, index) => ({
      threadId: `thread-${index}`,
      workspace: "/workspace",
      title: "Тестовый диалог",
      titleGenerated: true,
      createdAt: 1_786_000_000_000 + index,
      updatedAt: index,
      current: false,
    }));

    const { keyboard } = renderDialogs(dialogs, 0);
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).not.toContain("1/1");
  });

  it("renders project automations as detailed single-column entries", () => {
    const project: ProjectRecord = {
      id: "cody",
      name: "Коди",
      description: "Telegram-интерфейс",
      workspace: "/workspace/cody",
      services: [],
      urls: [],
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
    };
    const automation: AutomationRecord = {
      id: "auto-1234567890abcdef",
      projectId: "cody",
      name: "Недельный обзор",
      description: "Собирает итоги",
      instruction: "Собери итоги.",
      schedule: { kind: "cron", expression: "0 18 * * 5", timezone: "Europe/Moscow" },
      scheduleDescription: "по пятницам в 18:00",
      repeatLimit: null,
      runCount: 0,
      consecutiveFailures: 0,
      state: "scheduled",
      contextKey: "100",
      chatId: 100,
      nextRunAt: "2026-08-14T15:00:00.000Z",
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
    };

    const view = renderAutomations(
      [automation],
      project,
      0,
      "Europe/Moscow",
      new Date("2026-08-09T12:00:00.000Z"),
    );
    expect(view.text.plain).toContain("Автоматизации · Коди");
    expect(view.keyboard.inline_keyboard[0]?.[0]).toMatchObject({
      text: "＋ Новая автоматизация",
      callback_data: "automation:new:cody",
      style: "success",
    });
    expect(view.keyboard.inline_keyboard[1]?.[0]).toMatchObject({
      text: "Недельный обзор · 14 авг. 18:00",
      callback_data: "automation:view:auto-1234567890abcdef:0",
      style: "primary",
    });
    expect(view.keyboard.inline_keyboard.at(-1)?.[0]).toMatchObject({
      text: "Назад",
      callback_data: "project:view:cody:0",
    });
    for (const button of view.keyboard.inline_keyboard.flat()) {
      expect(Buffer.byteLength(button.callback_data ?? "", "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("shows automation state in list buttons", () => {
    const project: ProjectRecord = {
      id: "cody",
      name: "Коди",
      description: "Telegram-интерфейс",
      workspace: "/workspace/cody",
      services: [],
      urls: [],
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
    };
    const base: AutomationRecord = {
      id: "auto-1234567890abcdef",
      projectId: "cody",
      name: "Проверка",
      description: "Проверяет проект",
      instruction: "Проверь проект.",
      schedule: { kind: "interval", everyMinutes: 60 },
      scheduleDescription: "каждый час",
      repeatLimit: null,
      runCount: 0,
      consecutiveFailures: 0,
      state: "scheduled",
      contextKey: "100",
      chatId: 100,
      nextRunAt: "2026-08-09T18:00:00.000Z",
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
    };
    const automations: AutomationRecord[] = [
      { ...base, id: "auto-1111111111111111", claimToken: "execution-running" },
      { ...base, id: "auto-2222222222222222", state: "paused" },
      { ...base, id: "auto-3333333333333333", state: "completed", nextRunAt: undefined },
    ];

    const { keyboard } = renderAutomations(
      automations,
      project,
      0,
      "Europe/Moscow",
      new Date("2026-08-09T12:00:00.000Z"),
    );
    const buttons = keyboard.inline_keyboard.slice(1, 4).map((row) => row[0]);

    expect(buttons[0]).toMatchObject({
      text: "Проверка · выполняется",
      style: "primary",
      icon_custom_emoji_id: "5339319045340553200",
    });
    expect(buttons[1]).toMatchObject({ text: "Проверка · пауза" });
    expect(buttons[1]).not.toHaveProperty("style");
    expect(buttons[2]).toMatchObject({ text: "Проверка · завершена" });
    expect(buttons[2]).not.toHaveProperty("style");
  });
});
