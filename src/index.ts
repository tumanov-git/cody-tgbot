import path from "node:path";

import { Api } from "grammy";

import { createBot, registerCommands } from "./bot.js";
import { maintainAutomations } from "./automation-maintenance.js";
import { AutomationRunner } from "./automation-runner.js";
import { AutomationScheduler } from "./automation-scheduler.js";
import { AutomationStore } from "./automation-store.js";
import {
  AUTOMATION_DEVELOPER_INSTRUCTIONS,
  AUTOMATION_DYNAMIC_TOOL,
  AutomationToolRuntime,
} from "./automation-tools.js";
import { loadConfig, type CodyConfig } from "./config.js";
import {
  MANAGED_BOT_DEVELOPER_INSTRUCTIONS,
  MANAGED_BOT_DYNAMIC_TOOL,
  ManagedBotService,
} from "./managed-bots.js";
import { PROJECT_DEVELOPER_INSTRUCTIONS, PROJECT_DYNAMIC_TOOLS, ProjectToolRuntime } from "./project-tools.js";
import { CodexProjectAvatarGenerator, ProjectAvatarService } from "./project-avatar.js";
import { ProjectStore } from "./project-store.js";
import { ProjectWorkLock } from "./project-work-lock.js";
import { SessionRegistry } from "./session-registry.js";
import {
  TELEGRAM_CHANNEL_DEVELOPER_INSTRUCTIONS,
  TELEGRAM_CHANNEL_DYNAMIC_TOOL,
  TelegramChannelToolRuntime,
} from "./telegram-channel.js";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let config: CodyConfig | undefined;
let projectStore: ProjectStore | undefined;
let projectAvatars: ProjectAvatarService | undefined;
let managedBots: ManagedBotService | undefined;
let automationStore: AutomationStore | undefined;
let automationScheduler: AutomationScheduler | undefined;
let unsubscribeAuth: (() => void) | undefined;

