import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/**
 * The Unix socket is a private filesystem entry. Windows uses a named pipe;
 * named pipes are not regular files and therefore must not be lstat/unlinked.
 */
export function ipcEndpointPath(directory: string, platform = process.platform): string {
  const root = resolve(directory);
  if (platform === "win32") {
    const digest = createHash("sha256").update(root, "utf8").digest("hex").slice(0, 32);
    return `\\\\.\\pipe\\agent-mem-${digest}`;
  }
  return join(root, "broker.sock");
}
