$ErrorActionPreference = 'SilentlyContinue'

$backup = Join-Path $env:APPDATA 'FocusLock\dns-backup.json'
if (-not (Test-Path $backup)) {
  exit 0
}

try {
  $b = Get-Content $backup -Raw | ConvertFrom-Json
  $target = $b.target
  $servers = @($b.servers)

  if ($b.mode -eq 'dhcp' -or $servers.Count -eq 0) {
    & netsh interface ip set dns name="$target" dhcp | Out-Null
  } else {
    & netsh interface ip set dns name="$target" static $servers[0] | Out-Null
    for ($i = 1; $i -lt $servers.Count; $i++) {
      & netsh interface ip add dns name="$target" $servers[$i] | Out-Null
    }
  }
} catch {
  # Leave the backup in place if the restore failed so it is not lost; a
  # later uninstall attempt (or the app) can still recover the resolvers.
  exit 0
}

Remove-Item $backup -Force
exit 0