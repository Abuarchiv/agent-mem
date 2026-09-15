import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function canonicalDestination(path: string): string {
  const output = resolve(path);
  let ancestor = dirname(output);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, output));
}

/** Copy only files inside the owned source tree; reject symlink escapes and cycles. */
export function copyOwnedTree(source: string, target: string, skip: (relativePath: string) => boolean = () => false): void {
  const root = realpathSync(source);
  const canonicalOutput = canonicalDestination(target);
  assert.ok(!inside(root, canonicalOutput), "package_destination_inside_source");

  const visit = (input: string, output: string, rel: string, ancestors: Set<string>): void => {
    if (skip(rel)) return;
    const actual = realpathSync(input);
    assert.ok(inside(root, actual), "package_symlink_escape");
    const stat = lstatSync(actual);
    if (stat.isDirectory()) {
      assert.ok(!ancestors.has(actual), "package_symlink_cycle");
      mkdirSync(output, { recursive: true, mode: 0o700 });
      const next = new Set(ancestors).add(actual);
      for (const name of readdirSync(actual).sort()) visit(join(actual, name), join(output, name), rel ? `${rel}/${name}` : name, next);
      return;
    }
    assert.ok(stat.isFile(), "package_file_type_invalid");
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    copyFileSync(actual, output);
    chmodSync(output, stat.mode & 0o111 ? 0o755 : 0o644);
  };

  visit(source, target, "", new Set());
}
