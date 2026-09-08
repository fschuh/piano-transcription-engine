/**
 * Reads and writes a cached raw model trace.
 *
 * A capture is expensive and every later experiment on the model's own output
 * replays the same frames, so a trace is written once and reused. The layout is
 * a directory of plain typed-array files beside one metadata document, which
 * keeps a trace inspectable with ordinary tools and keeps the recording it came
 * from in the caller's private repository rather than in this package.
 *
 * A cached trace is only worth having if it cannot be mistaken for one it is
 * not, so the metadata records every input that decided its contents — the
 * engine build, the model, the recording's own bytes, the framing, the gain and
 * the tail flush — and `openCachedOnlineAmtTrace` refuses one that answers a
 * different request. The metadata identifies the artifact and the build that
 * produced it. It records nothing about the repository that ran the capture.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AudioConversionCommand, AudioLevelMeasurement } from "./audioDecoder.js";
import type { OnlineAmtCaptureTrace } from "./onlineAmtCapture.js";

export const ONLINE_AMT_TRACE_FORMAT_VERSION = 3;

const SCORES_FILE = "scores.f32";
const STATES_FILE = "states.u8";
const SIGNAL_ACTIVE_FILE = "signal-active.u8";
const INFERENCE_TIME_FILE = "inference-ms.f32";
const METADATA_FILE = "metadata.json";

/**
 * The engine build a trace was captured by.
 *
 * A package version does not identify code: several revisions share one, and a
 * working tree can differ from every revision. A caller that installed this
 * package at a pinned revision supplies that revision; a caller running a local
 * checkout has it discovered, along with whether the tree was clean. When
 * neither is possible the trace says so rather than implying provenance it does
 * not have.
 */
export interface OnlineAmtTraceEngine {
  name: string;
  version: string;
  /** Revision the capture code came from, or null when none was established. */
  revision: string | null;
  /**
   * Where the revision came from. A checkout is measured; a caller is taken at
   * its word, so a reader can tell one from the other.
   */
  revisionSource: "checkout" | "caller" | "none";
  /**
   * Whether the capture ran from code carrying uncommitted changes. Null when
   * that could not be established, which is not the same as knowing it was
   * clean.
   */
  uncommitted: boolean | null;
  /**
   * Whatever revision the caller asserted, recorded whether or not it was used.
   * A measured checkout wins, so this is how a wrong assertion stays visible
   * instead of disappearing.
   */
  callerRevision: string | null;
}

export interface OnlineAmtTraceModel {
  /** File name of the model asset, without the path that held it. */
  file: string;
  byteLength: number;
  sha256: string;
}

export interface OnlineAmtTraceAudio {
  /** Path of the recording as the caller named it. */
  file: string;
  /** Digest of the recording's own bytes, before any decoding. */
  sha256: string;
  sampleRateHz: number;
  /** Channels fed to the model; always one. */
  channelCount: number;
  /** Channels the recording itself carried before the downmix. */
  sourceChannelCount: number;
  durationMs: number;
  /** Level of the decoded samples before any gain. */
  decodedLevel: AudioLevelMeasurement;
  /** Level actually fed to the model; equal to the decoded level at unity gain. */
  capturedLevel: AudioLevelMeasurement;
  inputGainDb: number;
}

export interface OnlineAmtTraceShape {
  frameCount: number;
  inputFrameCount: number;
  chunkSize: number;
  pitchCount: number;
  stateCount: number;
  sampleRateHz: number;
  inputSampleCount: number;
  paddedSampleCount: number;
  tailFlushSampleCount: number;
  inputDurationMs: number;
  capturedDurationMs: number;
  elapsedMs: number;
  /** Captured audio duration divided by the wall-clock time spent producing it. */
  realtimeFactor: number;
}

export interface OnlineAmtTraceDigests {
  scores: string;
  states: string;
  signalActive: string;
  inferenceTimeMs: string;
}

export interface OnlineAmtTraceMetadata {
  formatVersion: number;
  capturedAt: string;
  recordingId: string;
  engine: OnlineAmtTraceEngine;
  model: OnlineAmtTraceModel;
  conversion: AudioConversionCommand;
  audio: OnlineAmtTraceAudio;
  capture: OnlineAmtTraceShape;
  /** How a frame index becomes an audio time, stated with the artifact. */
  frameTimeMsExpression: string;
  digests: OnlineAmtTraceDigests;
}

/** What a caller supplies; the shape and digests are derived from the trace. */
export type OnlineAmtTraceIdentification =
  Omit<OnlineAmtTraceMetadata, "formatVersion" | "capture" | "digests" | "frameTimeMsExpression">;

/**
 * Everything about a request that determines a trace's contents.
 *
 * A cached trace may only stand in for a capture when all of these agree. They
 * are the inputs the model actually saw: the weights, the recording's own
 * bytes, the rate and chunking they were fed at, and the gain and tail flush
 * applied on the way in.
 */
export interface OnlineAmtTraceRequirements {
  modelSha256: string;
  audioSha256: string;
  sampleRateHz: number;
  chunkSize: number;
  inputGainDb: number;
  tailFlushSampleCount: number;
}

