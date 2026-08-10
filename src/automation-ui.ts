import { InlineKeyboard, type Bot, type Context } from "grammy";

import type { AutomationScheduler } from "./automation-scheduler.js";
import type { AutomationStore } from "./automation-store.js";
import type { AutomationExecution, AutomationRecord } from "./automation-types.js";
import { formatAutomationDate } from "./automation-format.js";
import { automationDisplayTimezone } from "./automation-schedule.js";
import { renderAutomations } from "./bot-ui.js";
import type { CodyConfig } from "./config.js";
import { contextKeyFromCtx } from "./context-key.js";
import { escapeHTML } from "./format.js";
import type { ProjectStore } from "./project-store.js";
import type { SessionRegistry } from "./session-registry.js";

export interface AutomationUiOptions {
  bot: Bot<Context>;
  config: CodyConfig;
  registry: SessionRegistry;
  projectStore: ProjectStore;
  store: AutomationStore;
  scheduler: AutomationScheduler;
  menuImagePath: string;
  showPhotoScreen: (
    ctx: Context,
    imagePath: string,
    caption: string,
    keyboard: InlineKeyboard,
  ) => Promise<void>;
  showTextScreen: (
    ctx: Context,
    html: string,
    plain: string,
    keyboard: InlineKeyboard,
  ) => Promise<void>;
}

