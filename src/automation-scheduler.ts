import { randomUUID } from "node:crypto";

import type { AutomationStore, AutomationRecovery } from "./automation-store.js";
import type { ClaimedAutomation } from "./automation-types.js";
import type { AutomationRecord } from "./automation-types.js";
import type { AutomationSchedulerHealth } from "./automation-types.js";

const DEFAULT_TICK_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const LEASE_TTL_MS = 30_000;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface AutomationSchedulerOptions {
  store: AutomationStore;
  runner: {
    run(claim: ClaimedAutomation, runnerId: string): Promise<void>;
    deliver(executionId: string, runnerId: string): Promise<void>;
    stop?(executionId: string): Promise<boolean>;
  };
  maintenance?: () => Promise<void>;
  onRecovery?: (recovery: AutomationRecovery) => void;
  maxParallel?: number;
  tickIntervalMs?: number;
  instanceId?: string;
}

export class AutomationScheduler {
  private readonly maxParallel: number;
  private readonly tickIntervalMs: number;
  private readonly instanceId: string;
  private timer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private tickPromise: Promise<void> | undefined;
  private active = 0;
  private activeDeliveries = 0;
  private readonly pending: ClaimedAutomation[] = [];
  private stopped = true;
  private leaseOwned = false;
  private nextMaintenanceAt = 0;
  private launchEnabled = true;

  constructor(private readonly options: AutomationSchedulerOptions) {
    this.maxParallel = Math.max(1, options.maxParallel ?? 1);
    this.tickIntervalMs = Math.max(1_000, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    this.instanceId = options.instanceId ?? `scheduler-${randomUUID()}`;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), this.tickIntervalMs);
    this.timer.unref();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
    this.wake();
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.timer = undefined;
    this.heartbeatTimer = undefined;
    if (
      this.leaseOwned
      && this.active === 0
      && this.activeDeliveries === 0
      && this.pending.length === 0
    ) {
      this.options.store.releaseLease(this.instanceId);
      this.leaseOwned = false;
    }
  }

  wake(): void {
    if (this.stopped || this.tickPromise) return;
    this.tickPromise = this.tick()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Automation scheduler tick failed: ${message}`);
        try {
          this.options.store.recordSchedulerTickFailed(message);
        } catch (healthError) {
          console.error(
            "Failed to persist automation scheduler health:",
            healthError instanceof Error ? healthError.message : String(healthError),
          );
        }
      })
      .finally(() => {
        this.tickPromise = undefined;
      });
  }

  setLaunchEnabled(enabled: boolean): void {
    this.launchEnabled = enabled;
    if (enabled) this.wake();
  }

  getHealth(now = new Date()): AutomationSchedulerHealth {
    return {
      ...this.options.store.readSchedulerHealth(now, Math.max(90_000, this.tickIntervalMs * 3)),
      activeWorkers: this.active,
      queuedClaims: this.pending.length,
    };
  }

  runNow(automationId: string): ClaimedAutomation {
    if (this.stopped || !this.leaseOwned) throw new Error("Планировщик автоматизаций ещё запускается");
    const claim = this.options.store.claimNow(automationId, new Date(), this.instanceId);
    this.enqueueClaim(claim);
    return claim;
  }

  async stop(automationId: string): Promise<AutomationRecord> {
    const automation = this.options.store.require(automationId);
    if (!automation.claimToken) throw new Error("Автоматизация сейчас не выполняется");
    const pendingIndex = this.pending.findIndex(
      (claim) => claim.execution.id === automation.claimToken,
    );
    if (pendingIndex >= 0) {
      const [claim] = this.pending.splice(pendingIndex, 1);
      this.options.store.finish(
        claim!.execution.id,
        { status: "failed", error: "Остановлено пользователем" },
        new Date(),
        { runnerId: this.instanceId, countFailure: false },
      );
      this.wake();
      return this.options.store.require(automationId);
    }
    const stopped = await this.options.runner.stop?.(automation.claimToken);
    if (!stopped) throw new Error("Запуск уже завершается");
    return this.options.store.require(automationId);
  }

  private async tick(): Promise<void> {
    if (!this.ensureLease()) return;
    this.options.store.recordSchedulerTickStarted();
    await this.runMaintenanceIfDue();
    this.dispatchDeliveries();

    if (!this.launchEnabled) {
      this.options.store.recordSchedulerTickCompleted();
      return;
    }

    const capacity = this.maxParallel - this.active - this.pending.length;
    if (capacity > 0) {
      const claims = this.options.store.claimDue(new Date(), capacity, this.instanceId);
      for (const claim of claims) this.enqueueClaim(claim);
    }
    this.options.store.recordSchedulerTickCompleted();
  }

  private ensureLease(): boolean {
    if (this.leaseOwned) return true;
    if (!this.options.store.tryAcquireLease(this.instanceId, new Date(), LEASE_TTL_MS)) return false;
    this.leaseOwned = true;
    const recovery = this.options.store.recoverInterrupted(new Date(), this.instanceId);
    for (const claim of recovery.requeued) this.enqueueClaim(claim);
    this.options.onRecovery?.(recovery);
    return true;
  }

  private heartbeat(): void {
    if (this.stopped || !this.leaseOwned) {
      this.wake();
      return;
    }
    if (!this.options.store.heartbeatLease(this.instanceId)) {
      this.leaseOwned = false;
      console.warn("Automation scheduler lease lost; new launches are paused");
    }
  }

  private enqueueClaim(claim: ClaimedAutomation): void {
    this.pending.push(claim);
    this.drain();
  }

  private drain(): void {
    while (!this.stopped && this.leaseOwned && this.active < this.maxParallel && this.pending.length > 0) {
      const claim = this.pending.shift()!;
      this.active += 1;
      void this.options.runner.run(claim, this.instanceId)
        .catch((error) => {
          console.error(
            `Automation ${claim.automation.id} escaped runner:`,
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.drain();
          this.wake();
        });
    }
  }

  private dispatchDeliveries(): void {
    const capacity = Math.max(0, 4 - this.activeDeliveries);
    if (capacity === 0) return;
    for (const executionId of this.options.store.listDueDeliveryIds(new Date(), capacity)) {
      this.activeDeliveries += 1;
      void this.options.runner.deliver(executionId, this.instanceId)
        .catch((error) => {
          console.error(
            `Automation delivery ${executionId} escaped runner:`,
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          this.activeDeliveries = Math.max(0, this.activeDeliveries - 1);
          this.wake();
        });
    }
  }

  private async runMaintenanceIfDue(): Promise<void> {
    if (!this.options.maintenance || Date.now() < this.nextMaintenanceAt) return;
    this.nextMaintenanceAt = Date.now() + MAINTENANCE_INTERVAL_MS;
    try {
      await this.options.maintenance();
    } catch (error) {
      console.warn("Automation maintenance failed:", error);
    }
  }
}
