import { CronExpressionParser } from "cron-parser";

import type { AutomationSchedule } from "./automation-types.js";

const MAX_INTERVAL_MINUTES = 366 * 24 * 60;

const WEEKDAYS = [
  "по воскресеньям",
  "по понедельникам",
  "по вторникам",
  "по средам",
  "по четвергам",
  "по пятницам",
  "по субботам",
] as const;

export function normalizeAutomationSchedule(schedule: AutomationSchedule): AutomationSchedule {
  if (schedule.kind === "once") {
    const at = parseDate(schedule.at, "Время одноразового запуска");
    return { kind: "once", at: at.toISOString() };
  }
  if (schedule.kind === "interval") {
    if (
      !Number.isInteger(schedule.everyMinutes)
      || schedule.everyMinutes < 1
      || schedule.everyMinutes > MAX_INTERVAL_MINUTES
    ) {
      throw new Error("Интервал должен быть целым числом от 1 минуты до 366 дней");
    }
    return { kind: "interval", everyMinutes: schedule.everyMinutes };
  }
  const expression = schedule.expression.trim().replace(/\s+/g, " ");
  if (expression.split(" ").length !== 5) {
    throw new Error("Нужно стандартное cron-выражение из пяти полей");
  }
  const timezone = schedule.timezone.trim();
  if (!timezone) throw new Error("Для календарного расписания нужен часовой пояс");
  nextAutomationRun({ kind: "cron", expression, timezone }, new Date());
  return { kind: "cron", expression, timezone };
}

export function firstAutomationRun(schedule: AutomationSchedule, now = new Date()): Date {
  const normalized = normalizeAutomationSchedule(schedule);
  if (normalized.kind === "once") {
    const at = parseDate(normalized.at, "Время одноразового запуска");
    if (at.getTime() <= now.getTime()) {
      throw new Error("Время одноразового запуска уже прошло");
    }
    return at;
  }
  return nextAutomationRun(normalized, now);
}

export function nextAutomationRun(schedule: AutomationSchedule, after: Date): Date {
  if (schedule.kind === "once") return parseDate(schedule.at, "Время одноразового запуска");
  if (schedule.kind === "interval") {
    return new Date(after.getTime() + schedule.everyMinutes * 60_000);
  }
  try {
    return CronExpressionParser.parse(schedule.expression, {
      currentDate: after,
      tz: schedule.timezone,
    }).next().toDate();
  } catch (error) {
    throw new Error(`Некорректное расписание: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateAutomationFrequency(
  schedule: AutomationSchedule,
  minimumMinutes: number,
  now = new Date(),
): void {
  if (schedule.kind === "once") return;
  const minimumMs = minimumMinutes * 60_000;
  if (schedule.kind === "interval") {
    if (schedule.everyMinutes < minimumMinutes) {
      throw new Error(`Автоматизацию можно запускать не чаще раза в ${minimumMinutes} минут`);
    }
    return;
  }
  let previous = nextAutomationRun(schedule, now);
  for (let index = 0; index < 32; index += 1) {
    const next = nextAutomationRun(schedule, previous);
    if (next.getTime() - previous.getTime() < minimumMs) {
      throw new Error(`Автоматизацию можно запускать не чаще раза в ${minimumMinutes} минут`);
    }
    previous = next;
  }
}

export function describeAutomationSchedule(
  schedule: AutomationSchedule,
  defaultTimezone = "Europe/Moscow",
): string {
  if (schedule.kind === "once") {
    const date = parseDate(schedule.at, "Время одноразового запуска");
    return `Один раз · ${new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: defaultTimezone,
    }).format(date)}`;
  }
  if (schedule.kind === "interval") {
    if (schedule.everyMinutes % (24 * 60) === 0) {
      const days = schedule.everyMinutes / (24 * 60);
      if (days === 1) return "Раз в день";
      return `Каждые ${formatCount(days, "день", "дня", "дней")}`;
    }
    if (schedule.everyMinutes % 60 === 0) {
      const hours = schedule.everyMinutes / 60;
      if (hours === 1) return "Раз в час";
      return `Каждые ${formatCount(hours, "час", "часа", "часов")}`;
    }
    if (schedule.everyMinutes === 1) return "Каждую минуту";
    return `Каждые ${formatCount(schedule.everyMinutes, "минуту", "минуты", "минут")}`;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.expression.split(" ");
  const time = isNumber(hour) && isNumber(minute)
    ? `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`
    : undefined;
  if (time && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Каждый день в ${time}`;
  }
  if (time && dayOfMonth === "*" && month === "*" && isNumber(dayOfWeek)) {
    const weekday = WEEKDAYS[Number(dayOfWeek) % 7];
    if (weekday) return `${capitalize(weekday)} в ${time}`;
  }
  if (time && isNumber(dayOfMonth) && month === "*" && dayOfWeek === "*") {
    return `Каждый месяц ${Number(dayOfMonth)} числа в ${time}`;
  }
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const step = minute?.match(/^\*\/(\d+)$/)?.[1];
    if (step) return `Каждые ${formatCount(Number(step), "минуту", "минуты", "минут")}`;
  }
  return `По расписанию ${schedule.expression} · ${schedule.timezone}`;
}

export function automationDisplayTimezone(
  schedule: AutomationSchedule,
  defaultTimezone: string,
): string {
  return schedule.kind === "cron" ? schedule.timezone : defaultTimezone;
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} задано некорректно`);
  return date;
}

function isNumber(value: string | undefined): value is string {
  return Boolean(value && /^\d+$/.test(value));
}

function formatCount(value: number, one: string, few: string, many: string): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  const word = mod100 >= 11 && mod100 <= 14
    ? many
    : mod10 === 1
      ? one
      : mod10 >= 2 && mod10 <= 4
        ? few
        : many;
  return `${value} ${word}`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
