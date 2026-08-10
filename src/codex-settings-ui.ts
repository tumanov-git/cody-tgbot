import { InlineKeyboard, type Bot, type Context } from "grammy";

import type { AutomationScheduler } from "./automation-scheduler.js";
import {
  findFastServiceTier,
  type CodexModelOption,
  type CodexPreferences,
} from "./codex-preferences.js";
import { renderCodexStatus } from "./codex-status.js";
import { contextKeyFromCtx } from "./context-key.js";
import { escapeHTML } from "./format.js";
import type { SessionRegistry } from "./session-registry.js";

type ShowTextScreen = (
  ctx: Context,
  html: string,
  plain: string,
  keyboard: InlineKeyboard,
) => Promise<void>;

export function registerCodexSettingsUi(options: {
  bot: Bot<Context>;
  registry: SessionRegistry;
  automationScheduler?: AutomationScheduler;
  showTextScreen: ShowTextScreen;
}): void {
  const { bot, registry, automationScheduler, showTextScreen } = options;

  const load = async (ctx: Context): Promise<{
    contextKey: NonNullable<ReturnType<typeof contextKeyFromCtx>>;
    preferences: CodexPreferences;
    models: CodexModelOption[];
  } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) return null;
    const [models, preferences] = await Promise.all([
      registry.listModels().catch(() => []),
      Promise.resolve(registry.getPreferences(contextKey)),
    ]);
    return { contextKey, preferences, models };
  };

  const showRoot = async (ctx: Context): Promise<void> => {
    const state = await load(ctx);
    if (!state) return;
    const selected = selectedModel(state.models, state.preferences);
    const fast = selected && findFastServiceTier(selected);
    const fastAvailable = Boolean(fast);
    const fastEnabled = state.preferences.serviceTier === fast?.id;
    const auth = await registry.auth.read().catch(() => null);
    const lines = [
      "<b>Настройки</b>",
      "",
      `Модель: ${escapeHTML(selected?.displayName ?? state.preferences.model ?? "по умолчанию")}`,
      `Рассуждения: ${escapeHTML(effortLabel(state.preferences.reasoningEffort ?? selected?.defaultReasoningEffort))}`,
      `Быстрый режим: ${fastAvailable ? (fastEnabled ? "включён" : "выключен") : "недоступен"}`,
      `Доступ: ${accessLabel(state.preferences)}`,
      `Аккаунт: ${accountLabel(auth)}`,
    ];
    const keyboard = new InlineKeyboard()
      .text({ text: "Аккаунт", style: "primary" }, "settings:account")
      .row()
      .text({ text: "Статус", style: "primary" }, "settings:status")
      .row()
      .text({ text: "Модель", style: "primary" }, "settings:model")
      .row()
      .text({ text: "Рассуждения", style: "primary" }, "settings:effort")
      .row()
      .text({ text: "Быстрый режим", style: "primary" }, "settings:fast")
      .row()
      .text({ text: "Доступ", style: "primary" }, "settings:access")
      .row()
      .text("Назад", "menu:home");
    await showTextScreen(ctx, lines.join("\n"), stripHtml(lines.join("\n")), keyboard);
  };

  bot.callbackQuery("menu:settings", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showRoot(ctx);
  });

  bot.callbackQuery("settings:status", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) return;
    await ctx.answerCallbackQuery();
    const status = await registry.readStatus(contextKey);
    if (automationScheduler) status.automationHealth = automationScheduler.getHealth();
    const rendered = renderCodexStatus(status);
    const keyboard = new InlineKeyboard().text("Назад", "menu:settings");
    await showTextScreen(ctx, rendered.html, rendered.plain, keyboard);
  });

  bot.callbackQuery("settings:model", async (ctx) => {
    const state = await load(ctx);
    if (!state) return;
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    for (const model of state.models) {
      const active = model.model === state.preferences.model
        || (!state.preferences.model && model.isDefault);
      keyboard.text(
        active
          ? { text: `${model.displayName} · выбрана`, style: "primary" }
          : model.displayName,
        `settings:model:set:${model.model}`,
      ).row();
    }
    keyboard.text("Назад", "menu:settings");
    await showTextScreen(
      ctx,
      "<b>Модель</b>\n\nВыбери модель для следующих задач в этом Telegram-диалоге",
      "Модель\n\nВыбери модель для следующих задач в этом Telegram-диалоге",
      keyboard,
    );
  });

  bot.callbackQuery(/^settings:model:set:(.+)$/, async (ctx) => {
    const state = await load(ctx);
    const model = state?.models.find((candidate) => candidate.model === ctx.match?.[1]);
    if (!state || !model) {
      await ctx.answerCallbackQuery({ text: "Модель больше недоступна" }).catch(() => {});
      return;
    }
    await registry.setPreferences(state.contextKey, {
      model: model.model,
      reasoningEffort: model.defaultReasoningEffort,
      serviceTier: model.defaultServiceTier,
    });
    await ctx.answerCallbackQuery({ text: `Выбрана ${model.displayName}` });
    await showRoot(ctx);
  });

  bot.callbackQuery("settings:effort", async (ctx) => {
    const state = await load(ctx);
    if (!state) return;
    const model = selectedModel(state.models, state.preferences);
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    for (const option of model?.supportedReasoningEfforts ?? []) {
      const active = option.reasoningEffort
        === (state.preferences.reasoningEffort ?? model?.defaultReasoningEffort);
      const label = effortLabel(option.reasoningEffort);
      keyboard.text(
        active ? { text: `${label} · выбрано`, style: "primary" } : label,
        `settings:effort:set:${option.reasoningEffort}`,
      ).row();
    }
    keyboard.text("Назад", "menu:settings");
    await showTextScreen(
      ctx,
      "<b>Рассуждения</b>\n\nЧем выше уровень, тем дольше и внимательнее Коди думает",
      "Рассуждения\n\nЧем выше уровень, тем дольше и внимательнее Коди думает",
      keyboard,
    );
  });

  bot.callbackQuery(/^settings:effort:set:([a-z0-9_-]+)$/, async (ctx) => {
    const state = await load(ctx);
    const model = state && selectedModel(state.models, state.preferences);
    const effort = ctx.match?.[1];
    if (!state || !effort || !model?.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) {
      await ctx.answerCallbackQuery({ text: "Этот уровень недоступен" }).catch(() => {});
      return;
    }
    await registry.setPreferences(state.contextKey, { reasoningEffort: effort });
    await ctx.answerCallbackQuery({ text: `Рассуждения: ${effortLabel(effort)}` });
    await showRoot(ctx);
  });

  bot.callbackQuery("settings:fast", async (ctx) => {
    const state = await load(ctx);
    const model = state && selectedModel(state.models, state.preferences);
    if (!state) return;
    const fast = model && findFastServiceTier(model);
    const available = Boolean(fast);
    const enabled = state.preferences.serviceTier === fast?.id;
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    if (available) {
      keyboard
        .text(
          enabled ? { text: "Включён · выбрано", style: "primary" } : "Включить",
          "settings:fast:set:on",
        )
        .row()
        .text(
          !enabled ? { text: "Выключен · выбрано", style: "primary" } : "Выключить",
          "settings:fast:set:off",
        )
        .row();
    }
    keyboard.text("Назад", "menu:settings");
    await showTextScreen(
      ctx,
      available
        ? "<b>Быстрый режим</b>\n\nУскоряет ответы модели и расходует лимит быстрее"
        : "<b>Быстрый режим</b>\n\nДля выбранной модели он недоступен",
      available
        ? "Быстрый режим\n\nУскоряет ответы модели и расходует лимит быстрее"
        : "Быстрый режим\n\nДля выбранной модели он недоступен",
      keyboard,
    );
  });

  bot.callbackQuery(/^settings:fast:set:(on|off)$/, async (ctx) => {
    const state = await load(ctx);
    const model = state && selectedModel(state.models, state.preferences);
    const fast = model && findFastServiceTier(model);
    if (!state || !model || !fast) {
      await ctx.answerCallbackQuery({ text: "Для этой модели быстрый режим недоступен" }).catch(() => {});
      return;
    }
    const enabled = ctx.match?.[1] === "on";
    await registry.setPreferences(state.contextKey, {
      serviceTier: enabled ? fast.id : model.defaultServiceTier,
    });
    await ctx.answerCallbackQuery({ text: enabled ? "Быстрый режим включён" : "Быстрый режим выключен" });
    const keyboard = new InlineKeyboard()
      .text(
        enabled ? { text: "Включён · выбрано", style: "primary" } : "Включить",
        "settings:fast:set:on",
      )
      .row()
      .text(
        !enabled ? { text: "Выключен · выбрано", style: "primary" } : "Выключить",
        "settings:fast:set:off",
      )
      .row()
      .text("Назад", "menu:settings");
    await showTextScreen(
      ctx,
      "<b>Быстрый режим</b>\n\nУскоряет ответы модели и расходует лимит быстрее",
      "Быстрый режим\n\nУскоряет ответы модели и расходует лимит быстрее",
      keyboard,
    );
  });

  bot.callbackQuery("settings:access", async (ctx) => {
    const state = await load(ctx);
    if (!state) return;
    await ctx.answerCallbackQuery();
    const current = accessKey(state.preferences);
    const keyboard = new InlineKeyboard();
    for (const item of [
      { key: "readonly", label: "Только чтение" },
      { key: "auto", label: "Автоматически" },
      { key: "full", label: "Полный доступ" },
    ] as const) {
      keyboard.text(
        item.key === current
          ? { text: `${item.label} · выбран`, style: "primary" }
          : item.key === "full"
            ? { text: item.label, style: "danger" }
            : item.label,
        `settings:access:set:${item.key}`,
      ).row();
    }
    keyboard.text("Назад", "menu:settings");
    await showTextScreen(
      ctx,
      "<b>Доступ</b>\n\nОпределяет, что Коди может делать на сервере без отдельного разрешения",
      "Доступ\n\nОпределяет, что Коди может делать на сервере без отдельного разрешения",
      keyboard,
    );
  });

  bot.callbackQuery(/^settings:access:set:(readonly|auto|full)$/, async (ctx) => {
    const state = await load(ctx);
    if (!state) return;
    const key = ctx.match?.[1];
    const patch: Partial<CodexPreferences> = key === "readonly"
      ? { sandboxMode: "read-only", approvalPolicy: "never" }
      : key === "full"
        ? { sandboxMode: "danger-full-access", approvalPolicy: "never" }
        : { sandboxMode: "workspace-write", approvalPolicy: "on-request" };
    await registry.setPreferences(state.contextKey, patch);
    await ctx.answerCallbackQuery({ text: `Доступ: ${accessLabel({ ...state.preferences, ...patch })}` });
    await showRoot(ctx);
  });
}