export function registerAutomationUi(options: AutomationUiOptions): void {
  const { bot, config, registry, projectStore, store, scheduler } = options;

  const showList = async (ctx: Context, projectId: string, requestedPage: number): Promise<void> => {
    const project = await projectStore.get(projectId);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Проект не найден" }).catch(() => {});
      return;
    }
    const automations = store.list({ projectId, includeCompleted: true });
    const view = renderAutomations(
      automations,
      project,
      requestedPage,
      config.automationTimezone,
    );
    await options.showPhotoScreen(
      ctx,
      options.menuImagePath,
      view.text.html,
      view.keyboard,
    );
  };

  const showCard = async (
    ctx: Context,
    automation: AutomationRecord,
    page: number,
  ): Promise<void> => {
    const timezone = automationDisplayTimezone(automation.schedule, config.automationTimezone);
    const details = [
      `<b>${escapeHTML(automation.name)}</b>`,
      "",
      escapeHTML(automation.description),
      "",
      escapeHTML(automation.scheduleDescription),
    ];
    if (automation.claimToken || automation.state !== "scheduled") {
      details.push(`<b>Состояние:</b> ${automationStateLabel(automation)}`);
    }
    if (automation.nextRunAt && automation.state === "scheduled") {
      details.push(`<b>Следующий запуск:</b> ${escapeHTML(formatAutomationDate(automation.nextRunAt, timezone))}`);
    }
    if (automation.lastRunAt) {
      details.push(
        `<b>Последний:</b> ${escapeHTML(formatAutomationDate(automation.lastRunAt, timezone))} · ${escapeHTML(automationLastStatusLabel(automation))}`,
      );
    }
    if (automation.pausedReason) {
      details.push(`<b>Причина паузы:</b> ${escapeHTML(automation.pausedReason)}`);
    }
    const keyboard = new InlineKeyboard()
      .text({ text: "Управлять", style: "primary" }, `automation:discuss:${automation.id}:${page}`)
      .row();
    if (automation.state !== "completed" && !automation.claimToken) {
      keyboard.text("Запустить сейчас", `automation:run:${automation.id}:${page}`);
      keyboard.text("История", `automation:history:${automation.id}:${page}:0`).row();
    } else {
      keyboard.text("История", `automation:history:${automation.id}:${page}:0`).row();
    }
    if (automation.claimToken) {
      keyboard.text(
        { text: "Остановить запуск", style: "danger" },
        `automation:stop:${automation.id}:${page}`,
      ).row();
    }
    if (!automation.claimToken) {
      keyboard.text("Настройки", `automation:settings:${automation.id}:${page}`).row();
    }
    keyboard.text("Назад", `project:automations:${automation.projectId}:${page}`);
    await options.showTextScreen(
      ctx,
      details.join("\n"),
      details.map((line) => line.replace(/<[^>]+>/g, "")).join("\n"),
      keyboard,
    );
  };

  bot.callbackQuery(/^project:automations:([a-z0-9-]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showList(ctx, ctx.match?.[1] ?? "", Number(ctx.match?.[2] ?? 0));
  });

  bot.callbackQuery(/^automation:new:([a-z0-9-]+)$/, async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }
    const projectId = ctx.match?.[1] ?? "";
    const project = await projectStore.get(projectId);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Проект не найден" }).catch(() => {});
      return;
    }
    const session = await registry.getOrCreate(contextKey, { deferThreadStart: true });
    await session.newThread(project.workspace, [
      await projectStore.renderDiscussionContext(project.id),
      "",
      "Пользователь открыл создание автоматизации для этого проекта. Помоги сформулировать полезную отложенную или регулярную работу и создай её через automation(action=create), когда расписание и смысл станут понятны.",
    ].join("\n"));
    registry.updateMetadata(contextKey, session);
    await ctx.answerCallbackQuery({ text: "Можно описывать" });
    await options.showTextScreen(
      ctx,
      [
        "<b>Что Коди должен делать сам?</b>",
        "",
        `Автоматизация будет относиться к проекту «${escapeHTML(project.name)}». Опиши задачу и расписание своими словами.`,
      ].join("\n"),
      `Автоматизация для проекта «${project.name}». Опиши задачу и расписание своими словами.`,
      new InlineKeyboard()
        .text("Назад", `project:automations:${projectId}:0`)
        .row()
        .text("Меню", "menu:home"),
    );
  });

  bot.callbackQuery(/^automation:view:(auto-[a-f0-9]+):(\d+)$/, async (ctx) => {
    const automation = store.get(ctx.match?.[1] ?? "");
    if (!automation) {
      await ctx.answerCallbackQuery({ text: "Автоматизация не найдена" }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery();
    await showCard(ctx, automation, Number(ctx.match?.[2] ?? 0));
  });

  bot.callbackQuery(/^automation:settings:(auto-[a-f0-9]+):(\d+)$/, async (ctx) => {
    const automation = store.get(ctx.match?.[1] ?? "");
    if (!automation) {
      await ctx.answerCallbackQuery({ text: "Автоматизация не найдена" }).catch(() => {});
      return;
    }
    const page = Number(ctx.match?.[2] ?? 0);
    const details = [
      `<b>Настройки · ${escapeHTML(automation.name)}</b>`,
      "",
      escapeHTML(automation.scheduleDescription),
      `<b>Состояние:</b> ${automationStateLabel(automation)}`,
    ];
    const keyboard = new InlineKeyboard();
    if (automation.state !== "completed") {
      keyboard
        .text(
          automation.state === "paused" ? "Возобновить" : "Приостановить",
          `automation:${automation.state === "paused" ? "resume" : "pause"}:${automation.id}:${page}`,
        )
        .row();
    }
    keyboard
      .text({ text: "Удалить", style: "danger" }, `automation:remove-confirm:${automation.id}:${page}`)
      .row()
      .text("Назад", `automation:view:${automation.id}:${page}`);
    await ctx.answerCallbackQuery();
    await options.showTextScreen(
      ctx,
      details.join("\n"),
      details.map((line) => line.replace(/<[^>]+>/g, "")).join("\n"),
      keyboard,
    );
  });

  bot.callbackQuery(/^automation:(pause|resume):(auto-[a-f0-9]+):(\d+)$/, async (ctx) => {
    const action = ctx.match?.[1];
    const id = ctx.match?.[2] ?? "";
    try {
      const automation = action === "pause" ? store.pause(id) : store.resume(id);
      if (action === "resume") {
        scheduler.wake();
      }
      await ctx.answerCallbackQuery({
        text: action === "pause" ? "Приостановлено" : "Возобновлено",
      });
      await showCard(ctx, automation, Number(ctx.match?.[3] ?? 0));
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: error instanceof Error ? error.message.slice(0, 180) : "Не получилось",
        show_alert: true,
      }).catch(() => {});
    }
  });

  bot.callbackQuery(/^automation:run:(auto-[a-f0-9]+):(\d+)$/, async (ctx) => {
    const automation = store.get(ctx.match?.[1] ?? "");
    if (!automation) {
      await ctx.answerCallbackQuery({ text: "Автоматизация не найдена" }).catch(() => {});
      return;
    }
    const page = Number(ctx.match?.[2] ?? 0);
    if (manualRunNeedsConfirmation(automation)) {
      const timezone = automationDisplayTimezone(automation.schedule, config.automationTimezone);
      const lines = [
        `<b>Запустить дополнительный раз?</b>`,
        "",
        `Следующий запуск: ${escapeHTML(formatAutomationDate(automation.nextRunAt!, timezone))}`,
        "Расписание не изменится.",
      ];
      await ctx.answerCallbackQuery();
      await options.showTextScreen(
        ctx,
        lines.join("\n"),
        lines.map(stripHtml).join("\n"),
        new InlineKeyboard()
          .text({ text: "Запустить", style: "primary" }, `automation:run-confirm:${automation.id}:${page}`)
          .row()
          .text("Назад", `automation:view:${automation.id}:${page}`),
      );
      return;
    }
    await runNow(ctx, automation.id, page);
  });

  bot.callbackQuery(/^automation:run-confirm:(auto-[a-f0-9]+):(\d+)$/, async (ctx) => {
    await runNow(ctx, ctx.match?.[1] ?? "", Number(ctx.match?.[2] ?? 0));
  });

  bot.callbackQuery(/^automation:stop:(auto-[a-f0-9]+):(\d+)$/, async (ctx) => {
    try {
      const automation = await scheduler.stop(ctx.match?.[1] ?? "");
      await ctx.answerCallbackQuery({ text: "Останавливаю" });
      await options.showTextScreen(
        ctx,
        `<b>Останавливаю «${escapeHTML(automation.name)}»…</b>`,
        `Останавливаю «${automation.name}»…`,
        new InlineKeyboard().text(
          "Назад",
          `automation:view:${automation.id}:${Number(ctx.match?.[2] ?? 0)}`,
        ),
      );
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: error instanceof Error ? error.message.slice(0, 180) : "Не получилось",
        show_alert: true,
      }).catch(() => {});
    }
  });

  const runNow = async (ctx: Context, automationId: string, page: number): Promise<void> => {
    try {
      const automation = scheduler.runNow(automationId).automation;
      await ctx.answerCallbackQuery({ text: "Запустил" });
      await showCard(ctx, automation, page);
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: error instanceof Error ? error.message.slice(0, 180) : "Не получилось",
        show_alert: true,
      }).catch(() => {});
    }
  };

  bot.callbackQuery(/^automation:discuss:(auto-[a-f0-9]+):(\d+)$/, async (ctx) => {
    const automation = store.get(ctx.match?.[1] ?? "");
    const project = automation ? await projectStore.get(automation.projectId) : null;
    const contextKey = contextKeyFromCtx(ctx);
    if (!automation || !project || !contextKey) {
      await ctx.answerCallbackQuery({ text: "Автоматизация или проект не найдены" }).catch(() => {});
      return;
    }
    const session = await registry.getOrCreate(contextKey, { deferThreadStart: true });
    await session.newThread(project.workspace, [
      await projectStore.renderDiscussionContext(project.id),
      "",
      "КОНТЕКСТ АВТОМАТИЗАЦИИ",
      `automation_id: ${automation.id}`,
      `Название: ${automation.name}`,
      `Описание: ${automation.description}`,
      `Расписание: ${automation.scheduleDescription}`,
      `Скрытая инструкция: ${automation.instruction}`,
      `Состояние: ${automation.state}`,
      "",
      "Пользователь открыл управление этой автоматизацией через диалог. Можно отвечать на вопросы и обсуждать её. Изменяй автоматизацию через automation(action=update) только по явной просьбе пользователя.",
    ].join("\n"));
    registry.updateMetadata(contextKey, session);
    await ctx.answerCallbackQuery({ text: "Диалог готов" });
    await options.showTextScreen(
      ctx,
      `<b>${escapeHTML(automation.name)}</b>\n\nМожно задать вопрос или написать, что изменить.`,
      `${automation.name}\n\nМожно задать вопрос или написать, что изменить.`,
      new InlineKeyboard()
        .text("Назад", `automation:view:${automation.id}:${ctx.match?.[2] ?? 0}`)
        .row()
        .text("Меню", "menu:home"),
    );
  });

  bot.callbackQuery(/^automation:remove-confirm:(auto-[a-f0-9]+):(\d+)$/, async (ctx) => {
    const automation = store.get(ctx.match?.[1] ?? "");
    if (!automation) {
      await ctx.answerCallbackQuery({ text: "Автоматизация не найдена" }).catch(() => {});
      return;
    }
    const page = Number(ctx.match?.[2] ?? 0);
    const details = [
      `<b>Удалить «${escapeHTML(automation.name)}»?</b>`,
      "",
      "Расписание и история запусков будут удалены.",
    ];
    await ctx.answerCallbackQuery();
    await options.showTextScreen(
      ctx,
      details.join("\n"),
      details.map((line) => line.replace(/<[^>]+>/g, "")).join("\n"),
      new InlineKeyboard()
        .text({ text: "Удалить", style: "danger" }, `automation:remove:${automation.id}:${page}`)
        .row()
        .text("Назад", `automation:settings:${automation.id}:${page}`),
    );
  });

  bot.callbackQuery(/^automation:remove:(auto-[a-f0-9]+):(\d+)$/, async (ctx) => {
    const id = ctx.match?.[1] ?? "";
    const page = Number(ctx.match?.[2] ?? 0);
    try {
      const removed = store.remove(id);
      await ctx.answerCallbackQuery({ text: "Удалено" });
      await showList(ctx, removed.projectId, page);
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: error instanceof Error ? error.message.slice(0, 180) : "Не получилось",
        show_alert: true,
      }).catch(() => {});
    }
  });

  bot.callbackQuery(/^automation:history:(auto-[a-f0-9]+):(\d+):(\d+)$/, async (ctx) => {
    const automation = store.get(ctx.match?.[1] ?? "");
    if (!automation) {
      await ctx.answerCallbackQuery({ text: "Автоматизация не найдена" }).catch(() => {});
      return;
    }
    const cardPage = Number(ctx.match?.[2] ?? 0);
    const requestedPage = Number(ctx.match?.[3] ?? 0);
    const total = store.countExecutions(automation.id);
    const pageCount = Math.max(1, Math.ceil(total / 10));
    const historyPage = Math.min(Math.max(0, requestedPage), pageCount - 1);
    const executions = store.listExecutions(automation.id, 10, historyPage * 10);
    const timezone = automationDisplayTimezone(automation.schedule, config.automationTimezone);
    const lines = [
      `<b>История · ${escapeHTML(automation.name)}</b>`,
      "",
      executions.length > 0 ? "Последние запуски автоматизации" : "Запусков пока не было",
    ];
    const keyboard = new InlineKeyboard();
    executions.forEach((execution, index) => {
      keyboard
        .text(
          executionButtonText(execution, timezone),
          `automation:runview:${automation.id}:${cardPage}:${historyPage}:${index}`,
        )
        .row();
    });
    if (pageCount > 1) {
      if (historyPage > 0) {
        keyboard.text("←", `automation:history:${automation.id}:${cardPage}:${historyPage - 1}`);
      }
      keyboard.text(`${historyPage + 1}/${pageCount}`, `automation:history:${automation.id}:${cardPage}:${historyPage}`);
      if (historyPage < pageCount - 1) {
        keyboard.text("→", `automation:history:${automation.id}:${cardPage}:${historyPage + 1}`);
      }
      keyboard.row();
    }
    keyboard.text("Назад", `automation:view:${automation.id}:${cardPage}`);
    await ctx.answerCallbackQuery();
    await options.showTextScreen(ctx, lines.join("\n"), lines.map(stripHtml).join("\n"), keyboard);
  });

  bot.callbackQuery(
    /^automation:runview:(auto-[a-f0-9]+):(\d+):(\d+):(\d+)$/,
    async (ctx) => {
      const automation = store.get(ctx.match?.[1] ?? "");
      if (!automation) {
        await ctx.answerCallbackQuery({ text: "Автоматизация не найдена" }).catch(() => {});
        return;
      }
      const cardPage = Number(ctx.match?.[2] ?? 0);
      const historyPage = Number(ctx.match?.[3] ?? 0);
      const index = Number(ctx.match?.[4] ?? 0);
      const execution = store.listExecutions(automation.id, 10, historyPage * 10)[index];
      if (!execution) {
        await ctx.answerCallbackQuery({ text: "Запуск больше не найден" }).catch(() => {});
        return;
      }
      const timezone = automationDisplayTimezone(automation.schedule, config.automationTimezone);
      const lines = renderExecutionDetails(execution, timezone);
      await ctx.answerCallbackQuery();
      await options.showTextScreen(
        ctx,
        lines.html,
        lines.plain,
        new InlineKeyboard().text(
          "Назад",
          `automation:history:${automation.id}:${cardPage}:${historyPage}`,
        ),
      );
    },
  );
}

