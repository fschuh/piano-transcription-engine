import type {
  FunctionalEvaluationFixture,
  FunctionalRecognitionFrame,
} from "./functionalEvaluation.js";

interface PitchConfidence {
  midi: number;
  confidence?: number;
}

interface Attack extends PitchConfidence {
  noteConfidence?: number;
  type?: "onset" | "reOnset";
}

interface FrameOptions {
  atMs: number;
  attacks?: readonly Attack[];
  offsets?: readonly number[];
  active?: readonly PitchConfidence[];
  evidence?: readonly PitchConfidence[];
  emitAttackEvents?: boolean;
  physicalEventId?: string;
  playedTargetId?: string | null;
}

function pitchEvidence(
  values: readonly PitchConfidence[],
  fallbackConfidence = 0.8,
): Array<{ midi: number; confidence: number }> {
  return values.map(({ midi, confidence }) => ({
    midi,
    confidence: confidence ?? fallbackConfidence,
  }));
}

function frame(options: FrameOptions): FunctionalRecognitionFrame {
  const attacks = options.attacks ?? [];
  const active = options.active ?? attacks;
  const evidence = options.evidence ?? active;
  const result: FunctionalRecognitionFrame = {
    capturedAtMs: options.atMs,
    processingTimeMs: 1,
    onsets: attacks.map(({ midi, confidence, noteConfidence }) => ({
      midi,
      confidence: confidence ?? 0.8,
      noteConfidence: noteConfidence ?? 0.8,
      onsetTimeMs: options.atMs,
    })),
    recognizedActivePitches: pitchEvidence(active),
    targetPitchEvidence: pitchEvidence(evidence),
    noteEvents: [
      ...(options.emitAttackEvents === false ? [] : attacks.map(({ midi, type }) => ({
        midi,
        type: type ?? "onset" as const,
        confidence: 0.9,
        eventTimeMs: options.atMs,
      }))),
      ...(options.offsets ?? []).map((midi) => ({
        midi,
        type: "offset" as const,
        confidence: 0.9,
        eventTimeMs: options.atMs,
      })),
    ],
  };
  if (options.physicalEventId !== undefined) {
    result.physicalEventId = options.physicalEventId;
  }
  if (options.playedTargetId !== undefined) {
    result.playedTargetId = options.playedTargetId;
  }
  return result;
}

const LATENCY_LIMIT_MS = 64;

/**
 * Project-authored, non-musical numeric traces. They are not transcriptions or
 * derivatives of the private recording corpus and may be redistributed.
 */
