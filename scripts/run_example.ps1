# Carrega .env (se existir), valida e executa seu pipeline de exemplo.
if (Test-Path .env) {
  Write-Host "Carregando .env..."
  $envContent = Get-Content .env | Where-Object { $_ -match '^[^#].*=.*' }
  foreach ($line in $envContent) {
    $kv = $line -split '=',2
    if ($kv.Length -eq 2) {
      [Environment]::SetEnvironmentVariable($kv[0].Trim(), $kv[1].Trim(), "Process")
    }
  }
} else {
  Write-Host "ATENÇÃO: .env não encontrado. Crie a partir de .env.example"
}

python tools/validate_env.py || exit $LASTEXITCODE

$alvo = "10.10.10.20-10.10.10.30"
$usuario = "admin"
$senha = "global1234"
$run = "src\\run_all.py"
if (!(Test-Path $run)) {
  Write-Host "Aviso: $run não existe. Ajuste a variável `$run conforme seu projeto."
  exit 1
}
python $run `
  --alvo $alvo `
  --usuario $usuario `
  --senha $senha `
  --snapshot `
  --fast `
  --uploader imgbb `
  --mensagem .\saida\mensagem_cameras.txt `
  --netwatch `
  --token $env:TELEGRAM_BOT_TOKEN `
  --chat $env:TELEGRAM_CHAT_ID `
  --format-excel `
  --make-thumbs `
  --thumb-width $env:THUMB_WIDTH