try {
  config = loadConfig();
  projectStore = new ProjectStore({
    rootDirectory: `${config.workspace}/.cody-tgbot/projects`,
    approvedDirectories: config.approvedDirectories,
  });
  projectAvatars = new ProjectAvatarService(projectStore, {
    generator: new CodexProjectAvatarGenerator({
      canonicalReferences: [
        path.resolve(process.cwd(), "assets/cody/reference-primary.png"),
        path.resolve(process.cwd(), "assets/cody/reference-full.png"),
      ],
    }),
  });
  await projectAvatars.start();
  const telegramApi = new Api(config.telegramBotToken, { apiRoot: config.telegramApiRoot });
  managedBots = new ManagedBotService({
    rootDirectory: `${config.workspace}/.cody-tgbot/managed-bots`,
    api: telegramApi,
    projectStore,
    resolveContext: (threadId) => registry?.findContextByThreadId(threadId),
  });
  const projectTools = new ProjectToolRuntime(projectStore, projectAvatars);
  const projectWorkLock = new ProjectWorkLock();
  automationStore = new AutomationStore(`${config.workspace}/.cody-tgbot/automations.db`, {
    defaultTimezone: config.automationTimezone,
    minimumIntervalMinutes: config.automationMinIntervalMinutes,
    maxActivePerChat: config.maxActiveAutomations,
  });
  const automationRunner = new AutomationRunner({
    api: telegramApi,
    config,
    store: automationStore,
    projectStore,
    projectTools,
    projectWorkLock,
  });
  automationScheduler = new AutomationScheduler({
    store: automationStore,
    runner: automationRunner,
    maxParallel: config.maxParallelAutomations,
    maintenance: async () => {
      const cleaned = await maintainAutomations(automationStore!, projectStore!);
      if (cleaned.executionsRemoved > 0 || cleaned.runDirectoriesRemoved > 0) {
        console.log(
          `Automation cleanup: ${cleaned.executionsRemoved} runs, ${cleaned.runDirectoriesRemoved} directories`,
        );
      }
    },
    onRecovery: (recovery) => {
      if (recovery.requeued.length > 0 || recovery.unknown > 0 || recovery.deliveriesReset > 0) {
        console.log(
          `Automation recovery: ${recovery.requeued.length} queued, ${recovery.unknown} unknown, ${recovery.deliveriesReset} deliveries`,
        );
      }
    },
  });
  const automationTools = new AutomationToolRuntime({
    store: automationStore,
    scheduler: automationScheduler,
    projectStore,
    resolveContext: (threadId) => registry?.findContextByThreadId(threadId),
    defaultTimezone: config.automationTimezone,
  });
  const telegramChannels = new TelegramChannelToolRuntime();
  registry = new SessionRegistry(config, {
    dynamicTools: [
      ...PROJECT_DYNAMIC_TOOLS,
      MANAGED_BOT_DYNAMIC_TOOL,
      AUTOMATION_DYNAMIC_TOOL,
      TELEGRAM_CHANNEL_DYNAMIC_TOOL,
    ],
    developerInstructions: [
      PROJECT_DEVELOPER_INSTRUCTIONS,
      MANAGED_BOT_DEVELOPER_INSTRUCTIONS,
      AUTOMATION_DEVELOPER_INSTRUCTIONS,
      TELEGRAM_CHANNEL_DEVELOPER_INSTRUCTIONS,
    ].join("\n\n"),
    dynamicToolHandler: (params) => (
      params.tool === MANAGED_BOT_DYNAMIC_TOOL.name
        ? managedBots!.handleTool(params)
        : params.tool === AUTOMATION_DYNAMIC_TOOL.name
          ? automationTools.handle(params)
          : params.tool === TELEGRAM_CHANNEL_DYNAMIC_TOOL.name
            ? telegramChannels.handle(params)
        : projectTools.handle(params)
    ),
  });
  bot = createBot(
    config,
    registry,
    projectStore,
    managedBots,
    automationStore,
    automationScheduler,
    projectWorkLock,
  );
  await registerCommands(bot);
  let tasksRecovered = false;
  let taskRecovery: Promise<void> | undefined;
  const recoverTasks = (): Promise<void> => {
    if (tasksRecovered) return Promise.resolve();
    if (taskRecovery) return taskRecovery;
    taskRecovery = bot!.codyTasks.recover()
      .then(() => {
        tasksRecovered = true;
      })
      .finally(() => {
        taskRecovery = undefined;
      });
    return taskRecovery;
  };
  const initialAuth = await registry.auth.read().catch(() => null);
  automationScheduler.setLaunchEnabled(Boolean(initialAuth?.ready));
  if (initialAuth?.ready) await recoverTasks();
  unsubscribeAuth = registry.auth.onAuthChanged((state) => {
    automationScheduler?.setLaunchEnabled(state.ready);
    if (state.ready) {
      void recoverTasks().catch((error) => {
        console.error("Deferred task recovery failed:", error);
      });
    }
  });
  await bot.codyAuth.recover();
  await bot.codyMediaGroups.recover();

  console.log("cody-tgbot running");
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Approved directories: ${config.approvedDirectories.join(", ")}`);
  if (config.codexModel) {
    console.log(`Default model: ${config.codexModel}`);
  }
  console.log(`Codex launch: ${config.codexSandboxMode} / ${config.codexApprovalPolicy}`);
  console.log("Session mode: per Telegram context");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start cody-tgbot: ${message}`);
  registry?.disposeAll();
  projectAvatars?.dispose();
  automationScheduler?.dispose();
  automationStore?.close();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down cody-tgbot...`);
  bot?.codyTasks.prepareShutdown();
  bot?.codyMediaGroups.dispose();
  bot?.codyAuth.dispose();
  unsubscribeAuth?.();
  projectAvatars?.dispose();
  automationScheduler?.dispose();
  if (bot) bot.stop();

  setTimeout(() => {
    registry?.disposeAll();
    console.log("cody-tgbot stopped.");
    process.exit(0);
  }, 500);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function startPolling(): Promise<void> {
  try {
    await bot!.start({
      drop_pending_updates: false,
      onStart: () => {
        restartAttempts = 0;
        automationScheduler?.start();
      },
    });
  } catch (error) {
    if (shuttingDown) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const is409 = message.includes("409") || message.includes("Conflict");

    if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts += 1;
      console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      return startPolling();
    }

    console.error(`Fatal polling error: ${message}`);
    registry?.disposeAll();
    process.exit(1);
  }
}

await startPolling();
