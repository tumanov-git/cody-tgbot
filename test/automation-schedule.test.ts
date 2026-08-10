import {
  describeAutomationSchedule,
  firstAutomationRun,
  nextAutomationRun,
  normalizeAutomationSchedule,
  validateAutomationFrequency,
} from "../src/automation-schedule.js";

describe("automation schedule", () => {
  it("computes intervals from the supplied base time", () => {
    expect(nextAutomationRun(
      { kind: "interval", everyMinutes: 45 },
      new Date("2026-08-07T12:00:00.000Z"),
    ).toISOString()).toBe("2026-08-07T12:45:00.000Z");
  });

  it("supports five-field cron expressions in an explicit timezone", () => {
    const next = nextAutomationRun(
      { kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Moscow" },
      new Date("2026-08-07T07:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-08-10T06:00:00.000Z");
  });

  it("rejects past one-shots and six-field cron expressions", () => {
    expect(() => firstAutomationRun(
      { kind: "once", at: "2026-08-07T11:59:00.000Z" },
      new Date("2026-08-07T12:00:00.000Z"),
    )).toThrow("уже прошло");
    expect(() => normalizeAutomationSchedule({
      kind: "cron",
      expression: "0 0 9 * * 1-5",
      timezone: "Europe/Moscow",
    })).toThrow("пяти полей");
  });

  it("derives honest Russian descriptions from technical schedules", () => {
    expect(describeAutomationSchedule({ kind: "interval", everyMinutes: 60 })).toBe("Раз в час");
    expect(describeAutomationSchedule({
      kind: "cron",
      expression: "0 21 * * *",
      timezone: "Europe/Moscow",
    })).toBe("Каждый день в 21:00");
    expect(describeAutomationSchedule({
      kind: "cron",
      expression: "30 9 * * 1",
      timezone: "Europe/Moscow",
    })).toBe("По понедельникам в 09:30");
  });

  it("rejects cron schedules that beat the configured minimum", () => {
    expect(() => validateAutomationFrequency(
      { kind: "cron", expression: "*/5 * * * *", timezone: "Europe/Moscow" },
      15,
      new Date("2026-08-07T12:00:00.000Z"),
    )).toThrow("не чаще раза в 15 минут");
  });
});
