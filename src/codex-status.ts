import type { CodexAppServerTransport, CodexSessionInfo, CodexSessionStatus } from "./codex-session.js";
import type { CodyConfig } from "./config.js";
import type { AutomationSchedulerHealth } from "./automation-types.js";
import { escapeHTML } from "./format.js";

interface AccountResponse {
  account: null | {
    type: "apiKey" | "chatgpt" | "amazonBedrock";
    planType?: string;
  };
}

interface ConfigResponse {
  config?: {
    model?: string | null;
    model_reasoning_effort?: string | null;
    service_tier?: string | null;
  };
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  planType: string | null;
}

interface RateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
}

export interface CodexStatusData {
  model: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  authType?: string;
  planType?: string;
  threadId: string | null;
  workspace: string;
  sandboxMode: CodyConfig["codexSandboxMode"];
  approvalPolicy: CodyConfig["codexApprovalPolicy"];
  automationModel: string;
  automationTimezone: string;
  tokenUsage?: CodexSessionStatus["tokenUsage"];
  rateLimits: RateLimitSnapshot[];
  automationHealth?: AutomationSchedulerHealth;
}

export interface RenderedCodexStatus {
  html: string;
  plain: string;
}

export async function readCodexStatus(
  appServer: CodexAppServerTransport,
  config: CodyConfig,
  sessionInfo: CodexSessionInfo,
  sessionStatus: CodexSessionStatus,
): Promise<CodexStatusData> {
  const [accountResult, limitsResult, configResult] = await Promise.allSettled([
    appServer.request<AccountResponse>("account/read", { refreshToken: false }),
    appServer.request<RateLimitsResponse>("account/rateLimits/read"),
    appServer.request<ConfigResponse>("config/read", { includeLayers: false }),
  ]);
  const account = accountResult.status === "fulfilled" ? accountResult.value.account : null;
  const limits = limitsResult.status === "fulfilled"
    ? uniqueRateLimits(limitsResult.value)
    : [];
  const effectiveConfig = configResult.status === "fulfilled" ? configResult.value.config : undefined;

  return {
    model: sessionStatus.model
      ?? config.codexModel
      ?? effectiveConfig?.model
      ?? "Автовыбор Codex",
    reasoningEffort: sessionStatus.reasoningEffort ?? effectiveConfig?.model_reasoning_effort,
    serviceTier: sessionStatus.serviceTier ?? effectiveConfig?.service_tier,
    ...(account?.type ? { authType: account.type } : {}),
    ...(account?.planType ? { planType: account.planType } : {}),
    threadId: sessionInfo.threadId,
    workspace: sessionInfo.workspace,
    sandboxMode: config.codexSandboxMode,
    approvalPolicy: config.codexApprovalPolicy,
    automationModel:
      config.automationModel
      ?? config.codexModel
      ?? effectiveConfig?.model
      ?? "Автовыбор Codex",
    automationTimezone: config.automationTimezone,
    tokenUsage: sessionStatus.tokenUsage,
    rateLimits: limits,
  };
}

export function renderCodexStatus(status: CodexStatusData): RenderedCodexStatus {
  const settings = [
    `<b>Модель:</b> ${escapeHTML(status.model)}${formatEffort(status.reasoningEffort)}`,
    `<b>Доступ:</b> ${escapeHTML(formatAccess(status.sandboxMode, status.approvalPolicy))}`,
    `<b>Папка:</b> <code>${escapeHTML(status.workspace)}</code>`,
    `<b>Диалог:</b> <code>${escapeHTML(status.threadId ?? "ещё не создан")}</code>`,
    `<b>Автоматизации:</b> ${escapeHTML(status.automationModel)} · ${escapeHTML(status.automationTimezone)}`,
    ...(status.planType || status.authType
      ? [`<b>Аккаунт:</b> ${escapeHTML(formatAccount(status.authType, status.planType))}`]
      : []),
  ];
  const plainSettings = settings.map(stripTelegramHtml);
  const context = formatContext(status.tokenUsage);
  const rateLimits = status.rateLimits.flatMap(formatRateLimit);
  const automationHealth = status.automationHealth
    ? formatAutomationHealth(status.automationHealth)
    : undefined;

  const html = [
    "<b>Статус Codex</b>",
    "",
    `<blockquote>${settings.join("\n")}</blockquote>`,
    "",
    "<b>Контекст</b>",
    `<blockquote>${escapeHTML(context)}</blockquote>`,
    ...(automationHealth
      ? ["", "<b>Планировщик</b>", `<blockquote>${automationHealth.html}</blockquote>`]
      : []),
    "",
    "<b>Лимиты</b>",
    `<blockquote>${rateLimits.length > 0 ? rateLimits.join("\n\n") : "Данные о лимитах недоступны."}</blockquote>`,
  ].join("\n");
  const plain = [
    "Статус Codex",
    "",
    ...plainSettings,
    "",
    "Контекст",
    context,
    ...(automationHealth ? ["", "Планировщик", automationHealth.plain] : []),
    "",
    "Лимиты",
    ...(rateLimits.length > 0 ? rateLimits.map(stripTelegramHtml) : ["Данные о лимитах недоступны."]),
  ].join("\n");
  return { html, plain };
}

