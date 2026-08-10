import { InputFile, type Context } from "grammy";

import { collectArtifactReport, formatArtifactSummary } from "./artifacts.js";
import type { AutomationStore } from "./automation-store.js";
import type { CodyConfig } from "./config.js";
import { sendTextMessage, type TelegramChatId } from "./telegram-api.js";

export async function deliverArtifacts(
  api: Context["api"],
  config: CodyConfig,
  chatId: TelegramChatId,
  outDir: string,
  messageThreadId?: number,
): Promise<void> {
  const { artifacts, skippedCount } = await collectArtifactReport(
    outDir,
    config.telegramLocalMode ? config.maxFileSize : undefined,
  );
  if (artifacts.length === 0 && skippedCount === 0) return;

  await api.sendChatAction(chatId, "upload_document", {
    ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
  }).catch(() => {});

  let failedCount = 0;
  const delivered = [];
  for (const artifact of artifacts) {
    try {
      await api.sendDocument(chatId, new InputFile(artifact.localPath, artifact.name), {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      });
      delivered.push(artifact);
    } catch (error) {
      failedCount += 1;
      console.error(`Failed to send artifact ${artifact.name}:`, error);
    }
  }

  const summary = formatArtifactSummary(delivered, skippedCount, failedCount);
  if (summary) {
    await sendTextMessage(api, chatId, summary.html, {
      fallbackText: summary.plain,
      messageThreadId,
    });
  }
}

export async function deliverAutomationArtifacts(
  api: Context["api"],
  config: CodyConfig,
  store: AutomationStore,
  executionId: string,
  runnerId: string,
  chatId: TelegramChatId,
  outDir: string,
  messageThreadId?: number,
  summaryAlreadySent = false,
): Promise<void> {
  const report = await collectArtifactReport(
    outDir,
    config.telegramLocalMode ? config.maxFileSize : undefined,
  );
  const states = store.syncArtifactDeliveries(executionId, report.artifacts);
  const stateByName = new Map(states.map((state) => [state.artifactName, state]));
  if (report.artifacts.length > 0) {
    await api.sendChatAction(chatId, "upload_document", {
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    }).catch(() => {});
  }

  for (const artifact of report.artifacts) {
    const state = stateByName.get(artifact.name);
    if (state?.status === "delivered") continue;
    const claimed = store.claimArtifactDelivery(executionId, artifact.name);
    if (!claimed) {
      const current = store.listArtifactDeliveries(executionId)
        .find((candidate) => candidate.artifactName === artifact.name);
      if (current?.status === "delivered") continue;
      throw new Error(current?.lastError ?? `Файл «${artifact.name}» уже отправляется`);
    }
    try {
      const sent = await api.sendDocument(
        chatId,
        new InputFile(artifact.localPath, artifact.name),
        { ...(messageThreadId ? { message_thread_id: messageThreadId } : {}) },
      );
      store.finishArtifactDelivery(executionId, artifact.name, sent.message_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.finishArtifactDelivery(executionId, artifact.name, undefined, message);
      throw error;
    }
  }

  const summary = formatArtifactSummary(report.artifacts, report.skippedCount);
  if (summary && !summaryAlreadySent) {
    const sent = await sendTextMessage(api, chatId, summary.html, {
      fallbackText: summary.plain,
      messageThreadId,
    });
    store.markArtifactSummarySent(executionId, runnerId, sent.message_id);
  }
}
