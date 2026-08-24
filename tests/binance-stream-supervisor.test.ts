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
  const supervisor = new BinanceUsdmStreamSupervisor(rest, null, {
    socketFactory: sockets,
    scheduler,
    evidence,
    reconnectBaseMs: 1,
  });

  await supervisor.start(false);
  const publicSocket = sockets.sockets[0];
  if (!publicSocket) {
    throw new Error("public socket was not created");
  }
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
