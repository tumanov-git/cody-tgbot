import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { collectArtifactReport, ensureOutDir, formatArtifactSummary } from "../src/artifacts.js";

describe("ensureOutDir", () => {
  const testDir = path.join(tmpdir(), `cody-tgbot-art-${randomUUID()}`);

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("creates the output directory", async () => {
    const dir = path.join(testDir, "out");
    await ensureOutDir(dir);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("collectArtifactReport", () => {
  const testDir = path.join(tmpdir(), `cody-tgbot-collect-${randomUUID()}`);

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns an empty report for a nonexistent directory", async () => {
    const missingDir = path.join(testDir, "missing");
    expect(await collectArtifactReport(missingDir)).toEqual({ artifacts: [], skippedCount: 0 });
  });

  it("collects files from the output directory", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, "output.txt"), "result");
    writeFileSync(path.join(testDir, "data.json"), '{"key": "value"}');

    const { artifacts } = await collectArtifactReport(testDir);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.name)).toEqual(["data.json", "output.txt"]);
  });

  it("skips hidden files and temp files", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, ".hidden"), "nope");
    writeFileSync(path.join(testDir, "backup.tmp"), "nope");
    writeFileSync(path.join(testDir, "backup~"), "nope");
    writeFileSync(path.join(testDir, "good.txt"), "yes");
    writeFileSync(path.join(testDir, "__init__.py"), "yes");

    const { artifacts } = await collectArtifactReport(testDir);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((a) => a.name)).toEqual(["__init__.py", "good.txt"]);
  });

  it("skips files exceeding max size", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, "small.txt"), "ok");
    writeFileSync(path.join(testDir, "big.bin"), Buffer.alloc(1024));

    const { artifacts } = await collectArtifactReport(testDir, 512);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("small.txt");
  });

  it("tracks skipped oversize files in the artifact report", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, "small.txt"), "ok");
    writeFileSync(path.join(testDir, "big.bin"), Buffer.alloc(1024));

    const report = await collectArtifactReport(testDir, 512);
    expect(report.artifacts).toHaveLength(1);
    expect(report.skippedCount).toBe(1);
  });

  it("does not collect symbolic links", async () => {
    const outside = path.join(tmpdir(), `cody-tgbot-secret-${randomUUID()}.txt`);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(outside, "secret");
    symlinkSync(outside, path.join(testDir, "report.txt"));

    try {
      expect((await collectArtifactReport(testDir)).artifacts).toEqual([]);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe("formatArtifactSummary", () => {
  it("returns null when no artifacts", () => {
    expect(formatArtifactSummary([], 0)).toBeNull();
  });

  it("formats single artifact", () => {
    const artifacts = [{ name: "out.txt", localPath: "/tmp/out.txt", sizeBytes: 100 }];
    const summary = formatArtifactSummary(artifacts, 0);
    expect(summary?.plain).toContain("Готово файлов: 1");
    expect(summary?.html).toContain('emoji-id="5341591044385431126"');
  });

  it("formats multiple artifacts", () => {
    const artifacts = [
      { name: "a.txt", localPath: "/tmp/a.txt", sizeBytes: 100 },
      { name: "b.txt", localPath: "/tmp/b.txt", sizeBytes: 200 },
    ];
    expect(formatArtifactSummary(artifacts, 0)?.plain).toContain("Готово файлов: 2");
  });

  it("reports skipped files", () => {
    const summary = formatArtifactSummary([], 3);
    expect(summary?.plain).toContain("Не отправлено из-за размера: 3");
    expect(summary?.html).toContain('emoji-id="5339360882616983894"');
    expect(summary?.plain).not.toContain("⚠️");
  });

  it("reports failed deliveries separately from delivered files", () => {
    const artifacts = [{ name: "out.txt", localPath: "/tmp/out.txt", sizeBytes: 100 }];
    const summary = formatArtifactSummary(artifacts, 2, 1);

    expect(summary?.plain).toContain("Готово файлов: 1");
    expect(summary?.plain).toContain("Не отправлено из-за размера: 2");
    expect(summary?.plain).toContain("Не удалось отправить: 1");
  });
});
