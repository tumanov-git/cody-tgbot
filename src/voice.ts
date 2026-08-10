import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { transcribeWithCodexDictation } from "./codex-dictation.js";

export interface TranscriptionResult {
  text: string;
  backend: "codex" | "faster-whisper";
  durationMs: number;
  detail?: string;
}

let runFasterWhisper: (filePath: string) => Promise<TranscriptionResult> = runFasterWhisperProcess;

export function _setFasterWhisperHook(
  hook: (filePath: string) => Promise<TranscriptionResult>,
): void {
  runFasterWhisper = hook;
}

export function _resetFasterWhisperHook(): void {
  runFasterWhisper = runFasterWhisperProcess;
}

export function buildVoiceAgentPrompt(transcript: string): string {
  return [
    "[Контекст голосового сообщения]",
    "Пользователь отправил это сообщение голосом, а текст ниже получен автоматическим распознаванием речи и может содержать ошибки.",
    "Не изобретай новые термины и не приписывай смысл искажённым словам. Если неоднозначность существенно влияет на ответ или действие, коротко переспроси пользователя.",
    "",
    "[Расшифровка]",
    transcript,
  ].join("\n");
}

export async function transcribeAudio(filePath: string): Promise<TranscriptionResult> {
  try {
    const result = await transcribeWithCodexDictation(filePath);
    return {
      ...result,
      backend: "codex",
      detail: "ChatGPT / Codex Desktop dictation",
    };
  } catch (codexError) {
    try {
      const result = await runFasterWhisper(filePath);
      return {
        ...result,
        detail: [result.detail, "fallback after Codex dictation error"].filter(Boolean).join(" / "),
      };
    } catch (whisperError) {
      throw new Error(
        `Не удалось распознать голос через Codex и faster-whisper: ${errorMessage(codexError)}; ${errorMessage(whisperError)}`,
      );
    }
  }
}

async function runFasterWhisperProcess(filePath: string): Promise<TranscriptionResult> {
  const python = getFasterWhisperPython();
  const script = getFasterWhisperScript();
  if (isPathReference(python) && !existsSync(path.resolve(python))) {
    throw new Error(`faster-whisper Python не найден: ${python}`);
  }
  if (!existsSync(script)) {
    throw new Error(`faster-whisper helper не найден: ${script}`);
  }

  const model = process.env.FASTER_WHISPER_MODEL?.trim() || "medium";
  const computeType = process.env.FASTER_WHISPER_COMPUTE_TYPE?.trim() || "int8";
  const threads = process.env.FASTER_WHISPER_THREADS?.trim() || "2";
  const language = process.env.FASTER_WHISPER_LANGUAGE?.trim() || "auto";
  const modelDir = expandHome(
    process.env.FASTER_WHISPER_MODEL_DIR?.trim()
      || path.join(homedir(), ".cache", "cody-tgbot", "faster-whisper"),
  );
  const startedAt = Date.now();
  const output = await spawnAndCollect(python, [
    script,
    filePath,
    "--model",
    model,
    "--compute-type",
    computeType,
    "--threads",
    threads,
    "--language",
    language,
    "--model-dir",
    modelDir,
  ]);
  const payload = JSON.parse(output.stdout.trim()) as {
    text?: unknown;
    durationMs?: unknown;
    model?: unknown;
    language?: unknown;
  };

  if (typeof payload.text !== "string") {
    throw new Error("faster-whisper response did not include a text field");
  }

  return {
    text: payload.text,
    backend: "faster-whisper",
    durationMs: typeof payload.durationMs === "number" ? payload.durationMs : Date.now() - startedAt,
    detail: [
      typeof payload.model === "string" ? payload.model : model,
      typeof payload.language === "string" ? payload.language : language,
      computeType,
    ].join(" / "),
  };
}

function spawnAndCollect(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (code !== 0) {
          reject(new Error(
            `faster-whisper failed: ${stderr || (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`)}`,
          ));
          return;
        }
        resolve({ stdout });
      });
    });
  });
}

function getFasterWhisperPython(): string {
  return process.env.FASTER_WHISPER_PYTHON?.trim()
    || (process.platform === "win32" ? "python" : "python3");
}

function getFasterWhisperScript(): string {
  const configured = process.env.FASTER_WHISPER_SCRIPT?.trim();
  return path.resolve(process.cwd(), configured || path.join("tools", "faster-whisper-transcribe.py"));
}

function isPathReference(value: string): boolean {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
