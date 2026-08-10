import type { DynamicToolCallParams, DynamicToolCallResult, DynamicToolSpec } from "./codex-app-server.js";
import type { AutomationScheduler } from "./automation-scheduler.js";
import type { AutomationStore } from "./automation-store.js";
import type { AutomationSchedule, UpdateAutomationInput } from "./automation-types.js";
import { parseContextKey, type TelegramContextKey } from "./context-key.js";
import type { ProjectStore } from "./project-store.js";

export const AUTOMATION_DEVELOPER_INSTRUCTIONS = [
  "Внутренние автоматизации Коди:",
  "- Автоматизация — повторяющаяся или отложенная работа по существующему постоянному проекту, а не простое бытовое напоминание.",
  "- Создавай её через automation(action=create) только при явном временном намерении пользователя: позже, завтра, регулярно, каждый день и похожем.",
  "- Каждая автоматизация обязана принадлежать проекту. Если постоянного проекта ещё нет, сначала создай его через project(action=create), но не создавай проекты для одноразовых бытовых напоминаний.",
  "- name — 2–4 слова; description подробно и понятно объясняет работу и когда пользователь получит сообщение; instruction полностью самостоятельна и не полагается на историю текущего диалога.",
  "- Передавай только технические поля расписания: понятное русское описание Коди построит из них сам.",
  "- Результат всегда возвращается в Telegram-диалог, где автоматизация была создана; не спрашивай место доставки.",
  "- Чтобы изменить, остановить или удалить существующую автоматизацию, сначала вызови list и используй точный id.",
].join("\n");

