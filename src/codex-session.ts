import {
  CodexAppServerClient,
  type AppServerRequestHandler,
  type AppServerNotification,
  type DynamicToolHandler,
  type DynamicToolSpec,
} from "./codex-app-server.js";
import type { CodexApprovalPolicy, CodyConfig } from "./config.js";
import {
  defaultCodexPreferences,
  type CodexPreferences,
} from "./codex-preferences.js";
import { requireWithinAnyDirectory } from "./security.js";

export interface CodexAppServerTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
  onNotification(listener: (notification: AppServerNotification) => void): () => void;
  onServerRequest?: (listener: AppServerRequestHandler) => () => void;
  dispose(): void;
}

export interface CodexSessionCallbacks {
  onTextDelta: (delta: string) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onAgentEnd: (status: CodexTurnCompletionStatus) => void;
  onRequestUserInput?: (params: Record<string, unknown>) => Promise<unknown>;
  onRequestApproval?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onSubagentCount?: (count: number) => void;
  onAgentMessageDelta?: (
    messageId: string,
    delta: string,
    fullText: string,
    phase: AgentMessagePhase,
  ) => void;
  onAgentMessageComplete?: (messageId: string, text: string, phase: AgentMessagePhase) => void;
}

export type AgentMessagePhase = "commentary" | "final_answer" | null;
type CodexTurnCompletionStatus = "completed" | "interrupted";

export interface CodexSessionInfo {
  threadId: string | null;
  workspace: string;
  pendingInitialContext?: string;
}

interface CodexTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexThreadTokenUsage {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface CodexSessionStatus {
  model?: string;
  serviceTier?: string | null;
  reasoningEffort?: string | null;
  tokenUsage?: CodexThreadTokenUsage;
}

export interface CreateOptions {
  workspace?: string;
  deferThreadStart?: boolean;
  resumeThreadId?: string;
  pendingInitialContext?: string;
  dynamicTools?: DynamicToolSpec[];
  dynamicToolHandler?: DynamicToolHandler;
  developerInstructions?: string;
  preferences?: CodexPreferences;
}

export interface CodexTurnOptions {
  collaborationMode?: "plan" | "default";
}

interface CollaborationModeListResponse {
  data: Array<{
    mode: "plan" | "default";
    model?: string | null;
    reasoning_effort?: string | null;
  }>;
}

export type CodexPromptInput = string | {
  text?: string;
  imagePaths?: string[];
  stagedFileInstructions?: string;
};

interface ThreadStartResponse {
  thread: { id: string };
  model?: string;
  serviceTier?: string | null;
  reasoningEffort?: string | null;
}

interface TurnStartResponse {
  turn: { id: string };
}

interface TurnSteerResponse {
  turnId: string;
}

interface TurnState {
  id: string | null;
  agentText: Map<string, string>;
  agentPhase: Map<string, AgentMessagePhase>;
  subagentThreadIds: Set<string>;
}

export class CodexSessionService {
  private currentWorkspace: string;
  private currentThreadId: string | null = null;
  private threadActive = false;
  private threadAttached = false;
  private processing = false;
  private abortRequested = false;
  private activeTurnId: string | null = null;
  private pendingInitialContext: string | undefined;
  private dynamicTools: DynamicToolSpec[] = [];
  private developerInstructions: string | undefined;
  private currentModel: string | undefined;
  private currentServiceTier: string | null | undefined;
  private currentReasoningEffort: string | null | undefined;
  private currentTokenUsage: CodexThreadTokenUsage | undefined;
  private preferences: CodexPreferences;

  private constructor(
    private readonly config: CodyConfig,
    private readonly appServer: CodexAppServerTransport,
    private readonly ownsAppServer: boolean,
  ) {
    this.currentWorkspace = requireWithinAnyDirectory(config.workspace, this.getApprovedDirectories(), "workspace");
    this.preferences = defaultCodexPreferences(config);
  }

