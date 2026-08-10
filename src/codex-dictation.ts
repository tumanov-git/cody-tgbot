import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CODEX_DICTATION_ENDPOINT = "https://chatgpt.com/backend-api/transcribe";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_USER_AGENT = "codex_cli_rs/0.146.1 (Linux x86_64) cody-tgbot";

interface CodexAuthFile {
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
}

interface CodexDictationAuth {
  accessToken: string;
  accountId?: string;
}

export interface CodexDictationResult {
  text: string;
  durationMs: number;
}

export async function isCodexDictationAvailable(): Promise<boolean> {
  return Boolean(await readCodexDictationAuth());
}

export async function transcribeWithCodexDictation(filePath: string): Promise<CodexDictationResult> {
  const auth = await readCodexDictationAuth();
  if (!auth) {
    throw new Error("Codex Desktop dictation недоступен: войди через ChatGPT в Codex");
  }

  const startedAt = Date.now();
  const audio = await readFile(filePath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio], { type: getAudioMimeType(filePath) }),
    path.basename(filePath) || "audio.ogg",
  );

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    "User-Agent": process.env.CODEX_DICTATION_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
  };
  if (auth.accountId) {
    headers["ChatGPT-Account-Id"] = auth.accountId;
  }

  const timeoutMs = parsePositiveIntegerEnv("CODEX_DICTATION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const response = await fetch(CODEX_DICTATION_ENDPOINT, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  const payload = parseJsonObject(body);

  if (!response.ok) {
    const detail = extractErrorDetail(payload, body, auth.accessToken);
    throw new Error(
      `Codex Desktop dictation failed (${response.status}): ${detail || response.statusText || "Unknown error"}`,
    );
  }

  const text = payload?.text;
  if (typeof text !== "string") {
    throw new Error("Codex Desktop dictation response did not include a text field");
  }

  return {
    text,
    durationMs: Date.now() - startedAt,
  };
}

async function readCodexDictationAuth(): Promise<CodexDictationAuth | undefined> {
  try {
    const contents = await readFile(resolveCodexAuthPath(), "utf8");
    const auth = JSON.parse(contents) as CodexAuthFile;
    const accessToken = auth.tokens?.access_token;
    const accountId = auth.tokens?.account_id;
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      return undefined;
    }
    return {
      accessToken: accessToken.trim(),
      accountId: typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined,
    };
  } catch {
    return undefined;
  }
}

function resolveCodexAuthPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(codexHome, "auth.json");
}

function getAudioMimeType(filePath: string): string {
  const ext = (path.extname(filePath) || ".ogg").slice(1).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ogg: "audio/ogg",
    oga: "audio/ogg",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
    webm: "audio/webm",
    flac: "audio/flac",
  };
  return mimeTypes[ext] ?? "application/octet-stream";
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function extractErrorDetail(payload: Record<string, unknown> | undefined, body: string, accessToken: string): string {
  const error = payload?.error;
  const detail = payload?.detail;
  let value = "";
  if (typeof error === "string") {
    value = error;
  } else if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    value = (error as { message: string }).message;
  } else if (typeof detail === "string") {
    value = detail;
  } else {
    value = body;
  }
  return sanitizeSecret(value.trim(), accessToken).slice(0, 800);
}

function sanitizeSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join("[redacted]") : value;
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