function automationStateLabel(automation: AutomationRecord): string {
  if (automation.claimToken) return "выполняется";
  if (automation.state === "paused") return "приостановлена";
  if (automation.state === "completed") return "завершена";
  return "активна";
}

function automationLastStatusLabel(automation: AutomationRecord): string {
  if (automation.lastStatus === "failed" && automation.lastError === "Остановлено пользователем") {
    return "остановлено";
  }
  if (automation.lastStatus === "success") return "успешно";
  if (automation.lastStatus === "silent") return "без сообщения";
  if (automation.lastStatus === "failed") return "ошибка";
  if (automation.lastStatus === "timed_out") return "превышено время";
  if (automation.lastStatus === "unknown") return "результат неизвестен";
  return "ещё не запускалась";
}

function executionButtonText(execution: AutomationExecution, timezone: string): string {
  const date = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(execution.startedAt ?? execution.claimedAt));
  return `${date} · ${executionStatusLabel(execution)}`;
}

function executionStatusLabel(execution: AutomationExecution): string {
  if (execution.status === "claimed") return "ожидает";
  if (execution.status === "running") return "выполняется";
  if (execution.status === "success" && execution.deliveryStatus === "failed") return "ошибка доставки";
  if (execution.status === "success") return "готово";
  if (execution.status === "silent") return "нечего сообщать";
  if (execution.status === "timed_out") return "превышено время";
  if (execution.status === "unknown") return "результат неизвестен";
  if (execution.error === "Остановлено пользователем") return "остановлено";
  return "ошибка";
}

