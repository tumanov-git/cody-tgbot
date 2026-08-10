import { InlineKeyboard } from "grammy";

import { formatAutomationButtonDate } from "./automation-format.js";
import { automationDisplayTimezone } from "./automation-schedule.js";
import type { AutomationRecord } from "./automation-types.js";
import { escapeHTML, PREMIUM_EMOJI } from "./format.js";
import type { ProjectRecord } from "./project-store.js";
import type { DialogSummary } from "./session-registry.js";

export interface DualText {
  html: string;
  plain: string;
}

const DIALOGS_PER_PAGE = 4;
const PROJECTS_PER_PAGE = 4;
const AUTOMATIONS_PER_PAGE = 4;
export const CURRENT_DIALOG_ICON_ID = "5339062047382461917";
export const MAIN_MENU_TITLE = "Что делаем?";
export const MAIN_MENU_DESCRIPTION = "Можно продолжить начатое или заняться чем-нибудь новым";
export const MAIN_MENU_IMAGE_NAMES = [
  "home-1.png",
  "home-2.png",
  "home-3.png",
] as const;

export function pickMainMenuImageName(random: () => number = Math.random): string {
  return pickRandom(MAIN_MENU_IMAGE_NAMES, random);
}

export function buildMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text({ text: "Мои проекты", style: "success" }, "menu:projects:0")
    .text({ text: "Диалоги", style: "primary" }, "menu:dialogs:0")
    .row()
    .text("Настройки", "menu:settings")
    .row()
    .text("Закрыть", "menu:close");
}

