# Inicia o Setor IA com um duplo clique (via "Iniciar Setor IA.cmd"): o executor local e a interface,
# cada um na sua janela (com os logs visíveis), e abre o navegador quando a interface responde.
# Com -Parar, encerra os dois (só os processos que escutam nas portas do Setor IA).
# Não faz login em nada: os clientes oficiais (Claude Code / Codex) usam o login que já existe neste computador.
param([switch]$Parar)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$executorPort = 4317
$uiPort = 5173
$url = "http://localhost:$uiPort"

function Test-Port([int]$port) {
  # A interface (Vite) pode escutar só em IPv6 (::1) e o executor só em IPv4: testa os dois endereços locais.
  foreach ($addr in @([Net.IPAddress]::Loopback, [Net.IPAddress]::IPv6Loopback)) {
    $c = New-Object System.Net.Sockets.TcpClient($addr.AddressFamily)
    try { $iar = $c.BeginConnect($addr, $port, $null, $null); if ($iar.AsyncWaitHandle.WaitOne(300) -and $c.Connected) { return $true } }
    catch { } finally { $c.Close() }
  }
  return $false
}

function Wait-Port([int]$port, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) { if (Test-Port $port) { return $true }; Start-Sleep -Milliseconds 700 }
  return $false
}

function Stop-Port([int]$port, [string]$name) {
  $pids = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  if (-not $pids.Count) { Write-Host "  ${name}: não estava rodando."; return }
  foreach ($p in $pids) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
    # Sobe até a janela "Setor IA - ..." que este script abriu, para fechá-la junto (encerra a árvore inteira).
    $target = $null
    $cur = $proc
    for ($i = 0; $i -lt 8 -and $cur; $i++) {
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
      if ($parent -and $parent.Name -eq "cmd.exe" -and $parent.CommandLine -like "*title Setor IA - *") { $target = $parent.ProcessId; break }
      $cur = $parent
    }
    # Só encerra o que é do Setor IA: aberto por este script, ou Node rodando o código desta pasta
    # (a interface roda com caminho relativo: "node scripts/run-framework.mjs dev"). Outro programa na porta fica em paz.
    $ours = $target -or ($proc -and $proc.Name -eq "node.exe" -and ($proc.CommandLine -like "*$root*" -or $proc.CommandLine -like "*scripts/run-framework.mjs*"))
    if (-not $ours) {
      Write-Host "  A porta $port está ocupada por outro programa ($($proc.Name)); não mexi nele."
      continue
    }
    if (-not $target) { $target = $p }
    & taskkill /PID $target /T /F | Out-Null
    Write-Host "  ${name}: encerrado."
  }
}

Set-Location $root
Write-Host ""
Write-Host "=== Setor IA ===" -ForegroundColor Cyan

if ($Parar) {
  Write-Host "Parando..."
  Stop-Port $uiPort "Interface"
  Stop-Port $executorPort "Executor"
  # Janelas que este script abriu e que ficaram paradas no prompt (por exemplo, depois de uma falha).
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like "*title Setor IA - *" } | ForEach-Object { & taskkill /PID $_.ProcessId /T /F | Out-Null }
  Write-Host "Pronto."
  Start-Sleep -Seconds 2
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Node.js não encontrado. Instale o Node.js 22.13 ou mais novo e tente de novo." -ForegroundColor Red; Read-Host "Enter para fechar"; exit 1 }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Write-Host "pnpm não encontrado. Rode: npm install -g pnpm" -ForegroundColor Red; Read-Host "Enter para fechar"; exit 1 }

if (-not (Test-Path (Join-Path $root "node_modules"))) {
  Write-Host "Primeira vez: instalando dependências (pnpm install)..."
  & pnpm install
  if ($LASTEXITCODE -ne 0) { Write-Host "A instalação falhou; veja as mensagens acima." -ForegroundColor Red; Read-Host "Enter para fechar"; exit 1 }
}

# 1. Executor (cria o token em .dev.vars na primeira vez; a interface precisa dele, por isso sobe antes).
if (Test-Port $executorPort) {
  Write-Host "Executor já está rodando (porta $executorPort)."
} else {
  Write-Host "Iniciando o executor..."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "title Setor IA - Executor && cd /d `"$root`" && pnpm executor" -WorkingDirectory $root | Out-Null
  if (-not (Wait-Port $executorPort 60)) { Write-Host "O executor não respondeu em 60 s. Veja a janela 'Setor IA - Executor'." -ForegroundColor Red; Read-Host "Enter para fechar"; exit 1 }
  Write-Host "Executor pronto."
}

# 2. Interface. A primeira subida às vezes falha por um erro passageiro do runtime local; tenta uma segunda vez.
if (Test-Port $uiPort) {
  Write-Host "Interface já está rodando (porta $uiPort)."
} else {
  $ok = $false
  foreach ($try in 1..2) {
    Write-Host "Iniciando a interface$(if ($try -gt 1) { ' (nova tentativa)' })..."
    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "title Setor IA - Interface && cd /d `"$root`" && pnpm dev" -WorkingDirectory $root | Out-Null
    if (Wait-Port $uiPort 150) { $ok = $true; break }
    Write-Host "A interface não respondeu a tempo." -ForegroundColor Yellow
  }
  if (-not $ok) { Write-Host "A interface não subiu. Veja a janela 'Setor IA - Interface'." -ForegroundColor Red; Read-Host "Enter para fechar"; exit 1 }
  Write-Host "Interface pronta."
}

Start-Process $url
Write-Host ""
Write-Host "Aberto em $url" -ForegroundColor Green
Write-Host "Para encerrar: feche as janelas 'Setor IA - Executor' e 'Setor IA - Interface', ou use 'Parar Setor IA'."
Start-Sleep -Seconds 4
