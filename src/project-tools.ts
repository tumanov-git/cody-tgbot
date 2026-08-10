import type {
  DynamicToolCallParams,
  DynamicToolCallResult,
  DynamicToolSpec,
} from "./codex-app-server.js";
import {
  ProjectStore,
  type ProjectMemoryOperation,
  type ProjectMemoryResult,
} from "./project-store.js";

export interface ProjectAvatarScheduler {
  schedule(projectId: string): void;
}

const MAX_MEMORY_FAILURES_PER_TURN = 3;

export const PROJECT_DEVELOPER_INSTRUCTIONS = [
  "Внутренний реестр проектов Коди:",
  "- Если в текущем ходе создан новый постоянный продукт со своей рабочей папкой и предполагается, что к нему ещё вернутся, перед финальным ответом зарегистрируй его через project(action=create).",
  "- Не регистрируй идеи, исследования, временные файлы, тестовые песочницы и одноразовые скрипты.",
  "- Если продукт уже зарегистрирован, create безопасно вернёт существующую карточку без дубля.",
  "- При create передай avatar_brief: одно короткое визуальное объяснение, что Коди мог бы физически делать в мире этого продукта. Не пиши художественный промпт — сюжет придумает отдельная модель.",
  "- project_memory хранит только устойчивые продуктовые решения, ограничения и договорённости. Не сохраняй туда ход задачи, логи, выполненную работу и временные TODO.",
].join("\n");

export const PROJECT_DYNAMIC_TOOLS: DynamicToolSpec[] = [
  {
    type: "function",
    name: "project",
    description: [
      "Создаёт или обновляет внутреннюю карточку постоянного продукта Коди.",
      "Вызывай create только после появления реального продукта с собственной существующей рабочей папкой.",
      "Не создавай карточки для идей, исследований, временных экспериментов и одноразовых скриптов.",
      "Повторный create для той же папки идемпотентен и не создаёт дубль.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update"] },
        id: {
          type: "string",
          description: "Стабильный slug: латиница, цифры и дефисы, до 48 символов.",
        },
        name: { type: "string", description: "Короткое человеческое название." },
        description: { type: "string", description: "Одно короткое описание пользы продукта." },
        workspace: { type: "string", description: "Абсолютный путь существующей рабочей папки." },
        services: { type: "array", items: { type: "string" } },
        urls: { type: "array", items: { type: "string" } },
        avatar_brief: {
          type: "string",
          description: "Короткая визуальная суть продукта для автоматической аватарки Коди.",
        },
      },
      required: ["action", "id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "project_memory",
    description: [
      "Обновляет короткую долговременную память конкретного проекта.",
      "Делай все связанные изменения одним атомарным operations batch.",
      "Сохраняй только устойчивые решения, ограничения и предпочтения, которые понадобятся в будущих обсуждениях.",
      "При переполнении тем же batch удали или сократи менее важные записи. Успешный вызов не повторяй.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        operations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "replace", "remove"] },
              content: { type: "string", description: "Новая запись для add/replace." },
              old_text: {
                type: "string",
                description: "Короткий уникальный фрагмент записи для replace/remove.",
              },
            },
            required: ["action"],
            additionalProperties: false,
          },
        },
      },
      required: ["project_id", "operations"],
      additionalProperties: false,
    },
  },
];

export class ProjectToolRuntime {
  private readonly memoryFailures = new Map<string, number>();

  constructor(
    private readonly store: ProjectStore,
    private readonly avatarScheduler?: ProjectAvatarScheduler,
  ) {}

  async handle(params: DynamicToolCallParams): Promise<DynamicToolCallResult> {
    if (params.tool === "project") return this.handleProject(params.arguments);
    if (params.tool === "project_memory") {
      return this.handleMemory(params.turnId, params.arguments);
    }
    return toolResult(false, { success: false, error: `Неизвестный инструмент: ${params.tool}` });
  }

  private async handleProject(raw: unknown): Promise<DynamicToolCallResult> {
    const args = asRecord(raw);
    const action = readString(args, "action");
    const id = readString(args, "id");
    if (!id || (action !== "create" && action !== "update")) {
      return toolResult(false, { success: false, error: "Нужны корректные action и id" });
    }

    try {
      if (action === "create") {
        const name = readString(args, "name");
        const description = readString(args, "description");
        const workspace = readString(args, "workspace");
        if (!name || !description || !workspace) {
          return toolResult(false, {
            success: false,
            error: "Для create обязательны name, description и workspace",
          });
        }
        const result = await this.store.create({
          id,
          name,
          description,
          workspace,
          services: readStringArray(args, "services"),
          urls: readStringArray(args, "urls"),
          avatarBrief: readString(args, "avatar_brief"),
        });
        if (result.created) this.avatarScheduler?.schedule(result.project.id);
        return toolResult(true, {
          success: true,
          done: true,
          created: result.created,
          project: result.project,
          message: result.created
            ? "Проект зарегистрирован и появился в меню «Мои проекты». Аватар создаётся в фоне."
            : "Проект с этой рабочей папкой уже зарегистрирован. Дубль не создан.",
        });
      }

      const project = await this.store.update({
        id,
        ...(readString(args, "name") ? { name: readString(args, "name") } : {}),
        ...(readString(args, "description")
          ? { description: readString(args, "description") }
          : {}),
        ...(readString(args, "workspace") ? { workspace: readString(args, "workspace") } : {}),
        ...(Object.hasOwn(args, "services") ? { services: readStringArray(args, "services") } : {}),
        ...(Object.hasOwn(args, "urls") ? { urls: readStringArray(args, "urls") } : {}),
      });
      return toolResult(true, {
        success: true,
        done: true,
        project,
        message: "Карточка проекта обновлена.",
      });
    } catch (error) {
      return toolResult(false, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleMemory(turnId: string, raw: unknown): Promise<DynamicToolCallResult> {
    const args = asRecord(raw);
    const projectId = readString(args, "project_id");
    const rawOperations = args.operations;
    if (!projectId || !Array.isArray(rawOperations)) {
      return toolResult(false, { success: false, error: "Нужны project_id и operations" });
    }
    const operations = rawOperations.map((rawOperation): ProjectMemoryOperation => {
      const operation = asRecord(rawOperation);
      return {
        action: readString(operation, "action") as ProjectMemoryOperation["action"],
        ...(readString(operation, "content") ? { content: readString(operation, "content") } : {}),
        ...(readString(operation, "old_text") ? { oldText: readString(operation, "old_text") } : {}),
      };
    });

    let result: ProjectMemoryResult;
    try {
      result = await this.store.applyMemory(projectId, operations);
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        usage: "unknown",
      };
    }
    if (result.success) {
      this.memoryFailures.delete(turnId);
      return toolResult(true, result);
    }
    if (result.retryable) {
      if (this.memoryFailures.size > 500) this.memoryFailures.clear();
      const failures = (this.memoryFailures.get(turnId) ?? 0) + 1;
      this.memoryFailures.set(turnId, failures);
      if (failures >= MAX_MEMORY_FAILURES_PER_TURN) {
        this.memoryFailures.delete(turnId);
        return toolResult(false, {
          success: false,
          done: true,
          error: "Не удалось обновить память за три попытки. Не вызывай инструмент снова в этом ходе; продолжи ответ пользователю.",
          usage: result.usage,
        });
      }
    }
    return toolResult(false, result);
  }
}

function toolResult(success: boolean, value: unknown): DynamicToolCallResult {
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

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}