  static async create(
    config: CodyConfig,
    options?: CreateOptions,
    appServer?: CodexAppServerTransport,
  ): Promise<CodexSessionService> {
    const service = new CodexSessionService(
      config,
      appServer ?? new CodexAppServerClient({
        apiKey: config.codexApiKey,
        dynamicToolHandler: options?.dynamicToolHandler,
      }),
      !appServer,
    );
    service.currentWorkspace = requireWithinAnyDirectory(
      options?.workspace ?? config.workspace,
      service.getApprovedDirectories(),
      "workspace",
    );
    service.pendingInitialContext = options?.pendingInitialContext;
    service.dynamicTools = options?.dynamicTools ?? [];
    service.developerInstructions = options?.developerInstructions;
    service.preferences = options?.preferences ?? defaultCodexPreferences(config);
    if (options?.resumeThreadId) {
      await service.resumeThread(options.resumeThreadId);
      return service;
    }
    if (!options?.deferThreadStart) {
      await service.newThread(service.currentWorkspace);
    }
    return service;
  }

  getInfo(): CodexSessionInfo {
    const info: CodexSessionInfo = {
      threadId: this.currentThreadId,
      workspace: this.currentWorkspace,
      ...(this.pendingInitialContext ? { pendingInitialContext: this.pendingInitialContext } : {}),
    };
    return info;
  }

  getStatus(): CodexSessionStatus {
    return {
      ...(this.currentModel ? { model: this.currentModel } : {}),
      ...(this.currentServiceTier !== undefined ? { serviceTier: this.currentServiceTier } : {}),
      ...(this.currentReasoningEffort !== undefined
        ? { reasoningEffort: this.currentReasoningEffort }
        : {}),
      ...(this.currentTokenUsage ? { tokenUsage: this.currentTokenUsage } : {}),
    };
  }

  getPreferences(): CodexPreferences {
    return { ...this.preferences };
  }

  setPreferences(preferences: CodexPreferences): void {
    this.ensureIdle("change Codex settings");
    this.preferences = { ...preferences };
  }

  isProcessing(): boolean {
    return this.processing;
  }

