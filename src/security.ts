import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function isWithinDirectory(candidate: string, root: string): boolean {
  const paths = resolveBoundaryPaths(candidate, root);
  return paths.relative === "" || (!paths.relative.startsWith("..") && !paths.isRelativeAbsolute);
}

export function isWithinAnyDirectory(candidate: string, roots: string[]): boolean {
  return roots.some((root) => isWithinDirectory(candidate, root));
}

export function requireWithinDirectory(candidate: string, root: string, label = "path"): string {
  const paths = resolveBoundaryPaths(candidate, root);
  if (paths.relative !== "" && (paths.relative.startsWith("..") || paths.isRelativeAbsolute)) {
    throw new Error(`${label} must stay inside APPROVED_DIRECTORY`);
  }
  return paths.candidate;
}

export function requireWithinAnyDirectory(candidate: string, roots: string[], label = "path"): string {
  const resolvedCandidate = resolvePhysicalPath(candidate);
  if (!roots.some((root) => isWithinDirectory(resolvedCandidate, root))) {
    throw new Error(`${label} must stay inside APPROVED_DIRECTORIES`);
  }
  return resolvedCandidate;
}

function resolveBoundaryPaths(candidate: string, root: string): {
  candidate: string;
  relative: string;
  isRelativeAbsolute: boolean;
} {
  const resolvedCandidate = resolvePhysicalPath(candidate);
  const resolvedRoot = resolvePhysicalPath(root);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return {
    candidate: resolvedCandidate,
    relative,
    isRelativeAbsolute: path.isAbsolute(relative),
  };
}

function resolvePhysicalPath(value: string): string {
  const unresolved: string[] = [];
  let current = path.resolve(value);

  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    unresolved.unshift(path.basename(current));
    current = parent;
  }

  let canonical = current;
  try {
    canonical = realpathSync.native(current);
  } catch {
    canonical = path.resolve(current);
  }
  return path.resolve(canonical, ...unresolved);
}
