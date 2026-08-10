import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { InlineKeyboard } from "grammy";

import type {
  DynamicToolCallParams,
  DynamicToolCallResult,
  DynamicToolSpec,
} from "./codex-app-server.js";
import type { TelegramContextKey } from "./context-key.js";
import { parseContextKey } from "./context-key.js";
import { ProjectStore } from "./project-store.js";

export const MANAGED_BOT_DEVELOPER_INSTRUCTIONS = [
  "Создание Telegram-ботов:",
  "- Когда для зарегистрированного проекта нужен новый Telegram-бот, используй request_managed_bot.",
  "- Сначала зарегистрируй проект через project(action=create), затем передай его project_id.",
  "- Не проси пользователя создавать бота через BotFather и не проси присылать токен в чат.",
  "- После успешного вызова закончи ответ короткой просьбой нажать прикреплённую кнопку «Создать бота».",
  "- Не вставляй ссылку создания бота в текст: приложение само прикрепит синюю inline-кнопку.",
].join("\n");

export const MANAGED_BOT_DYNAMIC_TOOL: DynamicToolSpec = {
  type: "function",
  name: "request_managed_bot",
  description: [
    "Готовит нативное создание Telegram-бота пользователем и прикрепляет к финальному ответу кнопку «Создать бота».",
    "Вызывай только для уже зарегистрированного постоянного проекта, которому действительно нужен отдельный бот.",
    "Не проси токен и не показывай пользователю техническую ссылку.",
    "После подтверждения Telegram приложение безопасно сохранит токен и автоматически продолжит этот диалог.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "ID существующего проекта из внутреннего реестра Коди.",
      },
      suggested_name: {
        type: "string",
        description: "Предлагаемое отображаемое имя бота, до 64 символов.",
      },
      suggested_username: {
        type: "string",
        description: "Предлагаемый username без @, заканчивается на bot.",
      },
    },
    required: ["project_id", "suggested_name", "suggested_username"],
    additionalProperties: false,
  },
};

interface ManagedBotApi {
  getMe(): Promise<{ username: string; can_manage_bots: boolean }>;
  getManagedBotToken(userId: number): Promise<string>;
  editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    options: { reply_markup: InlineKeyboard },
  ): Promise<unknown>;
}

interface ManagedBotContext {
  contextKey: TelegramContextKey;
}

export interface ManagedBotFinalAction {
  requestId: string;
  keyboard: InlineKeyboard;
}

export interface ManagedBotCompletion {
  requestId: string;
  projectId: string;
  projectName: string;
  contextKey: TelegramContextKey;
  chatId: number;
  threadId: string;
  botId: number;
  botUsername?: string;
  secretFilePath: string;
  buttonMessageId?: number;
}

export interface ManagedBotUpdate {
  user: { id: number };
  bot: { id: number; username?: string };
}

type ManagedBotRequestStatus = "awaiting_delivery" | "awaiting_creation";

interface ManagedBotRequest {
  id: string;
  projectId: string;
  threadId: string;
  contextKey: TelegramContextKey;
  ownerUserId: number;
  suggestedName: string;
  suggestedUsername: string;
  createUrl: string;
  status: ManagedBotRequestStatus;
  createdAt: string;
  deliveredAt?: string;
  buttonMessageId?: number;
}

interface StoredManagedBots {
  requests: ManagedBotRequest[];
}

export interface ManagedBotServiceOptions {
  rootDirectory: string;
  api: ManagedBotApi;
  projectStore: ProjectStore;
  resolveContext: (threadId: string) => ManagedBotContext | undefined;
}

