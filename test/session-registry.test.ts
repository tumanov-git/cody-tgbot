import path from "node:path";

import { vi } from "vitest";

import type { CodyConfig } from "../src/config.js";

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Set<string>(),
}));

const sessionState = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
  existsSync: vi.fn((target: string) => fsState.files.has(target) || fsState.directories.has(target)),
  mkdirSync: vi.fn((target: string) => fsState.directories.add(target)),
  readFileSync: vi.fn((target: string) => {
    const value = fsState.files.get(target);
    if (value === undefined) throw new Error(`ENOENT: ${target}`);
    return value;
  }),
  writeFileSync: vi.fn((target: string, value: string) => {
    fsState.files.set(target, value);
    fsState.directories.add(path.dirname(target));
  }),
  renameSync: vi.fn((source: string, target: string) => {
    const value = fsState.files.get(source);
    if (value === undefined) throw new Error(`ENOENT: ${source}`);
    fsState.files.set(target, value);
    fsState.files.delete(source);
  }),
  unlinkSync: vi.fn((target: string) => {
    fsState.files.delete(target);
  }),
}));

vi.mock("../src/codex-session.js", () => ({
  CodexSessionService: { create: sessionState.create },
}));

import { SessionRegistry } from "../src/session-registry.js";

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
  codexModel: "gpt-5.6",
  codexSandboxMode: "workspace-write",
  codexApprovalPolicy: "never",
  maxParallelCodexTasks: 2,
};

function createSession(info: {
  threadId: string | null;
  workspace: string;
  pendingInitialContext?: string;
}) {
  let current = { ...info };
  return {
    getInfo: vi.fn(() => ({ ...current })),
    dispose: vi.fn(),
    isProcessing: vi.fn(() => false),
    setInfo(next: Partial<typeof current>) {
      current = { ...current, ...next };
    },
  };
}

describe("SessionRegistry", () => {
  beforeEach(() => {
    fsState.files.clear();
    fsState.directories.clear();
    sessionState.create.mockReset();
    sessionState.create.mockImplementation(async (_config: CodyConfig, options?: {
      workspace?: string;
      resumeThreadId?: string;
    }) => createSession({
      threadId: options?.resumeThreadId ?? null,
      workspace: options?.workspace ?? config.workspace,
    }));
  });

  it("reuses a session inside one Telegram context", async () => {
    const registry = new SessionRegistry(config);

    expect(await registry.getOrCreate("123")).toBe(await registry.getOrCreate("123"));
    expect(sessionState.create).toHaveBeenCalledTimes(1);
  });

  it("keeps topic contexts independent", async () => {
    const registry = new SessionRegistry(config);

    expect(await registry.getOrCreate("123:1")).not.toBe(await registry.getOrCreate("123:2"));
  });

  it("restores persisted thread metadata without old control settings", async () => {
    const persistPath = path.join(config.workspace, ".cody-tgbot", "contexts.json");
    fsState.files.set(persistPath, JSON.stringify([{
      contextKey: "123",
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "gpt-5.6",
      reasoningEffort: "high",
      launchProfileId: "legacy-profile",
      updatedAt: 10,
    }]));

    const registry = new SessionRegistry(config);
    await registry.getOrCreate("123");

    expect(sessionState.create).toHaveBeenCalledWith(config, {
      workspace: "/workspace/a",
      deferThreadStart: undefined,
      resumeThreadId: "thread-a",
      pendingInitialContext: undefined,
      dynamicTools: undefined,
      developerInstructions: undefined,
      preferences: {
        model: "gpt-5.6",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      },
    }, expect.anything());
  });

  it("persists only the current core context metadata", async () => {
    const registry = new SessionRegistry(config);
    const session = await registry.getOrCreate("123") as ReturnType<typeof createSession>;
    session.setInfo({ threadId: "thread-new" });

    registry.updateMetadata("123", session as never);

    const saved = JSON.parse(fsState.files.get(
      path.join(config.workspace, ".cody-tgbot", "contexts.json"),
    ) ?? "[]") as Array<Record<string, unknown>>;
    expect(saved[0]).toMatchObject({
      contextKey: "123",
      threadId: "thread-new",
    });
    expect(saved[0]).not.toHaveProperty("launchProfileId");
    expect(saved[0]).not.toHaveProperty("model");
    expect(saved[0]).not.toHaveProperty("reasoningEffort");
    expect(fsState.files.get(
      path.join(config.workspace, ".cody-tgbot", "contexts.json.bak"),
    )).toBeDefined();
  });

  it("restores context metadata from backup when the main file is corrupted", async () => {
    const persistPath = path.join(config.workspace, ".cody-tgbot", "contexts.json");
    fsState.files.set(persistPath, "{broken");
    fsState.files.set(`${persistPath}.bak`, JSON.stringify([{
      contextKey: "123",
      threadId: "thread-backup",
      workspace: "/workspace/a",
      updatedAt: 10,
    }]));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const registry = new SessionRegistry(config);
    await registry.getOrCreate("123");

    expect(sessionState.create).toHaveBeenCalledWith(config, expect.objectContaining({
      resumeThreadId: "thread-backup",
      workspace: "/workspace/a",
    }), expect.anything());
    expect(warning).toHaveBeenCalledWith("Context metadata restored from backup");
    warning.mockRestore();
  });

  it("persists a one-time project context without assigning the dialog to a project", async () => {
    const registry = new SessionRegistry(config);
    const session = await registry.getOrCreate("123") as ReturnType<typeof createSession>;
    session.setInfo({
      threadId: null,
      pendingInitialContext: "project_id: cody-tgbot",
    });

    registry.updateMetadata("123", session as never);

    const saved = JSON.parse(fsState.files.get(
      path.join(config.workspace, ".cody-tgbot", "contexts.json"),
    ) ?? "[]") as Array<Record<string, unknown>>;
    expect(saved[0]).toMatchObject({
      contextKey: "123",
      threadId: null,
      pendingInitialContext: "project_id: cody-tgbot",
    });
    expect(saved[0]).not.toHaveProperty("projectId");
  });
});
