import { readCodexStatus, renderCodexStatus } from "../src/codex-status.js";
import type { CodexAppServerTransport } from "../src/codex-session.js";
import type { CodyConfig } from "../src/config.js";

describe("Codex status", () => {
  const config: CodyConfig = {
    telegramBotToken: "token",
    telegramApiRoot: "https://api.telegram.org",
    telegramLocalMode: false,
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: "/workspace",
    approvedDirectories: ["/workspace"],
    maxFileSize: 20 * 1024 * 1024,
    codexSandboxMode: "danger-full-access",
    codexApprovalPolicy: "never",
    maxParallelCodexTasks: 2,
    automationTimezone: "Europe/Moscow",
  };

  it("reads native account limits and renders the current Codex state", async () => {
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === "account/read") {
          return { account: { type: "chatgpt", planType: "prolite" } };
        }
        if (method === "account/rateLimits/read") {
          return {
            rateLimits: emptyLimit(),
            rateLimitsByLimitId: {
              codex: {
                limitId: "codex",
                limitName: null,
                primary: {
                  usedPercent: 72,
                  windowDurationMins: 10_080,
                  resetsAt: 1_786_161_048,
                },
                secondary: null,
                planType: "prolite",
              },
              codex_bengalfox: {
                limitId: "codex_bengalfox",
                limitName: "GPT-5.3-Codex-Spark",
                primary: {
                  usedPercent: 0,
                  windowDurationMins: 10_080,
                  resetsAt: null,
                },
                secondary: null,
                planType: "prolite",
              },
            },
          };
        }
        return { config: { model: null } };
      }),
      onNotification: vi.fn(),
      dispose: vi.fn(),
    } as unknown as CodexAppServerTransport;

    const status = await readCodexStatus(
      transport,
      config,
      { threadId: "019fd258-0be5-7dd3-9f66-e119d8f296c1", workspace: "/workspace" },
      {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        tokenUsage: {
          total: usage(80_000),
          last: usage(25_000),
          modelContextWindow: 100_000,
        },
      },
    );
    const rendered = renderCodexStatus(status);

    expect(rendered.html).toContain("gpt-5.6-sol · high");
    expect(rendered.html).toContain("полный доступ · без подтверждений");
    expect(rendered.html).toContain("75% свободно · 25 тыс. / 100 тыс.");
    expect(rendered.html).toContain("Codex · неделя:</b> 28% осталось");
    expect(rendered.html).toContain("GPT-5.3-Codex-Spark · неделя:</b> 100% осталось");
    expect(rendered.html).toContain("ChatGPT Pro");
    expect(rendered.html).toContain("Автоматизации:</b> Автовыбор Codex · Europe/Moscow");
  });

  it("shows durable automation scheduler health", () => {
    const rendered = renderCodexStatus({
      model: "gpt-5.6-sol",
      threadId: null,
      workspace: "/workspace",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      automationModel: "gpt-5.6-sol",
      automationTimezone: "Europe/Moscow",
      rateLimits: [],
      automationHealth: {
        lastSuccessfulTickAt: new Date().toISOString(),
        scheduledCount: 2,
        dueCount: 1,
        runningCount: 1,
        activeWorkers: 1,
        queuedClaims: 0,
        healthy: true,
        status: "healthy",
      },
    });

    expect(rendered.plain).toContain("Планировщик");
    expect(rendered.plain).toContain("работает · тик 0с назад");
    expect(rendered.plain).toContain("Запущено: 1 · ожидает: 1");
  });

  it("keeps session status useful when account limits are unavailable", async () => {
    const transport = {
      request: vi.fn().mockRejectedValue(new Error("offline")),
      onNotification: vi.fn(),
      dispose: vi.fn(),
    } as unknown as CodexAppServerTransport;
    const status = await readCodexStatus(
      transport,
      config,
      { threadId: null, workspace: "/workspace" },
      {},
    );

    const rendered = renderCodexStatus(status);
    expect(rendered.plain).toContain("Автовыбор Codex");
    expect(rendered.plain).toContain("Данные о лимитах недоступны.");
  });

  it("shows a separately pinned automation model", async () => {
    const transport = {
      request: vi.fn().mockRejectedValue(new Error("offline")),
      onNotification: vi.fn(),
      dispose: vi.fn(),
    } as unknown as CodexAppServerTransport;
    const status = await readCodexStatus(
      transport,
      { ...config, codexModel: "gpt-chat", automationModel: "gpt-background" },
      { threadId: null, workspace: "/workspace" },
      {},
    );

    expect(renderCodexStatus(status).plain).toContain(
      "Автоматизации: gpt-background · Europe/Moscow",
    );
  });
});

function usage(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function emptyLimit() {
  return {
    limitId: "codex",
    limitName: null,
    primary: null,
    secondary: null,
    planType: "prolite",
  };
}
