#!/usr/bin/env node

/**
 * Raw model capture command.
 *
 * The private evaluation repository runs this against its own recordings, its
 * own protocol document, and its own trace cache. Every path is explicit: the
 * recordings to read, the protocol that says which recording plays which role,
 * where the traces are written, and where ONNX Runtime's WASM binary is. This
 * repository resolves none of those for its caller and stores nothing of its
 * own.
 *
 * Decoding needs a local FFmpeg install. It is a prerequisite of evaluation
 * only and is never installed by this package.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ONLINE_AMT_CHUNK_SIZE,
  ONLINE_AMT_SAMPLE_RATE,
  OnlineAmtSession,
} from "../index.js";
import {
  applyInputGain,
  audioConverterVersion,
  decodeAudioFileToPcm,
  measureAudioLevel,
  type AudioLevelMeasurement,
  type DecodedPcmAudio,
} from "./audioDecoder.js";
import {
  captureProvenanceWarnings,
  describeEngine,
  identifyEngine,
  type CaptureProvenance,
} from "./engineIdentity.js";
import {
  evaluationRecordingRoleOf,
  parseEvaluationProtocol,
  protocolRecordingIds,
  type EvaluationProtocol,
  type EvaluationRecordingRole,
} from "./evaluationProtocol.js";
import { captureOnlineAmtTrace } from "./onlineAmtCapture.js";
import { recordingIdOfAudioFile } from "./recordingCorpus.js";
import { inventoryRecordingFiles } from "./recordingInventory.js";
import {
  openCachedOnlineAmtTrace,
  traceDirectoryFor,
  writeOnlineAmtTrace,
  type OnlineAmtTraceMetadata,
  type OnlineAmtTraceRequirements,
} from "./traceStore.js";

const PACKAGED_MODEL = fileURLToPath(
  new URL("../../assets/models/online_amt_streaming.onnx", import.meta.url),
);
const ROLES: readonly EvaluationRecordingRole[] = ["gold", "development", "confirmation"];

function usage(): string {
  return [
    "Usage: piano-transcription-capture <recordings-directory> --protocol <file> " +
    "--traces <dir> --wasm <file> [options]",
    "",
    "  --protocol <file>   Private evaluation protocol JSON",
    "  --traces <dir>      Directory the raw traces are cached in",
    "  --wasm <file>       ONNX Runtime WASM binary; this package does not resolve it",
    "  --model <file>      ONNX model (default: the packaged canonical model)",
    "  --recording <id>    Capture only this recording; repeatable",
    "  --role <role>       Capture only gold, development, or confirmation; repeatable",
    "  --ffmpeg <path>     FFmpeg binary (default: ffmpeg)",
    "  --engine-revision <id>  Revision this engine was installed at; a local",
    "                      checkout is read directly and needs no value",
    "  --force             Replace a cached trace instead of reusing it. A trace",
    "                      captured under other settings is refused either way.",
    "  --json              Print the run as JSON",
  ].join("\n");
}

interface Options {
  recordingRoot: string;
  protocolPath: string;
  traceRoot: string;
  wasmPath: string;
  modelPath: string;
  recordingIds: string[];
  roles: EvaluationRecordingRole[];
  ffmpegPath: string | undefined;
  engineRevision: string | undefined;
  force: boolean;
  asJson: boolean;
}

function parseOptions(args: readonly string[]): Options {
  let recordingRoot: string | undefined;
  let protocolPath: string | undefined;
  let traceRoot: string | undefined;
  let wasmPath: string | undefined;
  let modelPath = PACKAGED_MODEL;
  let ffmpegPath: string | undefined;
  let engineRevision: string | undefined;
  const recordingIds: string[] = [];
  const roles: EvaluationRecordingRole[] = [];
  let force = false;
  let asJson = false;

  const next = (index: number, name: string): string => {
    const value = args[index];
    if (value === undefined) throw new Error(`${name} needs a value\n\n${usage()}`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--json") asJson = true;
    else if (argument === "--force") force = true;
    else if (argument === "--protocol") protocolPath = next((index += 1), argument);
    else if (argument === "--traces") traceRoot = next((index += 1), argument);
    else if (argument === "--wasm") wasmPath = next((index += 1), argument);
    else if (argument === "--model") modelPath = next((index += 1), argument);
    else if (argument === "--ffmpeg") ffmpegPath = next((index += 1), argument);
    else if (argument === "--engine-revision") engineRevision = next((index += 1), argument);
    else if (argument === "--recording") recordingIds.push(next((index += 1), argument));
    else if (argument === "--role") {
      const role = next((index += 1), argument) as EvaluationRecordingRole;
      if (!ROLES.includes(role)) {
        throw new Error(`--role must be one of ${ROLES.join(", ")}, received ${role}\n\n${usage()}`);
      }
      roles.push(role);
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option ${argument}\n\n${usage()}`);
    } else if (recordingRoot === undefined) recordingRoot = argument;
    else throw new Error(`Unexpected argument ${argument}\n\n${usage()}`);
  }

  if (recordingRoot === undefined) throw new Error(`No recordings directory\n\n${usage()}`);
  if (protocolPath === undefined) throw new Error(`--protocol is required\n\n${usage()}`);
  if (traceRoot === undefined) throw new Error(`--traces is required\n\n${usage()}`);
  if (wasmPath === undefined) {
    throw new Error(
      "--wasm is required: npm hoists onnxruntime-web above this package, so only the caller " +
      `knows where its WASM binary is\n\n${usage()}`,
    );
  }
  return {
    recordingRoot,
    protocolPath,
    traceRoot,
    wasmPath,
    modelPath,
    recordingIds,
    roles,
    ffmpegPath,
    engineRevision,
    force,
    asJson,
  };
}

interface CapturedRecording {
  recordingId: string;
  role: EvaluationRecordingRole;
  audioFile: string;
  cached: boolean;
  metadata: OnlineAmtTraceMetadata;
  signalActiveFrames: number;
  noise: (AudioLevelMeasurement & { startMs: number; endMs: number }) | null;
}

function decibelText(value: number | null): string {
  return value === null ? "silent" : `${value.toFixed(1)} dBFS`;
}

function reportLine(entry: CapturedRecording): string {
  const { capture, audio } = entry.metadata;
  const noise = entry.noise === null
    ? ""
    : `, noise ${decibelText(entry.noise.rootMeanSquareDbfs)} over ` +
      `${((entry.noise.endMs - entry.noise.startMs) / 1_000).toFixed(2)} s`;
  return [
    `  ${entry.recordingId} [${entry.role}]${entry.cached ? " (cached)" : ""}`,
    `    ${(capture.inputDurationMs / 1_000).toFixed(1)} s of audio in ${capture.frameCount} frames ` +
    `(${capture.inputFrameCount} with input, ${capture.paddedSampleCount} padded and ` +
    `${capture.tailFlushSampleCount} flushed samples)`,
    `    ${audio.sourceChannelCount === 1 ? "mono" : `${audio.sourceChannelCount} channels averaged to mono`}, ` +
    `peak ${decibelText(audio.capturedLevel.peakDbfs)}, ` +
    `RMS ${decibelText(audio.capturedLevel.rootMeanSquareDbfs)}, ` +
    `${audio.capturedLevel.overRangeSampleCount} over-range sample(s)${noise}`,
    `    signal active in ${entry.signalActiveFrames} of ${capture.frameCount} frames, ` +
    `${capture.realtimeFactor.toFixed(1)}x faster than its own audio`,
  ].join("\n");
}

/** The provenance of each capture, as the shared warning rules need it. */
function provenanceOf(captured: readonly CapturedRecording[]): CaptureProvenance[] {
  return captured.map((entry) => ({
    recordingId: entry.recordingId,
    cached: entry.cached,
    engine: entry.metadata.engine,
    converterVersion: entry.metadata.conversion.version,
  }));
}