const FRAME_TIME_MS_EXPRESSION = "(frameIndex + 1) * chunkSize / sampleRateHz * 1000";

function digestOf(view: ArrayBufferView): string {
  return createHash("sha256")
    .update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    .digest("hex");
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function float32Of(bytes: Uint8Array, label: string): Float32Array {
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`${label} holds ${bytes.byteLength} bytes, which is not whole float32 values.`);
  }
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

function traceShape(trace: OnlineAmtCaptureTrace): OnlineAmtTraceShape {
  return {
    frameCount: trace.frameCount,
    inputFrameCount: trace.inputFrameCount,
    chunkSize: trace.chunkSize,
    pitchCount: trace.pitchCount,
    stateCount: trace.stateCount,
    sampleRateHz: trace.sampleRateHz,
    inputSampleCount: trace.inputSampleCount,
    paddedSampleCount: trace.paddedSampleCount,
    tailFlushSampleCount: trace.tailFlushSampleCount,
    inputDurationMs: trace.inputDurationMs,
    capturedDurationMs: trace.capturedDurationMs,
    elapsedMs: trace.elapsedMs,
    realtimeFactor: trace.elapsedMs > 0 ? trace.capturedDurationMs / trace.elapsedMs : Infinity,
  };
}

function traceDigests(trace: OnlineAmtCaptureTrace): OnlineAmtTraceDigests {
  return {
    scores: digestOf(trace.scores),
    states: digestOf(trace.states),
    signalActive: digestOf(trace.signalActive),
    inferenceTimeMs: digestOf(trace.inferenceTimeMs),
  };
}

/**
 * Checks that a trace's arrays are exactly the size its own shape claims.
 *
 * Both entry points run this, so a trace that is written and a trace that is
 * read are held to the same rule rather than one trusting the other.
 */
function assertTraceShape(shape: OnlineAmtTraceShape, trace: OnlineAmtCaptureTrace): void {
  const expectedScores = shape.frameCount * shape.pitchCount * shape.stateCount;
  const expectedStates = shape.frameCount * shape.pitchCount;
  if (trace.scores.length !== expectedScores) {
    throw new Error(`Trace holds ${trace.scores.length} scores but claims ${expectedScores}.`);
  }
  if (trace.states.length !== expectedStates) {
    throw new Error(`Trace holds ${trace.states.length} states but claims ${expectedStates}.`);
  }
  if (trace.signalActive.length !== shape.frameCount) {
    throw new Error(
      `Trace holds ${trace.signalActive.length} signal-active flags but claims ${shape.frameCount}.`,
    );
  }
  if (trace.inferenceTimeMs.length !== shape.frameCount) {
    throw new Error(
      `Trace holds ${trace.inferenceTimeMs.length} inference times but claims ${shape.frameCount}.`,
    );
  }
  const framedSamples = shape.inputSampleCount + shape.paddedSampleCount;
  if (framedSamples + shape.tailFlushSampleCount !== shape.frameCount * shape.chunkSize) {
    throw new Error(
      `Trace claims ${shape.inputSampleCount} input, ${shape.paddedSampleCount} padded, and ` +
      `${shape.tailFlushSampleCount} flushed samples, which is not ${shape.frameCount} frames ` +
      `of ${shape.chunkSize}.`,
    );
  }
  if (framedSamples !== shape.inputFrameCount * shape.chunkSize) {
    throw new Error(
      `Trace claims ${shape.inputFrameCount} input frames, which does not hold ` +
      `${shape.inputSampleCount} input and ${shape.paddedSampleCount} padded samples.`,
    );
  }
}