function accountLabel(state: Awaited<ReturnType<SessionRegistry["auth"]["read"]>> | null): string {
  if (!state) return "не удалось проверить";
  if (!state.ready) return "не подключён";
  if (state.managedByApiKey || state.account?.type === "apiKey") return "OpenAI API";
  if (state.account?.planType) {
    const plan = state.account.planType;
    return `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
  }
  return state.account ? "ChatGPT" : "готов";
}

function selectedModel(models: CodexModelOption[], preferences: CodexPreferences): CodexModelOption | undefined {
  return models.find((model) => model.model === preferences.model)
    ?? models.find((model) => model.isDefault)
    ?? models[0];
}

function effortLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    none: "Без рассуждений",
    minimal: "Минимальные",
    low: "Низкие",
    medium: "Средние",
    high: "Высокие",
    xhigh: "Очень высокие",
    max: "Максимальные",
    ultra: "Ультра",
  };
  return value ? labels[value] ?? value : "по умолчанию";
}

function accessKey(preferences: CodexPreferences): "readonly" | "auto" | "full" {
  if (preferences.sandboxMode === "read-only") return "readonly";
  if (preferences.sandboxMode === "danger-full-access") return "full";
  return "auto";
}

function accessLabel(preferences: CodexPreferences): string {
  const key = accessKey(preferences);
  return key === "readonly" ? "только чтение" : key === "full" ? "полный" : "автоматически";
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}