  hasActiveThread(): boolean {
    return this.threadActive;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async ensureThreadId(): Promise<string> {
    if (!this.threadActive) {
      throw new Error("Codex thread is not initialized");
    }
    return this.attachThread();
  }

  async prompt(
    input: CodexPromptInput,
    callbacks: CodexSessionCallbacks,
    options: CodexTurnOptions = {},
  ): Promise<void> {
    const initialContext = this.pendingInitialContext;
    await this.executeTurn(callbacks, async (threadId) => {
      const collaborationMode = options.collaborationMode
        ? await this.buildCollaborationMode(options.collaborationMode)
        : undefined;
      const response = await this.appServer.request<TurnStartResponse>("turn/start", {
        threadId,
        input: this.buildAppServerInput(input),
        ...(initialContext
          ? {
              additionalContext: {
                "cody-project": { value: initialContext, kind: "application" },
              },
            }
          : {}),
        cwd: this.currentWorkspace,
        approvalPolicy: normalizeApprovalPolicy(this.preferences.approvalPolicy),
        model: this.preferences.model ?? null,
        effort: this.preferences.reasoningEffort ?? null,
        serviceTier: this.preferences.serviceTier ?? null,
        sandboxPolicy: sandboxPolicy(this.preferences.sandboxMode, this.getApprovedDirectories()),
        ...(collaborationMode ? { collaborationMode } : {}),
      });
      if (this.pendingInitialContext === initialContext) this.pendingInitialContext = undefined;
      return response;
    });
  }

  async review(callbacks: CodexSessionCallbacks, instructions?: string): Promise<void> {
    await this.executeTurn(callbacks, (threadId) => this.appServer.request<TurnStartResponse>(
      "review/start",
      {
        threadId,
        delivery: "inline",
        target: instructions?.trim()
          ? { type: "custom", instructions: instructions.trim() }
          : { type: "uncommittedChanges" },
      },
    ));
  }

  private async executeTurn(
    callbacks: CodexSessionCallbacks,
    start: (threadId: string) => Promise<TurnStartResponse>,
  ): Promise<void> {
    if (!this.threadActive) {
      throw new Error("Codex thread is not initialized");
    }
    if (this.processing) {
      throw new Error("A Codex turn is already in progress");
    }

    this.processing = true;
    this.abortRequested = false;
    let unsubscribe = () => {};
    let unsubscribeRequests = () => {};

    try {
      const threadId = await this.attachThread();
      const state: TurnState = {
        id: null,
        agentText: new Map(),
        agentPhase: new Map(),
        subagentThreadIds: new Set(),
      };
      let resolveCompletion!: () => void;
      let rejectCompletion!: (error: Error) => void;
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      unsubscribe = this.appServer.onNotification((notification) => {
        this.handleNotification(
          notification,
          threadId,
          state,
          callbacks,
          resolveCompletion,
          rejectCompletion,
        );
      });
      unsubscribeRequests = this.appServer.onServerRequest?.(async (request) => {
        const params = asRecord(request.params);
        if (readString(params, "threadId") !== threadId) return undefined;
        const requestTurnId = readString(params, "turnId");
        if (state.id && requestTurnId && requestTurnId !== state.id) return undefined;
        if (request.method === "item/tool/requestUserInput" && callbacks.onRequestUserInput) {
          return callbacks.onRequestUserInput(params);
        }
        if (
          (
            request.method === "item/commandExecution/requestApproval"
            || request.method === "item/fileChange/requestApproval"
            || request.method === "item/permissions/requestApproval"
          )
          && callbacks.onRequestApproval
        ) {
          return callbacks.onRequestApproval(request.method, params);
        }
        return undefined;
      }) ?? (() => {});
      const response = await start(threadId);
      state.id = response.turn.id;
      this.activeTurnId = state.id;

      if (this.abortRequested) {
        await this.interruptActiveTurn();
      }
      await completion;
    } finally {
      unsubscribe();
      unsubscribeRequests();
      this.processing = false;
      this.abortRequested = false;
      this.activeTurnId = null;
    }
  }

  async abort(): Promise<void> {
    if (!this.processing) {
      return;
    }
    this.abortRequested = true;
    await this.interruptActiveTurn();
  }

  async steer(input: CodexPromptInput): Promise<void> {
    if (!this.processing || !this.currentThreadId || !this.activeTurnId) {
      throw new Error("Нет активной задачи, в которую можно отправить сообщение");
    }

    const expectedTurnId = this.activeTurnId;
    const response = await this.appServer.request<TurnSteerResponse>("turn/steer", {
      threadId: this.currentThreadId,
      input: this.buildAppServerInput(input),
      expectedTurnId,
    });
    if (response.turnId !== expectedTurnId) {
      throw new Error("Codex подтвердил другое выполнение задачи");
    }
  }

  async newThread(workspace?: string, initialContext?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("start a new thread");
    const effectiveWorkspace = requireWithinAnyDirectory(
      workspace ?? this.currentWorkspace,
      this.getApprovedDirectories(),
      "workspace",
    );

    await this.unsubscribeCurrentThread();
    this.currentWorkspace = effectiveWorkspace;
    this.currentThreadId = null;
    this.threadActive = true;
    this.threadAttached = false;
    this.pendingInitialContext = initialContext?.trim() || undefined;
    this.currentModel = undefined;
    this.currentServiceTier = undefined;
    this.currentReasoningEffort = undefined;
    this.currentTokenUsage = undefined;
    return this.getInfo();
  }

  async resumeThread(threadId: string, workspace?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("resume a thread");
    const effectiveWorkspace = requireWithinAnyDirectory(
      workspace ?? this.currentWorkspace,
      this.getApprovedDirectories(),
      "workspace",
    );
    if (
      threadId === this.currentThreadId
      && this.threadActive
      && effectiveWorkspace === this.currentWorkspace
    ) {
      return this.getInfo();
    }
    if (threadId !== this.currentThreadId) {
      await this.unsubscribeCurrentThread();
      this.currentTokenUsage = undefined;
    }
    this.currentWorkspace = effectiveWorkspace;
    this.currentThreadId = threadId;
    this.threadActive = true;
    this.threadAttached = false;
    this.pendingInitialContext = undefined;
    await this.attachThread();
    return this.getInfo();
  }

  dispose(): void {
    void this.abort();
    this.threadActive = false;
    this.threadAttached = false;
    this.currentThreadId = null;
    if (this.ownsAppServer) {
      this.appServer.dispose();
    }
  }

  private async attachThread(): Promise<string> {
    if (this.threadAttached && this.currentThreadId) {
      return this.currentThreadId;
    }

    const params = {
      model: this.preferences.model,
      cwd: this.currentWorkspace,
      approvalPolicy: normalizeApprovalPolicy(this.preferences.approvalPolicy),
      sandbox: this.preferences.sandboxMode,
      ...(this.preferences.serviceTier !== undefined
        ? { serviceTier: this.preferences.serviceTier }
        : {}),
    };
    const response = this.currentThreadId
      ? await this.appServer.request<ThreadStartResponse>("thread/resume", {
          threadId: this.currentThreadId,
          ...params,
        })
      : await this.appServer.request<ThreadStartResponse>("thread/start", {
          ...params,
          serviceName: "cody-tgbot",
          ...(this.developerInstructions
            ? { developerInstructions: this.developerInstructions }
            : {}),
          ...(this.dynamicTools.length > 0 ? { dynamicTools: this.dynamicTools } : {}),
        });

    this.currentThreadId = response.thread.id;
    this.currentModel = response.model ?? this.preferences.model;
    this.currentServiceTier = response.serviceTier;
    this.currentReasoningEffort = response.reasoningEffort;
    this.threadAttached = true;
    return response.thread.id;
  }

  private async unsubscribeCurrentThread(): Promise<void> {
    if (!this.threadAttached || !this.currentThreadId) return;
    try {
      await this.appServer.request("thread/unsubscribe", { threadId: this.currentThreadId });
    } catch (error) {
      console.warn(
        `Failed to unsubscribe Codex thread ${this.currentThreadId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.threadAttached = false;
  }

  private async buildCollaborationMode(mode: "plan" | "default"): Promise<Record<string, unknown>> {
    let preset: CollaborationModeListResponse["data"][number] | undefined;
    try {
      const response = await this.appServer.request<CollaborationModeListResponse>(
        "collaborationMode/list",
        {},
      );
      preset = response.data.find((candidate) => candidate.mode === mode);
    } catch (error) {
      console.warn(
        `Failed to load Codex ${mode} preset:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      mode,
      settings: {
        model: this.preferences.model ?? preset?.model ?? this.currentModel ?? "",
        reasoning_effort: this.preferences.reasoningEffort ?? preset?.reasoning_effort ?? null,
        developer_instructions: null,
      },
    };
  }

  private buildAppServerInput(input: CodexPromptInput): Array<Record<string, unknown>> {
    if (typeof input === "string") {
      return [{ type: "text", text: input, text_elements: [] }];
    }

    const parts: Array<Record<string, unknown>> = [];
    const textParts: string[] = [];
    if (input.stagedFileInstructions) {
      textParts.push(input.stagedFileInstructions);
    }
    if (input.text) {
      textParts.push(input.text);
    }
    if (textParts.length > 0) {
      parts.push({ type: "text", text: textParts.join("\n\n"), text_elements: [] });
    }
    for (const imagePath of input.imagePaths ?? []) {
      parts.push({ type: "localImage", path: imagePath });
    }
    return parts;
  }

  private handleNotification(
    notification: AppServerNotification,
    threadId: string,
    state: TurnState,
    callbacks: CodexSessionCallbacks,
    resolveCompletion: () => void,
    rejectCompletion: (error: Error) => void,
  ): void {
    const params = asRecord(notification.params);
    if (notification.method === "cody-tgbot/appServerExited") {
      rejectCompletion(new Error(readString(params, "message") ?? "Codex app-server exited"));
      return;
    }
    if (readString(params, "threadId") !== threadId) {
      return;
    }

    if (notification.method === "thread/tokenUsage/updated") {
      const tokenUsage = readThreadTokenUsage(params.tokenUsage);
      if (tokenUsage) this.currentTokenUsage = tokenUsage;
      return;
    }

    const turnId = readString(params, "turnId") ?? readNestedString(params, "turn", "id");
    if (state.id && turnId && turnId !== state.id) {
      return;
    }

    switch (notification.method) {
      case "turn/started":
        state.id = turnId ?? state.id;
        this.activeTurnId = state.id;
        return;
      case "item/agentMessage/delta": {
        const itemId = readString(params, "itemId");
        const delta = readString(params, "delta");
        if (itemId && delta) {
          const fullText = `${state.agentText.get(itemId) ?? ""}${delta}`;
          state.agentText.set(itemId, fullText);
          callbacks.onTextDelta(delta);
          callbacks.onAgentMessageDelta?.(
            itemId,
            delta,
            fullText,
            state.agentPhase.get(itemId) ?? null,
          );
        }
        return;
      }
      case "item/started":
        this.handleItemStarted(asRecord(params.item), state, callbacks);
        return;
      case "item/completed":
        this.handleItemCompleted(asRecord(params.item), state, callbacks);
        return;
      case "error":
        if (!params.willRetry) {
          rejectCompletion(new Error(readNestedString(params, "error", "message") ?? "Codex turn failed"));
        }
        return;
      case "turn/completed": {
        const turn = asRecord(params.turn);
        const status = readString(turn, "status");
        if (status === "failed") {
          rejectCompletion(new Error(readNestedString(turn, "error", "message") ?? "Codex turn failed"));
          return;
        }
        callbacks.onAgentEnd(status === "interrupted" ? "interrupted" : "completed");
        resolveCompletion();
        return;
      }
      default:
        return;
    }
  }

  private handleItemStarted(
    item: Record<string, unknown>,
    state: TurnState,
    callbacks: CodexSessionCallbacks,
  ): void {
    const id = readString(item, "id");
    const type = readString(item, "type");
    if (!id || !type) {
      return;
    }
    if (type === "agentMessage") {
      state.agentPhase.set(id, readAgentMessagePhase(item));
    } else if (type === "commandExecution") {
      callbacks.onToolStart(readString(item, "command") ?? "command", id);
    } else if (type === "webSearch") {
      const query = readString(item, "query") ?? "web search";
      callbacks.onToolStart(`search:${truncate(query, 60)}`, id);
    } else if (type === "mcpToolCall") {
      callbacks.onToolStart(`mcp:${readString(item, "server") ?? "?"}/${readString(item, "tool") ?? "?"}`, id);
    } else if (type === "subAgentActivity") {
      updateSubagentActivity(item, state, callbacks);
    } else if (type === "collabAgentToolCall") {
      updateSubagentState(item, state, callbacks);
      callbacks.onToolStart(readString(item, "tool") ?? type, id);
    } else if (type === "dynamicToolCall") {
      callbacks.onToolStart(readString(item, "tool") ?? type, id);
    }
  }

  private handleItemCompleted(
    item: Record<string, unknown>,
    state: TurnState,
    callbacks: CodexSessionCallbacks,
  ): void {
    const id = readString(item, "id");
    const type = readString(item, "type");
    if (!id || !type) {
      return;
    }
    if (type === "agentMessage") {
      const text = readString(item, "text") ?? "";
      const phase = readAgentMessagePhase(item) ?? state.agentPhase.get(id) ?? null;
      state.agentPhase.set(id, phase);
      const previous = state.agentText.get(id) ?? "";
      const delta = computeTextDelta(previous, text);
      if (delta) {
        callbacks.onTextDelta(delta);
        callbacks.onAgentMessageDelta?.(id, delta, text, phase);
      }
      state.agentText.set(id, text);
      callbacks.onAgentMessageComplete?.(id, text, phase);
    } else if (type === "commandExecution") {
      callbacks.onToolEnd(id, item.status === "failed" || item.status === "declined");
    } else if (type === "fileChange") {
      callbacks.onToolStart("file_change", id);
      callbacks.onToolEnd(id, item.status === "failed" || item.status === "declined");
    } else if (type === "collabAgentToolCall") {
      updateSubagentState(item, state, callbacks);
      callbacks.onToolEnd(id, item.status === "failed");
    } else if (type === "subAgentActivity") {
      updateSubagentActivity(item, state, callbacks);
    } else if (type === "mcpToolCall" || type === "dynamicToolCall") {
      callbacks.onToolEnd(id, item.status === "failed");
    } else if (type === "webSearch") {
      callbacks.onToolEnd(id, false);
    }
  }

  private async interruptActiveTurn(): Promise<void> {
    if (!this.currentThreadId || !this.activeTurnId) {
      return;
    }
    await this.appServer.request("turn/interrupt", {
      threadId: this.currentThreadId,
      turnId: this.activeTurnId,
    });
  }

  private ensureIdle(action: string): void {
    if (this.processing) {
      throw new Error(`Нельзя выполнить действие "${action}", пока идёт текущая задача`);
    }
  }

  private getApprovedDirectories(): string[] {
    return this.config.approvedDirectories;
  }
}

function normalizeApprovalPolicy(policy: CodexApprovalPolicy): Exclude<CodexApprovalPolicy, "on-failure"> {
  return policy === "on-failure" ? "on-request" : policy;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function readNestedString(record: Record<string, unknown>, key: string, nestedKey: string): string | undefined {
  return readString(asRecord(record[key]), nestedKey);
}

function readThreadTokenUsage(value: unknown): CodexThreadTokenUsage | undefined {
  const record = asRecord(value);
  const total = readTokenUsageBreakdown(record.total);
  const last = readTokenUsageBreakdown(record.last);
  const modelContextWindow = record.modelContextWindow;
  if (!total || !last || (modelContextWindow !== null && typeof modelContextWindow !== "number")) {
    return undefined;
  }
  return { total, last, modelContextWindow };
}

function readTokenUsageBreakdown(value: unknown): CodexTokenUsageBreakdown | undefined {
  const record = asRecord(value);
  const totalTokens = readNumber(record, "totalTokens");
  const inputTokens = readNumber(record, "inputTokens");
  const cachedInputTokens = readNumber(record, "cachedInputTokens");
  const outputTokens = readNumber(record, "outputTokens");
  const reasoningOutputTokens = readNumber(record, "reasoningOutputTokens");
  if (
    totalTokens === undefined
    || inputTokens === undefined
    || cachedInputTokens === undefined
    || outputTokens === undefined
    || reasoningOutputTokens === undefined
  ) {
    return undefined;
  }
  return { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readAgentMessagePhase(record: Record<string, unknown>): AgentMessagePhase {
  const phase = readString(record, "phase");
  return phase === "commentary" || phase === "final_answer" ? phase : null;
}

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function sandboxPolicy(mode: CodexPreferences["sandboxMode"], writableRoots: string[]): Record<string, unknown> {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots,
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function updateSubagentState(
  item: Record<string, unknown>,
  state: TurnState,
  callbacks: CodexSessionCallbacks,
): void {
  for (const threadId of readStringArray(item.receiverThreadIds)) {
    if (readString(item, "tool") === "spawnAgent") state.subagentThreadIds.add(threadId);
  }
  const agentsStates = asRecord(item.agentsStates);
  for (const [threadId, rawAgentState] of Object.entries(agentsStates)) {
    const status = readString(asRecord(rawAgentState), "status");
    if (status === "running" || status === "pendingInit") state.subagentThreadIds.add(threadId);
    if (status === "completed" || status === "errored" || status === "interrupted" || status === "shutdown" || status === "notFound") {
      state.subagentThreadIds.delete(threadId);
    }
  }
  callbacks.onSubagentCount?.(state.subagentThreadIds.size);
}

function updateSubagentActivity(
  item: Record<string, unknown>,
  state: TurnState,
  callbacks: CodexSessionCallbacks,
): void {
  const threadId = readString(item, "agentThreadId");
  const kind = readString(item, "kind");
  if (threadId && (kind === "started" || kind === "interacted")) {
    state.subagentThreadIds.add(threadId);
  }
  if (threadId && kind === "interrupted") {
    state.subagentThreadIds.delete(threadId);
  }
  callbacks.onSubagentCount?.(state.subagentThreadIds.size);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
