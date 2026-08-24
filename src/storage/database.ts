import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_RISK_POLICY, validatePolicy } from "../domain/policy.js";
import type {
  AccountRecord,
  DailyStateRecord,
  GatewayMode,
  IntentReceipt,
  PositionRecord,
  RiskPolicy,
  TradeRecord,
} from "../domain/types.js";

interface StoredIntent {
  bodyHash: string;
  response: IntentReceipt | null;
}

export class GlitchDatabase {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    initialEquityCents = 100_000,
    initialMarkPriceCents = 6_000_000,
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.initializeSchema();
    this.initializeDefaults(initialEquityCents, initialMarkPriceCents);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getPolicy(): RiskPolicy {
    const row = this.db.prepare("SELECT policy_json FROM settings WHERE id = 1").get() as
      | { policy_json: string }
      | undefined;
    if (!row) {
      throw new Error("settings row is missing");
    }
    const policy = JSON.parse(row.policy_json) as RiskPolicy;
    validatePolicy(policy);
    return policy;
  }

  setPolicy(policy: RiskPolicy): void {
    validatePolicy(policy);
    this.db
      .prepare("UPDATE settings SET policy_json = ?, updated_utc = ? WHERE id = 1")
      .run(JSON.stringify(policy), nowUtc());
    this.appendJournal("policy_updated", "info", "Risk policy updated.", { policy });
  }

  getControl(): { running: boolean; gatewayMode: GatewayMode } {
    const row = this.db.prepare("SELECT running, gateway_mode FROM settings WHERE id = 1").get() as
      | { running: number; gateway_mode: GatewayMode }
      | undefined;
    if (!row) {
      throw new Error("settings row is missing");
    }
    return { running: row.running === 1, gatewayMode: row.gateway_mode };
  }

  setRunning(running: boolean): void {
    this.db
      .prepare("UPDATE settings SET running = ?, updated_utc = ? WHERE id = 1")
      .run(running ? 1 : 0, nowUtc());
    this.appendJournal(
      running ? "runtime_started" : "runtime_stopped",
      "info",
      running ? "Trading runtime started." : "Trading runtime stopped.",
      {},
    );
  }

  setGatewayMode(mode: GatewayMode): void {
    this.db
      .prepare("UPDATE settings SET gateway_mode = ?, updated_utc = ? WHERE id = 1")
      .run(mode, nowUtc());
    this.appendJournal("gateway_mode_changed", "warning", `Gateway mode changed to ${mode}.`, { mode });
  }

  getAccount(): AccountRecord {
    const row = this.db.prepare("SELECT * FROM account_state WHERE id = 1").get() as
      | {
          alias: string;
          balance_cents: number;
          mark_price_cents: number;
          updated_utc: string;
        }
      | undefined;
    if (!row) {
      throw new Error("account row is missing");
    }
    return {
      alias: row.alias,
      balanceCents: Number(row.balance_cents),
      markPriceCents: Number(row.mark_price_cents),
      updatedUtc: row.updated_utc,
    };
  }

  updateAccount(balanceCents: number, markPriceCents: number): void {
    this.db
      .prepare(
        "UPDATE account_state SET balance_cents = ?, mark_price_cents = ?, updated_utc = ? WHERE id = 1",
      )
      .run(balanceCents, markPriceCents, nowUtc());
  }

  setMarkPrice(markPriceCents: number): void {
    this.db
      .prepare("UPDATE account_state SET mark_price_cents = ?, updated_utc = ? WHERE id = 1")
      .run(markPriceCents, nowUtc());
  }

  getDailyState(day: string): DailyStateRecord | null {
    const row = this.db.prepare("SELECT * FROM daily_state WHERE day = ?").get(day) as
      | {
          day: string;
          start_equity_cents: number;
          high_water_equity_cents: number;
          lock_reached: number;
          active_floor_cents: number | null;
          updated_utc: string;
        }
      | undefined;
    return row
      ? {
          day: row.day,
          startEquityCents: Number(row.start_equity_cents),
          highWaterEquityCents: Number(row.high_water_equity_cents),
          lockReached: row.lock_reached === 1,
          activeFloorCents:
            row.active_floor_cents === null ? null : Number(row.active_floor_cents),
          updatedUtc: row.updated_utc,
        }
      : null;
  }

  upsertDailyState(state: DailyStateRecord): void {
    this.db
      .prepare(
        `INSERT INTO daily_state (
           day, start_equity_cents, high_water_equity_cents, lock_reached,
           active_floor_cents, updated_utc
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           start_equity_cents = excluded.start_equity_cents,
           high_water_equity_cents = excluded.high_water_equity_cents,
           lock_reached = excluded.lock_reached,
           active_floor_cents = excluded.active_floor_cents,
           updated_utc = excluded.updated_utc`,
      )
      .run(
        state.day,
        state.startEquityCents,
        state.highWaterEquityCents,
        state.lockReached ? 1 : 0,
        state.activeFloorCents,
        state.updatedUtc,
      );
  }

