import type { CodexApprovalPolicy, CodexSandboxMode, CodyConfig } from "./config.js";

export interface CodexPreferences {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
  defaultServiceTier: string | null;
  serviceTiers: Array<{
    id: string;
    name: string;
    description: string;
  }>;
}

export function findFastServiceTier(
  model: CodexModelOption,
): CodexModelOption["serviceTiers"][number] | undefined {
  return model.serviceTiers.find((tier) => (
    tier.id === "priority" || tier.name.toLowerCase() === "fast"
  ));
}

export function defaultCodexPreferences(config: CodyConfig): CodexPreferences {
  return {
    ...(config.codexModel ? { model: config.codexModel } : {}),
    sandboxMode: config.codexSandboxMode,
    approvalPolicy: config.codexApprovalPolicy,
  };
}

export function normalizeCodexPreferences(
  value: Partial<CodexPreferences> | undefined,
  config: CodyConfig,
): CodexPreferences {
  const defaults = defaultCodexPreferences(config);
  const sandboxMode = isSandboxMode(value?.sandboxMode)
    ? value.sandboxMode
    : defaults.sandboxMode;
  const approvalPolicy = isApprovalPolicy(value?.approvalPolicy)
    ? value.approvalPolicy
    : defaults.approvalPolicy;
  return {
    ...(typeof value?.model === "string" && value.model.trim()
      ? { model: value.model.trim() }
      : defaults.model ? { model: defaults.model } : {}),
    ...(typeof value?.reasoningEffort === "string" && value.reasoningEffort.trim()
      ? { reasoningEffort: value.reasoningEffort.trim() }
      : {}),
    ...(value?.serviceTier === null || typeof value?.serviceTier === "string"
      ? { serviceTier: value.serviceTier }
      : {}),
    sandboxMode,
    approvalPolicy,
  };
}

function isSandboxMode(value: unknown): value is CodexSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function isApprovalPolicy(value: unknown): value is CodexApprovalPolicy {
  return value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted";
}
