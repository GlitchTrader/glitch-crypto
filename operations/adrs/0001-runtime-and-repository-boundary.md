# ADR-0001 — Runtime and repository boundary

## Status

Accepted for GC-001.

## Decision

Use:

- Node 22 and strict TypeScript for the single-node gateway;
- built-in HTTP and SQLite for the dependency-light first vertical slice;
- a separate Python/Hermes profile repository for cognition and operator commands;
- a venue adapter boundary, beginning with a deterministic paper adapter;
- one active execution signer, one account, BTC perpetual, and one open-position scope.

## Rationale

The existing Glitch Topstep implementation has already validated TypeScript as a practical environment for authenticated local APIs, durable identity, evidence persistence, and provider adapters. Reusing those behavioral contracts lowers implementation risk. Node is adequate for the initial event rate and keeps the system simple. A measured latency or throughput defect—not anticipation—must justify moving a hot path to Rust.

The profile is physically separate so exchange credentials and native mutation authority cannot leak into Hermes.

## Consequences

- Domain and adapter contracts must remain portable.
- `node:sqlite` is isolated behind `GlitchDatabase` because Node 22 still marks it experimental.
- Real venue adapters are separate acceptance tickets.
- No distributed system is introduced before a single-node evidence sample proves the need.
