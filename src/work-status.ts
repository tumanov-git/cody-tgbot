import { escapeHTML, PREMIUM_EMOJI, renderPremiumEmoji } from "./format.js";

export type RenderedChunk = {
  text: string;
  fallbackText: string;
  parseMode: "HTML";
  sourceText: string;
};

export type WorkStatus =
  | "accepted"
  | "working"
  | "waiting-answer"
  | "waiting-approval"
  | "completed"
  | "stopped"
  | "failed";

export type WorklogEntry = {
  id: string;
  kind: "commentary" | "tool" | "queue";
  text: string;
};

export const COMMAND_COMPLETED_MESSAGES = [
  "Команда выполнена",
  "Покрутил шестерёнки",
  "Пошуршал файлами",
  "Подкрутил гайки",
  "Сверился с реальностью",
  "Разложил по полочкам",
  "Навёл порядок",
  "Состыковал детали",
  "Провернул механизм",
  "Подружил детали",
  "Расставил всё по местам",
  "Закрыл этот шаг",
  "Подкрутил нужное",
  "Подогнал детали",
  "Соединил части",
  "Проверил и закрепил",
  "Добавил недостающую деталь",
  "Закрыл очередной вопрос",
  "Готово, иду дальше",
  "Здесь порядок, продолжаю",
  "Всё сошлось, продолжаю",
] as const;

export function renderWorkingStatus(options: {
  status: WorkStatus;
  entries: WorklogEntry[];
  elapsedSeconds: number;
  subagentCount?: number;
}): RenderedChunk {
  const header = renderWorkStatusHeader(options.status, formatElapsedDuration(options.elapsedSeconds));
  const entries = trimWorklogEntries(options.entries, 3000);
  const htmlLines = [header.html];
  const plainLines = [header.plain];
  if ((options.subagentCount ?? 0) > 0) {
    const count = options.subagentCount ?? 0;
    const label = count === 1 ? "Субагент работает..." : `Субагенты работают: ${count}`;
    htmlLines.push(escapeHTML(label));
    plainLines.push(label);
  }

  if (entries.length > 0) {
    const htmlEntries = entries.map((entry) => {
      const text = escapeHTML(normalizeStatusText(entry.text));
      if (entry.kind === "tool") return `${renderPremiumEmoji(PREMIUM_EMOJI.tool, "⚙️")} ${text}`;
      if (entry.kind === "queue") return `${renderPremiumEmoji(PREMIUM_EMOJI.queue, "👕")} ${text}`;
      return text;
    });
    const plainEntries = entries.map((entry) => {
      const text = normalizeStatusText(entry.text);
      return text;
    });
    const quoteTag = statusHasFinished(options.status) ? "blockquote expandable" : "blockquote";
    htmlLines.push("", `<${quoteTag}>${htmlEntries.join("\n\n")}</blockquote>`);
    plainLines.push("", plainEntries.join("\n\n"));
  }

  const plain = plainLines.join("\n");
  return {
    text: htmlLines.join("\n"),
    fallbackText: plain,
    parseMode: "HTML",
    sourceText: plain,
  };
}

export function formatElapsedDuration(totalSeconds: number): string {
  const secondsTotal = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(secondsTotal / 3600);
  const minutes = Math.floor((secondsTotal % 3600) / 60);
  const seconds = secondsTotal % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}ч`);
  if (minutes > 0) parts.push(`${minutes}м`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}с`);
  return parts.join(" ");
}

export function formatToolLifecycleText(
  toolName: string,
  status: "running" | "completed" | "failed",
): string {
  const normalized = toolName.toLowerCase();
  const category = toolName.startsWith("search:")
    ? "search"
    : normalized === "file_change" || normalized.includes("apply_patch")
      ? "files"
      : normalized.includes("imagegen")
        ? "imagegen"
        : normalized.includes("view_image")
          ? "image"
          : normalized.includes("spawn_agent")
            ? "agent"
            : toolName.startsWith("mcp:") || /^[a-z][a-z0-9_:-]+$/i.test(toolName)
              ? "tool"
              : "command";
  const messages = {
    command: { running: "Выполняю команду", completed: "Команда выполнена", failed: "Команда завершилась с ошибкой" },
    search: { running: "Ищу информацию", completed: "Поиск завершён", failed: "Поиск завершился с ошибкой" },
    files: { running: "Работаю с файлами", completed: "Работа с файлами завершена", failed: "Работа с файлами завершилась с ошибкой" },
    imagegen: { running: "Создаю изображение", completed: "Изображение создано", failed: "Не удалось создать изображение" },
    image: { running: "Изучаю изображение", completed: "Изображение изучено", failed: "Не удалось изучить изображение" },
    agent: { running: "Подключаю дополнительного агента", completed: "Дополнительный агент закончил работу", failed: "Дополнительный агент завершился с ошибкой" },
    tool: { running: "Использую инструмент", completed: "Инструмент закончил работу", failed: "Инструмент завершился с ошибкой" },
  } as const;
  if (category === "command" && status === "completed") {
    return pickCommandCompletedMessage();
  }
  return messages[category][status];
}

