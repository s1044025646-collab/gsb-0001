# Crash-recovery demo.
# 1) Starts the engine with a single slow node.
# 2) Starts a run, waits until the child is running, then KILLS the server (simulating power loss).
# 3) Restarts the engine: the orphan process is killed, the lease is released, and the run finishes.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Remove-Item data\*.db* -ErrorAction SilentlyContinue
$env:PORT = "5190"
$env:WF_WORKERS = "1"
$env:WF_CONCURRENCY = "1"

function Start-Engine {
  $p = Start-Process node -ArgumentList "--import", "tsx", "server/index.ts" -PassThru -WindowStyle Hidden -RedirectStandardError "data\boot.err" -RedirectStandardOutput "data\boot.out"
  return $p
}

# install a slow workflow through the API
$proc = Start-Engine
try {
  Start-Sleep -Seconds 4
  $wf = @'
{"id":"crash","name":"crash","nodes":[{"id":"slow","kind":"task","label":"slow","position":{"x":100,"y":100},"config":{"command":"node","args":["-e","setTimeout(()=>console.log('survived'),20000)"],"timeoutMs":60000}}],"edges":[]}
'@
  Invoke-RestMethod -Method Put -Uri http://localhost:5190/api/workflows -ContentType "application/json" -Body $wf | Out-Null
  $r = Invoke-RestMethod -Method Post -Uri http://localhost:5190/api/runs -ContentType "application/json" -Body '{"workflowId":"crash"}'
  Write-Host "run started: $($r.runId)"
  Start-Sleep -Seconds 3
  $d = Invoke-RestMethod "http://localhost:5190/api/runs/$($r.runId)"
  Write-Host "before crash -> $($d.execs[0].status), live child processes tracked"
} finally {
  Stop-Process -Id $proc.Id -Force
}
Write-Host "server force-killed (simulated crash)"
Start-Sleep -Seconds 2

$proc2 = Start-Engine
try {
  Start-Sleep -Seconds 4
  $runs = Invoke-RestMethod "http://localhost:5190/api/runs"
  $id = $runs[0].id
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    $d = Invoke-RestMethod "http://localhost:5190/api/runs/$id"
    if ($d.run.status -ne "running") { break }
  }
  $d = Invoke-RestMethod "http://localhost:5190/api/runs/$id"
  Write-Host "after reboot -> RUN $($d.run.status), node $($d.execs[0].status) output=$($d.execs[0].output)"
} finally {
  Stop-Process -Id $proc2.Id -Force -ErrorAction SilentlyContinue
}
