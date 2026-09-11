/**
 * The frozen scoring path every candidate is measured by.
 *
 * A candidate decides which attacks exist. Nothing else about an experiment is
 * a candidate's to decide, and all of it lives here: the reference, the
 * alignment, the scored interval, the exclusions, the two match windows, the
 * one-to-one matching, the gold moment accounting, and the way a delay
 * distribution is summarised. A candidate cannot choose its own scoring
 * interval, reference offset, or match tolerance because it is never asked.
 *
 * The comparison against the control lives here too, and it is deliberately
 * event-level. An aggregate delta says a configuration scored better; it does
 * not say which attacks changed, and "F1 rose" is compatible with losing real
 * attacks while removing more false ones. So the outcome of every reference and
 * every prediction is compared one at a time, and the changed events are named.
 *
 * This module is prepared infrastructure. If it changes, every result measured
 * before the change was measured by a different scorer and has to be rerun.
 */

import { midiPitchName } from "./annotationReview.js";
import {
  alignmentOffsetMsFor,
  evaluationRecordingRoleOf,
  scoringIntervalFor,
  type EvaluationProtocol,
} from "./evaluationProtocol.js";
import type { ExperimentDecodedEvent, ExperimentDecoderRun } from "./experimentDecoders.js";
import type { OnlineAmtCaptureTrace } from "./onlineAmtCapture.js";
import {
  goldChordDiagnostics,
  matchAttacks,
  type Attack,
  type AttackMetrics,
  type GoldMoment,
} from "./recognitionEvaluation.js";

/** A half-open region of audio time a detection may be counted against. */
export interface QuietRegion {
  startMs: number;
  endMs: number;
  /** How the region was established; carried into the report, never inferred. */
  basis?: string;
}

export interface DelayDistribution {
  count: number;
  meanMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

/**
 * Summarises a delay sample without smoothing away its tail.
 *
 * A mean alone hides the case the plan cares about: a rule that usually costs
 * nothing and occasionally costs a great deal is not a rule that costs its
 * mean, so the median, the 95th percentile and the worst case are reported
 * beside it. The percentile convention matches the export validator's, so two
 * latency numbers in this project never mean two different things.
 */
export function delayDistribution(values: readonly number[]): DelayDistribution {
  if (values.length === 0) {
    return { count: 0, meanMs: null, medianMs: null, p95Ms: null, maxMs: null };
  }
  const ordered = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    ordered[Math.max(0, Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1))]!;
  return {
    count: ordered.length,
    meanMs: ordered.reduce((a, b) => a + b, 0) / ordered.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxMs: ordered[ordered.length - 1]!,
  };
}

export interface ExperimentWindowResult {
  windowMs: number;
  precision: number;
  recall: number;
  f1: number;
  matched: number;
  unmatchedReferences: number[];
  unmatchedPredictions: number[];
  meanTimingErrorMs: number | null;
  meanAbsoluteTimingErrorMs: number | null;
  /** Reference onset to availability, over matched attacks: the causal cost. */
  detectionDelayMs: DelayDistribution;
  /** Waiting the candidate added beyond immediate emission, over matched attacks. */
  addedDelayMs: DelayDistribution;
  /** True only when no prediction in the scored interval is unmatched. */
  zeroObservedFalseAttacks: boolean;
  goldChords: ReturnType<typeof goldChordDiagnostics> | null;
  /** Gold moments whose repeated attack was not recovered in full. */
  incompleteRepeatedChords: number | null;
  /** The matching itself, so a later comparison can be per event. */
  metrics: AttackMetrics;
}

export interface ExperimentMechanismCounts {
  /** Emitted while the pitch was off or releasing: a newly appearing pitch. */
  newPitch: number;
  /** Emitted while the pitch was already sounding. */
  duringSustain: number;
  /** Emitted while the pitch was already in an attack state. */
  duringAttack: number;
  /** Origin frame was suppressed, so the transition is unavailable, not absent. */
  unavailableTransition: number;
  /** Same pitch within the close-repeat span of its previous emitted onset. */
  closeRepeats: number;
}

