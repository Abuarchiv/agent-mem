param(
  [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath $Root).Path
$sourceRoot = if (Test-Path -LiteralPath (Join-Path $root 'src/models')) { Join-Path $root 'src/models' } else { Join-Path $root 'dist-v1/src/models' }
$manifests = @(
  (Join-Path $sourceRoot 'model-manifest.json'),
  (Join-Path $sourceRoot 'rerank-manifest.json')
)
$modelRoots = foreach ($manifestPath in $manifests) {
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $profile = if ($manifestPath -like '*rerank-manifest.json') { 'rerank' } else { 'e5' }
  $modelPath = ($manifest.model_id -split '/') -join [System.IO.Path]::DirectorySeparatorChar
  Join-Path (Join-Path (Join-Path (Join-Path $root '.models') $profile) $modelPath) $manifest.revision
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$trustedSids = @(
  $user.Value,
  'S-1-5-18',
  'S-1-5-32-544'
)

foreach ($modelRoot in $modelRoots) {
  $paths = @($modelRoot) + @(Get-ChildItem -LiteralPath $modelRoot -Recurse -Force | ForEach-Object { $_.FullName })
  foreach ($path in $paths) {
    $item = Get-Item -LiteralPath $path
    $isDirectory = $item.PSIsContainer
    $acl = if ($isDirectory) {
      [System.Security.AccessControl.DirectorySecurity]::new()
    } else {
      [System.Security.AccessControl.FileSecurity]::new()
    }
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = if ($isDirectory) {
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
      [System.Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($sidValue in $trustedSids) {
      $identity = [System.Security.Principal.SecurityIdentifier]::new($sidValue)
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
      )
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
  }
}
