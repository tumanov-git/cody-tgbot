import type { TelegramContextKey } from "./context-key.js";

export type AutomationState = "scheduled" | "paused" | "completed";
export type AutomationLastStatus = "success" | "silent" | "failed" | "timed_out" | "unknown";
export type AutomationExecutionStatus =
  | "claimed"
  | "running"
  | "success"
  | "silent"
  | "failed"
  | "timed_out"
  | "unknown";
export type AutomationDeliveryStatus =
  | "not_required"
  | "pending"
  | "delivering"
  | "delivered"
  | "failed";

export type AutomationSchedule =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMinutes: number }
  | { kind: "cron"; expression: string; timezone: string };

export interface AutomationRecord {
  id: string;
  projectId: string;
  name: string;
  description: string;
  instruction: string;
  schedule: AutomationSchedule;
  scheduleDescription: string;
  repeatLimit: number | null;
  runCount: number;
  consecutiveFailures: number;
  state: AutomationState;
  contextKey: TelegramContextKey;
  chatId: number;
  messageThreadId?: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: AutomationLastStatus;
  lastError?: string;
  lastResult?: string;
  lastSuccessfulAt?: string;
  lastSuccessfulResult?: string;
  pausedReason?: string;
  claimToken?: string;
  claimedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationExecution {
  id: string;
  automationId: string;
  source: "scheduled" | "manual";
  status: AutomationExecutionStatus;
  scheduledFor: string;
  claimedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  runnerId?: string;
  deliveryStatus: AutomationDeliveryStatus;
  deliveryAttempts: number;
  deliveryNextAttemptAt?: string;
  deliveryStartedAt?: string;
  deliveredAt?: string;
  deliveryError?: string;
  telegramMessageId?: number;
  artifactSummaryMessageId?: number;
}

export type AutomationArtifactDeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

export interface AutomationArtifactDelivery {
  executionId: string;
  artifactName: string;
  sizeBytes: number;
  status: AutomationArtifactDeliveryStatus;
  attempts: number;
  telegramMessageId?: number;
  lastError?: string;
  updatedAt: string;
}

export interface AutomationSchedulerHealth {
  lastTickStartedAt?: string;
  lastSuccessfulTickAt?: string;
  lastTickError?: string;
  lastLeaseHeartbeatAt?: string;
  scheduledCount: number;
  dueCount: number;
  runningCount: number;
  oldestDueAt?: string;
  activeWorkers: number;
  queuedClaims: number;
  healthy: boolean;
  status: "starting" | "healthy" | "degraded";
}

export interface ClaimedAutomation {
  automation: AutomationRecord;
  execution: AutomationExecution;
}

export interface CreateAutomationInput {
  projectId: string;
  name: string;
  description: string;
  instruction: string;
  schedule: AutomationSchedule;
  scheduleDescription?: string;
  repeatLimit?: number | null;
  contextKey: TelegramContextKey;
  chatId: number;
  messageThreadId?: number;
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string;
  instruction?: string;
  schedule?: AutomationSchedule;
  scheduleDescription?: string;
  repeatLimit?: number | null;
}
