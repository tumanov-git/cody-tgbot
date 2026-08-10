import { buildRestartRecoveryInput, renderQueueMessage } from "../src/task-controller.js";
import type { RuntimeJob } from "../src/runtime-jobs.js";

describe("queue UI", () => {
  it("renders the queued request with a premium gift and an ordinary blockquote", () => {
    const rendered = renderQueueMessage("проверь <бота>");

    expect(rendered.html).toContain('emoji-id="5449700997632925464"');
    expect(rendered.html).toContain("<b>Поставил в очередь:</b>");
    expect(rendered.html).toContain("<blockquote>проверь &lt;бота&gt;</blockquote>");
    expect(rendered.html).not.toContain("<i>");
    expect(rendered.plain).not.toMatch(/[🎁⚠️🧾↪️]/u);
  });

});

describe("restart recovery input", () => {
  it("continues the same thread while preserving staged images and file instructions", () => {
    const job: RuntimeJob = {
      id: "task-11111111-1111-4111-8111-111111111111",
      status: "running",
      contextKey: "123",
      chatId: 123,
      userInput: {
        text: "проверь эти материалы",
        imagePaths: ["/workspace/inbox/photo.webp"],
        stagedFileInstructions: "file: /workspace/inbox/report.pdf",
      },
      displayText: "проверь эти материалы",
      workspace: "/workspace",
      createdAt: "2026-08-07T19:00:00.000Z",
      updateId: 10,
      privateChat: true,
      resumeThreadId: "thread-1",
    };

    expect(buildRestartRecoveryInput(job)).toEqual({
      text: expect.stringContaining("перезапустился во время выполнения"),
      imagePaths: ["/workspace/inbox/photo.webp"],
      stagedFileInstructions: "file: /workspace/inbox/report.pdf",
    });
  });
});
