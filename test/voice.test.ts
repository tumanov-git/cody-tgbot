import { vi } from "vitest";

const dictation = vi.hoisted(() => ({
  transcribe: vi.fn(),
}));

vi.mock("../src/codex-dictation.js", () => ({
  transcribeWithCodexDictation: dictation.transcribe,
}));

import {
  _resetFasterWhisperHook,
  _setFasterWhisperHook,
  buildVoiceAgentPrompt,
  transcribeAudio,
} from "../src/voice.js";

describe("voice transcription", () => {
  afterEach(() => {
    dictation.transcribe.mockReset();
    _resetFasterWhisperHook();
  });

  it("uses Codex dictation first", async () => {
    dictation.transcribe.mockResolvedValue({ text: "привет", durationMs: 12 });
    const whisper = vi.fn();
    _setFasterWhisperHook(whisper);

    await expect(transcribeAudio("/tmp/voice.ogg")).resolves.toMatchObject({
      text: "привет",
      backend: "codex",
    });
    expect(whisper).not.toHaveBeenCalled();
  });

  it("falls back only to faster-whisper", async () => {
    dictation.transcribe.mockRejectedValue(new Error("dictation unavailable"));
    _setFasterWhisperHook(async () => ({
      text: "резервная расшифровка",
      backend: "faster-whisper",
      durationMs: 25,
      detail: "medium / ru / int8",
    }));

    await expect(transcribeAudio("/tmp/voice.ogg")).resolves.toMatchObject({
      text: "резервная расшифровка",
      backend: "faster-whisper",
      detail: "medium / ru / int8 / fallback after Codex dictation error",
    });
  });

  it("reports both failures without exposing another provider path", async () => {
    dictation.transcribe.mockRejectedValue(new Error("dictation unavailable"));
    _setFasterWhisperHook(async () => {
      throw new Error("whisper unavailable");
    });

    await expect(transcribeAudio("/tmp/voice.ogg")).rejects.toThrow(
      "Codex и faster-whisper",
    );
  });

  it("marks speech recognition text as fallible context", () => {
    const prompt = buildVoiceAgentPrompt("Radal Zayn");

    expect(prompt).toContain("автоматическим распознаванием речи");
    expect(prompt).toContain("коротко переспроси пользователя");
    expect(prompt).toContain("Radal Zayn");
  });
});
