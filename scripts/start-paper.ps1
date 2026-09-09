param(
    [string]$ProfileName = 'cryptoglitch',
    [string]$DataRoot = 'D:\ab\runtime\cryptoglitch'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$profileRoot = Join-Path $env:LOCALAPPDATA "hermes\profiles\$ProfileName"
if (-not (Test-Path -LiteralPath (Join-Path $profileRoot 'scripts/shadow_operator.py'))) {
    throw 'Install and verify the separate Crypto profile first.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repo 'dist/src/index.js'))) { throw 'Build the gateway first.' }
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
$gatewayEnv = Join-Path $DataRoot 'gateway.env'
$profileEnv = Join-Path $profileRoot '.env'
if (-not (Test-Path -LiteralPath $gatewayEnv)) {
    # Generate new local-only secrets once. Never print or commit them.
    $modelToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $operatorToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $gatewayLines = @(
        'GLITCH_LOCAL_HOST=127.0.0.1', 'GLITCH_LOCAL_PORT=8791',
        "GLITCH_LOCAL_TOKEN=$modelToken", "GLITCH_OPERATOR_TOKEN=$operatorToken",
        "GLITCH_DATA_DIR=$DataRoot", 'GLITCH_GATEWAY_MODE=shadow', 'GLITCH_RUNTIME_MODE=binance-shadow',
        'GLITCH_PAPER_INITIAL_EQUITY_USD=1000', 'GLITCH_BINANCE_INCLUDE_PRIVATE=false',
        'GLITCH_BINANCE_USDM_API_KEY=', 'GLITCH_BINANCE_USDM_API_SECRET='
    )
    $profileLines = @(
        'GLITCH_CRYPTO_GATEWAY_URL=http://127.0.0.1:8791',
        "GLITCH_CRYPTO_LOCAL_TOKEN=$modelToken", "GLITCH_CRYPTO_OPERATOR_TOKEN=$operatorToken",
        'GLITCH_CRYPTO_OPERATOR_POLL_SECONDS=2', 'GLITCH_CRYPTO_OPERATOR_MIN_INTERVAL_SECONDS=60',
        'GLITCH_CRYPTO_OPERATOR_MODEL_TIMEOUT_SECONDS=120'
    )
    if (Test-Path -LiteralPath $profileEnv) {
        $existing = Get-Content -LiteralPath $profileEnv -Raw
        if ($existing -notmatch 'replace-with-the-gateway') {
            throw 'Existing configured profile environment must be preserved; pair it deliberately.'
        }
    }
    [IO.File]::WriteAllLines($gatewayEnv, $gatewayLines)
    [IO.File]::WriteAllLines($profileEnv, $profileLines)
}
$existingHealth = $null
try { $existingHealth = Invoke-RestMethod http://127.0.0.1:8791/health -TimeoutSec 2 } catch {}
if ($existingHealth) {
    throw 'Port 8791 already has a gateway. Inspect and use its existing controls instead of starting another.'
}
$node = (Get-Command node.exe).Source
$args = @("--env-file=`"$gatewayEnv`"", '--enable-source-maps', "`"$(Join-Path $repo 'dist/src/index.js')`"")
$process = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $DataRoot 'gateway.stdout.log') `
    -RedirectStandardError (Join-Path $DataRoot 'gateway.stderr.log')
[IO.File]::WriteAllText((Join-Path $DataRoot 'gateway.pid'), [string]$process.Id)
$health = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try { $health = Invoke-RestMethod http://127.0.0.1:8791/health -TimeoutSec 2; break } catch {}
    if ($process.HasExited) { throw 'Gateway exited; inspect its own logs.' }
}
if (-not $health -or $health.venue -ne 'paper' -or $health.runtime.mutation_authority -ne $false) {
    throw 'Paper-only health was not verified. Operator was not started.'
}
$previousProfile = $env:HERMES_HOME
try {
    $env:HERMES_HOME = $profileRoot
    & python (Join-Path $profileRoot 'scripts/gateway_client.py') start
    if ($LASTEXITCODE -ne 0) { throw 'Paper gateway start failed.' }
    & python (Join-Path $profileRoot 'scripts/shadow_operator.py')
    if ($LASTEXITCODE -ne 0) { throw 'Crypto operator launch failed.' }
} finally {
    $env:HERMES_HOME = $previousProfile
}
Write-Output "Paper gateway PID $($process.Id); profile $ProfileName; data $DataRoot. No exchange keys or real orders."
