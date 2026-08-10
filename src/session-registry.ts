import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  CodexAppServerClient,
  type DynamicToolHandler,
  type DynamicToolSpec,
} from "./codex-app-server.js";
import { CodexAuthService } from "./codex-auth.js";
import { CodexSessionService } from "./codex-session.js";
import { readCodexStatus, type CodexStatusData } from "./codex-status.js";
import type { CodyConfig } from "./config.js";
import {
  defaultCodexPreferences,
  normalizeCodexPreferences,
  type CodexModelOption,
  type CodexPreferences,
} from "./codex-preferences.js";
import type { TelegramContextKey } from "./context-key.js";
import { generateDialogTitle, provisionalDialogTitle } from "./dialog-title.js";

interface DialogMetadata {
  threadId: string;
  workspace: string;
  title: string;
  titleGenerated: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DialogSummary extends DialogMetadata {
  current: boolean;
}

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  updatedAt: number;
  pendingInitialContext?: string;
  dialogs?: DialogMetadata[];
  preferences?: CodexPreferences;
}

interface ModelListResponse {
  data: CodexModelOption[];
  nextCursor?: string | null;
}

interface ThreadReadResponse {
  thread: {
    id: string;
    name?: string | null;
    preview?: string;
    ephemeral?: boolean;
    createdAt?: number;
    updatedAt?: number;
    cwd?: string;
  };
}

export interface SessionRegistryExtensions {
  dynamicTools?: DynamicToolSpec[];
  developerInstructions?: string;
  dynamicToolHandler?: DynamicToolHandler;
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionService>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly appServer: CodexAppServerClient;
  readonly auth: CodexAuthService;
  private readonly persistPath: string;

  constructor(
    private readonly config: CodyConfig,
    private readonly extensions: SessionRegistryExtensions = {},
  ) {
    this.persistPath = path.join(config.workspace, ".cody-tgbot", "contexts.json");
    this.appServer = new CodexAppServerClient({
      apiKey: config.codexApiKey,
      dynamicToolHandler: extensions.dynamicToolHandler,
    });
    this.auth = new CodexAuthService(this.appServer, Boolean(config.codexApiKey));
    this.loadPersistedMetadata();
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: {
      deferThreadStart?: boolean;
    },
  ): Promise<CodexSessionService> {
    let session = this.sessions.get(contextKey);
    if (session) {
      return session;
    }

    const meta = this.metadata.get(contextKey);
    session = await CodexSessionService.create(
      this.config,
      {
        workspace: meta?.workspace,
        deferThreadStart: options?.deferThreadStart && !meta?.threadId,
        resumeThreadId: meta?.threadId ?? undefined,
        pendingInitialContext: meta?.pendingInitialContext,
        dynamicTools: this.extensions.dynamicTools,
        developerInstructions: this.extensions.developerInstructions,
        preferences: normalizeCodexPreferences(meta?.preferences, this.config),
      },
      this.appServer,
    );

    this.sessions.set(contextKey, session);
    return session;
  }

  get(contextKey: TelegramContextKey): CodexSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  async readStatus(contextKey: TelegramContextKey): Promise<CodexStatusData> {
    const session = await this.getOrCreate(contextKey, { deferThreadStart: true });
    return readCodexStatus(
      this.appServer,
      this.config,
      session.getInfo(),
      session.getStatus(),
    );
  }

  getPreferences(contextKey: TelegramContextKey): CodexPreferences {
    return normalizeCodexPreferences(this.metadata.get(contextKey)?.preferences, this.config);
  }

