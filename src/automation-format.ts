export function formatAutomationDate(value: string, timezone: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const time = formatTime(date, timezone);
  const relative = relativeDay(date, now, timezone);
  if (relative) return `${relative} в ${time}`;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);
}

export function formatAutomationButtonDate(
  value: string,
  timezone: string,
  now = new Date(),
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "запланирована";
  const time = formatTime(date, timezone);
  const relative = relativeDay(date, now, timezone);
  if (relative) return `${relative} ${time}`;
  const day = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    timeZone: timezone,
  }).format(date);
  return `${day} ${time}`;
}

function relativeDay(date: Date, now: Date, timezone: string): "сегодня" | "завтра" | undefined {
  const targetDay = localDateKey(date, timezone);
  if (targetDay === localDateKey(now, timezone)) return "сегодня";
  if (targetDay === localDateKey(new Date(now.getTime() + 24 * 60 * 60_000), timezone)) {
    return "завтра";
  }
  return undefined;
}

function formatTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);
}

function localDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).format(date);
}
