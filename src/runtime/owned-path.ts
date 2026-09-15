import { lstatSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface OwnedPathIdentity { readonly dev: string; readonly ino: string; }
export type OwnedPathRemoval = "removed" | "missing" | "ownership_uncertain" | "pending";

function sameIdentity(actual: { readonly dev: number | bigint; readonly ino: number | bigint }, expected: OwnedPathIdentity): boolean {
  return String(actual.dev) === expected.dev && String(actual.ino) === expected.ino;
}

export function removeOwnedPath(root: string, relativePath: string, expected: OwnedPathIdentity): OwnedPathRemoval {
  if (!isAbsolute(root) || root === "/" || relativePath.length === 0 || isAbsolute(relativePath)) return "ownership_uncertain";
  const target = resolve(root, relativePath);
  const normalized = relative(root, target);
  if (normalized !== relativePath || normalized.startsWith("..") || isAbsolute(normalized)) return "ownership_uncertain";
  let parent = root;
  for (const component of relativePath.split("/").slice(0, -1)) {
    parent = resolve(parent, component);
    try {
      const info = lstatSync(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) return "ownership_uncertain";
    } catch { return "pending"; }
  }
  let info;
  try { info = lstatSync(target); } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "pending";
  }
  if (!sameIdentity(info, expected) || (info.mode & 0o077) !== 0) return "ownership_uncertain";
  try { rmSync(target, { recursive: info.isDirectory(), force: false }); } catch { return "pending"; }
  try { lstatSync(target); return "pending"; } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "removed" : "pending";
  }
}
