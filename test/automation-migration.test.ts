import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { AutomationStore } from "../src/automation-store.js";

describe("automation database migration", () => {
  it("upgrades the original execution ledger without losing queued work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cody-automation-migration-test-"));
    const databasePath = path.join(root, "automations.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE automations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL, instruction TEXT NOT NULL, schedule_json TEXT NOT NULL,
        schedule_description TEXT NOT NULL, repeat_limit INTEGER, run_count INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('scheduled', 'paused', 'completed')),
        context_key TEXT NOT NULL, chat_id INTEGER NOT NULL, message_thread_id INTEGER,
        next_run_at TEXT, last_run_at TEXT,
        last_status TEXT CHECK(last_status IS NULL OR last_status IN ('success', 'silent', 'failed', 'unknown')),
        last_error TEXT, last_result TEXT, claim_token TEXT, claimed_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX automations_due ON automations(state, next_run_at) WHERE claim_token IS NULL;
      CREATE INDEX automations_project ON automations(project_id, updated_at DESC);
      CREATE TABLE automation_executions (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK(source IN ('scheduled', 'manual')),
        status TEXT NOT NULL CHECK(status IN ('claimed', 'running', 'success', 'silent', 'failed', 'unknown')),
        scheduled_for TEXT NOT NULL, claimed_at TEXT NOT NULL, started_at TEXT,
        finished_at TEXT, result TEXT, error TEXT
      );
      CREATE INDEX automation_executions_history ON automation_executions(automation_id, claimed_at DESC);
      INSERT INTO automations VALUES (
        'auto-1234567890abcdef', 'cody', 'Обзор', 'Описание', 'Инструкция',
        '{"kind":"once","at":"2026-08-07T12:00:00.000Z"}', 'сегодня', 1, 1,
        'scheduled', '100', 100, NULL, NULL, NULL, NULL, NULL, NULL,
        'execution-old', '2026-08-07T12:00:00.000Z',
        '2026-08-07T11:00:00.000Z', '2026-08-07T12:00:00.000Z'
      );
      INSERT INTO automation_executions VALUES (
        'execution-old', 'auto-1234567890abcdef', 'scheduled', 'claimed',
        '2026-08-07T12:00:00.000Z', '2026-08-07T12:00:00.000Z',
        NULL, NULL, NULL, NULL
      );
    `);
    legacy.close();

    const store = new AutomationStore(databasePath);
    const recovery = store.recoverInterrupted(new Date("2026-08-07T12:01:00.000Z"), "runner-new");
    expect(recovery.requeued).toHaveLength(1);
    store.markRunning("execution-old", "runner-new");
    store.finish(
      "execution-old",
      { status: "timed_out", error: "Превышено время" },
      new Date("2026-08-07T12:02:00.000Z"),
      { runnerId: "runner-new" },
    );

    expect(store.require("auto-1234567890abcdef")).toMatchObject({
      state: "completed",
      lastStatus: "timed_out",
    });
    expect(store.listExecutions("auto-1234567890abcdef")[0]).toMatchObject({
      status: "timed_out",
      deliveryStatus: "pending",
    });
    store.close();

    const migrated = new Database(databasePath);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.pragma("user_version", { simple: true })).toBe(4);
    const automationColumns = migrated.prepare("PRAGMA table_info(automations)").all() as Array<{ name: string }>;
    expect(automationColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "last_successful_at",
      "last_successful_result",
    ]));
    expect(migrated.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'automation_artifact_deliveries'
    `).get()).toBeTruthy();
    migrated.close();
    await rm(root, { recursive: true, force: true });
  });
});
