import { rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CodexPromptInput } from "./codex-session.js";
import type { RuntimeJob } from "./runtime-jobs.js";
import { isWithinDirectory } from "./security.js";

export function buildRestartRecoveryInput(job: RuntimeJob): CodexPromptInput {
  const recoveryText = [
    "[Системное событие Коди]",
    "Процесс Коди перезапустился во время выполнения текущей задачи.",
    "Изучи историю этого треда и текущее состояние файлов и сервисов.",
    "Определи, что уже выполнено, не повторяй завершённые действия без необходимости и продолжи задачу с места остановки.",
    "После продолжения проверь результат и ответь пользователю как обычно.",
    "",
    `Исходный запрос: ${job.displayText}`,
  ].join("\n");
  if (typeof job.userInput === "string") return recoveryText;
  return {
    ...job.userInput,
    text: [recoveryText, job.userInput.text]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n"),
  };
}

export async function cleanupRuntimeJob(
  job: RuntimeJob,
  runtimeWorkspace = job.workspace,
): Promise<void> {
  for (const target of [...new Set(job.cleanupPaths ?? [])]) {
    if (!isSafeCleanupTarget(target, job.workspace, runtimeWorkspace)) {
      console.warn(`Skipped unsafe runtime cleanup path: ${target}`);
      continue;
    }
    await rm(target, { recursive: true, force: true }).catch((error) => {
      console.error(`Failed to clean up runtime path ${target}:`, error);
    });
  }
}

export async function retainRuntimeJobAttachments(
  job: RuntimeJob,
  runtimeWorkspace = job.workspace,
  retainedAt = new Date(),
): Promise<void> {
  for (const target of [...new Set(job.cleanupPaths ?? [])]) {
    if (!isSafeCleanupTarget(target, job.workspace, runtimeWorkspace)) {
      console.warn(`Skipped unsafe runtime retention path: ${target}`);
      continue;
    }
    await utimes(target, retainedAt, retainedAt).catch((error) => {
      if (!isNotFound(error)) {
        console.warn(`Failed to retain runtime attachment ${target}:`, error);
      }
    });
  }
}

function isSafeCleanupTarget(
  target: string,
  workspace: string,
  runtimeWorkspace: string,
): boolean {
  if (!target || target === path.parse(target).root) return false;
  const runtimeRoots = [workspace, runtimeWorkspace]
    .map((root) => path.join(root, ".cody-tgbot"));
  if (runtimeRoots.some((root) => isWithinDirectory(target, root))) return true;
  const resolved = path.resolve(target);
  return path.dirname(resolved) === path.resolve(tmpdir())
    && path.basename(resolved).startsWith("cody-tgbot-file-");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