export function manualRunNeedsConfirmation(
  automation: AutomationRecord,
  now = new Date(),
  thresholdMs = 30 * 60_000,
): boolean {
  if (automation.state !== "scheduled" || !automation.nextRunAt) return false;
  return new Date(automation.nextRunAt).getTime() - now.getTime() <= thresholdMs;
}

export function renderExecutionDetails(
  execution: AutomationExecution,
  timezone: string,
): { html: string; plain: string } {
  const details = [
    "<b>Запуск автоматизации</b>",
    "",
    `<b>Состояние:</b> ${escapeHTML(executionStatusLabel(execution))}`,
    `<b>Запланирован:</b> ${escapeHTML(formatAutomationDate(execution.scheduledFor, timezone))}`,
    ...(execution.startedAt
      ? [`<b>Начат:</b> ${escapeHTML(formatAutomationDate(execution.startedAt, timezone))}`]
      : []),
    ...(execution.finishedAt
      ? [`<b>Завершён:</b> ${escapeHTML(formatAutomationDate(execution.finishedAt, timezone))}`]
      : []),
    `<b>Длительность:</b> ${escapeHTML(formatExecutionDuration(execution))}`,
    `<b>Запуск:</b> ${execution.source === "manual" ? "вручную" : "по расписанию"}`,
    `<b>Доставка:</b> ${escapeHTML(deliveryStatusLabel(execution))}`,
  ];
  if (execution.result && execution.status !== "silent") {
    details.push("", "<b>Результат</b>", escapeDetail(execution.result, 2_100));
  }
  if (execution.error) {
    details.push("", "<b>Ошибка</b>", escapeDetail(execution.error, 800));
  }
  if (execution.deliveryError) {
    details.push(
      "",
      "<b>Ошибка доставки</b>",
      escapeDetail(execution.deliveryError, 300),
    );
  }
  return { html: details.join("\n"), plain: details.map(stripHtml).join("\n") };
}

function deliveryStatusLabel(execution: AutomationExecution): string {
  if (execution.deliveryStatus === "not_required") return "не требуется";
  if (execution.deliveryStatus === "pending") return "ожидает";
  if (execution.deliveryStatus === "delivering") return "отправляется";
  if (execution.deliveryStatus === "delivered") return "доставлено";
  return execution.deliveryAttempts >= 3 ? "не доставлено" : "будет повторена";
}

function formatExecutionDuration(execution: AutomationExecution): string {
  if (!execution.startedAt) return "ещё не начат";
  const end = execution.finishedAt ? new Date(execution.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(execution.startedAt).getTime()) / 1_000));
  if (seconds < 60) return `${seconds}с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}м ${rest}с` : `${minutes}м`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function escapeDetail(value: string, budget: number): string {
  let escaped = "";
  for (const character of value) {
    const next = escapeHTML(character);
    if (escaped.length + next.length > budget - 1) return `${escaped.trimEnd()}…`;
    escaped += next;
  }
  return escaped;
}
