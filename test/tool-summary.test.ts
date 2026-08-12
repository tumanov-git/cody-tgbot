import {
  COMMAND_COMPLETED_MESSAGES,
  formatElapsedDuration,
  formatToolLifecycleText,
  renderWorkingStatus,
} from "../src/work-status.js";

describe("work status formatting", () => {
  it("renders an immediate accepted state with the selected premium emoji", () => {
    const status = renderWorkingStatus({
      status: "accepted",
      entries: [],
      elapsedSeconds: 1,
    });

    expect(status.text).toContain(
      '<tg-emoji emoji-id="5339351141631155056">👨‍💻</tg-emoji> <b>Коди принял задачу...</b>',
    );
    expect(status.text).not.toContain("🌐");
  });

  it("keeps commentary and tool state in one open quote while working", () => {
    const status = renderWorkingStatus({
      status: "working",
      entries: [
        { id: "commentary-1", kind: "commentary", text: "Проверяю проект.Сейчас запущу тесты." },
        { id: "steer-1", kind: "queue", text: "Сообщение из очереди добавлено в текущую задачу" },
        { id: "tool-1", kind: "tool", text: "Команда выполнена" },
      ],
      elapsedSeconds: 61,
    });

    expect(status.parseMode).toBe("HTML");
    expect(status.text).toContain(
      '<tg-emoji emoji-id="5339319045340553200">🏃</tg-emoji> <b>Коди работает...</b>',
    );
    expect(status.text).toContain("<blockquote>");
    expect(status.text).not.toContain("<blockquote expandable>");
    expect(status.text).toContain("Проверяю проект. Сейчас запущу тесты.");
    expect(status.text).toContain(
      '<tg-emoji emoji-id="5449700997632925464">👕</tg-emoji> Сообщение из очереди добавлено в текущую задачу',
    );
    expect(status.text).toContain(
      '<tg-emoji emoji-id="5339081812821957844">⚙️</tg-emoji> Команда выполнена',
    );
    expect(status.text).not.toContain("🌐");
    expect(status.text).not.toContain("Шагов:");
    expect(status.text).toContain("<b>Коди работает...</b> 1м 1с");
    expect(status.text).not.toContain("План");
    expect(status.text).not.toContain("Ход работы");
    expect(status.text).not.toContain("Инструменты:");
  });

  it("shows active subagents directly under the live status", () => {
    const status = renderWorkingStatus({
      status: "working",
      entries: [{ id: "commentary-1", kind: "commentary", text: "Собираю результат" }],
      elapsedSeconds: 161,
      subagentCount: 1,
    });

    expect(status.sourceText.startsWith(
      "Коди работает... 2м 41с\nСубагент работает...",
    )).toBe(true);
  });

  it("uses a temporary waiting state for questions and approvals", () => {
    expect(renderWorkingStatus({
      status: "waiting-answer",
      entries: [],
      elapsedSeconds: 5,
    }).sourceText).toBe("Коди ждёт ответа...");
    expect(renderWorkingStatus({
      status: "waiting-approval",
      entries: [],
      elapsedSeconds: 5,
    }).sourceText).toBe("Коди ждёт разрешения...");
  });

  it("renders both selected sleep emojis when Коди completes", () => {
    const status = renderWorkingStatus({
      status: "completed",
      entries: [{ id: "commentary-1", kind: "commentary", text: "Работа закончена" }],
      elapsedSeconds: 3600,
    });

    expect(status.text).toContain(
      '<tg-emoji emoji-id="5341350878404173403">🛌</tg-emoji>' +
      '<tg-emoji emoji-id="5339398905962456755">🛌</tg-emoji> <b>Коди завершил за</b> 1ч',
    );
    expect(status.text).not.toContain("🌐");
    expect(status.text).not.toContain("Шагов:");
    expect(status.text).toContain("<blockquote expandable>Работа закончена</blockquote>");
  });

  it("renders a stopped state without a ready checkmark", () => {
    const status = renderWorkingStatus({
      status: "stopped",
      entries: [],
      elapsedSeconds: 5,
    });

    expect(status.text).toContain("<b>Коди остановлен</b>");
    expect(status.text).not.toContain("Готово");
    expect(status.text).not.toContain("✅");
    expect(status.text).not.toContain("🌐");
  });

  it("uses human tool lifecycle labels", () => {
    expect(formatToolLifecycleText("git status", "running")).toBe("Выполняю команду");
    const completed = Array.from(
      { length: COMMAND_COMPLETED_MESSAGES.length * 2 },
      () => formatToolLifecycleText("git status", "completed"),
    );
    expect(completed.every((message) => COMMAND_COMPLETED_MESSAGES.includes(
      message as typeof COMMAND_COMPLETED_MESSAGES[number],
    ))).toBe(true);
    expect(COMMAND_COMPLETED_MESSAGES[0]).toBe("Команда выполнена");
    expect(formatToolLifecycleText("search:latest Codex release", "running")).toBe("Ищу информацию");
    expect(formatToolLifecycleText("file_change", "completed")).toBe("Работа с файлами завершена");
    expect(formatToolLifecycleText("mcp:server/unknown_tool", "completed")).toBe(
      "Инструмент закончил работу",
    );
  });

  it("keeps the standard command completion message at fifty percent", () => {
    const random = vi.spyOn(Math, "random");
    random.mockReturnValueOnce(0.49);
    expect(formatToolLifecycleText("git status", "completed")).toBe("Команда выполнена");
    random.mockReturnValueOnce(0.5).mockReturnValueOnce(0);
    expect(formatToolLifecycleText("git status", "completed")).toBe("Покрутил шестерёнки");
    random.mockRestore();
  });

  it("formats elapsed work time without empty units", () => {
    expect(formatElapsedDuration(1)).toBe("1с");
    expect(formatElapsedDuration(60)).toBe("1м");
    expect(formatElapsedDuration(61)).toBe("1м 1с");
    expect(formatElapsedDuration(3661)).toBe("1ч 1м 1с");
  });

  it("collapses the beginning of one oversized streaming commentary", () => {
    const status = renderWorkingStatus({
      status: "working",
      entries: [{
        id: "commentary-1",
        kind: "commentary",
        text: `СТАРЫЕ МЫСЛИ ${"а".repeat(3200)} СВЕЖИЙ ХВОСТ`,
      }],
      elapsedSeconds: 549,
    });

    expect(status.sourceText).toContain("Коди работает... 9м 9с");
    expect(status.sourceText).not.toContain("🏃");
    expect(status.sourceText).toContain("…\n\n");
    expect(status.sourceText).toContain("СВЕЖИЙ ХВОСТ");
    expect(status.sourceText).not.toContain("СТАРЫЕ МЫСЛИ");
    expect(status.sourceText.length).toBeLessThan(3100);
  });

  it("does not split a surrogate pair when trimming commentary", () => {
    const status = renderWorkingStatus({
      status: "working",
      entries: [{
        id: "commentary-1",
        kind: "commentary",
        text: `${"а".repeat(3000)}🏃${"б".repeat(2996)}`,
      }],
      elapsedSeconds: 1,
    });

    expect(status.sourceText).not.toContain("�");
    expect(status.sourceText).toContain("…\n\n");
  });
});
