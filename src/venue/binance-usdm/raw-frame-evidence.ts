import { createHash } from "node:crypto";
import { unwrapBinanceStreamPayload } from "./stream-common.js";
import type {
  BinanceRawFrameChannel,
  BinanceRawFrameNormalizationVersion,
  BinanceStreamEvidenceRecordV2,
} from "./stream-evidence.js";

export interface BinanceRawFrameExpectedAuthority {
  channel: BinanceRawFrameChannel;
  instrument: string;
  normalization_version: BinanceRawFrameNormalizationVersion;
}

export interface BinanceRawFrameVerification {
  hash_matches: boolean;
  payload_matches: boolean;
  authority_matches: boolean;
  connection_attributed: boolean;
  receive_time_monotonic: boolean;
}

export function verifyBinanceRawFrame(
  record: BinanceStreamEvidenceRecordV2,
  expected: BinanceRawFrameExpectedAuthority,
  connectionIds: ReadonlySet<string>,
  previousMonotonicReceiveNs: bigint | null,
): BinanceRawFrameVerification {
  const provenance = record.provenance;
  const hashMatches = createHash("sha256")
    .update(provenance.raw_frame)
    .digest("hex") === provenance.raw_frame_sha256;
  let payloadMatches = false;
  try {
    payloadMatches = JSON.stringify(
      unwrapBinanceStreamPayload(provenance.raw_frame),
    ) === JSON.stringify(record.payload);
  } catch {
    payloadMatches = record.payload === null;
  }
  const monotonic = BigInt(provenance.monotonic_receive_ns);
  return {
    hash_matches: hashMatches,
    payload_matches: payloadMatches,
    authority_matches:
      record.channel === expected.channel &&
      provenance.venue === "BINANCE_USDM" &&
      provenance.channel === expected.channel &&
      provenance.instrument === expected.instrument &&
      provenance.normalization_version === expected.normalization_version,
    connection_attributed: connectionIds.has(provenance.connection_id),
    receive_time_monotonic:
      previousMonotonicReceiveNs === null ||
      monotonic > previousMonotonicReceiveNs,
  };
}
