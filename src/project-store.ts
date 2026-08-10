import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { requireWithinAnyDirectory } from "./security.js";

const MEMORY_DELIMITER = "\n§\n";
const DEFAULT_MEMORY_LIMIT = 3_500;
const MAX_MEMORY_OPERATIONS = 20;

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  workspace: string;
  services: string[];
  urls: string[];
  avatar?: ProjectAvatar;
  createdAt: string;
  updatedAt: string;
}

type ProjectAvatarStatus = "pending" | "generating" | "ready" | "failed";

interface ProjectAvatar {
  status: ProjectAvatarStatus;
  brief?: string;
  scene?: string;
  prompt?: string;
  error?: string;
  telegramFileId?: string;
  version: number;
  updatedAt: string;
}

export interface CreateProjectInput {
  id: string;
  name: string;
  description: string;
  workspace: string;
  services?: string[];
  urls?: string[];
  avatarBrief?: string;
}

export interface UpdateProjectInput {
  id: string;
  name?: string;
  description?: string;
  workspace?: string;
  services?: string[];
  urls?: string[];
}

export interface UpdateProjectAvatarInput {
  status?: ProjectAvatarStatus;
  brief?: string;
  scene?: string;
  prompt?: string;
  error?: string | null;
  telegramFileId?: string | null;
  version?: number;
}

export interface ProjectMemoryOperation {
  action: "add" | "replace" | "remove";
  content?: string;
  oldText?: string;
}

export interface ProjectMemoryResult {
  success: boolean;
  done?: boolean;
  message?: string;
  error?: string;
  currentEntries?: string[];
  usage: string;
  entryCount?: number;
  retryable?: boolean;
}

export interface ProjectStoreOptions {
  rootDirectory: string;
  approvedDirectories: string[];
  memoryCharLimit?: number;
}

