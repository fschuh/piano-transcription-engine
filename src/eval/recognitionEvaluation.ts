/** Target-independent readouts and reference-informed diagnostics; no matcher. */
import { ONLINE_AMT_CHUNK_SIZE, ONLINE_AMT_SAMPLE_RATE, OnlineAmtOutputDecoder } from "../index.js";
import {
  frameCapturedAtMs,
  frameScores,
  frameStates,
  ONLINE_AMT_PITCH_COUNT,
  ONLINE_AMT_STATE_COUNT,
  type OnlineAmtCaptureTrace,
} from "./onlineAmtCapture.js";
import {
  alignmentOffsetMsFor,
  scoringIntervalFor,
  type EvaluationProtocol,
} from "./evaluationProtocol.js";

const FIRST_PIANO_MIDI = 21;

export interface Attack {
  midi: number;
  onsetMs: number;
}

export interface PredictedAttack extends Attack {
  availableAtMs: number;
}

export interface AttackMatch {
  referenceIndex: number;
  predictionIndex: number;
  timingErrorMs: number;
  detectionDelayMs: number;
}

export interface AttackMetrics {
  windowMs: number;
  precision: number;
  recall: number;
  f1: number;
  matches: AttackMatch[];
  unmatchedReferences: number[];
  unmatchedPredictions: number[];
  meanTimingErrorMs: number | null;
  meanAbsoluteTimingErrorMs: number | null;
  meanDetectionDelayMs: number | null;
}

function nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and non-negative.`);
  }
}

function validateAttacks(events: readonly Attack[]): void {
  for (const event of events) {
    if (!Number.isInteger(event.midi) || event.midi < 0 || event.midi > 127 ||
      !Number.isFinite(event.onsetMs)) {
      throw new Error("Attacks require MIDI 0–127 and finite onset times.");
    }
  }
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/**
 * Maximum-cardinality exact-pitch matching within an inclusive symmetric window.
 * For each pitch, pair the earliest compatible events; an earlier incompatible
 * event can never match a later counterpart. This gives maximum cardinality for
 * fixed-width time windows. Ties use original indices; timing error is not a
 * secondary optimization objective. Indices always refer to caller arrays.
 */
export function matchAttacks(
  references: readonly Attack[],
  predictions: readonly PredictedAttack[],
  windowMs = 50,
): AttackMetrics {
  nonnegative(windowMs, "windowMs");
  validateAttacks(references);
  validateAttacks(predictions);
  for (const event of predictions) {
    if (!Number.isFinite(event.availableAtMs) || event.availableAtMs < event.onsetMs) {
      throw new Error("Prediction availability must be finite and at or after its onset.");
    }
  }
  const matches: AttackMatch[] = [];
  for (const midi of new Set(references.map((event) => event.midi))) {
    const sorted = <T extends Attack>(events: readonly T[]) => events.map((event, index) => ({
      event,
      index,
    }))
      .filter(({ event }) => event.midi === midi)
      .sort((a, b) => a.event.onsetMs - b.event.onsetMs || a.index - b.index);
    const refs = sorted(references);
    const preds = sorted(predictions);
    let r = 0;
    let p = 0;
    while (r < refs.length && p < preds.length) {
      const ref = refs[r]!;
      const pred = preds[p]!;
      const delta = pred.event.onsetMs - ref.event.onsetMs;
      if (delta < -windowMs) {
        p++;
        continue;
      }
      if (delta > windowMs) {
        r++;
        continue;
      }
      matches.push({
        referenceIndex: ref.index,
        predictionIndex: pred.index,
        timingErrorMs: delta,
        detectionDelayMs: pred.event.availableAtMs - ref.event.onsetMs,
      });
      r++;
      p++;
    }
  }
  matches.sort((a, b) => a.referenceIndex - b.referenceIndex);
  const matchedRefs = new Set(matches.map((m) => m.referenceIndex));
  const matchedPreds = new Set(matches.map((m) => m.predictionIndex));
  // Empty denominators are vacuously perfect; F1 is zero if only one side is empty.
  const precision = predictions.length ? matches.length / predictions.length : 1;
  const recall = references.length ? matches.length / references.length : 1;
  return {
    windowMs,
    precision,
    recall,
    f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
    matches,
    unmatchedReferences: references.flatMap((_, i) => matchedRefs.has(i) ? [] : [i]),
    unmatchedPredictions: predictions.flatMap((_, i) => matchedPreds.has(i) ? [] : [i]),
    meanTimingErrorMs: mean(matches.map((m) => m.timingErrorMs)),
    meanAbsoluteTimingErrorMs: mean(matches.map((m) => Math.abs(m.timingErrorMs))),
    meanDetectionDelayMs: mean(matches.map((m) => m.detectionDelayMs)),
  };
}

export type StateWeights = readonly [number, number, number, number, number];

export const BASELINE_STATE_WEIGHTS: StateWeights = [1, 1, 1, 2, 2];

export interface PitchScoreInspection {
  midi: number;
  /** Current selection is unavailable when the wrapper holds its previous state. */
  selectedState: number | null;
  weighted: number[];
  /** Null means suppressed/unavailable, not zero probability. */
  unweighted: number[] | null;
  attackProbability: number | null;
  presenceProbability: number | null;
}

function validateTrace(trace: OnlineAmtCaptureTrace, weights: StateWeights): void {
  if (trace.pitchCount !== ONLINE_AMT_PITCH_COUNT ||
    trace.stateCount !== ONLINE_AMT_STATE_COUNT ||
    trace.sampleRateHz !== ONLINE_AMT_SAMPLE_RATE ||
    trace.chunkSize !== ONLINE_AMT_CHUNK_SIZE ||
    trace.scores.length !== trace.frameCount * ONLINE_AMT_PITCH_COUNT * ONLINE_AMT_STATE_COUNT ||
    trace.states.length !== trace.frameCount * ONLINE_AMT_PITCH_COUNT ||
    trace.signalActive.length !== trace.frameCount) {
    throw new Error("Expected an 88-pitch, five-state, 16 kHz / 512-sample capture trace.");
  }
  if (weights.length !== ONLINE_AMT_STATE_COUNT ||
    weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error("State weights must be positive and finite.");
  }
}

function inspectPitch(
  trace: OnlineAmtCaptureTrace,
  frame: number,
  pitch: number,
  weights: StateWeights,
): PitchScoreInspection {
  const offset = pitch * ONLINE_AMT_STATE_COUNT;
  const weighted = Array.from(frameScores(trace, frame).subarray(offset, offset + ONLINE_AMT_STATE_COUNT));
  const unweighted = trace.signalActive[frame]
    ? weighted.map((score, state) => score / weights[state]!)
    : null;
  return {
    midi: pitch + FIRST_PIANO_MIDI,
    selectedState: trace.signalActive[frame] ? frameStates(trace, frame)[pitch]! : null,
    weighted,
    unweighted,
    attackProbability: unweighted ? unweighted[3]! + unweighted[4]! : null,
    presenceProbability: unweighted ? unweighted[2]! + unweighted[3]! + unweighted[4]! : null,
  };
}

export function inspectScoreFrame(
  trace: OnlineAmtCaptureTrace,
  frame: number,
  weights: StateWeights = BASELINE_STATE_WEIGHTS,
) {
  validateTrace(trace, weights);
  if (!Number.isInteger(frame) || frame < 0 || frame >= trace.frameCount) {
    throw new Error("Frame index out of range.");
  }
  return {
    frame,
    scoreTimeMs: frameCapturedAtMs(frame),
    availableAtMs: frameCapturedAtMs(frame),
    suppressed: !trace.signalActive[frame],
    addedSamplesOnly: frame >= trace.inputFrameCount,
    pitches: Array.from(
      { length: ONLINE_AMT_PITCH_COUNT },
      (_, pitch) => inspectPitch(trace, frame, pitch, weights)
    ),
  };
}

export interface AttackReadoutConfiguration {
  threshold: number;
  releaseThreshold: number;
  minimumSeparationMs: number;
}

export const DEFAULT_ATTACK_READOUT: AttackReadoutConfiguration = {
  threshold: 0.3,
  releaseThreshold: 0.15,
  minimumSeparationMs: 64,
};

/**
 * Hysteresis on unweighted onset + re-onset probability. Emit immediately on an
 * armed threshold crossing; rearm only on an ACTIVE frame <= releaseThreshold.
 * Suppression is missing evidence, so cannot rearm. Each pitch must also satisfy
 * minimumSeparationMs. No lookahead; availability is chunk end time. The optional fixed
 * onsetEstimateLagMs subtracts from the estimated onset only, never availability.
 * Model buffering remains in measured delay. Decode pre-roll and tail
 * before applying scoring intervals, preserving causal state throughout.
 */
export function readTraceAttacks(
  trace: OnlineAmtCaptureTrace,
  configuration: AttackReadoutConfiguration | "shipped" = "shipped",
  weights: StateWeights = BASELINE_STATE_WEIGHTS,
  onsetEstimateLagMs = 0,
): PredictedAttack[] {
  nonnegative(onsetEstimateLagMs, "onsetEstimateLagMs");
  validateTrace(trace, weights);
  if (configuration !== "shipped") {
    const { threshold, releaseThreshold, minimumSeparationMs } = configuration;
    nonnegative(minimumSeparationMs, "minimumSeparationMs");
    if (!Number.isFinite(threshold) || !Number.isFinite(releaseThreshold) ||
      releaseThreshold < 0 ||
      releaseThreshold >= threshold ||
      threshold > 1) {
      throw new Error("Require 0 <= releaseThreshold < threshold <= 1.");
    }
  }
  const decoder = new OnlineAmtOutputDecoder();
  const armed = Array<boolean>(ONLINE_AMT_PITCH_COUNT).fill(true);
  const last = Array<number>(ONLINE_AMT_PITCH_COUNT).fill(-Infinity);
  const events: PredictedAttack[] = [];
  for (let frame = 0; frame < trace.frameCount; frame++) {
    const time = frameCapturedAtMs(frame);
    if (configuration === "shipped") {
      const decoded = decoder.decode(
        frameScores(trace, frame),
        frameStates(trace, frame),
        Boolean(trace.signalActive[frame]),
        time
      );
      for (const event of decoded.noteEvents) {
        if (event.type !== "offset") {
          events.push({
            midi: event.midi,
            onsetMs: event.eventTimeMs - onsetEstimateLagMs,
            availableAtMs: time,
          });
        }
      }
    } else if (trace.signalActive[frame]) {
      const scores = frameScores(trace, frame);
      for (let pitch = 0; pitch < ONLINE_AMT_PITCH_COUNT; pitch++) {
        const offset = pitch * ONLINE_AMT_STATE_COUNT;
        const probability = scores[offset + 3]! / weights[3] + scores[offset + 4]! / weights[4];
        if (probability <= configuration.releaseThreshold) armed[pitch] = true;
        if (armed[pitch] && probability >= configuration.threshold &&
          time - last[pitch]! >= configuration.minimumSeparationMs) {
          events.push({
            midi: pitch + FIRST_PIANO_MIDI,
            onsetMs: time - onsetEstimateLagMs,
            availableAtMs: time,
          });
          armed[pitch] = false;
          last[pitch] = time;
        }
      }
    }
  }
  return events;
}

/** Reference-informed peaks are optimistic diagnostics, never event readouts. */
export function diagnoseRawAttacks(
  trace: OnlineAmtCaptureTrace,
  references: readonly Attack[],
  windowMs = 100,
  weights: StateWeights = BASELINE_STATE_WEIGHTS,
  onsetEstimateLagMs = 0,
  includeFrames = false,
) {
  validateTrace(trace, weights);
  validateAttacks(references);
  nonnegative(windowMs, "windowMs");
  nonnegative(onsetEstimateLagMs, "onsetEstimateLagMs");
  return references.map((reference) => {
    const centerMs = reference.onsetMs + onsetEstimateLagMs;
    const frames: {
      frame: number;
      timeMs: number;
      suppressed: boolean;
      evidence: PitchScoreInspection | null;
      competingPitches: PitchScoreInspection[];
    }[] = [];
    const firstFrame = Math.max(0, Math.ceil((centerMs - windowMs) / frameCapturedAtMs(0)) - 1);
    for (let frame = firstFrame;
      frame < trace.frameCount && frameCapturedAtMs(frame) <= centerMs + windowMs;
      frame++) {
      const pitches = Array.from(
        { length: ONLINE_AMT_PITCH_COUNT },
        (_, pitch) => inspectPitch(trace, frame, pitch, weights)
      );
      frames.push({
        frame,
        timeMs: frameCapturedAtMs(frame),
        suppressed: !trace.signalActive[frame],
        evidence: pitches.find((pitch) => pitch.midi === reference.midi) ?? null,
        competingPitches: pitches.filter((pitch) =>
          pitch.midi !== reference.midi && pitch.attackProbability !== null)
          .sort((a, b) => b.attackProbability! - a.attackProbability!).slice(0, 3),
      });
    }
    const peak = (key: "attackProbability" | "presenceProbability") => {
      const available = frames.filter((frame) => frame.evidence?.[key] != null);
      available.sort((a, b) => b.evidence![key]! - a.evidence![key]!);
      const best = available[0];
      return best ? {
        probability: best.evidence![key]!,
        timeMs: best.timeMs,
      } : null;
    };
    return {
      reference,
      evidenceCenterMs: centerMs,
      optimisticReferenceInformed: true,
      attackPeak: peak("attackProbability"),
      presencePeak: peak("presenceProbability"),
      suppressedFrames: frames.filter((frame) => frame.suppressed).length,
      ...(includeFrames ? { frames } : {}),
    };
  });
}

/** Moments are caller-annotated groups, avoiding guessed rhythmic/chord boundaries. */
export interface GoldMoment {
  onsetMs: number;
  pitches: readonly number[];
  /** Per-pitch performed onsets for rolled chords; defaults to the moment onset. */
  pitchOnsetsMs?: readonly number[];
}

export function goldChordDiagnostics(
  references: readonly Attack[],
  metrics: AttackMetrics,
  moments: readonly GoldMoment[],
) {
  validateAttacks(references);
  for (let index = 0; index < moments.length; index++) {
    const moment = moments[index]!;
    validateAttacks(moment.pitches.map((midi) => ({
      midi,
      onsetMs: moment.onsetMs,
    })));
    if (!Number.isFinite(moment.onsetMs) ||
      (index > 0 && moment.onsetMs <= moments[index - 1]!.onsetMs)) {
      throw new Error("Gold moments must have finite, strictly increasing onset times.");
    }
  }
  const matched = new Set(metrics.matches.map((match) => match.referenceIndex));
  const signature = (moment: GoldMoment) => [...new Set(moment.pitches)].sort((a, b) => a - b).join(",");
  return moments.map((moment, index) => {
    if (!moment.pitches.length || new Set(moment.pitches).size !== moment.pitches.length) {
      throw new Error("Gold moments require distinct pitches.");
    }
    if (moment.pitchOnsetsMs && (moment.pitchOnsetsMs.length !== moment.pitches.length ||
      moment.pitchOnsetsMs.some((time) => !Number.isFinite(time)))) {
      throw new Error("Gold pitch onsets must be finite and correspond to every pitch.");
    }
    const referenceIndices = moment.pitches.map((midi, i) =>
      references.findIndex((ref) => ref.midi === midi && ref.onsetMs === (moment.pitchOnsetsMs?.[i] ?? moment.onsetMs)));
    const recoveredPitches = moment.pitches.filter((_, i) => matched.has(referenceIndices[i]!));
    return {
      ...moment,
      repeatedChord: index > 0 && signature(moment) === signature(moments[index - 1]!),
      scored: referenceIndices.every((i) => i >= 0),
      recoveredPitches,
      complete: referenceIndices.every((i) => i >= 0 && matched.has(i)),
    };
  });
}

export interface RecognitionRecordingOptions {
  recordingId: string;
  trace: OnlineAmtCaptureTrace;
  references: readonly Attack[];
  protocol: EvaluationProtocol;
  goldMoments?: readonly GoldMoment[];
  readouts?: readonly AttackReadoutConfiguration[];
  weights?: StateWeights;
  /** Include detailed per-frame raw evidence; summaries are always returned. */
  includeRawFrames?: boolean;
  /** Fixed model/readout onset estimate correction; never changes availability or MIDI alignment. */
  onsetEstimateLagMs?: number;
}

export function evaluateRecognitionRecording(
  options: RecognitionRecordingOptions,
) {
  const { recordingId, trace, protocol } = options;
  const weights = options.weights ?? BASELINE_STATE_WEIGHTS;
  const onsetEstimateLagMs = options.onsetEstimateLagMs ?? 0;
  const offset = alignmentOffsetMsFor(protocol, recordingId);
  const interval = scoringIntervalFor(protocol, recordingId, trace.inputDurationMs);
  const excluded = protocol.excludedIntervals.filter((region) => region.recordingId === recordingId);
  const inside = (time: number) => time >= interval.startMs && time < interval.endMs;
  const omitted = (time: number) => excluded.some((region) => time >= region.startMs && time < region.endMs);
  const keep = (event: { onsetMs: number }) => inside(event.onsetMs) && !omitted(event.onsetMs);
  const aligned = options.references.map((event) => ({
    ...event,
    onsetMs: event.onsetMs + offset,
  }));
  const references = aligned.filter(keep);
  // Preserve performed adjacency before selecting the scored moments.
  const moments = options.goldMoments?.map((moment) => ({
    ...moment,
    onsetMs: moment.onsetMs + offset,
    ...(moment.pitchOnsetsMs ? { pitchOnsetsMs: moment.pitchOnsetsMs.map((time) => time + offset) } : {}),
  }));
  const readouts = options.readouts ?? [0.2, 0.3, 0.4].map((threshold) => ({
    ...DEFAULT_ATTACK_READOUT,
    threshold,
  }));
  const configurations = ["shipped" as const, ...readouts];
  const comparisons = configurations.map((configuration) => {
    const all = readTraceAttacks(trace, configuration, weights, onsetEstimateLagMs);
    const predictions = all.filter(keep);
    const timingWindows = [
      protocol.timing.primaryOnsetWindowMs,
      protocol.timing.supplementalOnsetWindowMs,
    ];
    const windows = timingWindows.map((window) => {
      const metrics = matchAttacks(references, predictions, window);
      return {
        ...metrics,
        zeroObservedFalseAttacks: metrics.unmatchedPredictions.length === 0,
        goldChords: moments ? goldChordDiagnostics(references, metrics, moments).filter(keep) : null,
      };
    });
    return {
      configuration,
      predictions,
      outsideIntervalPredictionCount: all.filter((event) => !inside(event.onsetMs)).length,
      excludedPredictionCount: all.filter((event) => inside(event.onsetMs) && omitted(event.onsetMs)).length,
      windows,
    };
  });
  // Union exclusions so overlaps are not double-counted.
  const segments = excluded.map((region) => [
    Math.max(interval.startMs, region.startMs),
    Math.min(interval.endMs, region.endMs),
  ] as const).filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
  let excludedDurationMs = 0;
  let end = interval.startMs;
  for (const [a, b] of segments) {
    excludedDurationMs += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return {
    recordingId,
    interval,
    alignmentOffsetMs: offset,
    onsetEstimateLagMs,
    stateWeights: weights,
    references,
    excludedDurationMs,
    outsideIntervalReferenceCount: aligned.filter((event) => !inside(event.onsetMs)).length,
    excludedReferenceCount: aligned.filter((event) => inside(event.onsetMs) && omitted(event.onsetMs)).length,
    suppressedFrames: Array.from(trace.signalActive).filter((active) => !active).length,
    totalFrames: trace.frameCount,
    comparisons,
    rawDiagnostics: diagnoseRawAttacks(
      trace,
      references,
      protocol.timing.supplementalOnsetWindowMs,
      weights,
      onsetEstimateLagMs,
      options.includeRawFrames ?? false
    ),
  };
}

/** Equal recording weights; never pool notes or mix different configurations/windows. */
export function meanRecordingMetrics(metrics: readonly AttackMetrics[]) {
  if (new Set(metrics.map((metric) => metric.windowMs)).size > 1) {
    throw new Error("Cannot average different timing windows.");
  }
  return {
    recordingCount: metrics.length,
    precision: mean(metrics.map((m) => m.precision)),
    recall: mean(metrics.map((m) => m.recall)),
    f1: mean(metrics.map((m) => m.f1)),
  };
}
