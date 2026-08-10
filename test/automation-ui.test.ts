import { formatAutomationDate } from "../src/automation-format.js";
import { manualRunNeedsConfirmation, renderExecutionDetails } from "../src/automation-ui.js";
import type { AutomationExecution, AutomationRecord } from "../src/automation-types.js";

describe("automation execution history UI", () => {
  it("uses short relative dates for nearby automation runs", () => {
    const now = new Date("2026-08-09T12:00:00.000Z");

    expect(formatAutomationDate("2026-08-09T18:00:00.000Z", "Europe/Moscow", now))
      .toBe("сегодня в 21:00");
    expect(formatAutomationDate("2026-08-10T08:00:00.000Z", "Europe/Moscow", now))
      .toBe("завтра в 11:00");
  });

  it("keeps even heavily escaped details inside Telegram's edit limit", () => {
    const execution: AutomationExecution = {
      id: "execution-long",
      automationId: "auto-1234567890abcdef",
      source: "scheduled",
      status: "failed",
      scheduledFor: "2026-08-07T12:00:00.000Z",
      claimedAt: "2026-08-07T12:00:00.000Z",
      startedAt: "2026-08-07T12:00:01.000Z",
      finishedAt: "2026-08-07T12:00:02.000Z",
      result: "&".repeat(10_000),
      error: "<".repeat(10_000),
      deliveryStatus: "failed",
      deliveryAttempts: 3,
      deliveryError: ">".repeat(10_000),
    };

    const rendered = renderExecutionDetails(execution, "Europe/Moscow");

    expect(rendered.html.length).toBeLessThan(4_000);
    expect(rendered.html).not.toMatch(/&(amp|lt|gt)?$/);
    expect(rendered.html).toContain("…");
  });

  it("warns only when an active schedule is less than 30 minutes away", () => {
    const automation: AutomationRecord = {
      id: "auto-1234567890abcdef",
      projectId: "cody",
      name: "Отчёт",
      description: "Готовит отчёт",
      instruction: "Подготовь отчёт.",
      schedule: { kind: "cron", expression: "0 21 * * *", timezone: "Europe/Moscow" },
      scheduleDescription: "Каждый день в 21:00",
      repeatLimit: null,
      runCount: 0,
      consecutiveFailures: 0,
      state: "scheduled",
      contextKey: "100",
      chatId: 100,
      nextRunAt: "2026-08-09T18:00:00.000Z",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
    };

    expect(manualRunNeedsConfirmation(
      automation,
      new Date("2026-08-09T17:40:00.000Z"),
    )).toBe(true);
    expect(manualRunNeedsConfirmation(
      automation,
      new Date("2026-08-09T17:00:00.000Z"),
    )).toBe(false);
    expect(manualRunNeedsConfirmation(
      { ...automation, state: "paused" },
      new Date("2026-08-09T17:40:00.000Z"),
    )).toBe(false);
  });
});