export class ProjectStore {
  private readonly rootDirectory: string;
  private readonly approvedDirectories: string[];
  private readonly memoryCharLimit: number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: ProjectStoreOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.approvedDirectories = options.approvedDirectories.map((entry) => path.resolve(entry));
    this.memoryCharLimit = options.memoryCharLimit ?? DEFAULT_MEMORY_LIMIT;
  }

  async list(): Promise<ProjectRecord[]> {
    return (await this.listWithIssues()).projects;
  }

  async listWithIssues(): Promise<{ projects: ProjectRecord[]; unreadableIds: string[] }> {
    await mkdir(this.rootDirectory, { recursive: true });
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });
    const unreadableIds: string[] = [];
    const projects = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && isProjectId(entry.name))
      .map((entry) => this.readProject(entry.name).catch((error) => {
        unreadableIds.push(entry.name);
        console.warn(
          `Failed to read project ${entry.name}:`,
          error instanceof Error ? error.message : String(error),
        );
        return null;
      })));
    return {
      projects: projects
      .filter((project): project is ProjectRecord => project !== null)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      unreadableIds: unreadableIds.sort(),
    };
  }

  async get(id: string): Promise<ProjectRecord | null> {
    assertProjectId(id);
    return this.readProject(id).catch((error) => {
      if (isNotFound(error)) return null;
      throw error;
    });
  }

  async create(input: CreateProjectInput): Promise<{ created: boolean; project: ProjectRecord }> {
    return this.withMutationLock(async () => {
      const id = normalizeProjectId(input.id);
      const workspace = await this.validateWorkspace(input.workspace);
      const existingProjects = await this.list();
      const sameWorkspace = existingProjects.find((project) => project.workspace === workspace);
      if (sameWorkspace) {
        return { created: false, project: sameWorkspace };
      }
      const sameId = existingProjects.find((project) => project.id === id);
      if (sameId) {
        throw new Error(`Проект с id «${id}» уже существует в другой рабочей папке`);
      }

      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id,
        name: boundedText(input.name, "name", 80),
        description: boundedText(input.description, "description", 500),
        workspace,
        services: normalizeStringList(input.services, "services", 20, 120),
        urls: normalizeUrls(input.urls),
        avatar: {
          status: "pending",
          ...(input.avatarBrief
            ? { brief: boundedText(input.avatarBrief, "avatarBrief", 500) }
            : {}),
          version: 1,
          updatedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      };
      await mkdir(this.projectDirectory(id), { recursive: true });
      await this.writeProject(project);
      await atomicWrite(this.memoryPath(id), "");
      return { created: true, project };
    });
  }

  async update(input: UpdateProjectInput): Promise<ProjectRecord> {
    return this.withMutationLock(async () => {
      const id = normalizeProjectId(input.id);
      const current = await this.get(id);
      if (!current) throw new Error(`Проект «${id}» не найден`);
      const next: ProjectRecord = {
        ...current,
        ...(input.name !== undefined ? { name: boundedText(input.name, "name", 80) } : {}),
        ...(input.description !== undefined
          ? { description: boundedText(input.description, "description", 500) }
          : {}),
        ...(input.workspace !== undefined
          ? { workspace: await this.validateWorkspace(input.workspace) }
          : {}),
        ...(input.services !== undefined
          ? { services: normalizeStringList(input.services, "services", 20, 120) }
          : {}),
        ...(input.urls !== undefined ? { urls: normalizeUrls(input.urls) } : {}),
        updatedAt: new Date().toISOString(),
      };
      const collision = (await this.list()).find(
        (project) => project.id !== id && project.workspace === next.workspace,
      );
      if (collision) {
        throw new Error(`Рабочая папка уже принадлежит проекту «${collision.name}»`);
      }
      await this.writeProject(next);
      return next;
    });
  }

  async readMemory(id: string): Promise<string[]> {
    assertProjectId(id);
    try {
      const raw = await readFile(this.memoryPath(id), "utf8");
      return parseMemory(raw);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async updateAvatar(id: string, input: UpdateProjectAvatarInput): Promise<ProjectRecord> {
    return this.withMutationLock(async () => {
      assertProjectId(id);
      const current = await this.get(id);
      if (!current) throw new Error(`Проект «${id}» не найден`);
      const now = new Date().toISOString();
      const previous = current.avatar ?? {
        status: "pending" as const,
        version: 1,
        updatedAt: now,
      };
      const avatar: ProjectAvatar = {
        ...previous,
        ...(input.status ? { status: input.status } : {}),
        ...(input.brief !== undefined
          ? { brief: boundedText(input.brief, "avatarBrief", 500) }
          : {}),
        ...(input.scene !== undefined
          ? { scene: boundedText(input.scene, "avatarScene", 1_000) }
          : {}),
        ...(input.prompt !== undefined
          ? { prompt: boundedText(input.prompt, "avatarPrompt", 8_000) }
          : {}),
        ...(input.version !== undefined ? { version: positiveInteger(input.version, "avatarVersion") } : {}),
        updatedAt: now,
      };
      if (input.error === null) delete avatar.error;
      else if (input.error !== undefined) avatar.error = boundedText(input.error, "avatarError", 500);
      if (input.telegramFileId === null) delete avatar.telegramFileId;
      else if (input.telegramFileId !== undefined) {
        avatar.telegramFileId = boundedText(input.telegramFileId, "telegramFileId", 500);
      }
      const next = { ...current, avatar, updatedAt: now };
      await this.writeProject(next);
      return next;
    });
  }

  avatarDirectory(id: string): string {
    assertProjectId(id);
    return path.join(this.projectDirectory(id), "avatar");
  }

  avatarOriginalPath(id: string): string {
    return path.join(this.avatarDirectory(id), "original.png");
  }

  avatarTelegramPath(id: string): string {
    return path.join(this.avatarDirectory(id), "telegram.jpg");
  }

  async hasTelegramAvatar(id: string): Promise<boolean> {
    assertProjectId(id);
    try {
      return (await stat(this.avatarTelegramPath(id))).isFile();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async applyMemory(id: string, operations: ProjectMemoryOperation[]): Promise<ProjectMemoryResult> {
    return this.withMutationLock(async () => {
      assertProjectId(id);
      if (!(await this.get(id))) {
        return this.memoryError([], `Проект «${id}» не найден`, false);
      }
      if (!Array.isArray(operations) || operations.length === 0) {
        return this.memoryError(await this.readMemory(id), "Список operations пуст", false);
      }
      if (operations.length > MAX_MEMORY_OPERATIONS) {
        return this.memoryError(
          await this.readMemory(id),
          `За один вызов разрешено не больше ${MAX_MEMORY_OPERATIONS} операций`,
          false,
        );
      }

      const current = await this.readMemory(id);
      const working = [...current];
      for (const [index, operation] of operations.entries()) {
        const position = `Операция ${index + 1}`;
        if (!operation || !["add", "replace", "remove"].includes(operation.action)) {
          return this.memoryError(current, `${position}: неизвестное действие`, true);
        }
        const content = operation.content?.trim() ?? "";
        const oldText = operation.oldText?.trim() ?? "";

        if (operation.action === "add") {
          if (!content) return this.memoryError(current, `${position}: content обязателен`, true);
          if (!working.includes(content)) working.push(content);
          continue;
        }

        if (!oldText) return this.memoryError(current, `${position}: old_text обязателен`, true);
        const matches = working
          .map((entry, entryIndex) => ({ entry, entryIndex }))
          .filter(({ entry }) => entry.includes(oldText));
        if (matches.length === 0) {
          return this.memoryError(current, `${position}: запись по old_text не найдена`, true);
        }
        if (new Set(matches.map(({ entry }) => entry)).size > 1) {
          return this.memoryError(current, `${position}: old_text совпал с несколькими записями`, true);
        }
        const targetIndex = matches[0]!.entryIndex;
        if (operation.action === "remove") {
          working.splice(targetIndex, 1);
        } else {
          if (!content) return this.memoryError(current, `${position}: content обязателен`, true);
          working[targetIndex] = content;
        }
      }

      const deduplicated = [...new Set(working.map((entry) => entry.trim()).filter(Boolean))];
      const serialized = serializeMemory(deduplicated);
      if (serialized.length > this.memoryCharLimit) {
        return this.memoryError(
          current,
          `Итоговая память занимает ${serialized.length}/${this.memoryCharLimit} символов. Удали или сократи старые записи в том же batch`,
          true,
        );
      }

      await atomicWrite(this.memoryPath(id), serialized);
      const project = await this.get(id);
      if (project) {
        await this.writeProject({ ...project, updatedAt: new Date().toISOString() });
      }
      return {
        success: true,
        done: true,
        message: "Память проекта обновлена. Не повторяй этот вызов.",
        usage: `${serialized.length}/${this.memoryCharLimit}`,
        entryCount: deduplicated.length,
      };
    });
  }

  async renderDiscussionContext(id: string): Promise<string> {
    return this.renderProjectContext(
      id,
      "КОНТЕКСТ ОБСУЖДАЕМОГО ПРОЕКТА",
      "Это снимок данных, подмешанный приложением при создании обычного диалога. Диалог не принадлежит проекту.",
      "Если в обсуждении появится устойчивое продуктовое решение, ограничение или договорённость, обнови эту память через project_memory. Не сохраняй ход задачи, логи и временные TODO.",
    );
  }

  async renderAutomationContext(id: string): Promise<string> {
    return this.renderProjectContext(
      id,
      "КОНТЕКСТ ПРОЕКТА ДЛЯ АВТОМАТИЗАЦИИ",
      "Это актуальная карточка проекта, которую приложение подмешало в автономный запуск.",
      "Обновляй project_memory только если в ходе работы появилось новое устойчивое решение или ограничение. Не сохраняй туда отчёт запуска, логи и временные TODO.",
    );
  }

  private async renderProjectContext(
    id: string,
    title: string,
    intro: string,
    footer: string,
  ): Promise<string> {
    const project = await this.get(id);
    if (!project) throw new Error(`Проект «${id}» не найден`);
    const memory = await this.readMemory(id);
    const lines = [
      title,
      intro,
      `project_id: ${project.id}`,
      `Название: ${project.name}`,
      `Описание: ${project.description}`,
      `Рабочая папка: ${project.workspace}`,
    ];
    if (project.services.length > 0) lines.push(`Сервисы: ${project.services.join(", ")}`);
    if (project.urls.length > 0) lines.push(`Адреса: ${project.urls.join(", ")}`);
    lines.push("", "Память проекта:");
    if (memory.length === 0) lines.push("Пока пуста.");
    else memory.forEach((entry) => lines.push(`- ${entry}`));
    lines.push(
      "",
      footer,
    );
    return lines.join("\n");
  }

  private async readProject(id: string): Promise<ProjectRecord> {
    const projectPath = this.projectPath(id);
    try {
      const raw = await readFile(projectPath, "utf8");
      return validateStoredProject(JSON.parse(raw) as unknown, id);
    } catch (error) {
      if (isNotFound(error)) throw error;
      try {
        const backup = await readFile(`${projectPath}.bak`, "utf8");
        const restored = validateStoredProject(JSON.parse(backup) as unknown, id);
        console.warn(`Project ${id} restored from backup`);
        return restored;
      } catch (backupError) {
        throw new Error(
          `project.json повреждён, резервная копия недоступна: ${errorMessage(backupError)}`,
          { cause: error },
        );
      }
    }
  }

  private async writeProject(project: ProjectRecord): Promise<void> {
    const contents = `${JSON.stringify(project, null, 2)}\n`;
    const projectPath = this.projectPath(project.id);
    await atomicWrite(projectPath, contents);
    await atomicWrite(`${projectPath}.bak`, contents);
  }

  private async validateWorkspace(value: string): Promise<string> {
    const requested = boundedText(value, "workspace", 1_000);
    const canonical = await realpath(requested).catch(() => {
      throw new Error(`Рабочая папка не существует: ${requested}`);
    });
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error(`Рабочая папка не является директорией: ${canonical}`);
    if (canonical === path.parse(canonical).root || canonical === path.resolve(os.tmpdir())) {
      throw new Error("Корневая или временная директория не может быть проектом");
    }
    const approvedCanonical = await Promise.all(this.approvedDirectories.map(async (root) => (
      realpath(root).catch(() => path.resolve(root))
    )));
    return requireWithinAnyDirectory(canonical, approvedCanonical, "project workspace");
  }

  private memoryError(entries: string[], error: string, retryable: boolean): ProjectMemoryResult {
    const size = serializeMemory(entries).length;
    return {
      success: false,
      error,
      currentEntries: entries,
      usage: `${size}/${this.memoryCharLimit}`,
      retryable,
    };
  }

  private projectDirectory(id: string): string {
    return path.join(this.rootDirectory, id);
  }

  private projectPath(id: string): string {
    return path.join(this.projectDirectory(id), "project.json");
  }

  private memoryPath(id: string): string {
    return path.join(this.projectDirectory(id), "MEMORY.md");
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

function parseMemory(raw: string): string[] {
  if (!raw.trim()) return [];
  return [...new Set(raw.split(MEMORY_DELIMITER).map((entry) => entry.trim()).filter(Boolean))];
}

function serializeMemory(entries: string[]): string {
  return entries.join(MEMORY_DELIMITER);
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeProjectId(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertProjectId(normalized);
  return normalized;
}

function assertProjectId(value: string): void {
  if (!isProjectId(value)) {
    throw new Error("project id должен содержать только a-z, 0-9 и дефисы (до 48 символов)");
  }
}

function isProjectId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value);
}

function boundedText(value: string, field: string, maxLength: number): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} не может быть пустым`);
  if (normalized.length > maxLength) throw new Error(`${field} длиннее ${maxLength} символов`);
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} должен быть положительным числом`);
  return value;
}

function normalizeStringList(
  values: string[] | undefined,
  field: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > maxItems) {
    throw new Error(`${field}: разрешено не больше ${maxItems} значений`);
  }
  return [...new Set(values.map((value) => boundedText(value, field, maxLength)))];
}

