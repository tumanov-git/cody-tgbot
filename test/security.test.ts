import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isWithinAnyDirectory,
  isWithinDirectory,
  requireWithinAnyDirectory,
  requireWithinDirectory,
} from "../src/security.js";

describe("security helpers", () => {
  it("accepts paths inside the approved directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cody-tgbot-security-"));

    try {
      expect(isWithinDirectory(path.join(root, "repo"), root)).toBe(true);
      expect(requireWithinDirectory(path.join(root, "repo"), root)).toBe(path.join(root, "repo"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects paths outside the approved directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cody-tgbot-security-"));
    const outside = path.dirname(root);

    try {
      expect(isWithinDirectory(outside, root)).toBe(false);
      expect(() => requireWithinDirectory(outside, root, "workspace")).toThrow(
        "workspace must stay inside APPROVED_DIRECTORY",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts paths inside any approved directory", () => {
    const firstRoot = mkdtempSync(path.join(tmpdir(), "cody-tgbot-security-a-"));
    const secondRoot = mkdtempSync(path.join(tmpdir(), "cody-tgbot-security-b-"));

    try {
      const candidate = path.join(secondRoot, "repo");
      expect(isWithinAnyDirectory(candidate, [firstRoot, secondRoot])).toBe(true);
      expect(requireWithinAnyDirectory(candidate, [firstRoot, secondRoot], "workspace")).toBe(candidate);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that escapes the approved directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cody-tgbot-security-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "cody-tgbot-security-outside-"));

    try {
      mkdirSync(path.join(outside, "project"));
      symlinkSync(path.join(outside, "project"), path.join(root, "linked-project"));
      expect(isWithinDirectory(path.join(root, "linked-project"), root)).toBe(false);
      expect(() => requireWithinDirectory(path.join(root, "linked-project"), root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