export interface ExperimentRecordingResult {
  recordingId: string;
  role: string;
  interval: { startMs: number; endMs: number };
  alignmentOffsetMs: number;
  onsetEstimateLagMs: number;
  stateWeights: readonly number[];
  decoder: {
    id: string;
    summary: string;
    configuration: Record<string, unknown>;
    pendingCandidates: number | null;
    notes: string | null;
    eventsAvailableAfterInput: number;
    maximumWaitedFrames: number;
  };
  referenceCount: number;
  outsideIntervalReferenceCount: number;
  excludedReferenceCount: number;
  excludedDurationMs: number;
  suppressedFrames: number;
  totalFrames: number;
  predictionCount: number;
  outsideIntervalPredictionCount: number;
  excludedPredictionCount: number;
  /** Detections inside a region verified to hold no performance. */
  verifiedQuietPredictions: number;
  mechanism: ExperimentMechanismCounts;
  windows: ExperimentWindowResult[];
  /** References and predictions as scored, so a comparison needs no rerun. */
  references: readonly Attack[];
  predictions: readonly ExperimentDecodedEvent[];
}

export interface ExperimentRecordingOptions {
  recordingId: string;
  role: string;
  trace: OnlineAmtCaptureTrace;
  /** Corrected reference attacks, before alignment. */
  references: readonly Attack[];
  protocol: EvaluationProtocol;
  goldMoments?: readonly GoldMoment[];
  run: ExperimentDecoderRun;
  quietRegions?: readonly QuietRegion[];
  /** Span within which two attacks on one pitch count as a close repeat. */
  closeRepeatMs?: number;
}

const DEFAULT_CLOSE_REPEAT_MS = 250;

/**
 * Scores one recording's candidate events against the frozen reference.
 *
 * The reference handling is the same code path the baseline uses — align, keep
 * the scored interval, drop the excluded regions, match exactly once per pitch
 * at each window — so a candidate result and a baseline result differ in the
 * decoder and in nothing else.
 */
