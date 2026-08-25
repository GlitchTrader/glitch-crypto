import test from "node:test";
import assert from "node:assert/strict";
import type { BinanceUsdmAccountSnapshot } from "../src/venue/binance-usdm/shadow-client.js";
import {
  BinanceUsdmStreamSupervisor,
  type BinanceStreamScheduler,
  type BinanceUsdmStreamRestClient,
  type BinanceWebSocketEventMap,
  type BinanceWebSocketFactory,
  type BinanceWebSocketLike,
} from "../src/venue/binance-usdm/stream-supervisor.js";
import type { BinanceUsdmListenKeySession } from "../src/venue/binance-usdm/listen-key-client.js";
import { InMemoryBinanceStreamEvidenceSink } from "../src/venue/binance-usdm/stream-evidence.js";

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveValue!: (value: T) => void;
  private rejectValue!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveValue = resolve;
      this.rejectValue = reject;
    });
  }

  resolve(value: T): void {
    this.resolveValue(value);
  }

  reject(error: unknown): void {
    this.rejectValue(error);
  }
}

class FakeSocket implements BinanceWebSocketLike {
  readyState = 0;
  readonly listeners: { [K in keyof BinanceWebSocketEventMap]: Array<(event: BinanceWebSocketEventMap[K]) => void> } = {
    open: [],
    message: [],
    error: [],
    close: [],
  };

  constructor(readonly url: string) {}

  addEventListener<K extends keyof BinanceWebSocketEventMap>(
    type: K,
    listener: (event: BinanceWebSocketEventMap[K]) => void,
  ): void {
    (this.listeners[type] as Array<(event: BinanceWebSocketEventMap[K]) => void>).push(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value: unknown): void {
    this.emit("message", { data: typeof value === "string" ? value : JSON.stringify(value) });
  }

  serverClose(code = 1006, reason = "network"): void {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: false });
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: true });
  }

  private emit<K extends keyof BinanceWebSocketEventMap>(
    type: K,
    event: BinanceWebSocketEventMap[K],
  ): void {
    for (const listener of this.listeners[type] as Array<(value: BinanceWebSocketEventMap[K]) => void>) {
      listener(event);
    }
  }
}

class FakeSocketFactory implements BinanceWebSocketFactory {
  readonly sockets: FakeSocket[] = [];

  create(url: string): FakeSocket {
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  }
}

class FakeScheduler implements BinanceStreamScheduler {
  private nextHandle = 1;
  readonly timeouts = new Map<number, () => void>();
  readonly intervals = new Map<number, () => void>();