/** Writes one trace and its metadata into `directory`, creating it if needed. */
export async function writeOnlineAmtTrace(
  directory: string,
  identification: OnlineAmtTraceIdentification,
  trace: OnlineAmtCaptureTrace,
): Promise<OnlineAmtTraceMetadata> {
  const shape = traceShape(trace);
  assertTraceShape(shape, trace);
  const metadata: OnlineAmtTraceMetadata = {
    ...identification,
    formatVersion: ONLINE_AMT_TRACE_FORMAT_VERSION,
    capture: shape,
    frameTimeMsExpression: FRAME_TIME_MS_EXPRESSION,
    digests: traceDigests(trace),
  };
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(resolve(root, SCORES_FILE), bytesOf(trace.scores)),
    writeFile(resolve(root, STATES_FILE), bytesOf(trace.states)),
    writeFile(resolve(root, SIGNAL_ACTIVE_FILE), bytesOf(trace.signalActive)),
    writeFile(resolve(root, INFERENCE_TIME_FILE), bytesOf(trace.inferenceTimeMs)),
  ]);
  // The metadata is written last, so an interrupted capture leaves a directory
  // that reads as absent rather than as a complete trace with missing frames.
  await writeFile(resolve(root, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

/**
 * Reads a cached trace and verifies it against its own metadata.
 *
 * The digests are recomputed from the bytes on disk rather than compared as
 * stored strings, so a truncated, swapped, or edited array file is refused
 * instead of being replayed as evidence.
 */
export async function readOnlineAmtTrace(
  directory: string,
): Promise<{ metadata: OnlineAmtTraceMetadata; trace: OnlineAmtCaptureTrace }> {
  const root = resolve(directory);
  const [metadataText, scoreBytes, stateBytes, activeBytes, inferenceBytes] = await Promise.all([
    readFile(resolve(root, METADATA_FILE), "utf8"),
    readFile(resolve(root, SCORES_FILE)),
    readFile(resolve(root, STATES_FILE)),
    readFile(resolve(root, SIGNAL_ACTIVE_FILE)),
    readFile(resolve(root, INFERENCE_TIME_FILE)),
  ]);
  const metadata = JSON.parse(metadataText) as OnlineAmtTraceMetadata;
  if (metadata.formatVersion !== ONLINE_AMT_TRACE_FORMAT_VERSION) {
    throw new Error(
      `${root} is trace format ${metadata.formatVersion}; this build reads ` +
      `${ONLINE_AMT_TRACE_FORMAT_VERSION}.`,
    );
  }
  const shape = metadata.capture;
  const trace: OnlineAmtCaptureTrace = {
    frameCount: shape.frameCount,
    inputFrameCount: shape.inputFrameCount,
    chunkSize: shape.chunkSize,
    pitchCount: shape.pitchCount,
    stateCount: shape.stateCount,
    sampleRateHz: shape.sampleRateHz,
    inputSampleCount: shape.inputSampleCount,
    paddedSampleCount: shape.paddedSampleCount,
    tailFlushSampleCount: shape.tailFlushSampleCount,
    inputDurationMs: shape.inputDurationMs,
    capturedDurationMs: shape.capturedDurationMs,
    elapsedMs: shape.elapsedMs,
    scores: float32Of(scoreBytes, SCORES_FILE),
    states: new Uint8Array(stateBytes),
    signalActive: new Uint8Array(activeBytes),
    inferenceTimeMs: float32Of(inferenceBytes, INFERENCE_TIME_FILE),
  };
  assertTraceShape(shape, trace);
  const digests = traceDigests(trace);
  for (const name of Object.keys(digests) as Array<keyof OnlineAmtTraceDigests>) {
    if (digests[name] !== metadata.digests[name]) {
      throw new Error(
        `${root} ${name} does not match its recorded digest; the cached trace is not the one ` +
        "that was captured.",
      );
    }
  }
  return { metadata, trace };
}

function decibels(value: number): string {
  return `${value} dB`;
}

/**
 * Names every way a cached trace fails to answer the request, or nothing.
 *
 * Each comparison is against a value the trace recorded about the capture it
 * actually ran, so a trace can never satisfy a request merely by sitting at the
 * path the request would have written to.
 */
export function onlineAmtTraceMismatches(
  metadata: OnlineAmtTraceMetadata,
  required: OnlineAmtTraceRequirements,
): string[] {
  const mismatches: string[] = [];
  const compare = (what: string, cached: string, wanted: string): void => {
    if (cached !== wanted) mismatches.push(`${what} is ${cached} but ${wanted} was requested`);
  };
  compare("its model", metadata.model.sha256, required.modelSha256);
  compare("its recording", metadata.audio.sha256, required.audioSha256);
  compare("its sample rate", `${metadata.audio.sampleRateHz} Hz`, `${required.sampleRateHz} Hz`);
  compare("its chunk size", `${metadata.capture.chunkSize}`, `${required.chunkSize}`);
  compare(
    "its input gain",
    decibels(metadata.audio.inputGainDb),
    decibels(required.inputGainDb),
  );
  compare(
    "its tail flush",
    `${metadata.capture.tailFlushSampleCount} samples`,
    `${required.tailFlushSampleCount} samples`,
  );
  return mismatches;
}

/**
 * Reads the cached trace at `directory` when it answers this exact request.
 *
 * Returns null when nothing is cached there. A trace that is cached but was
 * captured under different settings, from a different model, or from different
 * audio is refused: reusing it would compare two configurations while reporting
 * one, which is worse than the capture it saved.
 */
export async function openCachedOnlineAmtTrace(
  directory: string,
  required: OnlineAmtTraceRequirements,
): Promise<{ metadata: OnlineAmtTraceMetadata; trace: OnlineAmtCaptureTrace } | null> {
  const root = resolve(directory);
  const details = await stat(root).catch(() => null);
  if (details === null || !details.isDirectory()) return null;
  const cached = await readOnlineAmtTrace(root);
  const mismatches = onlineAmtTraceMismatches(cached.metadata, required);
  if (mismatches.length > 0) {
    throw new Error(
      `The trace cached for ${cached.metadata.recordingId} does not answer this request: ` +
      `${mismatches.join("; ")}. Capture into a different directory to keep both, or pass ` +
      "--force to replace it.",
    );
  }
  return cached;
}

/** Where the trace of one recording lives under a cache root. */
export function traceDirectoryFor(cacheRoot: string, recordingId: string): string {
  if (recordingId.trim() === "") throw new Error("A trace needs a non-empty recording id.");
  return resolve(cacheRoot, recordingId.replaceAll("/", "__"));
}