export function evaluateExperimentRecording(
  options: ExperimentRecordingOptions,
): ExperimentRecordingResult {
  const { recordingId, protocol, trace, run } = options;
  // The held-out half is refused here rather than only upstream. A caller that
  // reached it would not fail — it would produce a perfectly ordinary-looking
  // result, and the number that makes the held-out half worth holding out would
  // be gone with no trace that it had ever been spent.
  if (evaluationRecordingRoleOf(protocol, recordingId) === "confirmation") {
    throw new Error(
      `${recordingId} is in the protocol's confirmation half. Experiments are scored on the gold ` +
      "and development halves; the confirmation half is spent once, by the confirmation task.",
    );
  }
  const offset = alignmentOffsetMsFor(protocol, recordingId);
  const interval = scoringIntervalFor(protocol, recordingId, trace.inputDurationMs);
  const excluded = protocol.excludedIntervals.filter((region) => region.recordingId === recordingId);
  const inside = (time: number): boolean => time >= interval.startMs && time < interval.endMs;
  const omitted = (time: number): boolean =>
    excluded.some((region) => time >= region.startMs && time < region.endMs);
  const keep = (event: { onsetMs: number }): boolean => inside(event.onsetMs) && !omitted(event.onsetMs);
  const aligned = options.references.map((event) => ({ ...event, onsetMs: event.onsetMs + offset }));
  const references = aligned.filter(keep);
  const moments = options.goldMoments?.map((moment) => ({
    ...moment,
    onsetMs: moment.onsetMs + offset,
    ...(moment.pitchOnsetsMs ? { pitchOnsetsMs: moment.pitchOnsetsMs.map((time) => time + offset) } : {}),
  }));
  const predictions = run.events.filter(keep);
  const quietRegions = options.quietRegions ?? [];
  const closeRepeatMs = options.closeRepeatMs ?? DEFAULT_CLOSE_REPEAT_MS;

  const windows = [
    protocol.timing.primaryOnsetWindowMs,
    protocol.timing.supplementalOnsetWindowMs,
  ].map((windowMs): ExperimentWindowResult => {
    const metrics = matchAttacks(references, predictions, windowMs);
    const goldChords = moments
      ? goldChordDiagnostics(references, metrics, moments).filter(keep)
      : null;
    return {
      windowMs,
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
      matched: metrics.matches.length,
      unmatchedReferences: metrics.unmatchedReferences,
      unmatchedPredictions: metrics.unmatchedPredictions,
      meanTimingErrorMs: metrics.meanTimingErrorMs,
      meanAbsoluteTimingErrorMs: metrics.meanAbsoluteTimingErrorMs,
      detectionDelayMs: delayDistribution(metrics.matches.map((match) => match.detectionDelayMs)),
      addedDelayMs: delayDistribution(
        metrics.matches.map((match) => predictions[match.predictionIndex]!.addedDelayMs),
      ),
      zeroObservedFalseAttacks: metrics.unmatchedPredictions.length === 0,
      goldChords,
      incompleteRepeatedChords: goldChords === null
        ? null
        : goldChords.filter((chord) => chord.repeatedChord && !chord.complete).length,
      metrics,
    };
  });

  const segments = excluded
    .map((region) => [
      Math.max(interval.startMs, region.startMs),
      Math.min(interval.endMs, region.endMs),
    ] as const)
    .filter(([start, end]) => start < end)
    .sort((a, b) => a[0] - b[0]);
  let excludedDurationMs = 0;
  let reached = interval.startMs;
  for (const [start, end] of segments) {
    excludedDurationMs += Math.max(0, end - Math.max(start, reached));
    reached = Math.max(reached, end);
  }

  const mechanism: ExperimentMechanismCounts = {
    newPitch: predictions.filter((event) => event.transition.from === "off" ||
      event.transition.from === "offset").length,
    duringSustain: predictions.filter((event) => event.transition.from === "sustain").length,
    duringAttack: predictions.filter((event) => event.transition.from === "onset" ||
      event.transition.from === "reOnset").length,
    unavailableTransition: predictions.filter((event) => event.transition.from === null).length,
    closeRepeats: predictions.filter((event) => event.sincePreviousMs !== null &&
      Math.abs(event.sincePreviousMs) <= closeRepeatMs).length,
  };

  return {
    recordingId,
    role: options.role,
    interval,
    alignmentOffsetMs: offset,
    onsetEstimateLagMs: run.onsetEstimateLagMs,
    stateWeights: run.stateWeights,
    decoder: {
      id: run.decoderId,
      summary: run.summary,
      configuration: run.configuration,
      pendingCandidates: run.completion.pendingCandidates ?? null,
      notes: run.completion.notes ?? null,
      eventsAvailableAfterInput: run.eventsAvailableAfterInput,
      maximumWaitedFrames: run.maximumWaitedFrames,
    },
    referenceCount: references.length,
    outsideIntervalReferenceCount: aligned.filter((event) => !inside(event.onsetMs)).length,
    excludedReferenceCount: aligned.filter((event) => inside(event.onsetMs) && omitted(event.onsetMs)).length,
    excludedDurationMs,
    suppressedFrames: run.suppressedFrames,
    totalFrames: run.frameCount,
    predictionCount: predictions.length,
    outsideIntervalPredictionCount: run.events.filter((event) => !inside(event.onsetMs)).length,
    excludedPredictionCount: run.events
      .filter((event) => inside(event.onsetMs) && omitted(event.onsetMs)).length,
    verifiedQuietPredictions: predictions.filter((event) =>
      quietRegions.some((region) => event.onsetMs >= region.startMs && event.onsetMs < region.endMs)).length,
    mechanism,
    windows,
    references,
    predictions,
  };
}

export type ExperimentChangeKind =
  | "extra-removed"
  | "extra-introduced"
  | "match-lost"
  | "miss-recovered"
  | "timing-changed"
  | "availability-changed";

export interface ExperimentChangedEvent {
  recordingId: string;
  windowMs: number;
  change: ExperimentChangeKind;
  midi: number;
  pitchName: string;
  /** Estimated onset of the prediction, where the change involves one. */
  predictionOnsetMs: number | null;
  /** Reference onset, where the change involves a reference. */
  referenceOnsetMs: number | null;
  controlTimingErrorMs: number | null;
  candidateTimingErrorMs: number | null;
  controlAvailableAtMs: number | null;
  candidateAvailableAtMs: number | null;
  addedDelayMs: number | null;
  /** Selected-state transition at the origin frame, measured from the trace. */
  transitionFrom: string | null;
  transitionTo: string | null;
}

