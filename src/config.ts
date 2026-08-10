import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { requireWithinAnyDirectory } from "./security.js";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

export interface CodyConfig {
  telegramBotToken: string;
  telegramApiRoot: string;
  telegramLocalMode: boolean;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  telegramOwnerUserId: number;
  workspace: string;
  approvedDirectories: string[];
  maxFileSize: number;
  codexApiKey?: string;
  codexModel?: string;
  automationModel?: string;
  automationTimezone: string;
  automationMinIntervalMinutes: number;
  maxActiveAutomations: number;
  maxParallelAutomations: number;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  maxParallelCodexTasks: number;
}

export function loadConfig(): CodyConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramApiRoot = normalizeApiRoot(
    optionalString(process.env.TELEGRAM_API_ROOT) ?? "https://api.telegram.org",
  );
  const telegramLocalMode = telegramApiRoot !== "https://api.telegram.org";
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const telegramOwnerUserId = parseOwnerUserId(
    optionalString(process.env.TELEGRAM_OWNER_USER_ID),
    telegramAllowedUserIds,
  );
  const approvedDirectories = resolveApprovedDirectories();
  const workspace = resolveWorkspace(approvedDirectories);
  const maxFileSize = parseMaxFileSize(
    optionalString(process.env.MAX_FILE_SIZE),
    telegramLocalMode ? 2 * 1024 * 1024 * 1024 : 20 * 1024 * 1024,
  );
  const codexApiKey = optionalString(process.env.CODEX_API_KEY);
  const codexModel = optionalString(process.env.CODEX_MODEL);
  const automationModel = optionalString(process.env.CODEX_AUTOMATION_MODEL) ?? codexModel;
  const automationTimezone = parseTimezone(
    optionalString(process.env.CODY_TIMEZONE) ?? "Europe/Moscow",
  );
  const automationMinIntervalMinutes = parsePositiveIntEnv(
    optionalString(process.env.AUTOMATION_MIN_INTERVAL_MINUTES),
    15,
  );
  const maxActiveAutomations = parsePositiveIntEnv(
    optionalString(process.env.MAX_ACTIVE_AUTOMATIONS),
    20,
  );
  const maxParallelAutomations = parsePositiveIntEnv(
    optionalString(process.env.MAX_PARALLEL_AUTOMATIONS),
    2,
  );
  const codexSandboxMode = parseSandboxMode(optionalString(process.env.CODEX_SANDBOX_MODE));
  const codexApprovalPolicy = parseApprovalPolicy(optionalString(process.env.CODEX_APPROVAL_POLICY));
  const maxParallelCodexTasks = parsePositiveIntEnv(optionalString(process.env.MAX_PARALLEL_CODEX_TASKS), 2);

  return {
    telegramBotToken,
    telegramApiRoot,
    telegramLocalMode,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    telegramOwnerUserId,
    workspace,
    approvedDirectories,
    maxFileSize,
    codexApiKey,
    codexModel,
    automationModel,
    automationTimezone,
    automationMinIntervalMinutes,
    maxActiveAutomations,
    maxParallelAutomations,
    codexSandboxMode,
    codexApprovalPolicy,
    maxParallelCodexTasks,
  };
}

/**
 * Workspace is derived automatically:
 * - CODEX_WORKSPACE when set
 * - APPROVED_DIRECTORY / first APPROVED_DIRECTORIES entry when set
 * - the first approved directory
 */
function resolveWorkspace(approvedDirectories: string[]): string {
  const explicit = optionalString(process.env.CODEX_WORKSPACE);
  if (explicit) {
    return requireWithinAnyDirectory(explicit, approvedDirectories, "CODEX_WORKSPACE");
  }

  if (optionalString(process.env.APPROVED_DIRECTORY) || optionalString(process.env.APPROVED_DIRECTORIES)) {
    return approvedDirectories[0]!;
  }
  return requireWithinAnyDirectory(process.cwd(), approvedDirectories, "workspace");
}

function resolveApprovedDirectories(): string[] {
  const primary = optionalString(process.env.APPROVED_DIRECTORY);
  const additional = parsePathList(optionalString(process.env.APPROVED_DIRECTORIES));
  const rawDirectories = primary ? [primary, ...additional] : additional;

  if (rawDirectories.length > 0) {
    return uniqueResolvedPaths(rawDirectories);
  }
  return [path.resolve(process.cwd())];
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: value }).format(new Date());
    return value;
  } catch {
    throw new Error(`Invalid CODY_TIMEZONE: ${value}`);
  }
}

function normalizeApiRoot(value: string): string {
  return value.replace(/\/+$/, "");
}

function parsePathList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueResolvedPaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const resolved = path.resolve(value);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(resolved);
  }

  if (result.length === 0) {
    throw new Error("APPROVED_DIRECTORIES must contain at least one directory");
  }

  return result;
}

function parseAllowedUserIds(raw: string): number[] {
  return parseTelegramUserIds(raw, "TELEGRAM_ALLOWED_USER_IDS");
}

function parseOwnerUserId(raw: string | undefined, allowedUserIds: number[]): number {
  const configured = raw ? parseTelegramUserIds(raw, "TELEGRAM_OWNER_USER_ID") : [];
  if (configured.length > 1) {
    throw new Error("TELEGRAM_OWNER_USER_ID must contain exactly one Telegram user id");
  }
  const ownerUserId = configured[0] ?? allowedUserIds[0];
  if (ownerUserId === undefined || !allowedUserIds.includes(ownerUserId)) {
    throw new Error("TELEGRAM_OWNER_USER_ID must be listed in TELEGRAM_ALLOWED_USER_IDS");
  }
  return ownerUserId;
}

function parseTelegramUserIds(raw: string, envName: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid Telegram user id in ${envName}: ${value}`);
      }
      return parsed;
    });

  if (ids.length === 0) {
    throw new Error(`${envName} must contain at least one user id`);
  }

  return ids;
}

function parseMaxFileSize(raw: string | undefined, defaultValue: number): number {
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid MAX_FILE_SIZE value: "${raw}". Falling back to ${defaultValue} bytes.`);
    return defaultValue;
  }

  return parsed;
}

function parsePositiveIntEnv(raw: string | undefined, defaultValue: number): number {
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`Invalid positive integer env value: "${raw}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }

  return parsed;
}

function parseSandboxMode(raw: string | undefined): CodexSandboxMode {
  if (!raw) {
    return "workspace-write";
  }

  if (!isCodexSandboxMode(raw)) {
    console.warn(
      `Invalid CODEX_SANDBOX_MODE value: "${raw}". Expected one of: read-only, workspace-write, danger-full-access. Falling back to "workspace-write".`,
    );
    return "workspace-write";
  }

  return raw;
}

function parseApprovalPolicy(raw: string | undefined): CodexApprovalPolicy {
  if (!raw) {
    return "never";
  }

  if (!isCodexApprovalPolicy(raw)) {
    console.warn(
      `Invalid CODEX_APPROVAL_POLICY value: "${raw}". Expected one of: never, on-request, on-failure, untrusted. Falling back to "never".`,
    );
    return "never";
  }

  return raw;
}

function isCodexSandboxMode(value: string): value is CodexSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function isCodexApprovalPolicy(value: string): value is CodexApprovalPolicy {
  return value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted";
}
