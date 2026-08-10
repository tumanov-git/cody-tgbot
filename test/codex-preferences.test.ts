import type { CodyConfig } from "../src/config.js";
import {
  defaultCodexPreferences,
  findFastServiceTier,
  normalizeCodexPreferences,
} from "../src/codex-preferences.js";

const config: CodyConfig = {
  telegramBotToken: "bot-token",
  telegramApiRoot: "https://api.telegram.org",
  telegramLocalMode: false,
  telegramAllowedUserIds: [123],
  telegramAllowedUserIdSet: new Set([123]),
  workspace: "/workspace/base",
  approvedDirectories: ["/workspace"],
  maxFileSize: 20 * 1024 * 1024,
  codexApiKey: "codex-key",
  codexModel: "gpt-5.6-sol",
  codexSandboxMode: "workspace-write",
  codexApprovalPolicy: "on-request",
  maxParallelCodexTasks: 2,
};

describe("Codex preferences", () => {
  it("starts from the configured model and access policy", () => {
    expect(defaultCodexPreferences(config)).toEqual({
      model: "gpt-5.6-sol",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    });
  });

  it("keeps valid per-dialog overrides and rejects malformed access values", () => {
    expect(normalizeCodexPreferences({
      model: " gpt-5.6-terra ",
      reasoningEffort: " high ",
      serviceTier: "priority",
      sandboxMode: "invalid" as never,
      approvalPolicy: "invalid" as never,
    }, config)).toEqual({
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      serviceTier: "priority",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    });
  });

  it("maps Codex's priority tier to the Fast switch", () => {
    expect(findFastServiceTier({
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "",
      isDefault: true,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [],
      defaultServiceTier: null,
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
    })?.id).toBe("priority");
  });
});