export interface ExperimentComparison {
  recordingId: string;
  windowMs: number;
  extrasRemoved: number;
  extrasIntroduced: number;
  matchesLost: number;
  missesRecovered: number;
  timingChanged: number;
  availabilityChanged: number;
  /** Predictions identical in pitch, onset and availability in both runs. */
  unchangedPredictions: number;
  controlPredictionCount: number;
  candidatePredictionCount: number;
  changedEvents: ExperimentChangedEvent[];
}

function predictionKey(event: { midi: number; onsetMs: number }): string {
  return `${event.midi}@${event.onsetMs.toFixed(6)}`;
}

/**
 * Names every reference and prediction whose outcome differs between two runs.
 *
 * The two runs must have been scored against the same references, which is why
 * the reference lists are compared before anything else: comparing outcomes
 * across two different references would report recognition changes that are
 * really annotation changes. References are addressed by index into that shared
 * list; predictions by pitch and estimated onset, which a confirmation rule
 * leaves untouched even as it moves availability.
 */
export function compareExperimentRecordings(
  control: ExperimentRecordingResult,
  candidate: ExperimentRecordingResult,
  windowMs: number,
): ExperimentComparison {
  if (control.recordingId !== candidate.recordingId) {
    throw new Error(
      `Cannot compare ${control.recordingId} with ${candidate.recordingId}; a comparison is ` +
      "per recording.",
    );
  }
  if (control.references.length !== candidate.references.length ||
    control.references.some((reference, index) =>
      reference.midi !== candidate.references[index]!.midi ||
      reference.onsetMs !== candidate.references[index]!.onsetMs)) {
    throw new Error(
      `${control.recordingId} was scored against different references in the two runs; rescore ` +
      "both against the same reference revision before comparing them.",
    );
  }
  const controlWindow = control.windows.find((window) => window.windowMs === windowMs);
  const candidateWindow = candidate.windows.find((window) => window.windowMs === windowMs);
  if (controlWindow === undefined || candidateWindow === undefined) {
    throw new Error(`Both runs must report the ${windowMs} ms window.`);
  }

  const changedEvents: ExperimentChangedEvent[] = [];
  const base = (midi: number): Pick<ExperimentChangedEvent,
    "recordingId" | "windowMs" | "midi" | "pitchName"> => ({
      recordingId: control.recordingId,
      windowMs,
      midi,
      pitchName: midiPitchName(midi),
    });
  const blank = {
    predictionOnsetMs: null,
    referenceOnsetMs: null,
    controlTimingErrorMs: null,
    candidateTimingErrorMs: null,
    controlAvailableAtMs: null,
    candidateAvailableAtMs: null,
    addedDelayMs: null,
    transitionFrom: null,
    transitionTo: null,
  } as const;

  const controlMatchByReference = new Map(
    controlWindow.metrics.matches.map((match) => [match.referenceIndex, match]),
  );
  const candidateMatchByReference = new Map(
    candidateWindow.metrics.matches.map((match) => [match.referenceIndex, match]),
  );
  for (const [index, reference] of control.references.entries()) {
    const before = controlMatchByReference.get(index);
    const after = candidateMatchByReference.get(index);
    if (before !== undefined && after === undefined) {
      changedEvents.push({
        ...base(reference.midi),
        ...blank,
        change: "match-lost",
        referenceOnsetMs: reference.onsetMs,
        predictionOnsetMs: control.predictions[before.predictionIndex]!.onsetMs,
        controlTimingErrorMs: before.timingErrorMs,
        controlAvailableAtMs: control.predictions[before.predictionIndex]!.availableAtMs,
      });
      continue;
    }
    if (before === undefined && after !== undefined) {
      const prediction = candidate.predictions[after.predictionIndex]!;
      changedEvents.push({
        ...base(reference.midi),
        ...blank,
        change: "miss-recovered",
        referenceOnsetMs: reference.onsetMs,
        predictionOnsetMs: prediction.onsetMs,
        candidateTimingErrorMs: after.timingErrorMs,
        candidateAvailableAtMs: prediction.availableAtMs,
        addedDelayMs: prediction.addedDelayMs,
        transitionFrom: prediction.transition.from,
        transitionTo: prediction.transition.to,
      });
      continue;
    }
    if (before !== undefined && after !== undefined && before.timingErrorMs !== after.timingErrorMs) {
      changedEvents.push({
        ...base(reference.midi),
        ...blank,
        change: "timing-changed",
        referenceOnsetMs: reference.onsetMs,
        predictionOnsetMs: candidate.predictions[after.predictionIndex]!.onsetMs,
        controlTimingErrorMs: before.timingErrorMs,
        candidateTimingErrorMs: after.timingErrorMs,
        controlAvailableAtMs: control.predictions[before.predictionIndex]!.availableAtMs,
        candidateAvailableAtMs: candidate.predictions[after.predictionIndex]!.availableAtMs,
      });
    }
  }

  const controlExtras = new Map(controlWindow.unmatchedPredictions
    .map((index) => [predictionKey(control.predictions[index]!), control.predictions[index]!]));
  const candidateExtras = new Map(candidateWindow.unmatchedPredictions
    .map((index) => [predictionKey(candidate.predictions[index]!), candidate.predictions[index]!]));
  for (const [key, event] of controlExtras) {
    if (candidateExtras.has(key)) continue;
    changedEvents.push({
      ...base(event.midi),
      ...blank,
      change: "extra-removed",
      predictionOnsetMs: event.onsetMs,
      controlAvailableAtMs: event.availableAtMs,
      transitionFrom: event.transition.from,
      transitionTo: event.transition.to,
    });
  }
  for (const [key, event] of candidateExtras) {
    if (controlExtras.has(key)) continue;
    changedEvents.push({
      ...base(event.midi),
      ...blank,
      change: "extra-introduced",
      predictionOnsetMs: event.onsetMs,
      candidateAvailableAtMs: event.availableAtMs,
      addedDelayMs: event.addedDelayMs,
      transitionFrom: event.transition.from,
      transitionTo: event.transition.to,
    });
  }

  const controlByKey = new Map(control.predictions.map((event) => [predictionKey(event), event]));
  let availabilityChanged = 0;
  let unchangedPredictions = 0;
  for (const event of candidate.predictions) {
    const before = controlByKey.get(predictionKey(event));
    if (before === undefined) continue;
    if (before.availableAtMs === event.availableAtMs) {
      unchangedPredictions += 1;
      continue;
    }
    availabilityChanged += 1;
    changedEvents.push({
      ...base(event.midi),
      ...blank,
      change: "availability-changed",
      predictionOnsetMs: event.onsetMs,
      controlAvailableAtMs: before.availableAtMs,
      candidateAvailableAtMs: event.availableAtMs,
      addedDelayMs: event.addedDelayMs,
      transitionFrom: event.transition.from,
      transitionTo: event.transition.to,
    });
  }

  return {
    recordingId: control.recordingId,
    windowMs,
    extrasRemoved: changedEvents.filter((entry) => entry.change === "extra-removed").length,
    extrasIntroduced: changedEvents.filter((entry) => entry.change === "extra-introduced").length,
    matchesLost: changedEvents.filter((entry) => entry.change === "match-lost").length,
    missesRecovered: changedEvents.filter((entry) => entry.change === "miss-recovered").length,
    timingChanged: changedEvents.filter((entry) => entry.change === "timing-changed").length,
    availabilityChanged,
    unchangedPredictions,
    controlPredictionCount: control.predictions.length,
    candidatePredictionCount: candidate.predictions.length,
    changedEvents,
  };
}

/** The column order a changed-event CSV uses, so two reports can be diffed. */
export const EXPERIMENT_CHANGED_EVENT_FIELDS: readonly (keyof ExperimentChangedEvent)[] = [
  "recordingId",
  "windowMs",
  "change",
  "midi",
  "pitchName",
  "referenceOnsetMs",
  "predictionOnsetMs",
  "controlTimingErrorMs",
  "candidateTimingErrorMs",
  "controlAvailableAtMs",
  "candidateAvailableAtMs",
  "addedDelayMs",
  "transitionFrom",
  "transitionTo",
];