function pickCommandCompletedMessage(): string {
  if (Math.random() < 0.5) return COMMAND_COMPLETED_MESSAGES[0];
  const alternatives = COMMAND_COMPLETED_MESSAGES.slice(1);
  return alternatives[Math.floor(Math.random() * alternatives.length)]
    ?? COMMAND_COMPLETED_MESSAGES[0];
}

export function statusHasFinished(status: WorkStatus): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}

function trimWorklogEntries(entries: WorklogEntry[], maxLength: number): WorklogEntry[] {
  const normalized = entries
    .map((entry) => ({ ...entry, text: normalizeStatusText(entry.text) }))
    .filter((entry) => entry.text);
  const result: WorklogEntry[] = [];
  let used = 0;
  for (const entry of normalized.slice().reverse()) {
    const nextLength = entry.text.length + (result.length > 0 ? 2 : 0);
    if (used + nextLength > maxLength) {
      const separatorLength = result.length > 0 ? 2 : 0;
      const tailLength = Math.max(0, maxLength - used - separatorLength);
      if (tailLength > 0) {
        result.unshift({ ...entry, text: takeTextTail(entry.text, tailLength) });
      }
      return prependTrimmedMarker(result, maxLength);
    }
    result.unshift(entry);
    used += nextLength;
  }
  return result;
}

function prependTrimmedMarker(entries: WorklogEntry[], maxLength: number): WorklogEntry[] {
  const result = entries.map((entry) => ({ ...entry }));
  const marker: WorklogEntry = { id: "trimmed", kind: "commentary", text: "…" };

  while (result.length > 0 && worklogLength([marker, ...result]) > maxLength) {
    const overflow = worklogLength([marker, ...result]) - maxLength;
    const first = result[0]!;
    if (first.text.length > overflow) {
      first.text = takeTextTail(first.text, first.text.length - overflow);
      break;
    }
    result.shift();
  }

  return [marker, ...result];
}

function worklogLength(entries: WorklogEntry[]): number {
  return entries.reduce(
    (total, entry, index) => total + entry.text.length + (index > 0 ? 2 : 0),
    0,
  );
}

function takeTextTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let start = text.length - maxLength;
  const current = text.charCodeAt(start);
  const previous = text.charCodeAt(start - 1);
  if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
    start += 1;
  }
  return text.slice(start);
}

function renderWorkStatusHeader(status: WorkStatus, elapsed: string): { html: string; plain: string } {
  switch (status) {
    case "accepted":
      return { html: `${renderPremiumEmoji(PREMIUM_EMOJI.accepted, "👨‍💻")} <b>Коди принял задачу...</b> ${elapsed}`, plain: `Коди принял задачу... ${elapsed}` };
    case "working":
      return { html: `${renderPremiumEmoji(PREMIUM_EMOJI.working, "🏃")} <b>Коди работает...</b> ${elapsed}`, plain: `Коди работает... ${elapsed}` };
    case "waiting-answer":
      return { html: "<b>Коди ждёт ответа...</b>", plain: "Коди ждёт ответа..." };
    case "waiting-approval":
      return { html: "<b>Коди ждёт разрешения...</b>", plain: "Коди ждёт разрешения..." };
    case "completed": {
      const emoji = [PREMIUM_EMOJI.completedFirst, PREMIUM_EMOJI.completedSecond]
        .map((id) => renderPremiumEmoji(id, "🛌"))
        .join("");
      return { html: `${emoji} <b>Коди завершил за</b> ${elapsed}`, plain: `Коди завершил за ${elapsed}` };
    }
    case "stopped":
      return { html: `<b>Коди остановлен</b> ${elapsed}`, plain: `Коди остановлен ${elapsed}` };
    case "failed":
      return { html: `<b>Коди не завершил</b> ${elapsed}`, plain: `Коди не завершил ${elapsed}` };
  }
}

function normalizeStatusText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(?<![\s/\\])([.!?])(?=[A-Za-zА-Яа-яЁё])/g, "$1 ")
    .trim();
}
