/**
 * Schema and validator for a round's fixed evaluation protocol.
 *
 * The protocol is caller data: a private repository writes one document naming
 * its own recordings, the interval of each that is scored, the timing rules,
 * the intervals that may be used to estimate noise, the baseline capture
 * settings, and the experiment budget. This module owns only the shape and the
 * rules that make such a document usable, so no corpus, recording id, or score
 * ever lives in this package.
 *
 * It is deliberately strict. A protocol is written once and then applied
 * unchanged to every configuration, so a document that is ambiguous about which
 * recording is held out, which window matches an attack, or which interval is
 * scored is refused rather than half-understood.
 */

import { ONLINE_AMT_CHUNK_SIZE } from "../index.js";

/**
 * How a recording is used. Gold takes are all measured and support the
 * leave-one-take-out calibration folds; only the silver repertoire is split
 * into a half that may direct tuning and a half that is held out.
 */
export type EvaluationRecordingRole = "gold" | "development" | "confirmation";

export interface EvaluationSplit {
  /** Recordings whose failures may direct tuning. */
  development: readonly string[];
  /** Recordings held out; baseline runs are allowed, tuning on them is not. */
  confirmation: readonly string[];
}

export interface EvaluationTimingRules {
  /** Primary onset match window, applied symmetrically. */
  primaryOnsetWindowMs: number;
  /** Wider window reported alongside it as a timing-sensitivity result. */
  supplementalOnsetWindowMs: number;
  /**
   * Offset added to every reference onset before matching, derived from
   * audio/annotation inspection rather than from optimising a score.
   */
  alignmentOffsetMs: number;
  /** Per-recording replacement for the global offset. */
  recordingAlignmentOffsetMs: Readonly<Record<string, number>>;
}

/** A half-open interval of one recording, in audio time. */
export interface EvaluationInterval {
  recordingId: string;
  startMs: number;
  endMs: number;
  note?: string;
}

/**
 * An interval that may be used to estimate noise.
 *
 * `attackGuardMs` is trimmed from the end before measuring, so the estimate
 * cannot include the leading edge of the first attack.
 */
export interface NoiseInterval extends EvaluationInterval {
  attackGuardMs: number;
}

export interface BaselineCaptureConfiguration {
  /** Fixed input gain; zero is the untouched recording level. */
  inputGainDb: number;
  tailFlushSamples: number;
}

export interface ExperimentBudget {
  hypothesisCycles: number;
  minConfigurationsPerCycle: number;
  maxConfigurationsPerCycle: number;
  /** Consecutive unproductive cycles that end the loop early. */
  consecutiveUnproductiveCycles: number;
}

export interface EvaluationProtocol {
  id: string;
  round: string;
  adoptedOn: string;
  /** Gold takes, measured in full and never used as a held-out silver half. */
  goldRecordings: readonly string[];
  split: EvaluationSplit;
  timing: EvaluationTimingRules;
  /** Scored interval of a recording; a recording without one is scored whole. */
  scoringIntervals: readonly EvaluationInterval[];
  /**
   * Regions excluded from scoring for every configuration, on both the
   * reference and the predicted side.
   */
  excludedIntervals: readonly EvaluationInterval[];
  noiseIntervals: readonly NoiseInterval[];
  baseline: BaselineCaptureConfiguration;
  experimentBudget: ExperimentBudget;
}

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

