# ADR-0002 — Daily protected-profit lock semantics

## Status

Accepted.

## Decision

The default `daily_lock_target_pct` is 0.5% of the UTC day's starting usable pot.

```text
starting usable pot = min(starting equity, configured usable balance limit)
target profit       = starting usable pot × target percentage
target equity       = starting equity + target profit
protected equity    = current equity - loss to native stops - stressed exit cost
```

When protected equity reaches target equity, the target becomes an active floor. New exposure is rejected if its worst-case protected result would fall below that floor. Reductions and flatten remain available.

## Explicit non-meaning

The target does not:

- create an opportunity;
- set stop or target distance;
- determine quantity;
- require a trade;
- grant permission to lose 0.5%;
- reset risk merely because midnight passed locally.

## Rationale

This preserves the user's portfolio objective while preventing the system from harvesting ordinary noise for arbitrary fixed-dollar profits. It scales consistently from $100 to $10,000 and beyond.
