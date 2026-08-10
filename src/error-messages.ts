/**
 * Translate raw errors into user-friendly Telegram messages.
 * Raw details are preserved for console logging only.
 */

export interface FriendlyError {
  userMessage: string;
  logMessage: string;
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /ECONNREFUSED|ENOTFOUND|ENETUNREACH|fetch failed/i,
    message: "Не получается подключиться к Codex API. Проверь сеть и попробуй ещё раз.",
  },
  {
    pattern: /429|rate.?limit|too many requests/i,
    message: "API временно ограничил запросы. Подожди немного и попробуй снова.",
  },
  {
    pattern: /401|unauthorized|authentication|invalid.*api.?key/i,
    message: "Codex не авторизован на сервере. Проверь серверный вход или API-ключ.",
  },
  {
    pattern: /403|forbidden|permission/i,
    message: "Доступ запрещён. Проверь права API-ключа или аккаунта.",
  },
  {
    pattern: /404.*model|model.*not.*found|invalid.*model|model.*does not exist/i,
    message: "Эта модель недоступна. Проверь серверную настройку модели.",
  },
  {
    pattern: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    message: "Запрос занял слишком много времени. Попробуй отправить его ещё раз.",
  },
  {
    pattern: /500|internal.?server.?error/i,
    message: "API вернул серверную ошибку. Попробуй ещё раз чуть позже.",
  },
  {
    pattern: /502|503|504|bad.?gateway|service.?unavailable/i,
    message: "API временно недоступен. Попробуй ещё раз через минуту.",
  },
  {
    pattern: /context.?length|token.?limit|too.?long/i,
    message: "Диалог слишком длинный для этой модели. Нужно начать новый диалог.",
  },
  {
    pattern: /^(?:AbortError|The operation was aborted)/i,
    message: "Остановлено",
  },
  {
    pattern: /Telegram did not return a file path/i,
    message: "Telegram не вернул путь к файлу. Попробуй отправить файл ещё раз.",
  },
];

export function translateError(error: unknown): FriendlyError {
  const raw = extractRawMessage(error);
  const logMessage = raw;

  for (const { pattern, message } of ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return { userMessage: message, logMessage };
    }
  }

  const cleaned = stripStackTrace(raw);
  return { userMessage: cleaned, logMessage };
}

export function friendlyErrorText(error: unknown): string {
  return translateError(error).userMessage;
}

function extractRawMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: Error }).cause;
    const base = error.message || String(error);
    return cause?.message ? `${base}: ${cause.message}` : base;
  }

  return String(error);
}

function stripStackTrace(message: string): string {
  // Remove stack frame lines (lines starting with "at ")
  const lines = message.split("\n").filter((line) => !line.trim().startsWith("at "));
  return lines.join("\n").trim() || message.trim();
}