  async setPreferences(
    contextKey: TelegramContextKey,
    patch: Partial<CodexPreferences>,
  ): Promise<CodexPreferences> {
    const current = this.getPreferences(contextKey);
    const next = normalizeCodexPreferences({ ...current, ...patch }, this.config);
    const metadata = this.metadata.get(contextKey);
    if (metadata) {
      metadata.preferences = next;
      metadata.updatedAt = Date.now();
    } else {
      this.metadata.set(contextKey, {
        contextKey,
        threadId: null,
        workspace: this.config.workspace,
        updatedAt: Date.now(),
        dialogs: [],
        preferences: next,
      });
    }
    const session = this.sessions.get(contextKey);
    if (session) session.setPreferences(next);
    this.persistMetadata();
    return next;
  }

  async listModels(): Promise<CodexModelOption[]> {
    const models: CodexModelOption[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.appServer.request<ModelListResponse>("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      models.push(...response.data.filter(isCodexModelOption));
      cursor = response.nextCursor ?? undefined;
    } while (cursor);
    return models;
  }

  findContextByThreadId(threadId: string): { contextKey: TelegramContextKey } | undefined {
    for (const [contextKey, metadata] of this.metadata) {
      if (
        metadata.threadId === threadId
        || metadata.dialogs?.some((dialog) => dialog.threadId === threadId)
      ) {
        return { contextKey };
      }
    }
    return undefined;
  }

  updateMetadata(
    contextKey: TelegramContextKey,
    session: CodexSessionService,
    options?: { titleSource?: string },
  ): void {
    const info = session.getInfo();
    const previous = this.metadata.get(contextKey);
    const now = Date.now();
    const dialogs = [...(previous?.dialogs ?? [])];
    if (info.threadId) {
      const index = dialogs.findIndex((dialog) => dialog.threadId === info.threadId);
      const existing = index >= 0 ? dialogs[index] : undefined;
      const next: DialogMetadata = {
        threadId: info.threadId,
        workspace: info.workspace,
        title: existing?.title ?? provisionalDialogTitle(options?.titleSource),
        titleGenerated: existing?.titleGenerated ?? false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (index >= 0) dialogs[index] = next;
      else dialogs.push(next);
    }
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      updatedAt: now,
      ...(info.pendingInitialContext
        ? { pendingInitialContext: info.pendingInitialContext }
        : {}),
      dialogs,
      preferences: previous?.preferences ?? defaultCodexPreferences(this.config),
    });
    this.persistMetadata();
  }