function normalizeUrls(values: string[] | undefined): string[] {
  const urls = normalizeStringList(values, "urls", 20, 500);
  for (const value of urls) {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      throw new Error(`Неподдерживаемый URL: ${value}`);
    }
  }
  return urls;
}

function validateStoredProject(value: unknown, expectedId: string): ProjectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Повреждён project.json для «${expectedId}»`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.id !== expectedId ||
    typeof record.name !== "string" ||
    typeof record.description !== "string" ||
    typeof record.workspace !== "string" ||
    !Array.isArray(record.services) ||
    !record.services.every((entry) => typeof entry === "string") ||
    !Array.isArray(record.urls) ||
    !record.urls.every((entry) => typeof entry === "string") ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    throw new Error(`Повреждён project.json для «${expectedId}»`);
  }
  if (record.avatar !== undefined && !isStoredAvatar(record.avatar)) {
    throw new Error(`Повреждён avatar в project.json для «${expectedId}»`);
  }
  return record as unknown as ProjectRecord;
}

function isStoredAvatar(value: unknown): value is ProjectAvatar {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const avatar = value as Record<string, unknown>;
  return (
    ["pending", "generating", "ready", "failed"].includes(String(avatar.status)) &&
    Number.isInteger(avatar.version) &&
    Number(avatar.version) > 0 &&
    typeof avatar.updatedAt === "string" &&
    optionalStoredString(avatar.brief) &&
    optionalStoredString(avatar.scene) &&
    optionalStoredString(avatar.prompt) &&
    optionalStoredString(avatar.error) &&
    optionalStoredString(avatar.telegramFileId)
  );
}

function optionalStoredString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