function selected(
  protocol: EvaluationProtocol,
  options: Options,
): string[] {
  const wanted = new Set(options.recordingIds);
  return protocolRecordingIds(protocol).filter((recordingId) => {
    const role = evaluationRecordingRoleOf(protocol, recordingId);
    if (options.roles.length > 0 && (role === null || !options.roles.includes(role))) return false;
    return wanted.size === 0 || wanted.has(recordingId);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const options = parseOptions(args);
  const protocol = parseEvaluationProtocol(
    JSON.parse(await readFile(options.protocolPath, "utf8")),
    options.protocolPath,
  );
  const files = await inventoryRecordingFiles(options.recordingRoot);
  const audioByRecordingId = new Map(
    files.audioFiles.map((audioFile) => [recordingIdOfAudioFile(audioFile), audioFile]),
  );
  const missing = protocolRecordingIds(protocol)
    .filter((recordingId) => !audioByRecordingId.has(recordingId));
  if (missing.length > 0) {
    throw new Error(
      `${options.protocolPath} names ${missing.length} recording(s) that ${files.root} does not ` +
      `hold: ${missing.join(", ")}`,
    );
  }
  const unassigned = [...audioByRecordingId.keys()]
    .filter((recordingId) => evaluationRecordingRoleOf(protocol, recordingId) === null);

  const unknown = options.recordingIds
    .filter((id) => evaluationRecordingRoleOf(protocol, id) === null);
  if (unknown.length > 0) {
    throw new Error(`--recording named ${unknown.join(", ")}, which the protocol does not assign.`);
  }
  const recordingIds = selected(protocol, options);

  const modelData = new Uint8Array(await readFile(options.modelPath));
  const model = {
    file: basename(options.modelPath),
    byteLength: modelData.byteLength,
    sha256: createHash("sha256").update(modelData).digest("hex"),
  };
  const wasmBinary = new Uint8Array(await readFile(options.wasmPath));
  const converterVersion = await audioConverterVersion(options.ffmpegPath);
  const engine = await identifyEngine(options.engineRevision);

  // The recording is read by absolute path but recorded by its corpus-relative
  // one, so an archived trace names the recording and not this machine.
  const decode = (audioFile: string): Promise<DecodedPcmAudio> => decodeAudioFileToPcm(
    resolve(files.root, audioFile),
    {
      inputLabel: audioFile,
      ...(options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath }),
    },
  );

  const session = await OnlineAmtSession.create({ modelData, wasmBinary });
  const captured: CapturedRecording[] = [];
  try {
    for (const recordingId of recordingIds) {
      const audioFile = audioByRecordingId.get(recordingId) as string;
      const role = evaluationRecordingRoleOf(protocol, recordingId) as EvaluationRecordingRole;
      const directory = traceDirectoryFor(options.traceRoot, recordingId);
      let metadata: OnlineAmtTraceMetadata;
      let signalActiveFrames: number;
      let cached = false;
      const configuredNoise = protocol.noiseIntervals
        .find((entry) => entry.recordingId === recordingId);
      // The recording's own bytes are part of what a cached trace must match,
      // so they are read before the cache is consulted rather than assumed
      // unchanged since the capture.
      const audioSha256 = createHash("sha256")
        .update(await readFile(resolve(files.root, audioFile)))
        .digest("hex");
      const required: OnlineAmtTraceRequirements = {
        modelSha256: model.sha256,
        audioSha256,
        sampleRateHz: ONLINE_AMT_SAMPLE_RATE,
        chunkSize: ONLINE_AMT_CHUNK_SIZE,
        inputGainDb: protocol.baseline.inputGainDb,
        tailFlushSampleCount: protocol.baseline.tailFlushSamples,
      };
      const restored = options.force
        ? null
        : await openCachedOnlineAmtTrace(directory, required);
      let decoded: DecodedPcmAudio | null = null;
      if (restored !== null) {
        metadata = restored.metadata;
        signalActiveFrames = restored.trace.signalActive.reduce<number>(
          (count, flag) => count + (flag === 0 ? 0 : 1),
          0,
        );
        cached = true;
        // Level is a property of the audio, so a cached capture still needs the
        // samples to report the noise interval the protocol names.
        if (configuredNoise !== undefined) decoded = await decode(audioFile);
      } else {
        decoded = await decode(audioFile);
        const amplified = applyInputGain(decoded.samples, protocol.baseline.inputGainDb);
        const trace = await captureOnlineAmtTrace(session, amplified.samples, {
          tailFlushSamples: protocol.baseline.tailFlushSamples,
        });
        metadata = await writeOnlineAmtTrace(directory, {
          capturedAt: new Date().toISOString(),
          recordingId,
          engine,
          model,
          conversion: decoded.conversion,
          audio: {
            file: audioFile,
            sha256: audioSha256,
            sampleRateHz: decoded.sampleRateHz,
            channelCount: decoded.channelCount,
            sourceChannelCount: decoded.sourceChannelCount,
            durationMs: decoded.durationMs,
            decodedLevel: decoded.level,
            capturedLevel: amplified.level,
            inputGainDb: protocol.baseline.inputGainDb,
          },
        }, trace);
        signalActiveFrames = trace.signalActive.reduce<number>(
          (count, flag) => count + (flag === 0 ? 0 : 1),
          0,
        );
      }
      let noise: CapturedRecording["noise"] = null;
      if (configuredNoise !== undefined && decoded !== null) {
        const startMs = configuredNoise.startMs;
        const endMs = configuredNoise.endMs - configuredNoise.attackGuardMs;
        noise = {
          ...measureAudioLevel(
            decoded.samples,
            Math.round(startMs / 1_000 * decoded.sampleRateHz),
            Math.round(endMs / 1_000 * decoded.sampleRateHz),
          ),
          startMs,
          endMs,
        };
      }
      captured.push({ recordingId, role, audioFile, cached, metadata, signalActiveFrames, noise });
    }
  } finally {
    await session.dispose();
  }

  if (options.asJson) {
    console.log(JSON.stringify({
      protocol: protocol.id,
      engine,
      recordings: captured,
      unassignedRecordings: unassigned,
      converter: converterVersion,
      warnings: captureProvenanceWarnings(engine, converterVersion, provenanceOf(captured)),
    }, null, 2));
    return;
  }
  const lines = [
    `Protocol ${protocol.id} (round ${protocol.round}, adopted ${protocol.adoptedOn})`,
    `Recordings: ${files.root}`,
    `Traces: ${resolve(options.traceRoot)}`,
    `Engine: ${describeEngine(engine)}`,
    `Model: ${model.file}, ${model.byteLength} bytes, SHA-256 ${model.sha256.slice(0, 12)}…`,
    `Converter: ${converterVersion}`,
    `Baseline: ${protocol.baseline.inputGainDb} dB input gain, ` +
    `${protocol.baseline.tailFlushSamples}-sample tail flush`,
    "",
  ];
  for (const role of ROLES) {
    const entries = captured.filter((entry) => entry.role === role);
    if (entries.length === 0) continue;
    lines.push(`${role}: ${entries.length} recording(s)`);
    for (const entry of entries) lines.push(reportLine(entry));
    lines.push("");
  }
  lines.push(
    `Captured ${captured.filter((entry) => !entry.cached).length} and reused ` +
    `${captured.filter((entry) => entry.cached).length} cached trace(s).`,
  );
  for (const warning of captureProvenanceWarnings(engine, converterVersion, provenanceOf(captured))) {
    lines.push(warning);
  }
  if (unassigned.length > 0) {
    lines.push(
      `${unassigned.length} recording(s) in the corpus are not assigned by the protocol: ` +
      unassigned.join(", "),
    );
  }
  console.log(lines.join("\n"));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
