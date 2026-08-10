import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CodexPromptInput } from "./codex-session.js";
import type { TelegramContextKey } from "./context-key.js";

type RuntimeJobStatus = "queued" | "running";

export interface RuntimeJob {
  id: string;
  status: RuntimeJobStatus;
  contextKey: TelegramContextKey;
  chatId: number;
  userInput: CodexPromptInput;
  displayText: string;
  workspace: string;
  createdAt: string;
  updateId: number;
  privateChat: boolean;
  turnId?: string;
  outDir?: string;
  resumeThreadId?: string;
  queueMessageId?: number;
  liveMessageId?: number;
  startedAt?: string;
  cleanupPaths?: string[];
  executionMode?: "default" | "plan" | "review";
}

interface StoredRuntimeJobs {
  version: 1;
  jobs: RuntimeJob[];
}

export class RuntimeJobStore {
  private readonly statePath: string;
  private jobs: RuntimeJob[] = [];
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string) {
    this.statePath = path.join(path.resolve(rootDirectory), "jobs.json");
  }

  async list(): Promise<RuntimeJob[]> {
    await this.ensureLoaded();
    return this.jobs.map(cloneJob);
  }

  async put(job: RuntimeJob): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureLoaded();
      const index = this.jobs.findIndex((candidate) => candidate.id === job.id);
      if (index >= 0) this.jobs[index] = cloneJob(job);
      else this.jobs.push(cloneJob(job));
      await this.persist();
    });
  }

  async patch(id: string, patch: Partial<Omit<RuntimeJob, "id">>): Promise<RuntimeJob | undefined> {
    return this.withMutationLock(async () => {
      await this.ensureLoaded();
      const index = this.jobs.findIndex((candidate) => candidate.id === id);
      if (index < 0) return undefined;
      const updated = { ...this.jobs[index]!, ...patch, id };
      this.jobs[index] = updated;
      await this.persist();
      return cloneJob(updated);
    });
  }

  async remove(id: string): Promise<RuntimeJob | undefined> {
    return this.withMutationLock(async () => {
      await this.ensureLoaded();
      const index = this.jobs.findIndex((candidate) => candidate.id === id);
      if (index < 0) return undefined;
      const [removed] = this.jobs.splice(index, 1);
      await this.persist();
      return removed ? cloneJob(removed) : undefined;
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<StoredRuntimeJobs>;
      this.jobs = Array.isArray(parsed.jobs) ? parsed.jobs.filter(isRuntimeJob).map(cloneJob) : [];
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.jobs = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.statePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.jobs.${randomUUID()}.tmp`);
    try {
      const data: StoredRuntimeJobs = { version: 1, jobs: this.jobs };
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.statePath);
      await chmod(this.statePath, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function newRuntimeJobId(): string {
  return `task-${randomUUID()}`;
}

function cloneJob(job: RuntimeJob): RuntimeJob {
  return structuredClone(job);
}

function isRuntimeJob(value: unknown): value is RuntimeJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<RuntimeJob>;
  return (
    typeof job.id === "string"
    && (job.status === "queued" || job.status === "running")
    && typeof job.contextKey === "string"
    && typeof job.chatId === "number"
    && typeof job.displayText === "string"
    && typeof job.workspace === "string"
    && typeof job.createdAt === "string"
    && typeof job.updateId === "number"
    && typeof job.privateChat === "boolean"
    && isCodexPromptInput(job.userInput)
    && isOptionalString(job.turnId)
    && isOptionalString(job.outDir)
    && isOptionalString(job.resumeThreadId)
    && isOptionalNumber(job.queueMessageId)
    && isOptionalNumber(job.liveMessageId)
    && isOptionalString(job.startedAt)
    && isOptionalStringArray(job.cleanupPaths)
    && (job.executionMode === undefined || job.executionMode === "default" || job.executionMode === "plan" || job.executionMode === "review")
  );
}

function isCodexPromptInput(value: unknown): value is CodexPromptInput {
  if (typeof value === "string") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Exclude<CodexPromptInput, string>;
  return (
    isOptionalString(input.text)
    && isOptionalString(input.stagedFileInstructions)
    && isOptionalStringArray(input.imagePaths)
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
