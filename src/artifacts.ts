import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { PREMIUM_EMOJI, renderPremiumEmoji } from "./format.js";
import { isWithinDirectory } from "./security.js";

export interface Artifact {
  name: string;
  localPath: string;
  sizeBytes: number;
}

export interface ArtifactReport {
  artifacts: Artifact[];
  skippedCount: number;
}

const MAX_TELEGRAM_FILE_SIZE = 50 * 1024 * 1024;
const IGNORED_PATTERNS = [/^\./, /^__pycache__$/, /\.tmp$/i, /~$/];

export async function ensureOutDir(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
}

export async function collectArtifactReport(outDir: string, maxFileSize?: number): Promise<ArtifactReport> {
  if (!existsSync(outDir)) {
    return { artifacts: [], skippedCount: 0 };
  }

  const canonicalOutDir = await realpath(outDir).catch(() => null);
  if (!canonicalOutDir) return { artifacts: [], skippedCount: 0 };
  const maxSize = maxFileSize ?? MAX_TELEGRAM_FILE_SIZE;
  const entries = await readdir(outDir);
  const artifacts: Artifact[] = [];
  let skippedCount = 0;

  for (const entry of entries) {
    if (IGNORED_PATTERNS.some((pattern) => pattern.test(entry))) {
      continue;
    }

    const fullPath = path.join(outDir, entry);
    const fileStat = await lstat(fullPath).catch(() => null);
    if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) {
      continue;
    }
    const canonicalFile = await realpath(fullPath).catch(() => null);
    if (!canonicalFile || !isWithinDirectory(canonicalFile, canonicalOutDir)) continue;

    if (fileStat.size > maxSize) {
      skippedCount += 1;
      continue;
    }

    artifacts.push({
      name: entry,
      localPath: canonicalFile,
      sizeBytes: fileStat.size,
    });
  }

  artifacts.sort((left, right) => left.name.localeCompare(right.name));

  return { artifacts, skippedCount };
}

export interface ArtifactSummary {
  html: string;
  plain: string;
}

export function formatArtifactSummary(
  artifacts: Artifact[],
  skippedCount: number,
  failedCount = 0,
): ArtifactSummary | null {
  if (artifacts.length === 0 && skippedCount === 0 && failedCount === 0) {
    return null;
  }

  const htmlLines: string[] = [];
  const plainLines: string[] = [];
  if (artifacts.length > 0) {
    htmlLines.push(`${renderPremiumEmoji(PREMIUM_EMOJI.received, "😊")} Готово файлов: ${artifacts.length}`);
    plainLines.push(`Готово файлов: ${artifacts.length}`);
  }
  if (skippedCount > 0) {
    htmlLines.push(`${renderPremiumEmoji(PREMIUM_EMOJI.sad, "😕")} Не отправлено из-за размера: ${skippedCount}`);
    plainLines.push(`Не отправлено из-за размера: ${skippedCount}`);
  }
  if (failedCount > 0) {
    htmlLines.push(`${renderPremiumEmoji(PREMIUM_EMOJI.sad, "😕")} Не удалось отправить: ${failedCount}`);
    plainLines.push(`Не удалось отправить: ${failedCount}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}