export const AUTOMATION_DYNAMIC_TOOL: DynamicToolSpec = {
  type: "function",
  name: "automation",
  description: [
    "Создаёт и обслуживает отложенную или регулярную агентскую работу Коди по конкретному проекту.",
    "Результат всегда возвращается в исходный Telegram-диалог.",
    "Действия: create, list, update, pause, resume, run, remove.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "list", "update", "pause", "resume", "run", "remove"] },
      automation_id: { type: "string" },
      project_id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      instruction: { type: "string" },
      schedule_type: { type: "string", enum: ["once", "interval", "cron"] },
      run_at: { type: "string", description: "ISO 8601 с часовым поясом для once." },
      every_minutes: { type: "integer", minimum: 1, description: "Интервал в минутах; минимальная частота задаётся конфигурацией Коди." },
      cron_expression: { type: "string", description: "Стандартное cron-выражение из пяти полей." },
      timezone: { type: "string", description: "IANA timezone, например Europe/Moscow." },
      repeat_limit: { type: "integer", minimum: 0, description: "0 означает без ограничения." },
      include_completed: { type: "boolean" },
      confirm_run: { type: "boolean", description: "Подтверждение дополнительного запуска рядом с ближайшим плановым." },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export interface AutomationToolRuntimeOptions {
  store: AutomationStore;
  scheduler: Pick<AutomationScheduler, "wake" | "runNow">;
  projectStore: ProjectStore;
  resolveContext: (threadId: string) => { contextKey: TelegramContextKey } | undefined;
  defaultTimezone: string;
}

export class AutomationToolRuntime {
  constructor(private readonly options: AutomationToolRuntimeOptions) {}

  async handle(params: DynamicToolCallParams): Promise<DynamicToolCallResult> {
    const args = asRecord(params.arguments);
    const action = readString(args, "action");
    try {
      if (action === "create") return this.create(params.threadId, args);
      if (action === "list") return this.list(args);
      const automationId = readString(args, "automation_id");
      if (!automationId) return result(false, { success: false, error: "Нужен automation_id" });
      if (action === "update") return this.update(automationId, args);
      if (action === "pause") {
        return result(true, { success: true, automation: publicAutomation(this.options.store.pause(automationId)) });
      }
      if (action === "resume") {
        const automation = this.options.store.resume(automationId);
        this.options.scheduler.wake();
        return result(true, { success: true, automation: publicAutomation(automation) });
      }
      if (action === "run") {
        const current = this.options.store.require(automationId);
        if (needsRunConfirmation(current) && readBoolean(args, "confirm_run") !== true) {
          return result(true, {
            success: true,
            requires_confirmation: true,
            automation: publicAutomation(current),
            message: "Ближайший плановый запуск меньше чем через 30 минут. Уточни, нужен ли дополнительный запуск; расписание не изменится.",
          });
        }
        const claim = this.options.scheduler.runNow(automationId);
        return result(true, {
          success: true,
          started: true,
          automation: publicAutomation(claim.automation),
          message: "Автоматизация запущена в фоне. Результат придёт в этот диалог.",
        });
      }
      if (action === "remove") {
        const removed = this.options.store.remove(automationId);
        return result(true, { success: true, removed: publicAutomation(removed) });
      }
      return result(false, { success: false, error: `Неизвестное действие: ${action ?? "пусто"}` });
    } catch (error) {
      return result(false, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async create(threadId: string, args: Record<string, unknown>): Promise<DynamicToolCallResult> {
    const projectId = readString(args, "project_id");
    const name = readString(args, "name");
    const description = readString(args, "description");
    const instruction = readString(args, "instruction");
    if (!projectId || !name || !description || !instruction) {
      return result(false, {
        success: false,
        error: "Для create нужны project_id, name, description и instruction",
      });
    }
    const project = await this.options.projectStore.get(projectId);
    if (!project) {
      const projects = await this.options.projectStore.list();
      return result(false, {
        success: false,
        error: `Проект «${projectId}» не найден. Сначала создай постоянный проект или выбери существующий.`,
        projects: projects.map(({ id, name: projectName }) => ({ id, name: projectName })),
      });
    }
    const origin = this.options.resolveContext(threadId);
    if (!origin) {
      return result(false, { success: false, error: "Не удалось определить исходный Telegram-диалог" });
    }
    const parsed = parseContextKey(origin.contextKey);
    const existingIds = new Set(
      this.options.store.list({ projectId, includeCompleted: true }).map((item) => item.id),
    );
    const automation = this.options.store.create({
      projectId,
      name,
      description,
      instruction,
      schedule: requireSchedule(args, this.options.defaultTimezone),
      repeatLimit: readRepeatLimit(args),
      contextKey: origin.contextKey,
      chatId: parsed.chatId,
      messageThreadId: parsed.messageThreadId,
    });
    this.options.scheduler.wake();
    const duplicate = existingIds.has(automation.id);
    return result(true, {
      success: true,
      done: true,
      created: !duplicate,
      duplicate,
      automation: publicAutomation(automation),
      message: duplicate
        ? "Такая автоматизация уже существует; повторная копия не создана."
        : "Автоматизация создана. Результаты будут приходить в этот диалог.",
    });
  }

  private list(args: Record<string, unknown>): DynamicToolCallResult {
    const automations = this.options.store.list({
      projectId: readString(args, "project_id"),
      includeCompleted: readBoolean(args, "include_completed") ?? false,
    });
    return result(true, {
      success: true,
      count: automations.length,
      automations: automations.map(publicAutomation),
    });
  }

  private update(automationId: string, args: Record<string, unknown>): DynamicToolCallResult {
    const input: UpdateAutomationInput = {};
    const name = readString(args, "name");
    const description = readString(args, "description");
    const instruction = readString(args, "instruction");
    if (name) input.name = name;
    if (description) input.description = description;
    if (instruction) input.instruction = instruction;
    if (readString(args, "schedule_type")) {
      input.schedule = requireSchedule(args, this.options.defaultTimezone);
    }
    if (Object.hasOwn(args, "repeat_limit")) input.repeatLimit = readRepeatLimit(args);
    if (Object.keys(input).length === 0) {
      return result(false, { success: false, error: "Не указано, что изменить" });
    }
    const automation = this.options.store.update(automationId, input);
    this.options.scheduler.wake();
    return result(true, { success: true, automation: publicAutomation(automation) });
  }
}

function requireSchedule(args: Record<string, unknown>, defaultTimezone: string): AutomationSchedule {
  const type = readString(args, "schedule_type");
  if (type === "once") {
    const at = readString(args, "run_at");
    if (!at) throw new Error("Для once нужен run_at в ISO 8601 с часовым поясом");
    return { kind: "once", at };
  }
  if (type === "interval") {
    const everyMinutes = readNumber(args, "every_minutes");
    if (everyMinutes === undefined) throw new Error("Для interval нужен every_minutes");
    return { kind: "interval", everyMinutes };
  }
  if (type === "cron") {
    const expression = readString(args, "cron_expression");
    if (!expression) throw new Error("Для cron нужен cron_expression");
    return {
      kind: "cron",
      expression,
      timezone: readString(args, "timezone") ?? defaultTimezone,
    };
  }
  throw new Error("Нужен schedule_type: once, interval или cron");
}

function readRepeatLimit(args: Record<string, unknown>): number | null | undefined {
  const value = args.repeat_limit;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("repeat_limit должен быть целым неотрицательным числом");
  }
  return value === 0 ? null : value;
}

function publicAutomation(automation: ReturnType<AutomationStore["require"]>): Record<string, unknown> {
  return {
    id: automation.id,
    project_id: automation.projectId,
    name: automation.name,
    description: automation.description,
    schedule: automation.scheduleDescription,
    state: automation.state,
    next_run_at: automation.nextRunAt ?? null,
    last_run_at: automation.lastRunAt ?? null,
    last_status: automation.lastStatus ?? null,
    run_count: automation.runCount,
    repeat_limit: automation.repeatLimit,
  };
}

function result(success: boolean, value: unknown): DynamicToolCallResult {
  return { success, text: JSON.stringify(value, null, 2) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key].trim() || undefined : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" && Number.isFinite(record[key])
    ? record[key]
    : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function needsRunConfirmation(automation: ReturnType<AutomationStore["require"]>, now = new Date()): boolean {
  if (automation.state !== "scheduled" || !automation.nextRunAt) return false;
  return new Date(automation.nextRunAt).getTime() - now.getTime() <= 30 * 60_000;
}
