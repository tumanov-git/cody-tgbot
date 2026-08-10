import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

export type AutomationFailureKind = "blocked_config" | "transient" | "runtime";

class AutomationPreflightError extends Error {
  readonly kind = "blocked_config" as const;
}

export class AutomationLaunchError extends Error {
  constructor(
    readonly kind: AutomationFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export async function preflightAutomationWorkspace(workspace: string): Promise<void> {
  if (!path.isAbsolute(workspace)) {
    throw new AutomationPreflightError("Папка проекта должна быть абсолютным путём");
  }
  const metadata = await stat(workspace).catch(() => undefined);
  if (!metadata?.isDirectory()) {
    throw new AutomationPreflightError("Папка проекта больше не существует");
  }
  try {
    await access(workspace, constants.R_OK | constants.W_OK);
  } catch {
    throw new AutomationPreflightError("Нет доступа на чтение и запись в папку проекта");
  }
}

export function classifyAutomationFailure(error: unknown): AutomationFailureKind {
  if (error instanceof AutomationPreflightError || error instanceof AutomationLaunchError) {
    return error.kind;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (BLOCKED_CONFIG_PATTERN.test(message)) return "blocked_config";
  if (TRANSIENT_PATTERN.test(message)) return "transient";
  return "runtime";
}

const BLOCKED_CONFIG_PATTERN = new RegExp([
  "authentication",
  "unauthorized",
  "forbidden",
  "\\b40[13]\\b",
  "not[ -]?logged[ -]?in",
  "login required",
  "api[ _-]?key.*(?:missing|invalid|not set)",
  "invalid api[ _-]?key",
  "model.*(?:not found|does not exist|unavailable)",
  "permission denied",
  "eacces",
  "read-only file system",
].join("|"), "i");

const TRANSIENT_PATTERN = new RegExp([
  "rate[ -]?limit",
  "usage_limit_reached",
  "too many requests",
  "\\b429\\b",
  "overload",
  "temporar(?:y|ily)",
  "service unavailable",
  "internal server error",
  "bad gateway",
  "gateway timeout",
  "\\b50[0234]\\b",
  "econn(?:reset|refused|aborted)",
  "enetunreach",
  "etimedout",
  "timed out",
  "timeout",
  "network error",
].join("|"), "i");