  getPositions(): PositionRecord[] {
    const rows = this.db.prepare("SELECT * FROM positions ORDER BY opened_utc, tranche_id").all() as Array<
      Record<string, unknown>
    >;
    return rows.map(mapPosition);
  }

  getPosition(trancheId: string): PositionRecord | null {
    const row = this.db.prepare("SELECT * FROM positions WHERE tranche_id = ?").get(trancheId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapPosition(row) : null;
  }

  insertPosition(position: PositionRecord): void {
    this.db
      .prepare(
        `INSERT INTO positions (
           tranche_id, intent_id, instrument, side, quantity_units,
           entry_price_cents, stop_price_cents, target_price_cents, leverage,
           entry_fee_cents, entry_order_id, stop_order_id, target_order_id,
           opened_utc, updated_utc
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        position.trancheId,
        position.intentId,
        position.instrument,
        position.side,
        position.quantityUnits,
        position.entryPriceCents,
        position.stopPriceCents,
        position.targetPriceCents,
        position.leverage,
        position.entryFeeCents,
        position.entryOrderId,
        position.stopOrderId,
        position.targetOrderId,
        position.openedUtc,
        position.updatedUtc,
      );
  }

  updatePosition(position: PositionRecord): void {
    this.db
      .prepare(
        `UPDATE positions SET
           quantity_units = ?, stop_price_cents = ?, target_price_cents = ?,
           entry_fee_cents = ?, stop_order_id = ?, target_order_id = ?, updated_utc = ?
         WHERE tranche_id = ?`,
      )
      .run(
        position.quantityUnits,
        position.stopPriceCents,
        position.targetPriceCents,
        position.entryFeeCents,
        position.stopOrderId,
        position.targetOrderId,
        position.updatedUtc,
        position.trancheId,
      );
  }

  deletePosition(trancheId: string): void {
    this.db.prepare("DELETE FROM positions WHERE tranche_id = ?").run(trancheId);
  }

  getIntent(intentId: string): StoredIntent | null {
    const row = this.db.prepare("SELECT body_hash, response_json FROM intents WHERE intent_id = ?").get(intentId) as
      | { body_hash: string; response_json: string | null }
      | undefined;
    return row
      ? {
          bodyHash: row.body_hash,
          response: row.response_json ? (JSON.parse(row.response_json) as IntentReceipt) : null,
        }
      : null;
  }

  claimIntent(intentId: string, hash: string, requestJson: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO intents (
           intent_id, body_hash, request_json, response_json, state, created_utc, updated_utc
         ) VALUES (?, ?, ?, NULL, 'received', ?, ?)`,
      )
      .run(intentId, hash, requestJson, nowUtc(), nowUtc());
    return result.changes === 1;
  }

  finalizeIntent(receipt: IntentReceipt): void {
    this.db
      .prepare(
        "UPDATE intents SET response_json = ?, state = ?, updated_utc = ? WHERE intent_id = ?",
      )
      .run(JSON.stringify(receipt), receipt.state, receipt.recorded_utc, receipt.intent_id);
  }

  insertTrade(trade: TradeRecord): void {
    this.db
      .prepare(
        `INSERT INTO trades (
           trade_id, tranche_id, intent_id, instrument, side, quantity_units,
           entry_price_cents, exit_price_cents, gross_pnl_cents, entry_fee_cents,
           exit_fee_cents, net_pnl_cents, exit_reason, opened_utc, closed_utc
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trade.tradeId,
        trade.trancheId,
        trade.intentId,
        trade.instrument,
        trade.side,
        trade.quantityUnits,
        trade.entryPriceCents,
        trade.exitPriceCents,
        trade.grossPnlCents,
        trade.entryFeeCents,
        trade.exitFeeCents,
        trade.netPnlCents,
        trade.exitReason,
        trade.openedUtc,
        trade.closedUtc,
      );
  }

  listTrades(limit = 100): TradeRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM trades ORDER BY closed_utc DESC, trade_id DESC LIMIT ?")
      .all(Math.max(1, Math.min(1_000, limit))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      tradeId: String(row.trade_id),
      trancheId: String(row.tranche_id),
      intentId: String(row.intent_id),
      instrument: String(row.instrument),
      side: String(row.side) as TradeRecord["side"],
      quantityUnits: Number(row.quantity_units),
      entryPriceCents: Number(row.entry_price_cents),
      exitPriceCents: Number(row.exit_price_cents),
      grossPnlCents: Number(row.gross_pnl_cents),
      entryFeeCents: Number(row.entry_fee_cents),
      exitFeeCents: Number(row.exit_fee_cents),
      netPnlCents: Number(row.net_pnl_cents),
      exitReason: String(row.exit_reason),
      openedUtc: String(row.opened_utc),
      closedUtc: String(row.closed_utc),
    }));
  }

  appendJournal(
    eventType: string,
    severity: "info" | "warning" | "error",
    message: string,
    data: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        "INSERT INTO journal (utc, event_type, severity, message, data_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(nowUtc(), eventType, severity, message, JSON.stringify(data));
  }

  listJournal(limit = 100): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare("SELECT * FROM journal ORDER BY id DESC LIMIT ?")
      .all(Math.max(1, Math.min(1_000, limit))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      utc: String(row.utc),
      event_type: String(row.event_type),
      severity: String(row.severity),
      message: String(row.message),
      data: JSON.parse(String(row.data_json)) as unknown,
    }));
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        policy_json TEXT NOT NULL,
        running INTEGER NOT NULL CHECK (running IN (0, 1)),
        gateway_mode TEXT NOT NULL CHECK (gateway_mode IN ('disabled', 'shadow', 'armed')),
        updated_utc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        alias TEXT NOT NULL,
        balance_cents INTEGER NOT NULL,
        mark_price_cents INTEGER NOT NULL,
        updated_utc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_state (
        day TEXT PRIMARY KEY,
        start_equity_cents INTEGER NOT NULL,
        high_water_equity_cents INTEGER NOT NULL,
        lock_reached INTEGER NOT NULL CHECK (lock_reached IN (0, 1)),
        active_floor_cents INTEGER,
        updated_utc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS intents (
        intent_id TEXT PRIMARY KEY,
        body_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT,
        state TEXT NOT NULL,
        created_utc TEXT NOT NULL,
        updated_utc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS positions (
        tranche_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        instrument TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
        quantity_units INTEGER NOT NULL,
        entry_price_cents INTEGER NOT NULL,
        stop_price_cents INTEGER NOT NULL,
        target_price_cents INTEGER NOT NULL,
        leverage INTEGER NOT NULL,
        entry_fee_cents INTEGER NOT NULL,
        entry_order_id TEXT NOT NULL UNIQUE,
        stop_order_id TEXT NOT NULL UNIQUE,
        target_order_id TEXT NOT NULL UNIQUE,
        opened_utc TEXT NOT NULL,
        updated_utc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trades (
        trade_id TEXT PRIMARY KEY,
        tranche_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        instrument TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity_units INTEGER NOT NULL,
        entry_price_cents INTEGER NOT NULL,
        exit_price_cents INTEGER NOT NULL,
        gross_pnl_cents INTEGER NOT NULL,
        entry_fee_cents INTEGER NOT NULL,
        exit_fee_cents INTEGER NOT NULL,
        net_pnl_cents INTEGER NOT NULL,
        exit_reason TEXT NOT NULL,
        opened_utc TEXT NOT NULL,
        closed_utc TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        utc TEXT NOT NULL,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_utc);
      CREATE INDEX IF NOT EXISTS idx_journal_utc ON journal(utc);
    `);
  }

  private initializeDefaults(initialEquityCents: number, initialMarkPriceCents: number): void {
    const utc = nowUtc();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO settings (id, policy_json, running, gateway_mode, updated_utc) VALUES (1, ?, 0, 'shadow', ?)",
      )
      .run(JSON.stringify(DEFAULT_RISK_POLICY), utc);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO account_state (id, alias, balance_cents, mark_price_cents, updated_utc) VALUES (1, 'paper-main', ?, ?, ?)",
      )
      .run(initialEquityCents, initialMarkPriceCents, utc);
  }
}

function mapPosition(row: Record<string, unknown>): PositionRecord {
  return {
    trancheId: String(row.tranche_id),
    intentId: String(row.intent_id),
    instrument: String(row.instrument),
    side: String(row.side) as PositionRecord["side"],
    quantityUnits: Number(row.quantity_units),
    entryPriceCents: Number(row.entry_price_cents),
    stopPriceCents: Number(row.stop_price_cents),
    targetPriceCents: Number(row.target_price_cents),
    leverage: Number(row.leverage),
    entryFeeCents: Number(row.entry_fee_cents),
    entryOrderId: String(row.entry_order_id),
    stopOrderId: String(row.stop_order_id),
    targetOrderId: String(row.target_order_id),
    openedUtc: String(row.opened_utc),
    updatedUtc: String(row.updated_utc),
  };
}

export function nowUtc(): string {
  return new Date().toISOString();
}
