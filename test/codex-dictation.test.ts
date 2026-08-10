import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCodexDictationAvailable, transcribeWithCodexDictation } from "../src/codex-dictation.js";

describe("Codex Desktop dictation", () => {
  const originalCodexHome = process.env.CODEX_HOME;
  const originalTimeout = process.env.CODEX_DICTATION_TIMEOUT_MS;
  const originalUserAgent = process.env.CODEX_DICTATION_USER_AGENT;
  let tempDir: string;
  let audioPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "cody-tgbot-dictation-"));
    audioPath = path.join(tempDir, "voice.ogg");
    writeFileSync(audioPath, Buffer.from("test audio"));
    process.env.CODEX_HOME = tempDir;
    delete process.env.CODEX_DICTATION_TIMEOUT_MS;
    delete process.env.CODEX_DICTATION_USER_AGENT;
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tempDir, { recursive: true, force: true });
    restoreEnv("CODEX_HOME", originalCodexHome);
    restoreEnv("CODEX_DICTATION_TIMEOUT_MS", originalTimeout);
    restoreEnv("CODEX_DICTATION_USER_AGENT", originalUserAgent);
  });

  it("is unavailable without a ChatGPT access token", async () => {
    await expect(isCodexDictationAvailable()).resolves.toBe(false);
    await expect(transcribeWithCodexDictation(audioPath)).rejects.toThrow("войди через ChatGPT");
  });

  it("posts Telegram audio through the Codex Desktop transcription route", async () => {
    writeAuthFile(tempDir, "chatgpt-test-token", "account-test");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ text: "точная расшифровка" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(isCodexDictationAvailable()).resolves.toBe(true);
    const result = await transcribeWithCodexDictation(audioPath);

    expect(result.text).toBe("точная расшифровка");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/transcribe",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer chatgpt-test-token",
          "ChatGPT-Account-Id": "account-test",
        }),
        body: expect.any(FormData),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("redacts the ChatGPT token from backend errors", async () => {
    const token = "chatgpt-secret-token";
    writeAuthFile(tempDir, token, "account-test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => JSON.stringify({ error: { message: `rejected ${token}` } }),
    }));

    let thrown: unknown;
    try {
      await transcribeWithCodexDictation(audioPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("rejected [redacted]");
    expect((thrown as Error).message).not.toContain(token);
  });
});

function writeAuthFile(codexHome: string, accessToken: string, accountId: string): void {
  writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken,
      account_id: accountId,
    },
  }));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
