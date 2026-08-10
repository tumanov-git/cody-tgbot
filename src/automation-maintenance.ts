import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { AutomationStore } from "./automation-store.js";
import type { ProjectStore } from "./project-store.js";

const RUN_FILE_TTL_MS = 12 * 60 * 60 * 1_000;

export async function maintainAutomations(
  store: AutomationStore,
  projectStore: ProjectStore,
  now = new Date(),
): Promise<{ executionsRemoved: number; runDirectoriesRemoved: number }> {
  const executionsRemoved = store.pruneHistory(now);
  const protectedRuns = store.listProtectedRunIds();
  let runDirectoriesRemoved = 0;
  const projects = await projectStore.list();
  for (const project of projects) {
    const turnsDirectory = path.join(project.workspace, ".cody-tgbot", "turns");
    const entries = await readdir(turnsDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("execution-")) continue;
      if (protectedRuns.has(entry.name)) continue;
      const target = path.join(turnsDirectory, entry.name);
      const metadata = await stat(target).catch(() => undefined);
      if (!metadata || now.getTime() - metadata.mtimeMs < RUN_FILE_TTL_MS) continue;
      await rm(target, { recursive: true, force: true });
      runDirectoriesRemoved += 1;
    }
  }
  return { executionsRemoved, runDirectoriesRemoved };
}
