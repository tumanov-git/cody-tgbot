import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_API_ROOT",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_OWNER_USER_ID",
  "APPROVED_DIRECTORY",
  "APPROVED_DIRECTORIES",
  "CODEX_WORKSPACE",
  "MAX_FILE_SIZE",
  "CODEX_API_KEY",
  "CODEX_MODEL",
  "CODEX_AUTOMATION_MODEL",
  "CODY_TIMEZONE",
  "AUTOMATION_MIN_INTERVAL_MINUTES",
  "MAX_ACTIVE_AUTOMATIONS",
  "MAX_PARALLEL_AUTOMATIONS",
  "CODEX_SANDBOX_MODE",
  "CODEX_APPROVAL_POLICY",
  "MAX_PARALLEL_CODEX_TASKS",
] as const;

describe("loadConfig", () => {
  let root: string;
  let previousCwd: string;
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cody-tgbot-config-"));
    previousCwd = process.cwd();
    process.chdir(root);
    for (const key of ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.APPROVED_DIRECTORY = root;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    rmSync(root, { recursive: true, force: true });
  });

  it("loads the minimal fixed runtime configuration", () => {
    const config = loadConfig();

    expect(config.telegramAllowedUserIds).toEqual([123]);
    expect(config.telegramApiRoot).toBe("https://api.telegram.org");
    expect(config.telegramLocalMode).toBe(false);
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(config.telegramAllowedUserIdSet.has(123)).toBe(true);
    expect(config.telegramOwnerUserId).toBe(123);
    expect(config.workspace).toBe(root);
    expect(config.approvedDirectories).toEqual([root]);
    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.maxParallelCodexTasks).toBe(2);
    expect(config.automationTimezone).toBe("Europe/Moscow");
    expect(config.automationMinIntervalMinutes).toBe(15);
    expect(config.maxActiveAutomations).toBe(20);
    expect(config.maxParallelAutomations).toBe(2);
  });

  it("uses the local Bot API defaults when a custom API root is configured", () => {
    process.env.TELEGRAM_API_ROOT = "http://127.0.0.1:8081";

    const config = loadConfig();

    expect(config.telegramApiRoot).toBe("http://127.0.0.1:8081");
    expect(config.telegramLocalMode).toBe(true);
    expect(config.maxFileSize).toBe(2 * 1024 * 1024 * 1024);
  });

  it("does not mistake the public API with a trailing slash for local mode", () => {
    process.env.TELEGRAM_API_ROOT = "https://api.telegram.org/";

    const config = loadConfig();

    expect(config.telegramApiRoot).toBe("https://api.telegram.org");
    expect(config.telegramLocalMode).toBe(false);
  });

  it("accepts an explicitly configured fixed Codex launch policy", () => {
    process.env.CODEX_SANDBOX_MODE = "danger-full-access";
    process.env.CODEX_APPROVAL_POLICY = "on-request";

    const config = loadConfig();

    expect(config.codexSandboxMode).toBe("danger-full-access");
    expect(config.codexApprovalPolicy).toBe("on-request");
  });

  it("supports a dedicated automation model and validates its timezone", () => {
    process.env.CODEX_MODEL = "gpt-chat";
    process.env.CODEX_AUTOMATION_MODEL = "gpt-automation";
    process.env.CODY_TIMEZONE = "Asia/Yekaterinburg";

    const config = loadConfig();

    expect(config.codexModel).toBe("gpt-chat");
    expect(config.automationModel).toBe("gpt-automation");
    expect(config.automationTimezone).toBe("Asia/Yekaterinburg");

    process.env.CODY_TIMEZONE = "Mars/Olympus";
    expect(() => loadConfig()).toThrow("Invalid CODY_TIMEZONE");
  });

  it("keeps the workspace inside an approved root", () => {
    process.env.CODEX_WORKSPACE = path.dirname(root);

    expect(() => loadConfig()).toThrow("CODEX_WORKSPACE must stay inside APPROVED_DIRECTORIES");
  });

  it("parses multiple owner ids", () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";

    const config = loadConfig();

    expect(config.telegramAllowedUserIds).toEqual([123, 456]);
    expect(config.telegramOwnerUserId).toBe(123);
  });

  it("accepts an explicit owner from the allowlist", () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";
    process.env.TELEGRAM_OWNER_USER_ID = "456";

    expect(loadConfig().telegramOwnerUserId).toBe(456);
  });

  it("rejects an owner outside the allowlist", () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";
    process.env.TELEGRAM_OWNER_USER_ID = "789";

    expect(() => loadConfig()).toThrow("must be listed in TELEGRAM_ALLOWED_USER_IDS");
  });

  it("rejects malformed owner ids", () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "not-a-number";

    expect(() => loadConfig()).toThrow("Invalid Telegram user id");
  });
});