function record(value: unknown, source: string, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(source, `${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, source: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(source, `${path} must be a non-empty string.`);
  return value;
}

function finiteNumber(value: unknown, source: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(source, `${path} must be a finite number.`);
  }
  return value;
}

function positiveNumber(value: unknown, source: string, path: string): number {
  const parsed = finiteNumber(value, source, path);
  if (parsed <= 0) fail(source, `${path} must be greater than zero, received ${parsed}.`);
  return parsed;
}

function nonNegativeNumber(value: unknown, source: string, path: string): number {
  const parsed = finiteNumber(value, source, path);
  if (parsed < 0) fail(source, `${path} must not be negative, received ${parsed}.`);
  return parsed;
}

function positiveInteger(value: unknown, source: string, path: string): number {
  const parsed = finiteNumber(value, source, path);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(source, `${path} must be a positive whole number, received ${parsed}.`);
  }
  return parsed;
}

function list(value: unknown, source: string, path: string): unknown[] {
  if (!Array.isArray(value)) fail(source, `${path} must be an array.`);
  return value;
}

function recordingIds(value: unknown, source: string, path: string): string[] {
  const ids = list(value, source, path).map((entry, index) => text(entry, source, `${path}[${index}]`));
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(source, `${path} names ${id} twice.`);
    seen.add(id);
  }
  return ids;
}

function interval(value: unknown, source: string, path: string): EvaluationInterval {
  const entry = record(value, source, path);
  const recordingId = text(entry.recordingId, source, `${path}.recordingId`);
  const startMs = nonNegativeNumber(entry.startMs, source, `${path}.startMs`);
  const endMs = finiteNumber(entry.endMs, source, `${path}.endMs`);
  if (endMs <= startMs) {
    fail(source, `${path} ends at ${endMs} ms, which is not after its ${startMs} ms start.`);
  }
  const note = entry.note === undefined ? undefined : text(entry.note, source, `${path}.note`);
  return note === undefined
    ? { recordingId, startMs, endMs }
    : { recordingId, startMs, endMs, note };
}

function intervals(value: unknown, source: string, path: string): EvaluationInterval[] {
  return list(value, source, path).map((entry, index) => interval(entry, source, `${path}[${index}]`));
}

function oneIntervalPerRecording(
  parsed: readonly EvaluationInterval[],
  source: string,
  path: string,
): void {
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (seen.has(entry.recordingId)) {
      fail(source, `${path} gives ${entry.recordingId} more than one interval.`);
    }
    seen.add(entry.recordingId);
  }
}

/**
 * Parses one protocol document and refuses an unusable one.
 *
 * Beyond per-field types it enforces the rules the round depends on: a
 * recording is on exactly one side of the split, every interval names a
 * recording the split holds, the supplemental window is at least the primary
 * one, and the tail flush is a whole number of model chunks.
 */
export function parseEvaluationProtocol(
  value: unknown,
  sourceLabel = "protocol",
): EvaluationProtocol {
  const source = sourceLabel;
  const document = record(value, source, "the protocol");
  const id = text(document.id, source, "id");
  const round = text(document.round, source, "round");
  const adoptedOn = text(document.adoptedOn, source, "adoptedOn");

  const goldRecordings = recordingIds(document.goldRecordings, source, "goldRecordings");
  if (goldRecordings.length === 0) fail(source, "goldRecordings names no recording.");
  const splitDocument = record(document.split, source, "split");
  const development = recordingIds(splitDocument.development, source, "split.development");
  const confirmation = recordingIds(splitDocument.confirmation, source, "split.confirmation");
  if (development.length === 0) fail(source, "split.development names no recording.");
  if (confirmation.length === 0) fail(source, "split.confirmation names no recording.");
  const known = new Set(goldRecordings);
  for (const [path, ids] of [
    ["split.development", development] as const,
    ["split.confirmation", confirmation] as const,
  ]) {
    for (const recordingId of ids) {
      if (known.has(recordingId)) {
        fail(source, `${path} repeats ${recordingId}, which the protocol already assigns.`);
      }
      known.add(recordingId);
    }
  }

  const timingDocument = record(document.timing, source, "timing");
  const primaryOnsetWindowMs = positiveNumber(
    timingDocument.primaryOnsetWindowMs,
    source,
    "timing.primaryOnsetWindowMs",
  );
  const supplementalOnsetWindowMs = positiveNumber(
    timingDocument.supplementalOnsetWindowMs,
    source,
    "timing.supplementalOnsetWindowMs",
  );
  if (supplementalOnsetWindowMs < primaryOnsetWindowMs) {
    fail(
      source,
      `timing.supplementalOnsetWindowMs (${supplementalOnsetWindowMs}) is narrower than the ` +
      `primary window (${primaryOnsetWindowMs}); the supplemental result must be the wider one.`,
    );
  }
  const alignmentOffsetMs = finiteNumber(
    timingDocument.alignmentOffsetMs,
    source,
    "timing.alignmentOffsetMs",
  );
  const offsetsDocument = record(
    timingDocument.recordingAlignmentOffsetMs ?? {},
    source,
    "timing.recordingAlignmentOffsetMs",
  );
  const recordingAlignmentOffsetMs: Record<string, number> = {};
  for (const [recordingId, offset] of Object.entries(offsetsDocument)) {
    if (!known.has(recordingId)) {
      fail(
        source,
        `timing.recordingAlignmentOffsetMs names ${recordingId}, which the protocol does not assign.`,
      );
    }
    recordingAlignmentOffsetMs[recordingId] = finiteNumber(
      offset,
      source,
      `timing.recordingAlignmentOffsetMs.${recordingId}`,
    );
  }

  const scoringIntervals = intervals(document.scoringIntervals ?? [], source, "scoringIntervals");
  oneIntervalPerRecording(scoringIntervals, source, "scoringIntervals");
  const excludedIntervals = intervals(document.excludedIntervals ?? [], source, "excludedIntervals");
  const noiseIntervals = list(document.noiseIntervals ?? [], source, "noiseIntervals")
    .map((entry, index) => {
      const path = `noiseIntervals[${index}]`;
      const base = interval(entry, source, path);
      const attackGuardMs = nonNegativeNumber(
        record(entry, source, path).attackGuardMs,
        source,
        `${path}.attackGuardMs`,
      );
      if (base.startMs + attackGuardMs >= base.endMs) {
        fail(
          source,
          `${path} leaves nothing to measure once its ${attackGuardMs} ms attack guard is trimmed.`,
        );
      }
      return { ...base, attackGuardMs };
    });
  for (const [path, parsed] of [
    ["scoringIntervals", scoringIntervals] as const,
    ["excludedIntervals", excludedIntervals] as const,
    ["noiseIntervals", noiseIntervals] as const,
  ]) {
    for (const entry of parsed) {
      if (!known.has(entry.recordingId)) {
        fail(source, `${path} names ${entry.recordingId}, which the protocol does not assign.`);
      }
    }
  }

  const baselineDocument = record(document.baseline, source, "baseline");
  const inputGainDb = finiteNumber(baselineDocument.inputGainDb, source, "baseline.inputGainDb");
  const tailFlushSamples = finiteNumber(
    baselineDocument.tailFlushSamples,
    source,
    "baseline.tailFlushSamples",
  );
  if (!Number.isInteger(tailFlushSamples) || tailFlushSamples < 0) {
    fail(source, `baseline.tailFlushSamples must be a non-negative whole number, received ${tailFlushSamples}.`);
  }
  if (tailFlushSamples % ONLINE_AMT_CHUNK_SIZE !== 0) {
    fail(
      source,
      `baseline.tailFlushSamples must be a multiple of ${ONLINE_AMT_CHUNK_SIZE} so its frames can ` +
      `be counted exactly, received ${tailFlushSamples}.`,
    );
  }

  const budgetDocument = record(document.experimentBudget, source, "experimentBudget");
  const hypothesisCycles = positiveInteger(
    budgetDocument.hypothesisCycles,
    source,
    "experimentBudget.hypothesisCycles",
  );
  const minConfigurationsPerCycle = positiveInteger(
    budgetDocument.minConfigurationsPerCycle,
    source,
    "experimentBudget.minConfigurationsPerCycle",
  );
  const maxConfigurationsPerCycle = positiveInteger(
    budgetDocument.maxConfigurationsPerCycle,
    source,
    "experimentBudget.maxConfigurationsPerCycle",
  );
  if (maxConfigurationsPerCycle < minConfigurationsPerCycle) {
    fail(
      source,
      `experimentBudget.maxConfigurationsPerCycle (${maxConfigurationsPerCycle}) is below its ` +
      `minimum (${minConfigurationsPerCycle}).`,
    );
  }
  const consecutiveUnproductiveCycles = positiveInteger(
    budgetDocument.consecutiveUnproductiveCycles,
    source,
    "experimentBudget.consecutiveUnproductiveCycles",
  );

  return {
    id,
    round,
    adoptedOn,
    goldRecordings,
    split: { development, confirmation },
    timing: {
      primaryOnsetWindowMs,
      supplementalOnsetWindowMs,
      alignmentOffsetMs,
      recordingAlignmentOffsetMs,
    },
    scoringIntervals,
    excludedIntervals,
    noiseIntervals,
    baseline: { inputGainDb, tailFlushSamples },
    experimentBudget: {
      hypothesisCycles,
      minConfigurationsPerCycle,
      maxConfigurationsPerCycle,
      consecutiveUnproductiveCycles,
    },
  };
}

/** How the protocol uses a recording, or null when it does not name it. */
export function evaluationRecordingRoleOf(
  protocol: EvaluationProtocol,
  recordingId: string,
): EvaluationRecordingRole | null {
  if (protocol.goldRecordings.includes(recordingId)) return "gold";
  if (protocol.split.development.includes(recordingId)) return "development";
  if (protocol.split.confirmation.includes(recordingId)) return "confirmation";
  return null;
}

/** Every recording the protocol names, in gold, development, confirmation order. */
export function protocolRecordingIds(protocol: EvaluationProtocol): string[] {
  return [
    ...protocol.goldRecordings,
    ...protocol.split.development,
    ...protocol.split.confirmation,
  ];
}

/** The alignment offset that applies to one recording. */
export function alignmentOffsetMsFor(
  protocol: EvaluationProtocol,
  recordingId: string,
): number {
  return protocol.timing.recordingAlignmentOffsetMs[recordingId] ??
    protocol.timing.alignmentOffsetMs;
}

/** The scored interval of one recording, defaulting to the whole recording. */
export function scoringIntervalFor(
  protocol: EvaluationProtocol,
  recordingId: string,
  durationMs: number,
): { startMs: number; endMs: number } {
  const configured = protocol.scoringIntervals.find((entry) => entry.recordingId === recordingId);
  if (configured === undefined) return { startMs: 0, endMs: durationMs };
  return { startMs: configured.startMs, endMs: Math.min(configured.endMs, durationMs) };
}
