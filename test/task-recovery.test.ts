import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Bot, Context } from "grammy";

import type { CodexPromptInput, CodexSessionCallbacks, CodexSessionService } from "../src/codex-session.js";
import type { CodyConfig } from "../src/config.js";
import { RuntimeJobStore, type RuntimeJob } from "../src/runtime-jobs.js";
import type { SessionRegistry } from "../src/session-registry.js";
import { TaskController } from "../src/task-controller.js";

describe("TaskController restart recovery", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "cody-task-recovery-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resumes a running job in the same thread and reuses its live card", async () => {
    const store = new RuntimeJobStore(path.join(root, "runtime"));
    const job = runningJob(root);
    await mkdir(path.dirname(job.userInput.imagePaths[0]!), { recursive: true });
    await writeFile(job.userInput.imagePaths[0]!, "photo");
    await store.put(job);
    const prompt = vi.fn(async (input: CodexPromptInput, callbacks: CodexSessionCallbacks) => {
      callbacks.onAgentMessageComplete?.("final-1", "Готово после рестарта", "final_answer");
      callbacks.onAgentEnd("completed");
      expect(input).toMatchObject({ imagePaths: job.userInput.imagePaths });
    });
    const session = {
      getInfo: () => ({ threadId: "thread-1", workspace: root }),
      getCurrentWorkspace: () => root,
      isProcessing: () => false,
      hasActiveThread: () => true,
      ensureThreadId: async () => "thread-1",
      prompt,
    } as unknown as CodexSessionService;
    const registry = {
      getOrCreate: vi.fn().mockResolvedValue(session),
      get: vi.fn().mockReturnValue(session),
      updateMetadata: vi.fn(),
      ensureDialogTitle: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionRegistry;
    const api = {
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 778 }),
      sendRichMessage: vi.fn().mockResolvedValue({ message_id: 779 }),
    };
    const controller = new TaskController(
      { api } as unknown as Bot<Context>,
      config(root),
      registry,
      undefined,
      store,
    );

    await controller.recover();
    await waitUntil(async () => (await store.list()).length === 0);
    controller.prepareShutdown();

    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining("Коди перезапустился"),
      imagePaths: job.userInput.imagePaths,
    });
    expect(api.editMessageText).toHaveBeenCalledWith(
      123,
      777,
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    await expect(access(job.userInput.imagePaths[0]!)).resolves.toBeUndefined();
  });
});

function config(root: string): CodyConfig {
  return {
    telegramBotToken: "token",
    telegramApiRoot: "https://api.telegram.org",
    telegramLocalMode: false,
    telegramAllowedUserIds: [123],
    telegramAllowedUserIdSet: new Set([123]),
    workspace: root,
    approvedDirectories: [root],
    maxFileSize: 20 * 1024 * 1024,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    maxParallelCodexTasks: 2,
  };
}

function runningJob(root: string): RuntimeJob & { userInput: Exclude<CodexPromptInput, string> } {
  const attachmentDirectory = path.join(root, ".cody-tgbot", "inbox", "turn-1");
  return {
    id: "task-11111111-1111-4111-8111-111111111111",
    status: "running",
    contextKey: "123",
    chatId: 123,
    userInput: {
      text: "продолжай обработку",
      imagePaths: [path.join(attachmentDirectory, "photo.webp")],
    },
    displayText: "продолжай обработку",
    workspace: root,
    createdAt: "2026-08-07T19:00:00.000Z",
    updateId: 100,
    privateChat: true,
    turnId: "turn-1",
    outDir: path.join(root, ".cody-tgbot", "turns", "turn-1", "out"),
    resumeThreadId: "thread-1",
    liveMessageId: 777,
    startedAt: new Date().toISOString(),
    cleanupPaths: [attachmentDirectory],
  };
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for recovered job");
}
