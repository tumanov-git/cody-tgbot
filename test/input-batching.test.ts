import { vi } from "vitest";

import { mergeCodexPromptInputs, TaskController } from "../src/task-controller.js";

describe("Telegram input batching", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("merges text, images and staged files without losing their order", () => {
    expect(mergeCodexPromptInputs([
      "сделай сайт",
      { text: "вот референс", imagePaths: ["/tmp/one.png"] },
      { stagedFileInstructions: "file: /tmp/brief.pdf" },
      { text: "цвета возьми светлые", imagePaths: ["/tmp/two.png"] },
    ])).toEqual({
      text: "сделай сайт\n\nвот референс\n\nцвета возьми светлые",
      imagePaths: ["/tmp/one.png", "/tmp/two.png"],
      stagedFileInstructions: "file: /tmp/brief.pdf",
    });
  });

  it("waits one second after the latest message", async () => {
    vi.useFakeTimers();
    const controller = makeController();
    const enqueue = vi.spyOn(controller, "enqueueFromOrigin").mockResolvedValue(receipt());

    controller.enqueueUserInputFromOrigin(origin(1), "42", 42, session(), "первая");
    await vi.advanceTimersByTimeAsync(800);
    controller.enqueueUserInputFromOrigin(origin(2), "42", 42, session(), "вторая");
    await vi.advanceTimersByTimeAsync(999);
    expect(enqueue).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[4]).toEqual({ text: "первая\n\nвторая" });
  });

  it("flushes after three seconds even while messages keep arriving", async () => {
    vi.useFakeTimers();
    const controller = makeController();
    const enqueue = vi.spyOn(controller, "enqueueFromOrigin").mockResolvedValue(receipt());

    controller.enqueueUserInputFromOrigin(origin(1), "42", 42, session(), "1");
    await vi.advanceTimersByTimeAsync(900);
    controller.enqueueUserInputFromOrigin(origin(2), "42", 42, session(), "2");
    await vi.advanceTimersByTimeAsync(900);
    controller.enqueueUserInputFromOrigin(origin(3), "42", 42, session(), "3");
    await vi.advanceTimersByTimeAsync(900);
    controller.enqueueUserInputFromOrigin(origin(4), "42", 42, session(), "4");
    await vi.advanceTimersByTimeAsync(299);
    expect(enqueue).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

function makeController(): TaskController {
  const bot = { api: {} };
  const registry = {
    get: () => ({ isProcessing: () => true }),
  };
  return new TaskController(
    bot as never,
    { workspace: "/tmp/cody-input-batching", maxParallelCodexTasks: 1 } as never,
    registry as never,
  );
}

function session() {
  return {
    getCurrentWorkspace: () => "/tmp/cody-input-batching",
    getInfo: () => ({}),
  } as never;
}

function origin(updateId: number) {
  return { updateId, privateChat: true };
}

function receipt() {
  return { id: "task-1", position: 1, startedImmediately: true, maxParallel: 1 };
}
