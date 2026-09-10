/** Private annotations arrive as caller data; no model disagreement changes a label. */
import {
  diagnoseRawAttacks,
  type Attack,
  type PredictedAttack,
  type evaluateRecognitionRecording,
} from "./recognitionEvaluation.js";
import type { OnlineAmtCaptureTrace } from "./onlineAmtCapture.js";

export interface AnnotationCorrection {
  /** Index in the original parsed MIDI, never an index after another edit. Omit for additions. */
  referenceIndex?: number;
  /** Required for indexed edits to catch stale sidecars. */
  original?: Attack;
  replacement: Attack | null;
  verifiedBy: string;
  reason: string;
}

export interface ReviewedAttack extends Attack {
  annotationSource: {
    referenceIndex: number | null;
    /** Original caller record, including any MIDI release/channel metadata. */
    original: Attack | null;
    correctionIndex: number | null;
  };
}

/** Apply one reviewed sidecar once, before all configurations and interval filtering. */
export function applyAnnotationCorrections(
  references: readonly Attack[],
  edits: readonly AnnotationCorrection[],
): ReviewedAttack[] {
  const changed = new Map<number, Attack | null>();
  const added: ReviewedAttack[] = [];
  const correctionIndices = new Map<number, number>();
  const identity = (attack: Attack) => `${attack.midi}:${attack.onsetMs}`;
  const valid = (a: Attack) => a && Number.isInteger(a.midi) && a.midi >= 0 && a.midi <= 127 &&
    Number.isFinite(a.onsetMs) && a.onsetMs >= 0;
  for (const [correctionIndex, edit] of edits.entries()) {
    if (!edit || typeof edit.verifiedBy !== "string" || !edit.verifiedBy.trim() ||
      typeof edit.reason !== "string" || !edit.reason.trim()) {
      throw new Error("Corrections require a human verifier and reason.");
    }
    if (edit.replacement !== null && !valid(edit.replacement)) throw new Error("Invalid correction attack.");
    if (edit.referenceIndex === undefined) {
      if (!edit.replacement || edit.original !== undefined) {
        throw new Error("Additions require a replacement and no original.");
      }
      added.push({
        midi: edit.replacement.midi,
        onsetMs: edit.replacement.onsetMs,
        annotationSource: { referenceIndex: null, original: null, correctionIndex },
      });
    } else {
      const i = edit.referenceIndex;
      const original = references[i];
      if (!Number.isInteger(i) || !original || changed.has(i) || !edit.original ||
        original.midi !== edit.original.midi || original.onsetMs !== edit.original.onsetMs) {
        throw new Error("Stale, duplicate, or invalid correction reference.");
      }
      changed.set(i, edit.replacement);
      correctionIndices.set(i, correctionIndex);
    }
  }
  const corrected = [...references.flatMap((reference, i) => {
    const replacement = changed.get(i);
    if (replacement === null) return [];
    const attack = replacement ?? reference;
    return [{
      midi: attack.midi,
      onsetMs: attack.onsetMs,
      annotationSource: {
        referenceIndex: i,
        original: { ...reference },
        correctionIndex: correctionIndices.get(i) ?? null,
      },
    }];
  }), ...added.map((a) => ({ ...a }))];
  const identities = new Set<string>();
  for (const attack of corrected) {
    const key = identity(attack);
    if (identities.has(key)) throw new Error(`Duplicate corrected reference attack: ${key}.`);
    identities.add(key);
  }
  return corrected.sort((a, b) => a.onsetMs - b.onsetMs || a.midi - b.midi);
}

export function midiPitchName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

type RecognitionReport = ReturnType<typeof evaluateRecognitionRecording>;

/** Group identical disagreements across readouts; shared-model agreement is not proof. */
export function createAnnotationReviewQueue(report: RecognitionReport, trace: OnlineAmtCaptureTrace) {
  const entries = new Map<string, {
    side: "reference" | "prediction";
    event: Attack;
    configurations: string[];
  }>();
  for (const comparison of report.comparisons) {
    const metrics = comparison.windows[0]!;
    const configuration = typeof comparison.configuration === "string"
      ? comparison.configuration : JSON.stringify(comparison.configuration);
    for (const side of ["reference", "prediction"] as const) {
      const indices = side === "reference" ? metrics.unmatchedReferences : metrics.unmatchedPredictions;
      const events = side === "reference" ? report.references : comparison.predictions;
      for (const i of indices) {
        const event = events[i]!;
        const key = `${side}:${event.midi}:${event.onsetMs}`;
        const entry = entries.get(key) ?? { side, event, configurations: [] };
        entry.configurations.push(configuration);
        entries.set(key, entry);
      }
    }
  }
  const named = (a: Attack) => ({ ...a, pitchName: midiPitchName(a.midi) });
  return [...entries.entries()].map(([id, entry]) => {
    const { side, event, configurations } = entry;
    const nearbyReferences = report.references
      .filter((a) => Math.abs(a.onsetMs - event.onsetMs) <= 250).map(named);
    const nearbyPredictions = report.comparisons.flatMap((c) => c.predictions
      .filter((a) => Math.abs(a.onsetMs - event.onsetMs) <= 250)
      .map((a: PredictedAttack) => ({
        ...named(a), availableAtMs: a.availableAtMs, configuration: c.configuration,
      })));
    const opposite = side === "reference" ? nearbyPredictions : nearbyReferences;
    const diagnostic = diagnoseRawAttacks(
      trace, [event], 100, report.stateWeights, report.onsetEstimateLagMs, true,
    )[0]!;
    const {
      reference: diagnosticEvent,
      optimisticReferenceInformed: _referenceInformed,
      ...evidence
    } = diagnostic;
    return {
      eventTimeMs: event.onsetMs,
      annotationSource: side === "reference"
        ? (event as Partial<ReviewedAttack>).annotationSource ?? null : null,
      id: `${report.recordingId}:${id}`,
      recordingId: report.recordingId,
      status: "unresolved",
      classification: side === "reference"
        ? "Unmatched reference attack: possible extra annotation or recognition miss"
        : "Unmatched predicted attack: possible missing annotation or hallucination",
      timingConcern: opposite.some((a) => a.midi === event.midi)
        ? "Nearby same-pitch event: possible annotation or detection timing error" : null,
      pitchConcern: opposite.some((a) => a.midi !== event.midi)
        ? "Nearby different-pitch event: possible pitch substitution on either side" : null,
      reference: side === "reference" ? named(event) : null,
      prediction: side === "prediction" ? named(event) : null,
      configurations,
      sharedConfigurationCount: configurations.length,
      replay: {
        startMs: Math.max(0, event.onsetMs - 750),
        endMs: Math.min(trace.inputDurationMs, event.onsetMs + 750),
      },
      nearbyReferences,
      nearbyPredictions,
      evidence: {
        ...evidence,
        event: diagnosticEvent,
        eventSource: side,
        optimisticNeighborhoodPeak: true,
        optimisticReferenceInformed: side === "reference",
      },
    };
  }).sort((a, b) =>
    b.sharedConfigurationCount - a.sharedConfigurationCount || a.eventTimeMs - b.eventTimeMs);
}
