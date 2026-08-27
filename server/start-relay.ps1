# Keep-alive launcher for the Claude Glasses relay. Started hidden at logon.
# Exits immediately if a relay is already listening, otherwise runs node in a
# restart loop so a crash never leaves the glasses without a server.
$port = 8787
try {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop) { exit }
} catch { }

$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root "server\relay.log"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
Set-Location $root

while ($true) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
    Move-Item -Force $log "$log.old"
  }
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] starting relay" | Add-Content $log
  & $node "server\index.js" *>> $log
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] relay exited, restarting in 5s" | Add-Content $log
  Start-Sleep -Seconds 5
}
