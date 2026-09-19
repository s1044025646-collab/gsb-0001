$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:PORT = "5191"
$proc = Start-Process node -ArgumentList "--import", "tsx", "server/index.ts" -PassThru -WindowStyle Hidden
try {
  Start-Sleep -Seconds 4
  $health = Invoke-RestMethod http://localhost:5191/api/health
  $page = Invoke-WebRequest http://localhost:5191/ -UseBasicParsing
  Write-Host "health=$($health.ok) rootHttp=$($page.StatusCode) hasRootDiv=$($page.Content -match 'id=.root.')"
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
