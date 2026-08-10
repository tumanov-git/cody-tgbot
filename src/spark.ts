import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_SPARK_MODEL = "gpt-5.3-codex-spark";

export async function runSparkPrompt(
  prompt: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const model = process.env.CODY_SPARK_MODEL?.trim() || DEFAULT_SPARK_MODEL;
  const binary = path.resolve(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-m",
      model,
      "-C",
      "/tmp",
      "-c",
      "model_reasoning_effort=\"low\"",
      "--color",
      "never",
      "-",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Spark timed out")));
    }, options.timeoutMs ?? 20_000);

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString("utf8").trim();
          reject(new Error(detail || (signal ? `Spark exited with ${signal}` : `Spark exited with code ${code ?? "unknown"}`)));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
    child.stdin.end(prompt);
  });
}