function formatAutomationHealth(health: AutomationSchedulerHealth): RenderedCodexStatus {
  const state = health.status === "healthy"
    ? "работает"
    : health.status === "starting"
      ? "запускается"
      : "требует внимания";
  const tick = health.lastSuccessfulTickAt
    ? ` · тик ${formatAge(health.lastSuccessfulTickAt)} назад`
    : "";
  const queue = health.dueCount > 0 || health.activeWorkers > 0 || health.queuedClaims > 0
    ? `\nЗапущено: ${health.activeWorkers} · ожидает: ${health.dueCount + health.queuedClaims}`
    : "\nОчередь пуста";
  const error = health.status === "degraded" && health.lastTickError
    ? `\nОшибка: ${health.lastTickError}`
    : "";
  const plain = `${state}${tick}${queue}${error}`;
  return { html: escapeHTML(plain), plain };
}

function formatAge(value: string, now = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return `${seconds}с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}м`;
  return `${Math.floor(minutes / 60)}ч`;
}

function uniqueRateLimits(response: RateLimitsResponse): RateLimitSnapshot[] {
  const candidates = response.rateLimitsByLimitId
    ? Object.values(response.rateLimitsByLimitId)
    : [response.rateLimits];
  const seen = new Set<string>();
  return candidates.filter((limit) => {
    const key = limit.limitId ?? limit.limitName ?? JSON.stringify(limit);
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(limit.primary || limit.secondary);
  });
}

function formatRateLimit(limit: RateLimitSnapshot): string[] {
  const name = limit.limitName ?? (limit.limitId === "codex" ? "Codex" : limit.limitId) ?? "Лимит";
  return [limit.primary, limit.secondary]
    .filter((window): window is RateLimitWindow => Boolean(window))
    .map((window) => {
      const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
      const duration = formatWindowDuration(window.windowDurationMins);
      const reset = window.resetsAt ? `\nСброс: ${formatResetTime(window.resetsAt)}` : "";
      return `<b>${escapeHTML(name)}${duration ? ` · ${escapeHTML(duration)}` : ""}:</b> ${remaining}% осталось${reset}`;
    });
}

function formatContext(tokenUsage: CodexSessionStatus["tokenUsage"]): string {
  if (!tokenUsage?.modelContextWindow) return "Появится после следующего ответа Codex.";
  const used = Math.min(tokenUsage.last.totalTokens, tokenUsage.modelContextWindow);
  const remaining = Math.max(0, tokenUsage.modelContextWindow - used);
  const remainingPercent = Math.round((remaining / tokenUsage.modelContextWindow) * 100);
  return `${remainingPercent}% свободно · ${formatTokens(used)} / ${formatTokens(tokenUsage.modelContextWindow)}`;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  const thousands = value / 1_000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(".0", "")} тыс.`;
}

function formatWindowDuration(minutes: number | null): string | undefined {
  if (!minutes) return undefined;
  if (minutes === 10_080) return "неделя";
  if (minutes % 1_440 === 0) return `${minutes / 1_440} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} ч.`;
  return `${minutes} мин.`;
}

function formatResetTime(timestampSeconds: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestampSeconds * 1_000));
}

function formatEffort(effort: string | null | undefined): string {
  return effort ? ` · ${escapeHTML(effort)}` : "";
}

function formatAccess(
  sandboxMode: CodyConfig["codexSandboxMode"],
  approvalPolicy: CodyConfig["codexApprovalPolicy"],
): string {
  const sandbox = {
    "read-only": "только чтение",
    "workspace-write": "запись в рабочую папку",
    "danger-full-access": "полный доступ",
  }[sandboxMode];
  const approval = approvalPolicy === "never" ? "без подтверждений" : `подтверждения: ${approvalPolicy}`;
  return `${sandbox} · ${approval}`;
}

function formatAccount(authType: string | undefined, planType: string | undefined): string {
  if (authType === "apiKey") return "OpenAI API";
  if (authType === "amazonBedrock") return "Amazon Bedrock";
  const plan = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
  }[planType ?? ""] ?? planType;
  return plan ? `ChatGPT ${plan}` : "ChatGPT";
}

function stripTelegramHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
