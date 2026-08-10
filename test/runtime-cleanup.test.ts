import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupOrphanedAttachments } from "../src/runtime-cleanup.js";
import type { RuntimeJob } from "../src/runtime-jobs.js";
import { cleanupRuntimeJob } from "../src/task-recovery.js";

describe("cleanupOrphanedAttachments", () => {
  let base: string;
  let root: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "cody-runtime-cleanup-"));
    root = path.join(base, "workspace");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  it("keeps active attachments and removes old unreferenced files", async () => {
    const temp = path.join(base, "tmp");
    const inbox = path.join(root, ".cody-tgbot", "inbox");
    const active = path.join(inbox, "active");
    const orphan = path.join(inbox, "orphan");
    const recent = path.join(inbox, "recent");
    await mkdir(active, { recursive: true });
    await mkdir(orphan, { recursive: true });
    await mkdir(recent, { recursive: true });
    await mkdir(temp, { recursive: true });
    await writeFile(path.join(active, "photo.webp"), "active");
    await writeFile(path.join(orphan, "photo.webp"), "orphan");
    await writeFile(path.join(recent, "photo.webp"), "recent");
    const orphanTemp = path.join(temp, "cody-tgbot-file-old.bin");
    await writeFile(orphanTemp, "orphan");
    const old = new Date("2026-08-01T00:00:00Z");
    const elevenHoursOld = new Date("2026-08-06T13:00:00Z");
    await utimes(orphan, old, old);
    await utimes(recent, elevenHoursOld, elevenHoursOld);
    await utimes(orphanTemp, old, old);
    const job = { workspace: root, cleanupPaths: [active] } as RuntimeJob;

    await cleanupOrphanedAttachments(root, [job], Date.parse("2026-08-07T00:00:00Z"), temp);

    await expect(access(active)).resolves.toBeUndefined();
    await expect(access(orphan)).rejects.toThrow();
    await expect(access(recent)).resolves.toBeUndefined();
    await expect(access(orphanTemp)).rejects.toThrow();
  });

  it("removes old completed turns and keeps active ones", async () => {
    const turns = path.join(root, ".cody-tgbot", "turns");
    const active = path.join(turns, "active-turn");
    const completed = path.join(turns, "completed-turn");
    const automation = path.join(turns, "execution-automation");
    await mkdir(active, { recursive: true });
    await mkdir(completed, { recursive: true });
    await mkdir(automation, { recursive: true });
    const old = new Date("2026-08-01T00:00:00Z");
    await utimes(active, old, old);
    await utimes(completed, old, old);
    await utimes(automation, old, old);
    const job = {
      workspace: root,
      turnId: "active-turn",
      outDir: path.join(active, "out"),
    } as RuntimeJob;

    await cleanupOrphanedAttachments(root, [job], Date.parse("2026-08-07T00:00:00Z"));

    await expect(access(active)).resolves.toBeUndefined();
    await expect(access(completed)).rejects.toThrow();
    await expect(access(automation)).resolves.toBeUndefined();
  });

  it("only removes cleanup paths owned by the runtime", async () => {
    const owned = path.join(root, ".cody-tgbot", "inbox", "owned");
    const outside = path.join(base, "outside");
    await mkdir(owned, { recursive: true });
    await mkdir(outside, { recursive: true });

    await cleanupRuntimeJob({
      workspace: root,
      cleanupPaths: [owned, outside],
    } as RuntimeJob);

    await expect(access(owned)).rejects.toThrow();
    await expect(access(outside)).resolves.toBeUndefined();
  });
});
