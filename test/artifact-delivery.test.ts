import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { artifactInputFile } from "../src/artifact-delivery.js";

describe("artifactInputFile", () => {
  it("adds a UTF-8 BOM to Markdown uploads for Telegram text preview", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cody-markdown-"));
    const file = path.join(directory, "result.md");
    await writeFile(file, "# Привет\n", "utf8");

    const raw = await artifactInputFile(file, "result.md").toRaw();
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(raw as Uint8Array).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(Buffer.from(raw as Uint8Array).toString("utf8")).toBe("\ufeff# Привет\n");
  });
});
