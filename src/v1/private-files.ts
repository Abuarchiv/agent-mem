import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";

/** Private data excludes other users; assets permit only their known read/execute rights. */
export function isPrivateWindowsAcl(value: unknown, mode: "private" | "asset" = "private"): boolean {
  if (!value || typeof value !== "object" || !("owner" in value) || !("user" in value) || !("rules" in value)) return false;
  if (typeof value.user !== "string" || !/^S-\d+(?:-\d+)+$/.test(value.user) || value.owner !== value.user || !Array.isArray(value.rules)) return false;
  const allowed = new Set([value.user, "S-1-5-18", "S-1-5-32-544"]);
  const readExecute = 0x1200a9; // FileSystemRights.ReadAndExecute | Synchronize; no write/delete/ACL rights.
  const ownerRights = mode === "asset" ? 1 : 2032127; // ReadData/ListDirectory vs FullControl.
  let ownerAccess = false;
  for (const rule of value.rules) {
    if (!rule || typeof rule !== "object" || typeof rule.sid !== "string" || !/^S-\d+(?:-\d+)+$/.test(rule.sid) || rule.allow !== true || !Number.isSafeInteger(rule.rights) || rule.rights <= 0 || typeof rule.inheritOnly !== "boolean") return false;
    // A whitelist also rejects generic/unknown rights and large values that would truncate in bitwise operations.
    if (!allowed.has(rule.sid) && (mode === "private" || (rule.rights & readExecute) !== rule.rights)) return false;
    if (rule.sid === value.user && !rule.inheritOnly && (rule.rights & ownerRights) === ownerRights) ownerAccess = true;
  }
  return ownerAccess;
}

function windowsAcl(path: string, initialize = false, mode: "private" | "asset" = "private"): void {
  const script = `$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
${initialize ? `# Only a newly created, empty application directory is changed.
$existing = Get-Acl -LiteralPath $env:AGENT_MEMORY_PRIVATE_PATH
if (@(Get-ChildItem -LiteralPath $env:AGENT_MEMORY_PRIVATE_PATH -Force).Count -ne 0) { throw 'new_private_directory_unverified' }
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $env:AGENT_MEMORY_PRIVATE_PATH -AclObject $acl
` : ""}$acl = Get-Acl -LiteralPath $env:AGENT_MEMORY_PRIVATE_PATH
$rules = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow'); rights = [int]$_.FileSystemRights; inheritOnly = (($_.PropagationFlags -band 2) -ne 0) }
})
@{ owner = $acl.GetOwner($sidType).Value; user = $user.Value; rules = $rules } | ConvertTo-Json -Depth 4 -Compress
`;
  try {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error("windows_system_root_missing");
    const output = execFileSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, AGENT_MEMORY_PRIVATE_PATH: resolve(path) }, encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    if (!isPrivateWindowsAcl(JSON.parse(output.replace(/^\uFEFF/, "")), mode)) throw new Error("windows_acl_not_safe");
  } catch { throw new Error(`windows_${mode}_acl_unverified`); }
}

/** Also checks an opened descriptor still names the same non-symlink entry. */
export function assertPrivatePath(path: string, opened?: Stats, errorCode = "private_path_unverified", mode: "private" | "asset" = "private"): void {
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory()) || (opened && (opened.dev !== before.dev || opened.ino !== before.ino))) throw new Error(errorCode);
    if (process.platform === "win32") windowsAcl(path, false, mode);
    else if ((before.mode & (mode === "asset" ? 0o022 : 0o077)) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new Error(errorCode);
    const after = lstatSync(path);
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new Error(errorCode);
  } catch (cause) { throw new Error(errorCode, { cause }); }
}

export function ensurePrivateDirectory(directory: string): void {
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("data_directory_must_be_owned_and_private");
  if (process.platform === "win32" && (!existed || readdirSync(directory).length === 0)) windowsAcl(directory, true);
  assertPrivatePath(directory, info, "data_directory_must_be_owned_and_private");
}