  async listDialogs(contextKey: TelegramContextKey): Promise<DialogSummary[]> {
    const metadata = this.metadata.get(contextKey);
    if (!metadata) return [];

    const hydrated = await Promise.all(metadata.dialogs?.map(async (dialog) => {
      try {
        const result = await this.appServer.request<ThreadReadResponse>("thread/read", {
          threadId: dialog.threadId,
          includeTurns: false,
        });
        if (result.thread.ephemeral) return null;
        return {
          ...dialog,
          workspace: result.thread.cwd || dialog.workspace,
          title: result.thread.name?.trim()
            || dialog.title
            || provisionalDialogTitle(result.thread.preview),
          titleGenerated: Boolean(result.thread.name?.trim()) || dialog.titleGenerated,
          createdAt: secondsToMilliseconds(result.thread.createdAt) ?? dialog.createdAt,
          updatedAt: Math.max(
            secondsToMilliseconds(result.thread.updatedAt) ?? 0,
            dialog.updatedAt,
          ),
        };
      } catch (error) {
        console.warn(`Failed to read dialog ${dialog.threadId}:`, error instanceof Error ? error.message : String(error));
        return dialog;
      }
    }) ?? []);
    const dialogs = hydrated.filter((dialog): dialog is DialogMetadata => dialog !== null);
    metadata.dialogs = dialogs;
    this.persistMetadata();
    return dialogs
      .map((dialog) => ({ ...dialog, current: dialog.threadId === metadata.threadId }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async startNewDialog(contextKey: TelegramContextKey): Promise<void> {
    const session = await this.getOrCreate(contextKey, { deferThreadStart: true });
    await session.newThread(this.config.workspace);
    this.updateMetadata(contextKey, session);
  }

  async switchDialog(contextKey: TelegramContextKey, threadId: string): Promise<void> {
    const metadata = this.metadata.get(contextKey);
    const dialog = metadata?.dialogs?.find((candidate) => candidate.threadId === threadId);
    if (!dialog) throw new Error("Диалог не найден");
    const session = await this.getOrCreate(contextKey, { deferThreadStart: true });
    await session.resumeThread(threadId, dialog.workspace);
    this.updateMetadata(contextKey, session);
  }

  async ensureDialogTitle(
    contextKey: TelegramContextKey,
    threadId: string,
    source: string | undefined,
  ): Promise<void> {
    if (!source) return;
    const metadata = this.metadata.get(contextKey);
    const dialog = metadata?.dialogs?.find((candidate) => candidate.threadId === threadId);
    if (!dialog || dialog.titleGenerated) return;

    const title = await generateDialogTitle(source);
    if (!title) return;
    await this.appServer.request("thread/name/set", { threadId, name: title });
    const current = this.metadata.get(contextKey)?.dialogs
      ?.find((candidate) => candidate.threadId === threadId);
    if (!current) return;
    current.title = title;
    current.titleGenerated = true;
    this.persistMetadata();
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.auth.dispose();
    this.appServer.dispose();
  }

  private persistMetadata(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const data = [...this.metadata.values()];
      const contents = `${JSON.stringify(data, null, 2)}\n`;
      writeJsonAtomically(this.persistPath, contents);
      writeJsonAtomically(`${this.persistPath}.bak`, contents);
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(): void {
    if (!existsSync(this.persistPath)) return;
    let data: ContextMetadata[];
    try {
      data = parsePersistedMetadata(readFileSync(this.persistPath, "utf8"));
    } catch (error) {
      console.warn(
        "Failed to read context metadata; trying backup:",
        error instanceof Error ? error.message : String(error),
      );
      const backupPath = `${this.persistPath}.bak`;
      if (!existsSync(backupPath)) return;
      try {
        data = parsePersistedMetadata(readFileSync(backupPath, "utf8"));
        console.warn("Context metadata restored from backup");
      } catch (backupError) {
        console.warn(
          "Failed to read context metadata backup:",
          backupError instanceof Error ? backupError.message : String(backupError),
        );
        return;
      }
    }
    for (const entry of data) {
      if (!entry.contextKey) continue;
      const dialogs = Array.isArray(entry.dialogs) ? entry.dialogs : [];
      if (entry.threadId && !dialogs.some((dialog) => dialog.threadId === entry.threadId)) {
        dialogs.push({
          threadId: entry.threadId,
          workspace: entry.workspace,
          title: "Новый диалог",
          titleGenerated: false,
          createdAt: entry.updatedAt,
          updatedAt: entry.updatedAt,
        });
      }
      this.metadata.set(entry.contextKey, {
        ...entry,
        dialogs,
        preferences: normalizeCodexPreferences(entry.preferences, this.config),
      });
    }
  }
}

function parsePersistedMetadata(raw: string): ContextMetadata[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error("contexts.json must contain an array");
  if (!value.every((entry) => (
    typeof entry === "object"
    && entry !== null
    && "contextKey" in entry
    && typeof entry.contextKey === "string"
  ))) {
    throw new Error("contexts.json contains an invalid entry");
  }
  return value as ContextMetadata[];
}

function writeJsonAtomically(target: string, contents: string): void {
  const temporaryPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, target);
    chmodSync(target, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best effort: the previous file is still intact.
    }
    throw error;
  }
}

function secondsToMilliseconds(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return (value as number) * 1000;
}

function isCodexModelOption(value: CodexModelOption): boolean {
  return Boolean(
    value
    && typeof value.id === "string"
    && typeof value.model === "string"
    && typeof value.displayName === "string"
    && Array.isArray(value.supportedReasoningEfforts)
    && Array.isArray(value.serviceTiers),
  );
}
