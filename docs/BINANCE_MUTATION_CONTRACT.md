# Binance USD-M protected mutation contract

This module is deliberately dormant. It has no CLI, HTTP route, environment
loader, or `TradingEngine` binding. It accepts only Binance Futures Testnet or
numeric loopback test infrastructure.

The lifecycle is:

1. derive deterministic ordinary/Algo order identities from the Glitch intent UUID;
2. retain sanitized before-transport evidence;
3. submit one market entry and query any ambiguous result by exact client ID;
4. submit and query a reduce-only `STOP_MARKET` for exact executed quantity;
5. submit and query a reduce-only `TAKE_PROFIT_MARKET` only after stop proof;
6. if stop proof fails, submit one deterministic reduce-only emergency market close;
7. leave unresolved outcomes nonterminal and block blind retry.

An accepted HTTP response is not by itself production acceptance. Authenticated
Testnet evidence, user-stream reconciliation, engine integration, an operator
arming contract, and explicit live authorization remain separate gates.
