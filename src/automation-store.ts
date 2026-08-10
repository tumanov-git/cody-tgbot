import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  describeAutomationSchedule,
  firstAutomationRun,
  nextAutomationRun,
  normalizeAutomationSchedule,
  validateAutomationFrequency,
} from "./automation-schedule.js";
import type {
  AutomationArtifactDelivery,
  AutomationArtifactDeliveryStatus,
  AutomationDeliveryStatus,
  AutomationExecution,
  AutomationExecutionStatus,
  AutomationLastStatus,
  AutomationRecord,
  AutomationSchedule,
  AutomationSchedulerHealth,
  AutomationState,
  ClaimedAutomation,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "./automation-types.js";

type AutomationRow = {
  id: string;
  project_id: string;
  name: string;
  description: string;
  instruction: string;
  schedule_json: string;
  schedule_description: string;
  repeat_limit: number | null;
  run_count: number;
  consecutive_failures: number;
  state: AutomationState;
  context_key: string;
  chat_id: number;
  message_thread_id: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: AutomationLastStatus | null;
  last_error: string | null;
  last_result: string | null;
  last_successful_at: string | null;
  last_successful_result: string | null;
  paused_reason: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
};

type ExecutionRow = {
  id: string;
  automation_id: string;
  source: "scheduled" | "manual";
  status: AutomationExecutionStatus;
  scheduled_for: string;
  claimed_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: string | null;
  error: string | null;
  runner_id: string | null;
  delivery_status: AutomationDeliveryStatus;
  delivery_attempts: number;
  delivery_next_attempt_at: string | null;
  delivery_started_at: string | null;
  delivered_at: string | null;
  delivery_error: string | null;
  delivery_runner_id: string | null;
  telegram_message_id: number | null;
  artifact_summary_message_id: number | null;
};

type ArtifactDeliveryRow = {
  execution_id: string;
  artifact_name: string;
  size_bytes: number;
  status: AutomationArtifactDeliveryStatus;
  attempts: number;
  telegram_message_id: number | null;
  last_error: string | null;
  updated_at: string;
};

type SchedulerHealthRow = {
  last_tick_started_at: string | null;
  last_tick_completed_at: string | null;
  last_tick_error: string | null;
  last_lease_heartbeat_at: string | null;
};

export interface AutomationRecovery {
  requeued: ClaimedAutomation[];
  unknown: number;
  deliveriesReset: number;
}

export interface FinishAutomationOptions {
  runnerId?: string;
  pauseReason?: string;
  deliveryRequired?: boolean;
  countFailure?: boolean;
}

export interface AutomationStoreOptions {
  defaultTimezone?: string;
  minimumIntervalMinutes?: number;
  maxActivePerChat?: number;
  duplicateWindowMs?: number;
}

const DELIVERY_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const MAX_DELIVERY_ATTEMPTS = DELIVERY_RETRY_DELAYS_MS.length;
const MAX_CONSECUTIVE_FAILURES = 3;

export class AutomationStore {
  private readonly db: Database.Database;
  private readonly defaultTimezone: string;
  private readonly minimumIntervalMinutes: number;
  private readonly maxActivePerChat: number;
  private readonly duplicateWindowMs: number;

  constructor(databasePath: string, options: AutomationStoreOptions = {}) {
    this.defaultTimezone = options.defaultTimezone ?? "Europe/Moscow";
    this.minimumIntervalMinutes = options.minimumIntervalMinutes ?? 15;
    this.maxActivePerChat = options.maxActivePerChat ?? 20;
    this.duplicateWindowMs = options.duplicateWindowMs ?? 10 * 60_000;
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    this.db = new Database(resolved);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
    this.canonicalizeScheduleDescriptions();
  }

  close(): void {
    this.db.close();
  }

  create(input: CreateAutomationInput, now = new Date()): AutomationRecord {
    const schedule = normalizeAutomationSchedule(input.schedule);
    validateAutomationFrequency(schedule, this.minimumIntervalMinutes, now);
    const nextRunAt = firstAutomationRun(schedule, now).toISOString();
    const repeatLimit = normalizeRepeatLimit(input.repeatLimit, schedule.kind === "once" ? 1 : null);
    const projectId = bounded(input.projectId, 80, "project_id");
    const name = bounded(input.name, 80, "Название");
    const description = bounded(input.description, 1_500, "Описание");
    const instruction = bounded(input.instruction, 12_000, "Инструкция");
    const scheduleJson = JSON.stringify(schedule);
    const scheduleDescription = describeAutomationSchedule(schedule, this.defaultTimezone);
    return this.db.transaction(() => {
      const duplicate = this.db.prepare(`
        SELECT * FROM automations
        WHERE project_id = ? AND context_key = ? AND schedule_json = ? AND instruction = ?
          AND state != 'completed' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1
      `).get(
        projectId,
        input.contextKey,
        scheduleJson,
        instruction,
        new Date(now.getTime() - this.duplicateWindowMs).toISOString(),
      ) as AutomationRow | undefined;
      if (duplicate) return automationFromRow(duplicate);

      this.ensureActivationAllowed(input.chatId);
      const id = `auto-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const createdAt = now.toISOString();
      this.db.prepare(`
        INSERT INTO automations (
          id, project_id, name, description, instruction, schedule_json,
          schedule_description, repeat_limit, run_count, state, context_key,
          chat_id, message_thread_id, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'scheduled', ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        projectId,
        name,
        description,
        instruction,
        scheduleJson,
        scheduleDescription,
        repeatLimit,
        input.contextKey,
        input.chatId,
        input.messageThreadId ?? null,
        nextRunAt,
        createdAt,
        createdAt,
      );
      return this.require(id);
    })();
  }

  get(id: string): AutomationRecord | null {
    const row = this.db.prepare("SELECT * FROM automations WHERE id = ?").get(id) as AutomationRow | undefined;
    return row ? automationFromRow(row) : null;
  }

  require(id: string): AutomationRecord {
    const automation = this.get(id);
    if (!automation) throw new Error("Автоматизация не найдена");
    return automation;
  }

  list(options: { projectId?: string; contextKey?: string; includeCompleted?: boolean } = {}): AutomationRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) {
      clauses.push("project_id = ?");
      params.push(options.projectId);
    }
    if (options.contextKey) {
      clauses.push("context_key = ?");
      params.push(options.contextKey);
    }
    if (!options.includeCompleted) clauses.push("state != 'completed'");
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM automations${where} ORDER BY updated_at DESC, id DESC`,
    ).all(...params) as AutomationRow[];
    return rows.map(automationFromRow);
  }

  update(id: string, input: UpdateAutomationInput, now = new Date()): AutomationRecord {
    const current = this.requireIdle(id);
    const schedule = input.schedule ? normalizeAutomationSchedule(input.schedule) : current.schedule;
    const scheduleChanged = input.schedule !== undefined;
    if (scheduleChanged) validateAutomationFrequency(schedule, this.minimumIntervalMinutes, now);
    const repeatLimit = input.repeatLimit !== undefined
      ? normalizeRepeatLimit(input.repeatLimit, schedule.kind === "once" ? 1 : null)
      : current.repeatLimit;
    const nextRunAt = scheduleChanged
      ? firstAutomationRun(schedule, now).toISOString()
      : current.nextRunAt ?? null;
    const state = current.state === "completed" && scheduleChanged ? "scheduled" : current.state;
    if (state === "scheduled" && current.state !== "scheduled") {
      this.ensureActivationAllowed(current.chatId, current.id);
    }
    this.db.prepare(`
      UPDATE automations SET
        name = ?, description = ?, instruction = ?, schedule_json = ?,
        schedule_description = ?, repeat_limit = ?, state = ?, next_run_at = ?,
        paused_reason = CASE WHEN ? = 'scheduled' THEN NULL ELSE paused_reason END,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.name !== undefined ? bounded(input.name, 80, "Название") : current.name,
      input.description !== undefined ? bounded(input.description, 1_500, "Описание") : current.description,
      input.instruction !== undefined ? bounded(input.instruction, 12_000, "Инструкция") : current.instruction,
      JSON.stringify(schedule),
      describeAutomationSchedule(schedule, this.defaultTimezone),
      repeatLimit,
      state,
      nextRunAt,
      state,
      now.toISOString(),
      id,
    );
    return this.require(id);
  }

  pause(id: string, now = new Date(), reason?: string): AutomationRecord {
    this.requireIdle(id);
    this.db.prepare(`
      UPDATE automations SET state = 'paused', paused_reason = ?, updated_at = ?
      WHERE id = ? AND state != 'completed'
    `).run(reason?.slice(0, 1_000) ?? null, now.toISOString(), id);
    return this.require(id);
  }

  resume(id: string, now = new Date()): AutomationRecord {
    const current = this.requireIdle(id);
    if (current.state !== "paused") return current;
    this.ensureActivationAllowed(current.chatId, current.id);
    const nextRunAt = current.schedule.kind === "once"
      ? firstAutomationRun(current.schedule, now).toISOString()
      : nextAutomationRun(current.schedule, now).toISOString();
    this.db.prepare(`
      UPDATE automations
      SET state = 'scheduled', next_run_at = ?, paused_reason = NULL, updated_at = ?
      WHERE id = ?
    `).run(nextRunAt, now.toISOString(), id);
    return this.require(id);
  }

  remove(id: string): AutomationRecord {
    const current = this.requireIdle(id);
    this.db.prepare("DELETE FROM automations WHERE id = ?").run(id);
    return current;
  }

  tryAcquireLease(ownerId: string, now = new Date(), ttlMs = 30_000): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT owner_id, heartbeat_at FROM automation_scheduler_lease WHERE id = 1",
      ).get() as { owner_id: string; heartbeat_at: string } | undefined;
      const nowIso = now.toISOString();
      if (!row) {
        this.db.prepare(`
          INSERT INTO automation_scheduler_lease (id, owner_id, heartbeat_at) VALUES (1, ?, ?)
        `).run(ownerId, nowIso);
        this.recordLeaseHeartbeat(now);
        return true;
      }
      if (row.owner_id === ownerId) {
        this.db.prepare(
          "UPDATE automation_scheduler_lease SET heartbeat_at = ? WHERE id = 1 AND owner_id = ?",
        ).run(nowIso, ownerId);
        this.recordLeaseHeartbeat(now);
        return true;
      }
      if (new Date(row.heartbeat_at).getTime() > now.getTime() - ttlMs) return false;
      const updated = this.db.prepare(`
        UPDATE automation_scheduler_lease SET owner_id = ?, heartbeat_at = ?
        WHERE id = 1 AND owner_id = ? AND heartbeat_at = ?
      `).run(ownerId, nowIso, row.owner_id, row.heartbeat_at);
      if (updated.changes === 1) this.recordLeaseHeartbeat(now);
      return updated.changes === 1;
    })();
  }

  heartbeatLease(ownerId: string, now = new Date()): boolean {
    return this.db.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE automation_scheduler_lease SET heartbeat_at = ? WHERE id = 1 AND owner_id = ?
      `).run(now.toISOString(), ownerId);
      if (updated.changes === 1) this.recordLeaseHeartbeat(now);
      return updated.changes === 1;
    })();
  }

  releaseLease(ownerId: string): void {
    this.db.prepare("DELETE FROM automation_scheduler_lease WHERE id = 1 AND owner_id = ?").run(ownerId);
  }

  recordSchedulerTickStarted(now = new Date()): void {
    this.db.prepare(`
      UPDATE automation_scheduler_health
      SET last_tick_started_at = ?, last_tick_error = NULL
      WHERE id = 1
    `).run(now.toISOString());
  }

  recordSchedulerTickCompleted(now = new Date()): void {
    this.db.prepare(`
      UPDATE automation_scheduler_health
      SET last_tick_completed_at = ?, last_tick_error = NULL
      WHERE id = 1
    `).run(now.toISOString());
  }

  recordSchedulerTickFailed(error: string): void {
    this.db.prepare(`
      UPDATE automation_scheduler_health
      SET last_tick_error = ?
      WHERE id = 1
    `).run(error.slice(0, 2_000));
  }

  readSchedulerHealth(
    now = new Date(),
    staleAfterMs = 90_000,
  ): Omit<AutomationSchedulerHealth, "activeWorkers" | "queuedClaims"> {
    const health = this.db.prepare(`
      SELECT last_tick_started_at, last_tick_completed_at, last_tick_error,
        last_lease_heartbeat_at
      FROM automation_scheduler_health WHERE id = 1
    `).get() as SchedulerHealthRow;
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN state = 'scheduled' THEN 1 ELSE 0 END) AS scheduled_count,
        SUM(CASE WHEN state = 'scheduled' AND claim_token IS NULL
          AND next_run_at IS NOT NULL AND next_run_at <= ? THEN 1 ELSE 0 END) AS due_count,
        MIN(CASE WHEN state = 'scheduled' AND claim_token IS NULL
          AND next_run_at IS NOT NULL AND next_run_at <= ? THEN next_run_at END) AS oldest_due_at,
        SUM(CASE WHEN claim_token IS NOT NULL THEN 1 ELSE 0 END) AS running_count
      FROM automations
    `).get(now.toISOString(), now.toISOString()) as {
      scheduled_count: number | null;
      due_count: number | null;
      oldest_due_at: string | null;
      running_count: number | null;
    };
    const lastSuccessful = health.last_tick_completed_at
      ? new Date(health.last_tick_completed_at).getTime()
      : 0;
    const lastStarted = health.last_tick_started_at
      ? new Date(health.last_tick_started_at).getTime()
      : 0;
    const hasLatestError = Boolean(health.last_tick_error && lastStarted >= lastSuccessful);
    const stale = lastSuccessful > 0 && now.getTime() - lastSuccessful > staleAfterMs;
    const starting = lastSuccessful === 0 && !hasLatestError;
    return {
      ...(health.last_tick_started_at ? { lastTickStartedAt: health.last_tick_started_at } : {}),
      ...(health.last_tick_completed_at ? { lastSuccessfulTickAt: health.last_tick_completed_at } : {}),
      ...(health.last_tick_error ? { lastTickError: health.last_tick_error } : {}),
      ...(health.last_lease_heartbeat_at
        ? { lastLeaseHeartbeatAt: health.last_lease_heartbeat_at }
        : {}),
      scheduledCount: counts.scheduled_count ?? 0,
      dueCount: counts.due_count ?? 0,
      runningCount: counts.running_count ?? 0,
      ...(counts.oldest_due_at ? { oldestDueAt: counts.oldest_due_at } : {}),
      healthy: !starting && !hasLatestError && !stale,
      status: starting ? "starting" : hasLatestError || stale ? "degraded" : "healthy",
    };
  }

  claimDue(now = new Date(), limit = 10, runnerId = "standalone"): ClaimedAutomation[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM automations
        WHERE state = 'scheduled' AND claim_token IS NULL
          AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC LIMIT ?
      `).all(now.toISOString(), Math.max(1, Math.min(limit, 100))) as AutomationRow[];
      return rows
        .map((row) => this.claimScheduledRow(row, now, runnerId))
        .filter((claim): claim is ClaimedAutomation => claim !== null);
    })();
  }

  claimNow(id: string, now = new Date(), runnerId = "standalone"): ClaimedAutomation {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM automations WHERE id = ? AND state != 'completed' AND claim_token IS NULL",
      ).get(id) as AutomationRow | undefined;
      if (!row) {
        const current = this.get(id);
        if (!current) throw new Error("Автоматизация не найдена");
        if (current.claimToken) throw new Error("Автоматизация уже выполняется");
        throw new Error("Завершённую автоматизацию нельзя запустить повторно");
      }
      const execution = this.createExecution(row.id, "manual", now.toISOString(), now, runnerId);
      const changed = this.db.prepare(`
        UPDATE automations SET claim_token = ?, claimed_at = ?, updated_at = ?
        WHERE id = ? AND claim_token IS NULL
      `).run(execution.id, now.toISOString(), now.toISOString(), row.id);
      if (changed.changes !== 1) throw new Error("Автоматизация уже выполняется");
      return { automation: this.require(row.id), execution };
    })();
  }

  markRunning(executionId: string, runnerId = "standalone", now = new Date()): AutomationExecution {
    const updated = this.db.prepare(`
      UPDATE automation_executions SET status = 'running', started_at = ?
      WHERE id = ? AND status = 'claimed' AND runner_id = ?
    `).run(now.toISOString(), executionId, runnerId);
    if (updated.changes !== 1) throw new Error("Запуск автоматизации уже не ожидает выполнения");
    return this.requireExecution(executionId);
  }

  finish(
    executionId: string,
    outcome: {
      status: "success" | "silent" | "failed" | "timed_out";
      result?: string;
      error?: string;
    },
    now = new Date(),
    options: FinishAutomationOptions = {},
  ): AutomationRecord {
    return this.db.transaction(() => {
      const execution = this.requireExecution(executionId);
      if (execution.status !== "claimed" && execution.status !== "running") {
        throw new Error("Запуск уже завершён");
      }
      if (options.runnerId && execution.runnerId !== options.runnerId) {
        throw new Error("Запуск принадлежит другому процессу Коди");
      }
      const finishedAt = now.toISOString();
      const result = outcome.result?.slice(0, 100_000) || null;
      const error = outcome.error?.slice(0, 4_000) || null;
      const deliveryRequired = options.deliveryRequired ?? outcome.status !== "silent";
      this.db.prepare(`
        UPDATE automation_executions SET
          status = ?, finished_at = ?, result = ?, error = ?,
          delivery_status = ?, delivery_next_attempt_at = ?, runner_id = NULL
        WHERE id = ?
      `).run(
        outcome.status,
        finishedAt,
        result,
        error,
        deliveryRequired ? "pending" : "not_required",
        deliveryRequired ? finishedAt : null,
        executionId,
      );
      const current = this.require(execution.automationId);
      const successful = outcome.status === "success" || outcome.status === "silent";
      const countsAsFailure = options.countFailure ?? !successful;
      const consecutiveFailures = successful
        ? 0
        : countsAsFailure
          ? current.consecutiveFailures + 1
          : current.consecutiveFailures;
      const failurePauseReason = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
        ? "Приостановлена после трёх неудачных запусков подряд"
        : undefined;
      const pauseReason = options.pauseReason ?? failurePauseReason;
      const nextState = pauseReason
        ? "paused"
        : current.state === "paused"
          ? "paused"
          : current.nextRunAt
            ? "scheduled"
            : "completed";
      const updated = this.db.prepare(`
        UPDATE automations SET
          state = ?, paused_reason = ?, claim_token = NULL, claimed_at = NULL,
          last_run_at = ?, last_status = ?, last_error = ?, last_result = ?,
          last_successful_at = CASE WHEN ? THEN ? ELSE last_successful_at END,
          last_successful_result = CASE
            WHEN ? AND ? IS NOT NULL THEN ? ELSE last_successful_result END,
          consecutive_failures = ?, updated_at = ?
        WHERE id = ? AND claim_token = ?
      `).run(
        nextState,
        pauseReason?.slice(0, 1_000) ?? current.pausedReason ?? null,
        finishedAt,
        outcome.status,
        error,
        result,
        successful ? 1 : 0,
        finishedAt,
        outcome.status === "success" ? 1 : 0,
        result,
        result,
        consecutiveFailures,
        finishedAt,
        current.id,
        executionId,
      );
      if (updated.changes !== 1) throw new Error("Не удалось завершить запуск автоматизации");
      return this.require(current.id);
    })();
  }

  recoverInterrupted(now = new Date(), runnerId = "standalone"): AutomationRecovery {
    return this.db.transaction(() => {
      const finishedAt = now.toISOString();
      const error = "Коди перезапустился до подтверждённого завершения запуска";
      const claimed = this.db.prepare(`
        SELECT * FROM automation_executions WHERE status = 'claimed'
      `).all() as ExecutionRow[];
      const requeued: ClaimedAutomation[] = [];
      for (const row of claimed) {
        this.db.prepare(
          "UPDATE automation_executions SET runner_id = ? WHERE id = ? AND status = 'claimed'",
        ).run(runnerId, row.id);
        const automation = this.get(row.automation_id);
        if (automation?.claimToken === row.id) {
          requeued.push({ automation, execution: this.requireExecution(row.id) });
        }
      }

      const running = this.db.prepare(`
        SELECT id, automation_id FROM automation_executions WHERE status = 'running'
      `).all() as Array<{ id: string; automation_id: string }>;
      for (const execution of running) {
        const automation = this.get(execution.automation_id);
        const consecutiveFailures = (automation?.consecutiveFailures ?? 0) + 1;
        const pauseAfterFailures = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
        this.db.prepare(`
          UPDATE automation_executions SET
            status = 'unknown', finished_at = ?, error = ?, runner_id = NULL,
            delivery_status = 'pending', delivery_next_attempt_at = ?
          WHERE id = ?
        `).run(finishedAt, error, finishedAt, execution.id);
        this.db.prepare(`
          UPDATE automations SET
            state = CASE
              WHEN state = 'paused' THEN 'paused'
              WHEN ? THEN 'paused'
              WHEN next_run_at IS NULL THEN 'completed'
              ELSE 'scheduled'
            END,
            claim_token = NULL, claimed_at = NULL, last_run_at = ?,
            last_status = 'unknown', last_error = ?, consecutive_failures = ?,
            paused_reason = CASE WHEN ? THEN ? ELSE paused_reason END,
            updated_at = ?
          WHERE id = ? AND claim_token = ?
        `).run(
          pauseAfterFailures ? 1 : 0,
          finishedAt,
          error,
          consecutiveFailures,
          pauseAfterFailures ? 1 : 0,
          pauseAfterFailures
            ? "Приостановлена после трёх неудачных запусков подряд"
            : null,
          finishedAt,
          execution.automation_id,
          execution.id,
        );
      }
      const deliveriesReset = this.db.prepare(`
        UPDATE automation_executions SET
          delivery_status = 'pending', delivery_runner_id = NULL,
          delivery_started_at = NULL, delivery_next_attempt_at = ?
        WHERE delivery_status = 'delivering'
      `).run(finishedAt).changes;
      const artifactDeliveriesReset = this.db.prepare(`
        UPDATE automation_artifact_deliveries SET
          status = 'failed', last_error = ?, updated_at = ?
        WHERE status = 'delivering'
      `).run("Коди перезапустился во время отправки файла", finishedAt).changes;
      return {
        requeued,
        unknown: running.length,
        deliveriesReset: deliveriesReset + artifactDeliveriesReset,
      };
    })();
  }

  listExecutions(automationId: string, limit = 20, offset = 0): AutomationExecution[] {
    const rows = this.db.prepare(`
      SELECT * FROM automation_executions WHERE automation_id = ?
      ORDER BY claimed_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(
      automationId,
      Math.max(1, Math.min(limit, 200)),
      Math.max(0, offset),
    ) as ExecutionRow[];
    return rows.map(executionFromRow);
  }

  countExecutions(automationId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM automation_executions WHERE automation_id = ?",
    ).get(automationId) as { count: number };
    return row.count;
  }

  listDueDeliveryIds(now = new Date(), limit = 20): string[] {
    const rows = this.db.prepare(`
      SELECT id FROM automation_executions
      WHERE delivery_status IN ('pending', 'failed')
        AND delivery_attempts < ?
        AND (delivery_next_attempt_at IS NULL OR delivery_next_attempt_at <= ?)
      ORDER BY COALESCE(delivery_next_attempt_at, finished_at, claimed_at) ASC
      LIMIT ?
    `).all(MAX_DELIVERY_ATTEMPTS, now.toISOString(), Math.max(1, Math.min(limit, 100))) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  listProtectedRunIds(): Set<string> {
    const rows = this.db.prepare(`
      SELECT id FROM automation_executions
      WHERE status IN ('claimed', 'running')
        OR delivery_status IN ('pending', 'delivering')
        OR (delivery_status = 'failed' AND delivery_attempts < ?)
    `).all(MAX_DELIVERY_ATTEMPTS) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  claimDelivery(executionId: string, runnerId: string, now = new Date()): ClaimedAutomation | null {
    return this.db.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE automation_executions SET
          delivery_status = 'delivering', delivery_attempts = delivery_attempts + 1,
          delivery_started_at = ?, delivery_runner_id = ?, delivery_error = NULL
        WHERE id = ? AND delivery_status IN ('pending', 'failed')
          AND delivery_attempts < ?
          AND (delivery_next_attempt_at IS NULL OR delivery_next_attempt_at <= ?)
      `).run(now.toISOString(), runnerId, executionId, MAX_DELIVERY_ATTEMPTS, now.toISOString());
      if (updated.changes !== 1) return null;
      const execution = this.requireExecution(executionId);
      return { automation: this.require(execution.automationId), execution };
    })();
  }

  markDeliveryMainSent(executionId: string, runnerId: string, messageId: number): void {
    const updated = this.db.prepare(`
      UPDATE automation_executions SET telegram_message_id = ?
      WHERE id = ? AND delivery_status = 'delivering' AND delivery_runner_id = ?
    `).run(messageId, executionId, runnerId);
    if (updated.changes !== 1) throw new Error("Доставка принадлежит другому процессу Коди");
  }

  syncArtifactDeliveries(
    executionId: string,
    artifacts: Array<{ name: string; sizeBytes: number }>,
    now = new Date(),
  ): AutomationArtifactDelivery[] {
    return this.db.transaction(() => {
      this.requireExecution(executionId);
      const insert = this.db.prepare(`
        INSERT INTO automation_artifact_deliveries (
          execution_id, artifact_name, size_bytes, status, attempts, updated_at
        ) VALUES (?, ?, ?, 'pending', 0, ?)
        ON CONFLICT(execution_id, artifact_name) DO NOTHING
      `);
      for (const artifact of artifacts) {
        insert.run(executionId, artifact.name, artifact.sizeBytes, now.toISOString());
        const existing = this.db.prepare(`
          SELECT size_bytes FROM automation_artifact_deliveries
          WHERE execution_id = ? AND artifact_name = ?
        `).get(executionId, artifact.name) as { size_bytes: number };
        if (existing.size_bytes !== artifact.sizeBytes) {
          throw new Error(`Файл «${artifact.name}» изменился после завершения автоматизации`);
        }
      }
      const registered = this.listArtifactDeliveries(executionId);
      const availableNames = new Set(artifacts.map((artifact) => artifact.name));
      const missing = registered.find(
        (artifact) => artifact.status !== "delivered" && !availableNames.has(artifact.artifactName),
      );
      if (missing) {
        throw new Error(`Файл «${missing.artifactName}» пропал до подтверждённой доставки`);
      }
      return registered;
    })();
  }

  listArtifactDeliveries(executionId: string): AutomationArtifactDelivery[] {
    const rows = this.db.prepare(`
      SELECT * FROM automation_artifact_deliveries
      WHERE execution_id = ? ORDER BY artifact_name ASC
    `).all(executionId) as ArtifactDeliveryRow[];
    return rows.map(artifactDeliveryFromRow);
  }

  claimArtifactDelivery(
    executionId: string,
    artifactName: string,
    now = new Date(),
  ): AutomationArtifactDelivery | null {
    const updated = this.db.prepare(`
      UPDATE automation_artifact_deliveries SET
        status = 'delivering', attempts = attempts + 1, last_error = NULL, updated_at = ?
      WHERE execution_id = ? AND artifact_name = ?
        AND status IN ('pending', 'failed') AND attempts < ?
    `).run(now.toISOString(), executionId, artifactName, MAX_DELIVERY_ATTEMPTS);
    if (updated.changes !== 1) return null;
    return this.requireArtifactDelivery(executionId, artifactName);
  }

  finishArtifactDelivery(
    executionId: string,
    artifactName: string,
    messageId?: number,
    error?: string,
    now = new Date(),
  ): AutomationArtifactDelivery {
    const updated = this.db.prepare(`
      UPDATE automation_artifact_deliveries SET
        status = ?, telegram_message_id = ?, last_error = ?, updated_at = ?
      WHERE execution_id = ? AND artifact_name = ? AND status = 'delivering'
    `).run(
      error ? "failed" : "delivered",
      error ? null : messageId ?? null,
      error?.slice(0, 4_000) ?? null,
      now.toISOString(),
      executionId,
      artifactName,
    );
    if (updated.changes !== 1) throw new Error("Доставка файла уже завершена");
    return this.requireArtifactDelivery(executionId, artifactName);
  }

  markArtifactSummarySent(executionId: string, runnerId: string, messageId: number): void {
    const updated = this.db.prepare(`
      UPDATE automation_executions SET artifact_summary_message_id = ?
      WHERE id = ? AND delivery_status = 'delivering' AND delivery_runner_id = ?
    `).run(messageId, executionId, runnerId);
    if (updated.changes !== 1) throw new Error("Доставка принадлежит другому процессу Коди");
  }

  finishDelivery(executionId: string, runnerId: string, error?: string, now = new Date()): AutomationExecution {
    return this.db.transaction(() => {
      const execution = this.requireExecution(executionId);
      if (execution.deliveryStatus !== "delivering") throw new Error("Доставка уже завершена");
      const failed = Boolean(error);
      const terminalFailure = failed && execution.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS;
      const delay = DELIVERY_RETRY_DELAYS_MS[Math.max(0, execution.deliveryAttempts - 1)];
      const retryAt = failed && !terminalFailure && delay
        ? new Date(now.getTime() + delay).toISOString()
        : null;
      const updated = this.db.prepare(`
        UPDATE automation_executions SET
          delivery_status = ?, delivered_at = ?, delivery_error = ?,
          delivery_next_attempt_at = ?, delivery_runner_id = NULL
        WHERE id = ? AND delivery_status = 'delivering' AND delivery_runner_id = ?
      `).run(
        failed ? "failed" : "delivered",
        failed ? null : now.toISOString(),
        error?.slice(0, 4_000) ?? null,
        retryAt,
        executionId,
        runnerId,
      );
      if (updated.changes !== 1) throw new Error("Доставка принадлежит другому процессу Коди");
      if (terminalFailure) {
        this.db.prepare(`
          UPDATE automations SET state = 'paused', paused_reason = ?, updated_at = ?
          WHERE id = ? AND state = 'scheduled'
        `).run(
          "Приостановлена: результат не удалось доставить в Telegram после трёх попыток",
          now.toISOString(),
          execution.automationId,
        );
      }
      return this.requireExecution(executionId);
    })();
  }

  pruneHistory(now = new Date(), maxPerAutomation = 100, maxAgeMs = 90 * 24 * 60 * 60 * 1_000): number {
    const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
    return this.db.prepare(`
      DELETE FROM automation_executions
      WHERE status NOT IN ('claimed', 'running')
        AND (
          delivery_status IN ('not_required', 'delivered')
          OR (delivery_status = 'failed' AND delivery_attempts >= ?)
        )
        AND (
          finished_at < ?
          OR id IN (
            SELECT id FROM (
              SELECT id,
                ROW_NUMBER() OVER (PARTITION BY automation_id ORDER BY claimed_at DESC, id DESC) AS position
              FROM automation_executions
              WHERE status NOT IN ('claimed', 'running')
            ) WHERE position > ?
          )
        )
    `).run(MAX_DELIVERY_ATTEMPTS, cutoff, Math.max(1, maxPerAutomation)).changes;
  }

  private claimScheduledRow(row: AutomationRow, now: Date, runnerId: string): ClaimedAutomation | null {
    const schedule = parseSchedule(row.schedule_json);
    const runCount = row.run_count + 1;
    const exhausted = row.repeat_limit !== null && runCount >= row.repeat_limit;
    const nextRunAt = schedule.kind === "once" || exhausted
      ? null
      : nextAutomationRun(schedule, now).toISOString();
    const execution = this.createExecution(row.id, "scheduled", row.next_run_at!, now, runnerId);
    const changed = this.db.prepare(`
      UPDATE automations SET
        claim_token = ?, claimed_at = ?, run_count = ?, next_run_at = ?, updated_at = ?
      WHERE id = ? AND state = 'scheduled' AND claim_token IS NULL AND next_run_at = ?
    `).run(
      execution.id,
      now.toISOString(),
      runCount,
      nextRunAt,
      now.toISOString(),
      row.id,
      row.next_run_at,
    );
    if (changed.changes !== 1) {
      this.db.prepare("DELETE FROM automation_executions WHERE id = ?").run(execution.id);
      return null;
    }
    return { automation: this.require(row.id), execution };
  }

  private createExecution(
    automationId: string,
    source: "scheduled" | "manual",
    scheduledFor: string,
    now: Date,
    runnerId: string,
  ): AutomationExecution {
    const id = `execution-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO automation_executions (
        id, automation_id, source, status, scheduled_for, claimed_at, runner_id
      ) VALUES (?, ?, ?, 'claimed', ?, ?, ?)
    `).run(id, automationId, source, scheduledFor, now.toISOString(), runnerId);
    return this.requireExecution(id);
  }

  private requireExecution(id: string): AutomationExecution {
    const row = this.db.prepare("SELECT * FROM automation_executions WHERE id = ?").get(id) as ExecutionRow | undefined;
    if (!row) throw new Error("Запуск автоматизации не найден");
    return executionFromRow(row);
  }

  private requireArtifactDelivery(
    executionId: string,
    artifactName: string,
  ): AutomationArtifactDelivery {
    const row = this.db.prepare(`
      SELECT * FROM automation_artifact_deliveries
      WHERE execution_id = ? AND artifact_name = ?
    `).get(executionId, artifactName) as ArtifactDeliveryRow | undefined;
    if (!row) throw new Error("Файл запуска не найден");
    return artifactDeliveryFromRow(row);
  }

  private recordLeaseHeartbeat(now: Date): void {
    this.db.prepare(`
      UPDATE automation_scheduler_health SET last_lease_heartbeat_at = ? WHERE id = 1
    `).run(now.toISOString());
  }

  private requireIdle(id: string): AutomationRecord {
    const current = this.require(id);
    if (current.claimToken) throw new Error("Сначала дождись завершения текущего запуска");
    return current;
  }

  private ensureActivationAllowed(chatId: number, excludeId?: string): void {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM automations
      WHERE chat_id = ? AND state = 'scheduled'${excludeId ? " AND id != ?" : ""}
    `).get(...(excludeId ? [chatId, excludeId] : [chatId])) as { count: number };
    if (row.count >= this.maxActivePerChat) {
      throw new Error(`Можно держать не больше ${this.maxActivePerChat} активных автоматизаций`);
    }
  }

  private canonicalizeScheduleDescriptions(): void {
    const rows = this.db.prepare("SELECT id, schedule_json, schedule_description FROM automations").all() as Array<{
      id: string;
      schedule_json: string;
      schedule_description: string;
    }>;
    const update = this.db.prepare(
      "UPDATE automations SET schedule_description = ? WHERE id = ? AND schedule_description != ?",
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const description = describeAutomationSchedule(parseSchedule(row.schedule_json), this.defaultTimezone);
        update.run(description, row.id, description);
      }
    })();
  }

  private initialize(): void {
    const automationSql = this.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automations'
    `).get() as { sql: string } | undefined;
    if (!automationSql) {
      this.createSchema();
      return;
    }

    const automationColumns = this.db.prepare("PRAGMA table_info(automations)").all() as Array<{ name: string }>;
    if (!automationColumns.some((column) => column.name === "paused_reason")) {
      this.db.exec("ALTER TABLE automations ADD COLUMN paused_reason TEXT");
    }
    if (!automationColumns.some((column) => column.name === "consecutive_failures")) {
      this.db.exec("ALTER TABLE automations ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
    }
    if (!automationColumns.some((column) => column.name === "last_successful_at")) {
      this.db.exec("ALTER TABLE automations ADD COLUMN last_successful_at TEXT");
    }
    if (!automationColumns.some((column) => column.name === "last_successful_result")) {
      this.db.exec("ALTER TABLE automations ADD COLUMN last_successful_result TEXT");
      this.db.exec(`
        UPDATE automations SET
          last_successful_at = CASE
            WHEN last_status IN ('success', 'silent') THEN last_run_at ELSE NULL END,
          last_successful_result = CASE
            WHEN last_status = 'success' THEN last_result ELSE NULL END
      `);
    }
    const executionSql = this.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_executions'
    `).get() as { sql: string } | undefined;
    const executionColumns = this.db.prepare("PRAGMA table_info(automation_executions)").all() as Array<{ name: string }>;
    if (!executionColumns.some((column) => column.name === "artifact_summary_message_id")) {
      this.db.exec("ALTER TABLE automation_executions ADD COLUMN artifact_summary_message_id INTEGER");
    }
    if (
      !automationSql.sql.includes("timed_out")
      || !executionSql?.sql.includes("delivery_status")
      || !executionSql.sql.includes("timed_out")
    ) {
      this.migrateLegacySchema();
    }
    this.createLeaseTable();
    this.createSchedulerHealthTable();
    this.createArtifactDeliveryTable();
    this.db.pragma("user_version = 4");
  }

  private createSchema(): void {
    this.createAutomationTable();
    this.createExecutionTable();
    this.createLeaseTable();
    this.createSchedulerHealthTable();
    this.createArtifactDeliveryTable();
    this.db.pragma("user_version = 4");
  }

  private createAutomationTable(): void {
    this.db.exec(`
      CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instruction TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        schedule_description TEXT NOT NULL,
        repeat_limit INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('scheduled', 'paused', 'completed')),
        context_key TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        message_thread_id INTEGER,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT CHECK(last_status IS NULL OR last_status IN ('success', 'silent', 'failed', 'timed_out', 'unknown')),
        last_error TEXT,
        last_result TEXT,
        last_successful_at TEXT,
        last_successful_result TEXT,
        paused_reason TEXT,
        claim_token TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX automations_due ON automations(state, next_run_at) WHERE claim_token IS NULL;
      CREATE INDEX automations_project ON automations(project_id, updated_at DESC);
    `);
  }

  private createExecutionTable(): void {
    this.db.exec(`
      CREATE TABLE automation_executions (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK(source IN ('scheduled', 'manual')),
        status TEXT NOT NULL CHECK(status IN ('claimed', 'running', 'success', 'silent', 'failed', 'timed_out', 'unknown')),
        scheduled_for TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        result TEXT,
        error TEXT,
        runner_id TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'not_required'
          CHECK(delivery_status IN ('not_required', 'pending', 'delivering', 'delivered', 'failed')),
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        delivery_next_attempt_at TEXT,
        delivery_started_at TEXT,
        delivered_at TEXT,
        delivery_error TEXT,
        delivery_runner_id TEXT,
        telegram_message_id INTEGER,
        artifact_summary_message_id INTEGER
      );
      CREATE INDEX automation_executions_history
        ON automation_executions(automation_id, claimed_at DESC);
      CREATE INDEX automation_executions_delivery
        ON automation_executions(delivery_status, delivery_next_attempt_at);
    `);
  }

  private createLeaseTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_scheduler_lease (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        owner_id TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
    `);
  }

  private createSchedulerHealthTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_scheduler_health (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        last_tick_started_at TEXT,
        last_tick_completed_at TEXT,
        last_tick_error TEXT,
        last_lease_heartbeat_at TEXT
      );
      INSERT OR IGNORE INTO automation_scheduler_health (id) VALUES (1);
    `);
  }

  private createArtifactDeliveryTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_artifact_deliveries (
        execution_id TEXT NOT NULL REFERENCES automation_executions(id) ON DELETE CASCADE,
        artifact_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivering', 'delivered', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        telegram_message_id INTEGER,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (execution_id, artifact_name)
      );
      CREATE INDEX IF NOT EXISTS automation_artifact_deliveries_status
        ON automation_artifact_deliveries(status, updated_at);
    `);
  }

  private migrateLegacySchema(): void {
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.exec(`
          DROP INDEX IF EXISTS automation_executions_history;
          DROP INDEX IF EXISTS automation_executions_delivery;
          DROP INDEX IF EXISTS automations_due;
          DROP INDEX IF EXISTS automations_project;
          ALTER TABLE automation_executions RENAME TO automation_executions_legacy;
          ALTER TABLE automations RENAME TO automations_legacy;
        `);
        this.createAutomationTable();
        this.db.exec(`
          INSERT INTO automations (
            id, project_id, name, description, instruction, schedule_json,
            schedule_description, repeat_limit, run_count, consecutive_failures, state, context_key,
            chat_id, message_thread_id, next_run_at, last_run_at, last_status,
            last_error, last_result, last_successful_at, last_successful_result,
            paused_reason, claim_token, claimed_at,
            created_at, updated_at
          )
          SELECT
            id, project_id, name, description, instruction, schedule_json,
            schedule_description, repeat_limit, run_count, consecutive_failures, state, context_key,
            chat_id, message_thread_id, next_run_at, last_run_at, last_status,
            last_error, last_result, last_successful_at, last_successful_result,
            paused_reason, claim_token, claimed_at,
            created_at, updated_at
          FROM automations_legacy;
        `);
        this.createExecutionTable();
        this.db.exec(`
        INSERT INTO automation_executions (
          id, automation_id, source, status, scheduled_for, claimed_at,
          started_at, finished_at, result, error, runner_id,
          delivery_status, delivery_attempts, delivered_at
        )
        SELECT
          id, automation_id, source, status, scheduled_for, claimed_at,
          started_at, finished_at, result, error, NULL,
          CASE
            WHEN status = 'silent' THEN 'not_required'
            WHEN status IN ('success', 'failed', 'unknown') THEN 'delivered'
            ELSE 'not_required'
          END,
          CASE WHEN status IN ('success', 'failed', 'unknown') THEN 1 ELSE 0 END,
          CASE WHEN status IN ('success', 'failed', 'unknown') THEN finished_at ELSE NULL END
        FROM automation_executions_legacy;
          DROP TABLE automation_executions_legacy;
          DROP TABLE automations_legacy;
        `);
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }
}

function automationFromRow(row: AutomationRow): AutomationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    instruction: row.instruction,
    schedule: parseSchedule(row.schedule_json),
    scheduleDescription: row.schedule_description,
    repeatLimit: row.repeat_limit,
    runCount: row.run_count,
    consecutiveFailures: row.consecutive_failures,
    state: row.state,
    contextKey: row.context_key,
    chatId: row.chat_id,
    ...(row.message_thread_id !== null ? { messageThreadId: row.message_thread_id } : {}),
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    ...(row.last_status ? { lastStatus: row.last_status } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_result ? { lastResult: row.last_result } : {}),
    ...(row.last_successful_at ? { lastSuccessfulAt: row.last_successful_at } : {}),
    ...(row.last_successful_result ? { lastSuccessfulResult: row.last_successful_result } : {}),
    ...(row.paused_reason ? { pausedReason: row.paused_reason } : {}),
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function executionFromRow(row: ExecutionRow): AutomationExecution {
  return {
    id: row.id,
    automationId: row.automation_id,
    source: row.source,
    status: row.status,
    scheduledFor: row.scheduled_for,
    claimedAt: row.claimed_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.runner_id ? { runnerId: row.runner_id } : {}),
    deliveryStatus: row.delivery_status,
    deliveryAttempts: row.delivery_attempts,
    ...(row.delivery_next_attempt_at ? { deliveryNextAttemptAt: row.delivery_next_attempt_at } : {}),
    ...(row.delivery_started_at ? { deliveryStartedAt: row.delivery_started_at } : {}),
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    ...(row.delivery_error ? { deliveryError: row.delivery_error } : {}),
    ...(row.telegram_message_id !== null ? { telegramMessageId: row.telegram_message_id } : {}),
    ...(row.artifact_summary_message_id !== null
      ? { artifactSummaryMessageId: row.artifact_summary_message_id }
      : {}),
  };
}

function artifactDeliveryFromRow(row: ArtifactDeliveryRow): AutomationArtifactDelivery {
  return {
    executionId: row.execution_id,
    artifactName: row.artifact_name,
    sizeBytes: row.size_bytes,
    status: row.status,
    attempts: row.attempts,
    ...(row.telegram_message_id !== null ? { telegramMessageId: row.telegram_message_id } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    updatedAt: row.updated_at,
  };
}

function parseSchedule(value: string): AutomationSchedule {
  return normalizeAutomationSchedule(JSON.parse(value) as AutomationSchedule);
}

function normalizeRepeatLimit(value: number | null | undefined, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === null || value === 0) return null;
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error("Количество повторов должно быть положительным целым числом");
  }
  return value;
}

function bounded(value: string, limit: number, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} не может быть пустым`);
  if (normalized.length > limit) throw new Error(`${label}: максимум ${limit} символов`);
  return normalized;
}