  setTimeout(callback: () => void, _delayMs: number): number {
    const handle = this.nextHandle++;
    this.timeouts.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  setInterval(callback: () => void, _delayMs: number): number {
    const handle = this.nextHandle++;
    this.intervals.set(handle, callback);
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  runNextTimeout(): void {
    const entry = this.timeouts.entries().next().value as [number, () => void] | undefined;
    if (!entry) {
      throw new Error("no timeout is scheduled");
    }
    this.timeouts.delete(entry[0]);
    entry[1]();
  }

  runIntervals(): void {
    for (const callback of [...this.intervals.values()]) {
      callback();
    }
  }
}

class FakeRest implements BinanceUsdmStreamRestClient {
  readonly depth = new Deferred<unknown>();
  readonly account = new Deferred<BinanceUsdmAccountSnapshot>();

  publicGet(path: string): Promise<unknown> {
    assert.equal(path, "/fapi/v1/depth");
    return this.depth.promise;
  }

  accountSnapshot(): Promise<BinanceUsdmAccountSnapshot> {
    return this.account.promise;
  }
}

class FakeRawRest extends FakeRest {
  readonly rawDepth = new Deferred<{
    method: "GET";
    origin: string;
    path: string;
    query: string;
    http_status: number;
    local_receive_timestamp_ms: number;
    monotonic_receive_ns: string;
    raw_response: string;
  }>();

  publicGetRaw(
    path: string,
    parameters: Readonly<Record<string, unknown>> = {},
  ) {
    assert.equal(path, "/fapi/v1/depth");
    assert.deepEqual(parameters, { symbol: "BTCUSDT", limit: 1_000 });
    return this.rawDepth.promise;
  }
}

class FakeListenKeySession implements BinanceUsdmListenKeySession {
  createCount = 0;
  keepAliveCount = 0;
  closeCount = 0;
  failKeepAlive = false;

  async create(): Promise<string> {
    this.createCount += 1;
    return `private-listen-key-${this.createCount}`;
  }

  async keepAlive(): Promise<void> {
    this.keepAliveCount += 1;
    if (this.failKeepAlive) {
      throw new Error("keepalive failed");
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

test("public depth buffers before snapshot and reconnects on continuity loss", async () => {
  const rest = new FakeRest();
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const evidence = new InMemoryBinanceStreamEvidenceSink();
  const connectionIds = ["depth-connection-0001", "depth-connection-0002"];
  let connectionIndex = 0;
  let receiveNow = 1_787_622_187_000;
  let monotonicNow = 10_000_000n;
  const supervisor = new BinanceUsdmStreamSupervisor(rest, null, {
    socketFactory: sockets,
    scheduler,
    evidence,
    reconnectBaseMs: 1,
    now: () => (receiveNow += 10),
    publicMonotonicClock: () => (monotonicNow += 1_000n),
    publicConnectionIdFactory: () =>
      connectionIds[connectionIndex++] ?? "unexpected-connection",
  });

  await supervisor.start(false);
  const publicSocket = sockets.sockets[0];
  if (!publicSocket) {
    throw new Error("public socket was not created");
  }
  assert.equal(
    publicSocket.url,
    "wss://fstream.binance.com/public/ws/btcusdt@depth@100ms",
  );
  publicSocket.open();
  publicSocket.message({
    e: "depthUpdate",
    E: 1001,
    T: 1000,
    s: "BTCUSDT",
    U: 101,
    u: 101,
    pu: 100,
    b: [["60000", "2"]],
    a: [],
  });
  rest.depth.resolve({
    lastUpdateId: 100,
    bids: [["60000", "1"]],
    asks: [["60001", "1"]],
  });
  await flushAsync();

  assert.equal(supervisor.status().public.state, "running");
  assert.deepEqual(supervisor.status().public.order_book.best_bid, ["60000", "2"]);
  const firstMessage = evidence.records.find(
    (record) =>
      record.schema_version ===
      "glitch.crypto.binance-usdm-stream-evidence.v2",
  );
  if (!firstMessage) {
    throw new Error("replay-grade depth evidence was not recorded");
  }
  assert.equal(firstMessage.channel, "public-depth");
  assert.equal(firstMessage.provenance.connection_id, "depth-connection-0001");
  assert.equal(firstMessage.provenance.provider_sequence.first_update_id, 101);
  assert.equal(firstMessage.provenance.provider_sequence.final_update_id, 101);
  assert.equal(firstMessage.provenance.provider_sequence.previous_final_update_id, 100);
  assert.equal(firstMessage.provenance.raw_frame_sha256.length, 64);

  publicSocket.message({
    e: "depthUpdate",
    E: 1002,
    T: 1002,
    s: "BTCUSDT",
    U: 102,
    u: 102,
    pu: 99,
    b: [],
    a: [],
  });
  await flushAsync();
  assert.equal(supervisor.status().public.state, "backoff");
  scheduler.runNextTimeout();
  assert.equal(sockets.sockets.length, 2);
  assert.equal(supervisor.status().public.state, "connecting");
  assert.equal(
    evidence.records.some(
      (record) =>
        record.kind === "transition" &&
        (record.payload as Record<string, unknown>).connection_id ===
          "depth-connection-0002",
    ),
    true,
  );
  await supervisor.stop();
});

test("invalid depth JSON is retained exactly before reconnect", async () => {
  const rest = new FakeRest();
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const evidence = new InMemoryBinanceStreamEvidenceSink();
  const connectionIds = ["depth-connection-invalid-0001", "depth-connection-invalid-0002"];
  let connectionIndex = 0;
  const supervisor = new BinanceUsdmStreamSupervisor(rest, null, {
    socketFactory: sockets,
    scheduler,
    evidence,
    reconnectBaseMs: 1,
    now: () => 1_787_622_187_100,
    publicMonotonicClock: () => 1_000_000n,
    publicConnectionIdFactory: () =>
      connectionIds[connectionIndex++] ?? "unexpected-connection",
  });

  await supervisor.start(false);
  const socket = sockets.sockets[0];
  if (!socket) {
    throw new Error("public socket was not created");
  }
  socket.open();
  socket.message("{invalid-json");
  await flushAsync();

  const rawRecord = evidence.records.find(
    (record) =>
      record.schema_version ===
      "glitch.crypto.binance-usdm-stream-evidence.v2",
  );
  const errorRecord = evidence.records.find((record) => record.kind === "error");
  if (!rawRecord || !errorRecord) {
    throw new Error("raw depth error evidence was not recorded");
  }
  assert.equal(rawRecord.payload, null);
  assert.equal(rawRecord.provenance.raw_frame, "{invalid-json");
  assert.ok(evidence.records.indexOf(rawRecord) < evidence.records.indexOf(errorRecord));
  assert.equal(supervisor.status().public.state, "backoff");

  scheduler.runNextTimeout();
  assert.equal(sockets.sockets.length, 2);
  assert.equal(
    evidence.records.some(
      (record) =>
        record.kind === "transition" &&
        (record.payload as Record<string, unknown>).connection_id ===
          "depth-connection-invalid-0002",
    ),
    true,
  );
  await supervisor.stop();
});

test("malformed depth identity is retained before fail-closed reconnect", async () => {
  const rest = new FakeRest();
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const evidence = new InMemoryBinanceStreamEvidenceSink();
  const supervisor = new BinanceUsdmStreamSupervisor(rest, null, {
    socketFactory: sockets,
    scheduler,
    evidence,
    reconnectBaseMs: 1,
    now: () => 1_787_622_187_100,
    publicMonotonicClock: () => 1_000_000n,
    publicConnectionIdFactory: () => "depth-connection-malformed-0001",
  });

  await supervisor.start(false);
  const socket = sockets.sockets[0];
  if (!socket) {
    throw new Error("public socket was not created");
  }
  socket.open();
  socket.message({
    e: "notDepthUpdate",
    E: 1_787_622_187_101,
    T: 1_787_622_187_100,
    s: "BTCUSDT",
    U: 101,
    u: 101,
    pu: 100,
    b: [],
    a: [],
  });
  await flushAsync();

  const rawRecord = evidence.records.find(
    (record) =>
      record.schema_version ===
      "glitch.crypto.binance-usdm-stream-evidence.v2",
  );
  const errorRecord = evidence.records.find((record) => record.kind === "error");
  if (!rawRecord || !errorRecord) {
    throw new Error("malformed depth evidence was not recorded");
  }
  assert.equal(rawRecord.provenance.provider_sequence.event_type, "notDepthUpdate");
  assert.ok(evidence.records.indexOf(rawRecord) < evidence.records.indexOf(errorRecord));
  assert.equal(supervisor.status().public.state, "backoff");
  await supervisor.stop();
});

test("exact REST depth response is retained before its parsed snapshot", async () => {
  const rest = new FakeRawRest();
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const evidence = new InMemoryBinanceStreamEvidenceSink();
  const supervisor = new BinanceUsdmStreamSupervisor(rest, null, {
    socketFactory: sockets,
    scheduler,
    evidence,
    reconnectBaseMs: 1,
    now: () => 1_700_000_000_100,
    publicMonotonicClock: () => 1_000_000n,
    publicConnectionIdFactory: () => "depth-connection-snapshot-0001",
  });

  await supervisor.start(false);
  const socket = sockets.sockets[0];
  if (!socket) {
    throw new Error("public socket was not created");
  }
  socket.open();
  socket.message({
    e: "depthUpdate",
    E: 1_700_000_000_101,
    T: 1_700_000_000_100,
    s: "BTCUSDT",
    U: 101,
    u: 101,
    pu: 100,
    b: [["60000", "2"]],
    a: [],
  });
  const exact = '{ "lastUpdateId":100,"E":1700000000050,"T":1700000000040,"bids":[["60000","1"]],"asks":[["60001","1"]] }';
  rest.rawDepth.resolve({
    method: "GET",
    origin: "https://demo-fapi.binance.com",
    path: "/fapi/v1/depth",
    query: "limit=1000&symbol=BTCUSDT",
    http_status: 200,
    local_receive_timestamp_ms: 1_700_000_000_500,
    monotonic_receive_ns: "2000000",
    raw_response: exact,
  });
  await flushAsync();

  const rawRecord = evidence.records.find(
    (record) =>
      record.schema_version ===
      "glitch.crypto.binance-usdm-stream-evidence.v3",
  );
  const parsedRecord = evidence.records.find(
    (record) => record.channel === "public-depth" && record.kind === "snapshot",
  );
  if (!rawRecord || !parsedRecord) {
    throw new Error("raw and parsed snapshot evidence were not recorded");
  }
  assert.equal(rawRecord.provenance.raw_response, exact);
  assert.ok(evidence.records.indexOf(rawRecord) < evidence.records.indexOf(parsedRecord));
  assert.deepEqual(parsedRecord.payload, {
    lastUpdateId: 100,
    bids: [["60000", "1"]],
    asks: [["60001", "1"]],
  });
  assert.equal(supervisor.status().public.state, "running");
  assert.deepEqual(supervisor.status().public.order_book.best_bid, ["60000", "2"]);
  await supervisor.stop();
});

test("malformed REST depth response is retained before snapshot backoff", async () => {
  const rest = new FakeRawRest();
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const evidence = new InMemoryBinanceStreamEvidenceSink();
  const supervisor = new BinanceUsdmStreamSupervisor(rest, null, {
    socketFactory: sockets,
    scheduler,
    evidence,
    reconnectBaseMs: 1,
  });

  await supervisor.start(false);
  const socket = sockets.sockets[0];
  if (!socket) {
    throw new Error("public socket was not created");
  }
  socket.open();
  rest.rawDepth.resolve({
    method: "GET",
    origin: "https://demo-fapi.binance.com",
    path: "/fapi/v1/depth",
    query: "limit=1000&symbol=BTCUSDT",
    http_status: 200,
    local_receive_timestamp_ms: 1_700_000_000_500,
    monotonic_receive_ns: "2000000",
    raw_response: "{invalid-json",
  });
  await flushAsync();

  const rawRecord = evidence.records.find(
    (record) =>
      record.schema_version ===
      "glitch.crypto.binance-usdm-stream-evidence.v3",
  );
  const errorRecord = evidence.records.find((record) => record.kind === "error");
  if (!rawRecord || !errorRecord) {
    throw new Error("malformed raw snapshot evidence was not recorded");
  }
  assert.equal(rawRecord.provenance.raw_response, "{invalid-json");
  assert.ok(evidence.records.indexOf(rawRecord) < evidence.records.indexOf(errorRecord));
  assert.equal(
    evidence.records.some((record) => record.kind === "snapshot"),
    false,
  );
  assert.equal(supervisor.status().public.state, "backoff");
  await supervisor.stop();
});

test("private stream buffers events through REST reconciliation and rotates after keepalive failure", async () => {
  const rest = new FakeRest();
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const listen = new FakeListenKeySession();
  const evidence = new InMemoryBinanceStreamEvidenceSink({
    forbiddenValues: ["private-listen-key-1"],
  });
  const supervisor = new BinanceUsdmStreamSupervisor(rest, listen, {
    socketFactory: sockets,
    scheduler,
    evidence,
    reconnectBaseMs: 1,
    keepaliveMs: 60_000,
  });

  await supervisor.start(true);
  const privateSocket = sockets.sockets.find((socket) => socket.url.includes("private-listen-key"));
  if (!privateSocket) {
    throw new Error("private socket was not created");
  }
  assert.equal(
    privateSocket.url,
    "wss://fstream.binance.com/private/ws?listenKey=private-listen-key-1&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/listenKeyExpired",
  );
  privateSocket.open();
  privateSocket.message({
    e: "ACCOUNT_UPDATE",
    E: 2001,
    T: 2001,
    a: { B: [{ a: "USDT", wb: "1005", cw: "1005", bc: "5" }], P: [] },
  });
  rest.account.resolve({
    balances: [{ asset: "USDT", balance: "1000", crossWalletBalance: "1000" }],
    positions: [],
    open_orders: [],
    commission_rate: {},
    position_mode: {},
    multi_asset_mode: {},
    symbol_configuration: {},
    account_configuration: {},
  });
  await flushAsync();

  assert.equal(supervisor.status().private.state, "running");
  assert.equal(supervisor.status().private.account.balances[0]?.wallet_balance, "1005");
  assert.equal(JSON.stringify(evidence.records).includes("private-listen-key-1"), false);

  listen.failKeepAlive = true;
  scheduler.runIntervals();
  await flushAsync();
  assert.equal(supervisor.status().private.state, "backoff");
  assert.equal(listen.closeCount, 1);
  scheduler.runNextTimeout();
  await flushAsync();
  assert.equal(listen.createCount, 2);
  assert.equal(sockets.sockets.some((socket) => socket.url.includes("private-listen-key-2")), true);
  await supervisor.stop();
});

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("private socket diagnostics redact the active listen key", async () => {
  const rest = new FakeRest();
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const listen = new FakeListenKeySession();
  const evidence = new InMemoryBinanceStreamEvidenceSink();
  const supervisor = new BinanceUsdmStreamSupervisor(rest, listen, {
    socketFactory: sockets,
    scheduler,
    evidence,
    reconnectBaseMs: 1,
  });

  await supervisor.start(true);
  const privateSocket = sockets.sockets.find((socket) => socket.url.includes("private-listen-key-1"));
  if (!privateSocket) {
    throw new Error("private socket was not created");
  }
  privateSocket.serverClose(1006, "private-listen-key-1");
  await flushAsync();
  assert.equal(JSON.stringify(evidence.records).includes("private-listen-key-1"), false);
  await supervisor.stop();
});

test("operator stop cancels pending reconnects and leaves both lanes stopped", async () => {
  const rest = new FakeRest();
  const sockets = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const supervisor = new BinanceUsdmStreamSupervisor(rest, null, {
    socketFactory: sockets,
    scheduler,
    reconnectBaseMs: 1,
  });

  await supervisor.start(false);
  const publicSocket = sockets.sockets[0];
  if (!publicSocket) {
    throw new Error("public socket was not created");
  }
  publicSocket.serverClose();
  assert.equal(supervisor.status().public.state, "backoff");
  assert.equal(scheduler.timeouts.size, 1);
  await supervisor.stop();
  assert.equal(scheduler.timeouts.size, 0);
  assert.equal(supervisor.status().public.state, "stopped");
  assert.equal(supervisor.status().private.state, "stopped");
  assert.equal(supervisor.status().desired_running, false);
});
