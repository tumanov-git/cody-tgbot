import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  classifyAutomationFailure,
  preflightAutomationWorkspace,
} from "../src/automation-preflight.js";

describe("automation preflight", () => {
  it("classifies configuration, temporary and runtime failures", () => {
    expect(classifyAutomationFailure(new Error("invalid API key"))).toBe("blocked_config");
    expect(classifyAutomationFailure(new Error("429 too many requests"))).toBe("transient");
    expect(classifyAutomationFailure(new Error("test assertion failed"))).toBe("runtime");
  });

  it("accepts a writable project and blocks a missing workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cody-preflight-test-"));
    const workspace = path.join(root, "project");
    await mkdir(workspace);
    await expect(preflightAutomationWorkspace(workspace)).resolves.toBeUndefined();
    await rm(workspace, { recursive: true, force: true });
    await expect(preflightAutomationWorkspace(workspace)).rejects.toThrow("больше не существует");
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  });
});
