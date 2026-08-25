# GC-002 Phase K Specification — fail-closed Testnet execution context

## Purpose

Compile the already separated Binance USD-M Testnet preflight, public depth,
public market, and private account truths into one immutable point-in-time
execution context. The context is a deterministic prerequisite for a later
engine adapter; it does not select a venue, hold credentials, or authorize a
mutation.

The current paper engine cannot safely call the asynchronous Binance
coordinator because it still owns paper balance, mark, fee, and synchronous
management assumptions. Phase K closes the account/market truth gap without
exposing that half-safe runtime mode.

## Source facts

- The venue is authoritative for account, position, order, fill, fee, contract,
  and market state.
- A successful authenticated preflight is point-in-time evidence, not enduring
  runtime readiness.
- The public depth lane owns order-book continuity; the market lane owns
  mark-price and aggregate-trade continuity; the private lane owns reconciled
  account, position, and order state.
- The protected mutation coordinator supports protected entry, full protected
  close, and reconciliation, but not stop amendment, target amendment, or
  partial reduction.

## Functional requirements

### FR-K001 Market truth

The market recorder MUST retain the latest strictly inspected aggregate trade
and mark-price summaries in its status. It MUST keep exact frame evidence and
the summarized current state as separate facts.

### FR-K002 Private reconciliation truth

The private reducer MUST distinguish provider transaction/event time from local
REST reconciliation observation time. A reconciled balance MUST preserve the
venue's available balance separately from wallet and cross-wallet balance.

An `ACCOUNT_UPDATE` that cannot provide current available balance MUST
invalidate that value. Readiness then remains blocked until a new REST
reconciliation proves it again.

### FR-K003 Immutable compilation

The compiler MUST accept only explicit preflight, stream-supervisor, market
recorder, clock, and freshness inputs. It MUST return a new serializable object
and MUST NOT retain a credential, client, signer, socket, callback, or mutation
handle.

### FR-K004 Fail-closed freshness

Readiness MUST be blocked when preflight, depth, mark, trade, or private
reconciliation evidence is missing, stale, or implausibly in the future. The
configured maximum ages MUST be positive bounded integers and MUST be retained
in the output.

### FR-K005 Identity and continuity

Readiness MUST require one BTCUSDT identity across preflight, supervisor,
order book, and market recorder; running public/private/market lanes; a ready
non-crossed book; an unexpired private stream; and no buffered private events.

### FR-K006 Flat and usable account envelope

Readiness MUST require positive USDT wallet and available balances, no nonzero
BTCUSDT position, and no active native order. Terminal historical order updates
MUST NOT masquerade as open orders.

### FR-K007 Exact risk inputs

A ready context MUST expose exact decimal strings for wallet balance, available
balance, mark price, best bid/ask, maker/taker fee rates, tick size, market
quantity step/minimum, and minimum notional, plus the accepted leverage and
configured leverage ceiling.

### FR-K008 Capability truth

The context MUST state that protected entry, full close, and reconciliation are
implemented source capabilities, while partial reduction and stop/target
amendment are absent. It MUST keep `mutation_authority` and
`engine_binding_authority` false even when status is `ready`.

### FR-K009 Deterministic blockers

All failed preconditions MUST be returned as stable, de-duplicated, sorted
blocker codes. Invalid outer identities or freshness configuration MAY throw
before compilation; observed runtime deficiencies MUST produce `blocked`.

## Meaning of `ready`

`ready` means the supplied Testnet observations form a coherent, fresh, flat
account-and-market envelope suitable for a later bounded protected-entry
exercise. It does not mean:

- credentials were supplied or a private stream was observed in this task;
- an order may be placed;
- the engine is wired to Binance;
- management parity, production, capital, or profitability is accepted.

## Acceptance

1. Current coherent fixtures produce a ready, non-authorizing context.
2. Each stale/missing/disconnected/gapped/crossed/expired/exposed/open-order/
   unavailable-balance condition deterministically blocks readiness.
3. A private account update invalidates snapshot-only available balance.
4. Terminal order history does not count as active exposure.
5. No context output contains credentials or transport/mutation handles.
6. The complete repository gate passes.

## Non-goals

Credentials, authenticated capture, exchange mutation, venue selection,
engine/API/CLI binding, production URLs, partial execution, protection
amendment, deployment, capital transfer, or profitability claims.
