import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";

import { pathAncestors } from "../src/store/backup.js";

test("backup ancestor checks honor POSIX and Windows separators", () => {
  assert.deepEqual(pathAncestors("/tmp/agent-memory/backups", posix), [
    "/tmp",
    "/tmp/agent-memory",
    "/tmp/agent-memory/backups",
  ]);
  assert.deepEqual(pathAncestors("C:\\Users\\abu\\backups", win32), [
    "C:\\Users",
    "C:\\Users\\abu",
    "C:\\Users\\abu\\backups",
  ]);
});
