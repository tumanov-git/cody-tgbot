import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RuntimeJob } from "./runtime-jobs.js";

const ORPHAN_TTL_MS = 12 * 60 * 60 * 1_000;

export async function cleanupOrphanedAttachments(
  workspace: string,
  jobs: RuntimeJob[],
  now = Date.now(),
  temporaryDirectory = tmpdir(),
): Promise<void> {
  const protectedPaths = new Set(
    jobs.flatMap((job) => [
      ...(job.cleanupPaths ?? []),
      ...(job.outDir ? [job.outDir] : []),
      ...(job.turnId
        ? [path.join(job.workspace, ".cody-tgbot", "turns", job.turnId)]
        : []),
    ]).map((target) => path.resolve(target)),
  );
  const runtimeWorkspaces = new Set([workspace, ...jobs.map((job) => job.workspace)]);
  for (const runtimeWorkspace of runtimeWorkspaces) {
    await cleanupDirectoryChildren(
      path.join(runtimeWorkspace, ".cody-tgbot", "inbox"),
      protectedPaths,
      now,
      () => true,
    );
    await cleanupDirectoryChildren(
      path.join(runtimeWorkspace, ".cody-tgbot", "turns"),
      protectedPaths,
      now,
      (name) => !name.startsWith("execution-"),
    );
  }
  await cleanupDirectoryChildren(
    temporaryDirectory,
    protectedPaths,
    now,
    (name) => name.startsWith("cody-tgbot-file-"),
  );
}

async function cleanupDirectoryChildren(
  directory: string,
  protectedPaths: Set<string>,
  now: number,
  include: (name: string) => boolean,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!include(entry.name)) continue;
    const target = path.resolve(directory, entry.name);
    if (isProtected(target, protectedPaths)) continue;
    const metadata = await stat(target).catch(() => undefined);
    if (!metadata || now - metadata.mtimeMs < ORPHAN_TTL_MS) continue;
    await rm(target, { recursive: true, force: true }).catch((error) => {
      console.warn(`Failed to remove orphaned attachment ${target}:`, error);
    });
  }
}

function isProtected(target: string, protectedPaths: Set<string>): boolean {
  for (const protectedPath of protectedPaths) {
    if (
      target === protectedPath
      || target.startsWith(`${protectedPath}${path.sep}`)
      || protectedPath.startsWith(`${target}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}
