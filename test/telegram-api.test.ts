import { readFile, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { Context } from "grammy";

import { downloadTelegramFile } from "../src/telegram-api.js";

describe("downloadTelegramFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams a remote Telegram file to disk", async () => {
    const api = {
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/example.bin" }),
    } as unknown as Context["api"];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("hello")));

    const downloaded = await downloadTelegramFile(api, "token", "file-id", { maxBytes: 10 });
    try {
      expect(await readFile(downloaded, "utf8")).toBe("hello");
    } finally {
      await unlink(downloaded).catch(() => {});
    }
  });

  it("stops an oversized stream and removes the partial file", async () => {
    const before = await temporaryDownloads();
    const api = {
      getFile: vi.fn().mockResolvedValue({ file_path: "documents/large.bin" }),
    } as unknown as Context["api"];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("0123456789abcdef")));

    await expect(
      downloadTelegramFile(api, "token", "file-id", { maxBytes: 8 }),
    ).rejects.toThrow("превышает настроенный предел");

    expect(await temporaryDownloads()).toEqual(before);
  });
});

async function temporaryDownloads(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("cody-tgbot-file-"))
    .sort();
}
