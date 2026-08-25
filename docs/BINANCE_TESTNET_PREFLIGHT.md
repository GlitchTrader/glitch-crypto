# Binance USD-M authenticated Testnet preflight

This command performs signed GET-only discovery against Binance Futures Testnet.
It cannot change account mode, leverage, margin, orders, positions, or balances.

## Run

Build first, then provide separately managed Testnet credentials to the process:

```powershell
npm.cmd run build
$env:GLITCH_BINANCE_USDM_BASE_URL = "https://demo-fapi.binance.com"
$env:GLITCH_BINANCE_USDM_API_KEY = "<testnet key>"
$env:GLITCH_BINANCE_USDM_API_SECRET = "<testnet secret>"
$env:GLITCH_BINANCE_USDM_MAX_LEVERAGE = "3"
npm.cmd run binance:preflight
```

Exit status:

- `0`: every declared precondition is proven;
- `2`: authenticated capture succeeded but one or more preconditions are blocked;
- `1`: configuration, authentication, transport, or contract error.

## Required envelope

- BTCUSDT perpetual supports market, stop-market, and take-profit-market orders;
- one-way position mode;
- single-asset mode;
- isolated BTCUSDT margin;
- leverage from 1 through the configured ceiling (3 by default);
- auto-add margin disabled;
- trading permission and positive USDT wallet/available balance;
- maker and taker commission rates observed;
- no BTCUSDT exposure and no open order.

The report is sanitized and declares `mutation_authority: false`. A ready report
does not authorize a Testnet order, production access, capital use, or deployment.
