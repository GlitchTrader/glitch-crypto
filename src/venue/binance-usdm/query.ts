import { createHmac } from "node:crypto";

export type BinanceQueryValue = string | number | bigint | boolean | null | undefined;

export function encodeBinanceQuery(
  parameters: Readonly<Record<string, BinanceQueryValue>>,
): string {
  return Object.entries(parameters)
    .filter((entry): entry is [string, Exclude<BinanceQueryValue, null | undefined>] =>
      entry[1] !== null && entry[1] !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

export function signBinanceQuery(secret: string, query: string): string {
  if (!secret) {
    throw new Error("Binance API secret is not configured");
  }
  return createHmac("sha256", secret).update(query).digest("hex");
}

export function buildSignedBinanceQuery(
  parameters: Readonly<Record<string, BinanceQueryValue>>,
  secret: string,
  timestamp: number,
  recvWindow = 5_000,
): string {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error("Binance timestamp must be a positive safe integer");
  }
  if (!Number.isSafeInteger(recvWindow) || recvWindow < 1 || recvWindow > 60_000) {
    throw new Error("Binance recvWindow must be an integer between 1 and 60000 milliseconds");
  }
  const query = encodeBinanceQuery({ ...parameters, recvWindow, timestamp });
  return `${query}&signature=${signBinanceQuery(secret, query)}`;
}
