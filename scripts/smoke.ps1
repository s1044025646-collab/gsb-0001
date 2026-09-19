# End-to-end smoke test: boots the server, starts the demo workflow, prints status.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Remove-Item data\*.db* -ErrorAction SilentlyContinue
$env:PORT = "5180"
$env:WF_WORKERS = "2"
$env:WF_CONCURRENCY = "2"

$proc = Start-Process node -ArgumentList "--import", "tsx", "server/index.ts" -PassThru -WindowStyle Hidden
try {
  Start-Sleep -Seconds 4
  Invoke-RestMethod http://localhost:5180/api/health | Out-Null
  Write-Host "health OK"

  $r1 = Invoke-RestMethod -Method Post -Uri http://localhost:5180/api/runs -ContentType "application/json" -Body '{"workflowId":"demo-pipeline","idempotencyKey":"smoke"}'
  $r2 = Invoke-RestMethod -Method Post -Uri http://localhost:5180/api/runs -ContentType "application/json" -Body '{"workflowId":"demo-pipeline","idempotencyKey":"smoke"}'
  Write-Host "idempotent duplicated = $($r2.duplicated), sameRun = $($r1.runId -eq $r2.runId)"

  Start-Sleep -Seconds 7
  $d = Invoke-RestMethod "http://localhost:5180/api/runs/$($r1.runId)"
  Write-Host "RUN STATUS: $($d.run.status)"
  $d.execs | ForEach-Object {
    Write-Host ("  {0,-8} {1,-9} attempt={2} out={3}" -f $_.node_id, $_.status, $_.attempt, $_.output)
  }
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
