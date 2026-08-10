import type { Context } from "grammy";

import { deliverAutomationArtifacts } from "./artifact-delivery.js";
import { buildOutputInstructions, outboxPath } from "./attachments.js";
import { ensureOutDir } from "./artifacts.js";
import {
  AutomationLaunchError,
  classifyAutomationFailure,
  preflightAutomationWorkspace,
} from "./automation-preflight.js";
import type { AutomationStore } from "./automation-store.js";
import type { ClaimedAutomation } from "./automation-types.js";
import type { CodexSessionCallbacks } from "./codex-session.js";
import { CodexSessionService } from "./codex-session.js";
import type { CodyConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import { PREMIUM_EMOJI, renderPremiumEmojiMarkdown } from "./format.js";
import { PROJECT_DYNAMIC_TOOLS, type ProjectToolRuntime } from "./project-tools.js";
import { ProjectWorkAbortedError, type ProjectWorkLock } from "./project-work-lock.js";
import type { ProjectStore } from "./project-store.js";
import { sendRichFinalMessage } from "./telegram-api.js";

const INACTIVITY_TIMEOUT_MS = 15 * 60_000;
const HARD_TIMEOUT_MS = 60 * 60_000;
const SESSION_CREATE_RETRY_DELAYS_MS = [1_000, 5_000];

const AUTOMATION_DEVELOPER_INSTRUCTIONS = [
  "Ты выполняешь автономный запуск автоматизации Коди без живого пользователя в ходе.",
  "Выполни только сохранённую инструкцию в контексте указанного проекта.",
  "Не создавай новые проекты и автоматизации и не проси уточнений: если данных не хватает, коротко сообщи об этом в финальном ответе.",
  "Не повторяй опасное внешнее действие, если не можешь доказать, что оно ещё не выполнено.",
  "execution_id из контекста — постоянный ключ этого запуска. Передавай его как idempotency key внешним системам, если они это поддерживают.",
  "Если сообщать пользователю действительно нечего, верни ровно [SILENT] без другого текста.",
  "Финальный ответ должен быть самостоятельным и понятным без истории запуска.",
].join("\n");

export interface AutomationRunnerOptions {
  api: Context["api"];
  config: CodyConfig;
  store: AutomationStore;
  projectStore: ProjectStore;
  projectTools: ProjectToolRuntime;
  projectWorkLock: ProjectWorkLock;
}

export class AutomationRunner {
  private readonly activeSessions = new Map<string, CodexSessionService>();
  private readonly activeWatchdogs = new Map<string, AutomationWatchdog>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(private readonly options: AutomationRunnerOptions) {}

  async stop(executionId: string): Promise<boolean> {
    const controller = this.abortControllers.get(executionId);
    if (!controller) return false;
    controller.abort();
    const watchdog = this.activeWatchdogs.get(executionId);
    if (watchdog) watchdog.stop();
    else await this.activeSessions.get(executionId)?.abort().catch(() => {});
    return true;
  }

  async run(claim: ClaimedAutomation, runnerId = "standalone"): Promise<void> {
    const { automation, execution } = claim;
    let session: CodexSessionService | undefined;
    let watchdog: AutomationWatchdog | undefined;
    let deliveryNeeded = false;
    const abortController = new AbortController();
    this.abortControllers.set(execution.id, abortController);
    try {
      const project = await this.options.projectStore.get(automation.projectId);
      if (!project) {
        this.options.store.markRunning(execution.id, runnerId);
        const message = `Проект «${automation.projectId}» больше не существует`;
        this.options.store.finish(
          execution.id,
          { status: "failed", error: message },
          new Date(),
          { runnerId, pauseReason: message },
        );
        await this.deliver(execution.id, runnerId);
        return;
      }
      await this.options.projectWorkLock.runExclusive(project.workspace, async () => {
        if (abortController.signal.aborted) throw new AutomationStoppedError();
        this.options.store.markRunning(execution.id, runnerId);
        if (
          execution.source === "scheduled"
          && automation.schedule.kind === "once"
          && new Date(execution.claimedAt).getTime() - new Date(execution.scheduledFor).getTime()
            > 24 * 60 * 60_000
        ) {
          const message = "Одноразовый запуск пропущен больше чем на сутки";
          this.options.store.finish(
            execution.id,
            { status: "failed", error: message },
            new Date(),
            { runnerId, pauseReason: message, countFailure: false },
          );
          deliveryNeeded = true;
          return;
        }

        await preflightAutomationWorkspace(project.workspace);
        const outDir = outboxPath(project.workspace, execution.id);
        await ensureOutDir(outDir);
        const projectContext = await this.options.projectStore.renderAutomationContext(project.id);
        session = await createSessionWithRetry(
          () => CodexSessionService.create(
            {
              ...this.options.config,
              codexModel: this.options.config.automationModel ?? this.options.config.codexModel,
            },
            {
              workspace: project.workspace,
              pendingInitialContext: buildAutomationContext(claim, projectContext),
              developerInstructions: AUTOMATION_DEVELOPER_INSTRUCTIONS,
              dynamicTools: PROJECT_DYNAMIC_TOOLS.filter((tool) => tool.name === "project_memory"),
              dynamicToolHandler: (params) => this.options.projectTools.handle(params),
            },
          ),
          abortController.signal,
        );
        this.activeSessions.set(execution.id, session);
        if (abortController.signal.aborted) throw new AutomationStoppedError();
        let finalText = "";
        let interrupted = false;
        watchdog = new AutomationWatchdog(session);
        this.activeWatchdogs.set(execution.id, watchdog);
        const activity = () => watchdog?.activity();
        const callbacks: CodexSessionCallbacks = {
          onTextDelta: activity,
          onToolStart: activity,
          onToolEnd: activity,
          onAgentMessageDelta: (_id, _delta, fullText, phase) => {
            activity();
            if (phase === "final_answer") finalText = fullText;
          },
          onAgentMessageComplete: (_id, text, phase) => {
            activity();
            if (phase === "final_answer" || phase === null) finalText = text;
          },
          onAgentEnd: (status) => {
            activity();
            interrupted = status === "interrupted";
          },
        };
        await watchdog.run(() => session!.prompt({
          text: automation.instruction,
          stagedFileInstructions: buildOutputInstructions(outDir),
        }, callbacks));
        if (abortController.signal.aborted) throw new AutomationStoppedError();
        if (interrupted) throw new Error("Запуск был прерван");
        const result = finalText.trim();
        if (!result) throw new Error("Codex завершил запуск без финального ответа");
        if (isSilentResult(result)) {
          this.options.store.finish(
            execution.id,
            { status: "silent", result },
            new Date(),
            { runnerId, deliveryRequired: false },
          );
          return;
        }

        this.options.store.finish(
          execution.id,
          { status: "success", result },
          new Date(),
          { runnerId },
        );
        deliveryNeeded = true;
      }, abortController.signal);
      if (deliveryNeeded) await this.deliver(execution.id, runnerId);
    } catch (error) {
      const stopped = error instanceof AutomationStoppedError
        || error instanceof ProjectWorkAbortedError
        || abortController.signal.aborted;
      const failureKind = classifyAutomationFailure(error);
      const status = error instanceof AutomationTimeoutError ? "timed_out" : "failed";
      const message = stopped
        ? "Остановлено пользователем"
        : error instanceof AutomationTimeoutError
          ? error.message
          : friendlyErrorText(error);
      try {
        const pauseReason = !stopped && failureKind === "blocked_config"
          ? `Приостановлена: ${message}`
          : undefined;
        this.options.store.finish(
          execution.id,
          { status, error: message },
          new Date(),
          { runnerId, countFailure: !stopped && failureKind !== "blocked_config", pauseReason },
        );
        await this.deliver(execution.id, runnerId);
      } catch (storeError) {
        console.error("Failed to persist automation error:", storeError);
      }
    } finally {
      watchdog?.dispose();
      this.activeSessions.delete(execution.id);
      this.activeWatchdogs.delete(execution.id);
      this.abortControllers.delete(execution.id);
      session?.dispose();
    }
  }

  async deliver(executionId: string, runnerId = "standalone"): Promise<void> {
    const claim = this.options.store.claimDelivery(executionId, runnerId);
    if (!claim) return;
    const { automation, execution } = claim;
    try {
      if (!execution.telegramMessageId) {
        const message = renderDeliveryMessage(claim);
        const sent = await sendRichFinalMessage(this.options.api, automation.chatId, message, {
          messageThreadId: automation.messageThreadId,
        });
        this.options.store.markDeliveryMainSent(execution.id, runnerId, sent.message_id);
      }
      if (execution.status === "success") {
        const project = await this.options.projectStore.get(automation.projectId);
        if (project) {
          await deliverAutomationArtifacts(
            this.options.api,
            this.options.config,
            this.options.store,
            execution.id,
            runnerId,
            automation.chatId,
            outboxPath(project.workspace, execution.id),
            automation.messageThreadId,
            Boolean(execution.artifactSummaryMessageId),
          );
        }
      }
      this.options.store.finishDelivery(execution.id, runnerId);
    } catch (error) {
      const message = friendlyErrorText(error);
      try {
        this.options.store.finishDelivery(execution.id, runnerId, message);
      } catch (storeError) {
        console.error("Failed to persist automation delivery error:", storeError);
      }
    }
  }
}

class AutomationWatchdog {
  private inactivityTimer: NodeJS.Timeout | undefined;
  private hardTimer: NodeJS.Timeout | undefined;
  private rejectTimeout: ((error: Error) => void) | undefined;
  private timedOut = false;

  constructor(private readonly session: CodexSessionService) {}

  async run(task: () => Promise<void>): Promise<void> {
    const timeout = new Promise<never>((_resolve, reject) => {
      this.rejectTimeout = reject;
      this.hardTimer = setTimeout(
        () => this.timeout("Автоматизация работала дольше 60 минут"),
        HARD_TIMEOUT_MS,
      );
      this.hardTimer.unref();
      this.activity();
    });
    try {
      await Promise.race([task(), timeout]);
    } finally {
      this.dispose();
    }
  }

  activity(): void {
    if (this.timedOut) return;
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(
      () => this.timeout("Автоматизация не подавала признаков работы 15 минут"),
      INACTIVITY_TIMEOUT_MS,
    );
    this.inactivityTimer.unref();
  }

  dispose(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.inactivityTimer = undefined;
    this.hardTimer = undefined;
    this.rejectTimeout = undefined;
  }

  private timeout(message: string): void {
    if (this.timedOut) return;
    this.timedOut = true;
    void this.session.abort().catch(() => {});
    this.rejectTimeout?.(new AutomationTimeoutError(message));
  }

  stop(): void {
    if (this.timedOut) return;
    this.timedOut = true;
    void this.session.abort().catch(() => {});
    this.rejectTimeout?.(new AutomationStoppedError());
  }
}

class AutomationTimeoutError extends Error {}
class AutomationStoppedError extends Error {}

function renderDeliveryMessage(claim: ClaimedAutomation): string {
  const { automation, execution } = claim;
  if (execution.status === "success") return execution.result ?? "Автоматизация завершена";
  const marker = renderPremiumEmojiMarkdown(PREMIUM_EMOJI.sad, "😕");
  if (execution.error === "Остановлено пользователем") {
    return `${marker} Автоматизация «${automation.name}» остановлена`;
  }
  if (execution.status === "timed_out") {
    return `${marker} Автоматизация «${automation.name}» остановлена\n\n${execution.error ?? "Превышено время выполнения"}`;
  }
  if (execution.status === "unknown") {
    return `${marker} Результат автоматизации «${automation.name}» неизвестен\n\nКоди перезапустился во время выполнения. Я не повторяю такую работу автоматически.`;
  }
  const paused = automation.state === "paused" && automation.pausedReason
    ? `\n\n${automation.pausedReason}`
    : "";
  return `${marker} Не удалось выполнить автоматизацию «${automation.name}»\n\n${execution.error ?? "Неизвестная ошибка"}${paused}`;
}

function buildAutomationContext(claim: ClaimedAutomation, projectContext: string): string {
  const { automation, execution } = claim;
  const lines = [
    "КОНТЕКСТ АВТОМАТИЗАЦИИ КОДИ",
    `automation_id: ${automation.id}`,
    `execution_id: ${execution.id}`,
    `Название: ${automation.name}`,
    `Описание: ${automation.description}`,
    `Расписание: ${automation.scheduleDescription}`,
    `Запланированное время этого запуска: ${execution.scheduledFor}`,
    `Номер запуска: ${automation.runCount}`,
  ];
  if (automation.lastSuccessfulResult) {
    lines.push(
      "",
      "Последний успешный результат (используй только если он нужен для сравнения):",
      automation.lastSuccessfulResult.slice(0, 4_000),
    );
  }
  lines.push("", projectContext);
  return lines.join("\n");
}

async function createSessionWithRetry(
  create: () => Promise<CodexSessionService>,
  signal: AbortSignal,
): Promise<CodexSessionService> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw new AutomationStoppedError();
    try {
      return await create();
    } catch (error) {
      const kind = classifyAutomationFailure(error);
      const delay = SESSION_CREATE_RETRY_DELAYS_MS[attempt];
      if (kind !== "transient" || delay === undefined) {
        const message = error instanceof Error ? error.message : String(error);
        throw new AutomationLaunchError(kind, message, { cause: error });
      }
      await abortableDelay(delay, signal);
    }
  }
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new AutomationStoppedError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    timer.unref();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new AutomationStoppedError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function isSilentResult(value: string): boolean {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, " ");
  return normalized === "[SILENT]" || normalized === "SILENT" || normalized === "NO_REPLY";
}