export const PUBLIC_FUNCTIONAL_EVALUATION_FIXTURES: readonly FunctionalEvaluationFixture[] =
  Object.freeze([
    {
      id: "isolated-exact-chord",
      kind: "isolated",
      description: "One isolated exact chord advances after the settling interval.",
      targets: [{
        id: "isolated-chord",
        pitches: [60, 64, 67],
        attackAtMs: 100,
        maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
      }],
      frames: [
        frame({
          atMs: 100,
          attacks: [{ midi: 60 }, { midi: 64 }, { midi: 67 }],
          physicalEventId: "isolated-attack",
          playedTargetId: "isolated-chord",
        }),
        frame({
          atMs: 132,
          active: [{ midi: 60 }, { midi: 64 }, { midi: 67 }],
          physicalEventId: "isolated-attack",
          playedTargetId: "isolated-chord",
        }),
      ],
    },
    {
      id: "continuous-two-moment-sequence",
      kind: "continuous-sequence",
      description: "Two different moments advance in order during one continuous replay.",
      targets: [
        {
          id: "sequence-first",
          pitches: [60, 64],
          attackAtMs: 100,
          maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
        },
        {
          id: "sequence-second",
          pitches: [62, 65],
          attackAtMs: 200,
          maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
        },
      ],
      frames: [
        frame({
          atMs: 100,
          attacks: [{ midi: 60 }, { midi: 64 }],
          physicalEventId: "sequence-attack-one",
          playedTargetId: "sequence-first",
        }),
        frame({
          atMs: 132,
          active: [{ midi: 60 }, { midi: 64 }],
          physicalEventId: "sequence-attack-one",
          playedTargetId: "sequence-first",
        }),
        frame({ atMs: 164, offsets: [60, 64], active: [], evidence: [] }),
        frame({
          atMs: 200,
          attacks: [{ midi: 62 }, { midi: 65 }],
          physicalEventId: "sequence-attack-two",
          playedTargetId: "sequence-second",
        }),
        frame({
          atMs: 232,
          active: [{ midi: 62 }, { midi: 65 }],
          physicalEventId: "sequence-attack-two",
          playedTargetId: "sequence-second",
        }),
      ],
    },
    {
      id: "original-three-level-dynamics",
      kind: "dynamics",
      description: "Original soft, medium, and strong attacks all clear baseline gates.",
      targets: [
        {
          id: "dynamic-soft",
          pitches: [60],
          attackAtMs: 100,
          maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
        },
        {
          id: "dynamic-medium",
          pitches: [62],
          attackAtMs: 200,
          maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
        },
        {
          id: "dynamic-strong",
          pitches: [64],
          attackAtMs: 300,
          maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
        },
      ],
      frames: [
        frame({
          atMs: 100,
          attacks: [{ midi: 60, confidence: 0.62, noteConfidence: 0.55 }],
          active: [{ midi: 60, confidence: 0.4 }],
          physicalEventId: "dynamic-soft-attack",
          playedTargetId: "dynamic-soft",
        }),
        frame({
          atMs: 132,
          active: [{ midi: 60, confidence: 0.4 }],
          physicalEventId: "dynamic-soft-attack",
          playedTargetId: "dynamic-soft",
        }),
        frame({ atMs: 164, offsets: [60], active: [], evidence: [] }),
        frame({
          atMs: 200,
          attacks: [{ midi: 62, confidence: 0.75, noteConfidence: 0.7 }],
          physicalEventId: "dynamic-medium-attack",
          playedTargetId: "dynamic-medium",
        }),
        frame({
          atMs: 232,
          active: [{ midi: 62 }],
          physicalEventId: "dynamic-medium-attack",
          playedTargetId: "dynamic-medium",
        }),
        frame({ atMs: 264, offsets: [62], active: [], evidence: [] }),
        frame({
          atMs: 300,
          attacks: [{ midi: 64, confidence: 0.95, noteConfidence: 0.95 }],
          physicalEventId: "dynamic-strong-attack",
          playedTargetId: "dynamic-strong",
        }),
        frame({
          atMs: 332,
          active: [{ midi: 64, confidence: 0.95 }],
          physicalEventId: "dynamic-strong-attack",
          playedTargetId: "dynamic-strong",
        }),
      ],
    },
    {
      id: "repeated-chord-requires-reattack",
      kind: "repeated-chord",
      description:
        "Three consecutive identical moments each need their own fresh re-attack, " +
        "so the matcher must re-arm twice in a row while the chord keeps sounding.",
      targets: [
        {
          id: "repeated-chord-first",
          pitches: [55, 60, 64],
          attackAtMs: 100,
          maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
        },
        {
          id: "repeated-chord-second",
          pitches: [55, 60, 64],
          attackAtMs: 220,
          maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
        },
        {
          id: "repeated-chord-third",
          pitches: [55, 60, 64],
          attackAtMs: 340,
          maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
        },
      ],
      frames: [
        frame({
          atMs: 100,
          attacks: [{ midi: 55 }, { midi: 60 }, { midi: 64 }],
          physicalEventId: "repeated-chord-attack-one",
          playedTargetId: "repeated-chord-first",
        }),
        frame({
          atMs: 132,
          active: [{ midi: 55 }, { midi: 60 }, { midi: 64 }],
          physicalEventId: "repeated-chord-attack-one",
          playedTargetId: "repeated-chord-first",
        }),
        frame({ atMs: 180, active: [{ midi: 55 }, { midi: 60 }, { midi: 64 }] }),
        frame({
          atMs: 220,
          attacks: [
            { midi: 55, type: "reOnset" },
            { midi: 60, type: "reOnset" },
            { midi: 64, type: "reOnset" },
          ],
          physicalEventId: "repeated-chord-attack-two",
          playedTargetId: "repeated-chord-second",
        }),
        frame({
          atMs: 252,
          active: [{ midi: 55 }, { midi: 60 }, { midi: 64 }],
          physicalEventId: "repeated-chord-attack-two",
          playedTargetId: "repeated-chord-second",
        }),
        frame({ atMs: 300, active: [{ midi: 55 }, { midi: 60 }, { midi: 64 }] }),
        frame({
          atMs: 340,
          attacks: [
            { midi: 55, type: "reOnset" },
            { midi: 60, type: "reOnset" },
            { midi: 64, type: "reOnset" },
          ],
          physicalEventId: "repeated-chord-attack-three",
          playedTargetId: "repeated-chord-third",
        }),
        frame({
          atMs: 372,
          active: [{ midi: 55 }, { midi: 60 }, { midi: 64 }],
          physicalEventId: "repeated-chord-attack-three",
          playedTargetId: "repeated-chord-third",
        }),
      ],
    },
    {
      id: "omitted-bass-safety",
      kind: "omitted-bass",
      description: "Stable bass evidence cannot replace the omitted fresh bass attack.",
      targets: [{
        id: "omitted-bass-target",
        pitches: [48, 60, 64],
        shouldAdvance: false,
      }],
      frames: [
        frame({
          atMs: 100,
          attacks: [{ midi: 60 }, { midi: 64 }],
          active: [{ midi: 48 }, { midi: 60 }, { midi: 64 }],
          evidence: [{ midi: 48 }, { midi: 60 }, { midi: 64 }],
          physicalEventId: "upper-notes-without-bass",
          playedTargetId: null,
        }),
        frame({
          atMs: 132,
          active: [{ midi: 48 }, { midi: 60 }, { midi: 64 }],
          evidence: [{ midi: 48 }, { midi: 60 }, { midi: 64 }],
          physicalEventId: "upper-notes-without-bass",
          playedTargetId: null,
        }),
      ],
    },
    {
      id: "confident-extra-note-safety",
      kind: "false-advance",
      description: "A distinguishable confident extra note prevents an advance.",
      targets: [{
        id: "false-advance-target",
        pitches: [60, 64],
        shouldAdvance: false,
      }],
      frames: [
        frame({
          atMs: 100,
          attacks: [
            { midi: 60 },
            { midi: 64 },
            { midi: 67, confidence: 0.995, noteConfidence: 0.99 },
          ],
          active: [{ midi: 60 }, { midi: 64 }, { midi: 67 }],
          physicalEventId: "wrong-chord-attack",
          playedTargetId: null,
        }),
        frame({
          atMs: 132,
          active: [{ midi: 60 }, { midi: 64 }, { midi: 67 }],
          physicalEventId: "wrong-chord-attack",
          playedTargetId: null,
        }),
      ],
    },
    {
      id: "clear-attack-does-not-skip",
      kind: "skipped-advance",
      description: "A clear intended attack advances rather than being skipped.",
      targets: [{
        id: "clear-attack-target",
        pitches: [72],
        attackAtMs: 100,
        maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
      }],
      frames: [
        frame({
          atMs: 100,
          attacks: [{ midi: 72, confidence: 0.8, noteConfidence: 0.8 }],
          physicalEventId: "clear-attack",
          playedTargetId: "clear-attack-target",
        }),
        frame({
          atMs: 132,
          active: [{ midi: 72 }],
          physicalEventId: "clear-attack",
          playedTargetId: "clear-attack-target",
        }),
      ],
    },
    {
      id: "duplicate-onset-tail-safety",
      kind: "duplicate-advance",
      description: "One physical attack cannot consume two repeated score moments.",
      targets: [
        {
          id: "duplicate-first",
          pitches: [72],
          attackAtMs: 100,
          maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
        },
        {
          id: "duplicate-second",
          pitches: [72],
          attackAtMs: 240,
          maxAdvanceLatencyMs: LATENCY_LIMIT_MS,
        },
      ],
      frames: [
        frame({
          atMs: 100,
          attacks: [{ midi: 72 }],
          physicalEventId: "duplicate-physical-attack-one",
          playedTargetId: "duplicate-first",
        }),
        frame({
          atMs: 132,
          active: [{ midi: 72 }],
          physicalEventId: "duplicate-physical-attack-one",
          playedTargetId: "duplicate-first",
        }),
        frame({
          atMs: 164,
          attacks: [{ midi: 72 }],
          emitAttackEvents: false,
          physicalEventId: "duplicate-physical-attack-one",
          playedTargetId: "duplicate-first",
        }),
        frame({
          atMs: 196,
          active: [{ midi: 72 }],
          physicalEventId: "duplicate-physical-attack-one",
          playedTargetId: "duplicate-first",
        }),
        frame({
          atMs: 240,
          attacks: [{ midi: 72, type: "reOnset" }],
          physicalEventId: "duplicate-physical-attack-two",
          playedTargetId: "duplicate-second",
        }),
        frame({
          atMs: 272,
          active: [{ midi: 72 }],
          physicalEventId: "duplicate-physical-attack-two",
          playedTargetId: "duplicate-second",
        }),
      ],
    },
  ]);

/** Deliberately unsafe: stable evidence may stand in for a missing bass attack. */
export const DELIBERATELY_WORSE_OMITTED_BASS_CONFIGURATION = Object.freeze({
  requireFreshBassOnset: false,
});

/** Deliberately insensitive: the otherwise clear attack falls below this gate. */
export const DELIBERATELY_WORSE_SKIPPED_ADVANCE_CONFIGURATION = Object.freeze({
  onsetThreshold: 0.95,
});

/** Deliberately permissive: even a very confident wrong note is ignored. */
export const DELIBERATELY_WORSE_FALSE_ADVANCE_CONFIGURATION = Object.freeze({
  noteThreshold: 1,
});

/** Deliberately loses note-event identity, allowing a repeated onset tail through. */
export const DELIBERATELY_WORSE_DUPLICATE_ADVANCE_CONFIGURATION = Object.freeze({
  refractoryMode: "time" as const,
  refractoryMs: 0,
});