export function renderAutomations(
  automations: AutomationRecord[],
  project: ProjectRecord,
  requestedPage: number,
  timezone = "Europe/Moscow",
  now = new Date(),
): { text: DualText; keyboard: InlineKeyboard; page: number } {
  const pageCount = Math.max(1, Math.ceil(automations.length / AUTOMATIONS_PER_PAGE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const pageAutomations = automations.slice(
    page * AUTOMATIONS_PER_PAGE,
    (page + 1) * AUTOMATIONS_PER_PAGE,
  );
  const title = `Автоматизации · ${project.name}`;
  const description = "Задачи, к которым Коди возвращается сам";
  const text = {
    html: `<b>${escapeHTML(title)}</b>\n\n<i>${escapeHTML(description)}</i>`,
    plain: `${title}\n\n${description}`,
  };
  const keyboard = new InlineKeyboard()
    .text({ text: "＋ Новая автоматизация", style: "success" }, `automation:new:${project.id}`)
    .row();

  for (const automation of pageAutomations) {
    const button = automationButton(automation, timezone, now);
    keyboard.text(
      button.primary ? { text: button.text, style: "primary" } : button.text,
      `automation:view:${automation.id}:${page}`,
    );
    if (button.iconId) keyboard.icon(button.iconId);
    keyboard.row();
  }
  if (pageCount > 1) {
    if (page > 0) keyboard.text("←", automationPageCallback(project.id, page - 1));
    keyboard.text(`${page + 1}/${pageCount}`, automationPageCallback(project.id, page));
    if (page < pageCount - 1) keyboard.text("→", automationPageCallback(project.id, page + 1));
    keyboard.row();
  }
  keyboard.text("Назад", `project:view:${project.id}:0`);
  return { text, keyboard, page };
}

export function renderProjects(projects: ProjectRecord[], requestedPage: number, unreadableCount = 0): {
  text: DualText;
  keyboard: InlineKeyboard;
  page: number;
} {
  const pageCount = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const pageProjects = projects.slice(page * PROJECTS_PER_PAGE, (page + 1) * PROJECTS_PER_PAGE);
  const description = "Здесь собраны проекты, которые Коди создаёт и поддерживает";
  const warning = unreadableCount > 0
    ? `\n\nНе удалось прочитать проектов: ${unreadableCount}. Подробности в логах`
    : "";
  const text = {
    html: `<b>Мои проекты</b>\n\n<i>${description}</i>${warning}`,
    plain: `Мои проекты\n\n${description}${warning}`,
  };
  const keyboard = new InlineKeyboard()
    .text({ text: "＋ Новый проект", style: "success" }, "project:new")
    .row();

  for (let index = 0; index < pageProjects.length; index += 2) {
    for (const project of pageProjects.slice(index, index + 2)) {
      keyboard.text(
        { text: projectButtonText(project), style: "primary" },
        `project:view:${project.id}:${page}`,
      );
    }
    keyboard.row();
  }

  if (pageCount > 1) {
    if (page > 0) keyboard.text("←", `menu:projects:${page - 1}`);
    keyboard.text(`${page + 1}/${pageCount}`, `menu:projects:${page}`);
    if (page < pageCount - 1) keyboard.text("→", `menu:projects:${page + 1}`);
    keyboard.row();
  }

  keyboard.text("Назад", "menu:home");
  return { text, keyboard, page };
}

export function renderDialogs(dialogs: DialogSummary[], requestedPage: number): {
  text: DualText;
  keyboard: InlineKeyboard;
  page: number;
} {
  const pageCount = Math.max(1, Math.ceil(dialogs.length / DIALOGS_PER_PAGE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const pageDialogs = dialogs.slice(page * DIALOGS_PER_PAGE, (page + 1) * DIALOGS_PER_PAGE);
  const description = dialogs.length > 0
    ? "Продолжи прошлый или начни новый."
    : "Здесь появятся разговоры с Коди.";
  const text = {
    html: `<b>Диалоги</b>\n\n<i>${description}</i>`,
    plain: `Диалоги\n\n${description}`,
  };
  const keyboard = new InlineKeyboard()
    .text({ text: "＋ Новый диалог", style: "success" }, "dialog:new")
    .row();

  for (const dialog of pageDialogs) {
    keyboard.text(
      { text: dialogButtonText(dialog), style: "primary" },
      `dialog:open:${dialog.threadId}:${page}`,
    );
    if (dialog.current) keyboard.icon(CURRENT_DIALOG_ICON_ID);
    keyboard.row();
  }

  if (pageCount > 1) {
    if (page > 0) keyboard.text("←", `menu:dialogs:${page - 1}`);
    keyboard.text(`${page + 1}/${pageCount}`, `menu:dialogs:${page}`);
    if (page < pageCount - 1) keyboard.text("→", `menu:dialogs:${page + 1}`);
    keyboard.row();
  }

  keyboard.text("Назад", "menu:home");
  return { text, keyboard, page };
}

function dialogButtonText(dialog: DialogSummary): string {
  const date = new Date(dialog.createdAt);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const title = dialog.title.length > 22 ? `${dialog.title.slice(0, 21)}…` : dialog.title;
  return `${day}.${month} ${hours}:${minutes} — ${title}`;
}

function projectButtonText(project: ProjectRecord): string {
  return project.name.length > 24 ? `${project.name.slice(0, 23)}…` : project.name;
}

function automationButton(
  automation: AutomationRecord,
  timezone: string,
  now: Date,
): { text: string; primary: boolean; iconId?: string } {
  const displayTimezone = automationDisplayTimezone(automation.schedule, timezone);
  const suffix = automation.claimToken
    ? " · выполняется"
    : automation.state === "paused"
      ? " · пауза"
      : automation.state === "completed"
        ? " · завершена"
        : automation.nextRunAt
          ? ` · ${formatAutomationButtonDate(automation.nextRunAt, displayTimezone, now)}`
          : " · запланирована";
  const limit = Math.max(12, 48 - suffix.length);
  const name = automation.name.length > limit
    ? `${automation.name.slice(0, limit - 1)}…`
    : automation.name;
  return {
    text: `${name}${suffix}`,
    primary: automation.state === "scheduled",
    ...(automation.claimToken ? { iconId: PREMIUM_EMOJI.working } : {}),
  };
}

function automationPageCallback(projectId: string, page: number): string {
  return `project:automations:${projectId}:${page}`;
}

function pickRandom<T>(values: readonly T[], random: () => number): T {
  const value = Math.min(0.999999, Math.max(0, random()));
  return values[Math.floor(value * values.length)]!;
}
