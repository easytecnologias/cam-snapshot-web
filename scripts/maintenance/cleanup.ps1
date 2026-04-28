Param(
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Usage {
@"
Uso:
  powershell -ExecutionPolicy Bypass -File .\scripts\maintenance\cleanup.ps1 [-DryRun] [-Force]

Remove caches/artefatos gerados, SEM apagar inventário JSON nem configurações.
- Remove: __pycache__, *.pyc, thumbs, saida\thumbs, saida\snapshots_manual
- Não remove: saida\cam-inventory.json, config\, .env
"@ | Write-Host
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")

function Confirm-Run {
  if ($Force) { return $true }
  $ans = Read-Host "Confirma limpeza em '$root'? (digite 'sim' para continuar)"
  return ($ans -eq "sim")
}

function Remove-PathSafe([string]$p) {
  if (Test-Path $p) {
    if ($DryRun) {
      Write-Host "[DRY-RUN] Remover: $p"
    } else {
      Write-Host "Removendo: $p"
      Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $p
    }
  }
}

if (-not (Confirm-Run)) { Write-Host "Cancelado."; exit 1 }

Write-Host ">> Limpando artefatos..."

# __pycache__ e *.pyc
Get-ChildItem -Path $root -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($DryRun) { Write-Host "[DRY-RUN] Remover:" $_.FullName } else { Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $_.FullName }
}
Get-ChildItem -Path $root -Recurse -File -Filter "*.pyc" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($DryRun) { Write-Host "[DRY-RUN] Remover:" $_.FullName } else { Remove-Item -Force -ErrorAction SilentlyContinue $_.FullName }
}

# thumbs e rascunhos
Remove-PathSafe (Join-Path $root "thumbs")
Remove-PathSafe (Join-Path $root "saida\thumbs")
Remove-PathSafe (Join-Path $root "saida\snapshots_manual")

Write-Host ">> OK."
