import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { assertPrivatePath } from "./private-files.js";

/** Single local owner; a dead process's private lock can be recovered after a crash. */
export function acquireOwnerLock(directory: string, installationId: string, fileName: "owner.lock" | "config.lock" = "owner.lock"): () => void {
  assertPrivatePath(directory, undefined, "owner_lock_unverified");
  const path = join(directory, fileName);
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const reader = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let info: ReturnType<typeof fstatSync>;
    try {
      info = fstatSync(reader);
      if (!info.isFile() || info.size > 1024) throw new Error("owner_lock_unverified");
      assertPrivatePath(path, info, "owner_lock_unverified");
      let lock: unknown;
      try { lock = JSON.parse(readFileSync(reader, "utf8")) as unknown; }
      catch { throw new Error(fileName === "config.lock" ? "configuration_busy_retry" : "owner_lock_unverified"); }
      if (!lock || typeof lock !== "object" || !("installation_id" in lock) || lock.installation_id !== installationId || !("pid" in lock) || typeof lock.pid !== "number" || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error("owner_lock_unverified");
      try { process.kill(lock.pid, 0); }
      catch (probeError) {
        if (!(probeError instanceof Error && "code" in probeError && probeError.code === "ESRCH")) throw new Error("owner_lock_unverified");
        const current = lstatSync(path);
        if (current.dev !== info.dev || current.ino !== info.ino) throw new Error("owner_lock_changed");
        unlinkSync(path);
        return acquireOwnerLock(directory, installationId, fileName);
      }
      throw new Error(fileName === "config.lock" ? "configuration_busy_retry" : "v1_backend_already_running");
    } finally { closeSync(reader); }
  }
  let identity: ReturnType<typeof fstatSync>;
  try {
    assertPrivatePath(path, fstatSync(fd), "owner_lock_unverified");
    writeFileSync(fd, JSON.stringify({ installation_id: installationId, pid: process.pid }) + "\n");
    fsyncSync(fd); identity = fstatSync(fd);
  } finally { closeSync(fd); }
  return () => {
    if (!existsSync(path)) return;
    const current = lstatSync(path);
    if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("owner_lock_changed");
    unlinkSync(path);
  };
}

/** Called only while holding the owner lock; never unlink a listening or unverified endpoint. */
export async function clearStaleSocket(path: string): Promise<void> {
  if (process.platform === "win32") return;
  if (!existsSync(path)) return;
  const before = lstatSync(path);
  if (!before.isSocket() || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new Error("socket_unverified");
  const live = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("socket_probe_timeout")); }, 1000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", error => {
      clearTimeout(timer); socket.destroy();
      if ("code" in error && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) resolve(false);
      else reject(new Error("socket_unverified"));
    });
  });
  if (live) throw new Error("v1_backend_already_running");
  if (!existsSync(path)) return;
  const current = lstatSync(path);
  if (!current.isSocket() || current.dev !== before.dev || current.ino !== before.ino) throw new Error("socket_changed");
  unlinkSync(path);
}