export class ManagedBotService {
  private readonly rootDirectory: string;
  private readonly statePath: string;
  private readonly secretsDirectory: string;
  private requests: ManagedBotRequest[] = [];
  private loaded = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ManagedBotServiceOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.statePath = path.join(this.rootDirectory, "requests.json");
    this.secretsDirectory = path.join(this.rootDirectory, "secrets");
  }

  async handleTool(params: DynamicToolCallParams): Promise<DynamicToolCallResult> {
    if (params.tool !== "request_managed_bot") {
      return toolResult(false, { success: false, error: `Неизвестный инструмент: ${params.tool}` });
    }

    const args = asRecord(params.arguments);
    const projectId = readString(args, "project_id");
    const suggestedName = readString(args, "suggested_name");
    const suggestedUsername = normalizeUsername(readString(args, "suggested_username"));
    if (!projectId || !suggestedName || !suggestedUsername) {
      return toolResult(false, {
        success: false,
        error: "Нужны project_id, suggested_name и корректный suggested_username, заканчивающийся на bot",
      });
    }
    if (suggestedName.length > 64) {
      return toolResult(false, { success: false, error: "suggested_name длиннее 64 символов" });
    }

    try {
      const project = await this.options.projectStore.get(projectId);
      if (!project) {
        return toolResult(false, { success: false, error: `Проект «${projectId}» не найден` });
      }
      const context = this.options.resolveContext(params.threadId);
      if (!context) {
        return toolResult(false, { success: false, error: "Не удалось связать Codex-тред с Telegram-диалогом" });
      }
      const { chatId, messageThreadId } = parseContextKey(context.contextKey);
      if (!Number.isSafeInteger(chatId) || messageThreadId !== undefined) {
        return toolResult(false, {
          success: false,
          error: "Managed Bots можно создавать только в личном диалоге с Коди",
        });
      }

      const me = await this.options.api.getMe();
      if (!me.can_manage_bots) {
        return toolResult(false, {
          success: false,
          error: "У Коди не включён Bot Management Mode в BotFather",
        });
      }

      const { request, superseded } = await this.withMutationLock(async () => {
        await this.ensureLoaded();
        const superseded = this.requests.filter((entry) => entry.ownerUserId === chatId);
        const supersededIds = new Set(superseded.map((entry) => entry.id));
        this.requests = this.requests.filter((entry) => !supersededIds.has(entry.id));

        const created: ManagedBotRequest = {
          id: randomUUID(),
          projectId: project.id,
          threadId: params.threadId,
          contextKey: context.contextKey,
          ownerUserId: chatId,
          suggestedName,
          suggestedUsername,
          createUrl: buildCreateUrl(me.username, suggestedUsername, suggestedName),
          status: "awaiting_delivery",
          createdAt: new Date().toISOString(),
        };
        this.requests.push(created);
        await this.persist();
        return { request: created, superseded };
      });

      await Promise.all(superseded.flatMap((entry) => (
        entry.buttonMessageId
          ? [this.options.api.editMessageReplyMarkup(entry.ownerUserId, entry.buttonMessageId, {
              reply_markup: new InlineKeyboard(),
            }).catch((error) => {
              console.warn(`Failed to remove superseded managed-bot button ${entry.id}:`, error);
            })]
          : []
      )));

      return toolResult(true, {
        success: true,
        done: true,
        awaiting_user: true,
        project_id: project.id,
        suggested_username: request.suggestedUsername,
        message: "Запрос подготовлен. Заверши ответ и попроси пользователя нажать прикреплённую кнопку «Создать бота».",
      });
    } catch (error) {
      return toolResult(false, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async prepareFinalAction(threadId: string): Promise<ManagedBotFinalAction | undefined> {
    await this.ensureLoaded();
    const request = [...this.requests]
      .reverse()
      .find((entry) => entry.threadId === threadId && entry.status === "awaiting_delivery");
    if (!request) return undefined;
    return {
      requestId: request.id,
      keyboard: new InlineKeyboard().url(
        { text: "＋ Создать бота", style: "primary" },
        request.createUrl,
      ),
    };
  }

  async markDelivered(requestId: string, messageId: number): Promise<void> {
    await this.withMutationLock(async () => {
      await this.ensureLoaded();
      const request = this.requests.find((entry) => entry.id === requestId);
      if (!request) return;
      request.status = "awaiting_creation";
      request.deliveredAt = new Date().toISOString();
      request.buttonMessageId = messageId;
      await this.persist();
    });
  }

  async complete(update: ManagedBotUpdate): Promise<ManagedBotCompletion | undefined> {
    return this.withMutationLock(async () => {
      await this.ensureLoaded();
      const candidates = this.requests.filter((entry) => (
        entry.ownerUserId === update.user.id
      ));
      const updateUsername = update.bot.username?.toLowerCase();
      const request = updateUsername
        ? candidates.find((entry) => entry.suggestedUsername.toLowerCase() === updateUsername)
        : undefined;
      if (!request) return undefined;

      const project = await this.options.projectStore.get(request.projectId);
      if (!project) throw new Error(`Проект «${request.projectId}» больше не существует`);
      const token = await this.options.api.getManagedBotToken(update.bot.id);
      const secretFilePath = await this.writeSecretFile(
        request.projectId,
        token,
        update.bot.id,
        update.bot.username,
      );
      const username = update.bot.username;
      await this.options.projectStore.update({
        id: project.id,
        services: unique([
          ...project.services,
          ...(username ? [`telegram:@${username}`] : [`telegram-bot:${update.bot.id}`]),
        ]),
        urls: unique([
          ...project.urls,
          ...(username ? [`https://t.me/${username}`] : []),
        ]),
      });

      this.requests = this.requests.filter((entry) => entry.id !== request.id);
      await this.persist();

      return {
        requestId: request.id,
        projectId: project.id,
        projectName: project.name,
        contextKey: request.contextKey,
        chatId: request.ownerUserId,
        threadId: request.threadId,
        botId: update.bot.id,
        ...(username ? { botUsername: username } : {}),
        secretFilePath,
        ...(request.buttonMessageId ? { buttonMessageId: request.buttonMessageId } : {}),
      };
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredManagedBots>;
      this.requests = Array.isArray(parsed.requests)
        ? parsed.requests.flatMap(parseStoredRequest)
        : [];
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.requests = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await atomicWrite(
      this.statePath,
      `${JSON.stringify({ requests: this.requests } satisfies StoredManagedBots, null, 2)}\n`,
    );
  }

  private async writeSecretFile(
    projectId: string,
    token: string,
    botId: number,
    username?: string,
  ): Promise<string> {
    await mkdir(this.secretsDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.secretsDirectory, 0o700);
    const projectDirectory = path.join(this.secretsDirectory, projectId);
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
    await chmod(projectDirectory, 0o700);
    const target = path.join(projectDirectory, `${botId}.env`);
    const contents = [
      "# Managed by cody-tgbot. Do not print or commit this file.",
      `TELEGRAM_BOT_TOKEN=${token}`,
      `TELEGRAM_BOT_ID=${botId}`,
      ...(username ? [`TELEGRAM_BOT_USERNAME=${username}`] : []),
      "",
    ].join("\n");
    await atomicWrite(target, contents);
    await chmod(target, 0o600);
    return target;
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function buildCreateUrl(managerUsername: string, username: string, name: string): string {
  const manager = managerUsername.replace(/^@/, "");
  const params = new URLSearchParams({ name });
  return `https://t.me/newbot/${encodeURIComponent(manager)}/${encodeURIComponent(username)}?${params}`;
}

function normalizeUsername(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^@/, "");
  if (!normalized || !/^[a-z][a-z0-9_]{1,28}bot$/i.test(normalized)) return undefined;
  return normalized;
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function toolResult(success: boolean, value: unknown): DynamicToolCallResult {
  return { success, text: JSON.stringify(value) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseStoredRequest(value: unknown): ManagedBotRequest[] {
  const entry = asRecord(value);
  const id = readString(entry, "id");
  const projectId = readString(entry, "projectId");
  const threadId = readString(entry, "threadId");
  const contextKey = readString(entry, "contextKey");
  const suggestedName = readString(entry, "suggestedName");
  const suggestedUsername = normalizeUsername(readString(entry, "suggestedUsername"));
  const createUrl = readString(entry, "createUrl");
  const createdAt = readString(entry, "createdAt");
  const ownerUserId = entry.ownerUserId;
  const status = entry.status;
  if (
    !id
    || !projectId
    || !threadId
    || !contextKey
    || !suggestedName
    || !suggestedUsername
    || !createUrl
    || !createdAt
    || !Number.isSafeInteger(ownerUserId)
    || (status !== "awaiting_delivery" && status !== "awaiting_creation")
  ) {
    return [];
  }

  const deliveredAt = readString(entry, "deliveredAt");
  const buttonMessageId = entry.buttonMessageId;
  return [{
    id,
    projectId,
    threadId,
    contextKey,
    ownerUserId: ownerUserId as number,
    suggestedName,
    suggestedUsername,
    createUrl,
    status,
    createdAt,
    ...(deliveredAt ? { deliveredAt } : {}),
    ...(Number.isSafeInteger(buttonMessageId) ? { buttonMessageId: buttonMessageId as number } : {}),
  }];
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
