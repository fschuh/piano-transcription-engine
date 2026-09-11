/**
 * E01 — brief pitch confirmation for newly detected notes.
 *
 * A fleeting false activation shows the onset state for a single frame and then
 * collapses: the unweighted pitch presence (sustain + onset + re-onset) that
 * carried that frame is already gone a frame later. A genuine note keeps its
 * presence. This module turns that difference into a gate on the one transition
 * the baseline over-produces: an `off` or `offset` state stepping into `onset`.
 *
 * The module wraps the shipped candidate generation — the production decoder, the
 * same object the `shipped` control runs — so every candidate it can act on is
 * one the control also produced, on the same frame. It never adds a candidate
 * and it never re-times the ones it keeps; it only post-processes the targeted
 * transition. A candidate the control emitted for an `off`/`offset` -> `onset`
 * step is *held*: it is released, attributed to its original frame, only if each
 * of the next `confirmationFrames` frames still shows unweighted presence at or
 * above `presenceThreshold`. Every other candidate the control emitted is passed
 * straight through, unchanged, so the control is reproduced exactly except for the
 * gate.
 *
 * What the gate does to a held candidate, as each following frame is delivered:
 *
 *  - a frame whose presence is at or above the threshold confirms one step; once
 *    `confirmationFrames` such frames have confirmed, the candidate is emitted.
 *    Its onset estimate is the original frame's, so only its availability moves
 *    later — the waiting is charged to the delay distribution, not hidden.
 *  - a frame whose presence is a real reading below the threshold rejects the
 *    candidate: the note did not hold, so the transient extra is dropped.
 *  - a frame that is suppressed, or that is padding or tail flush, carries no
 *    confirmation evidence. Such a frame resolves the candidate as unconfirmed and
 *    it is not emitted; it is not counted as a low-presence frame and its window
 *    is not stretched past the missing evidence.
 *  - a candidate whose confirmation window has not finished by the time the
 *    recording ends is still owed evidence that will never arrive; it is reported
 *    through `finish()` as pending, not emitted.
 *
 * Each candidate is emitted at most once, is attributed only to a frame it has
 * been handed, and a pitch the control emitted on more than one frame is treated
 * as distinct candidates, never merged.
 */

import { OnlineAmtOutputDecoder } from "../../index.js";
import {
  EXPERIMENT_STATE_NAMES,
  experimentConfigurationError,
  experimentNumber,
  experimentOnlyKeys,
  type ExperimentCandidateEvent,
  type ExperimentDecoder,
  type ExperimentDecoderCompletion,
  type ExperimentDecoderContext,
  type ExperimentDecoderModule,
  type ExperimentFrame,
  type ExperimentStateName,
} from "./types.js";

/** The one new-attack state the gate targets: `onset` occupies index three. */
const ONSET_STATE = 3;

/** A state name's index, built from the frozen state order. */
const STATE_INDEX: ReadonlyMap<ExperimentStateName, number> = new Map(
  EXPERIMENT_STATE_NAMES.map((name, index): [ExperimentStateName, number] => [name, index]),
);

/** A candidate held while it waits out its confirmation window. */
type HeldCandidate = { midi: number; origin: number; remaining: number; kind: string };

/** The only parameters this algorithm defines; any other key is a typo, not a default. */
const PARAMETER_KEYS = ["confirmationFrames", "presenceThreshold", "gatedTransitions"];

const briefPitchConfirmation: ExperimentDecoderModule = {
  id: "briefPitchConfirmation",
  summary:
    "Wraps the shipped candidate generation and holds each off/offset -> onset candidate for the " +
    "following confirmationFrames, emitting it only while that window keeps unweighted presence at or " +
    "above presenceThreshold; a low, suppressed, or tail-flush frame ends the wait and the candidate is " +
    "lost, and an end-of-recording candidate that never confirms is reported, not emitted.",

  validateConfiguration(value: unknown): Record<string, unknown> {
    experimentOnlyKeys(value ?? {}, PARAMETER_KEYS);

    const confirmationFrames = experimentNumber(value, "confirmationFrames", {
      minimum: 1,
      maximum: 16,
      integer: true,
    });
    const presenceThreshold = experimentNumber(value, "presenceThreshold", {
      minimum: 0,
      maximum: 1,
    });

    const rawGated = (value as { gatedTransitions?: unknown } | null)?.gatedTransitions;
    if (!Array.isArray(rawGated) || rawGated.length === 0) {
      throw experimentConfigurationError("gatedTransitions must be a non-empty array of state names.");
    }
    const gatedTransitions: ExperimentStateName[] = [];
    for (const entry of rawGated) {
      if (typeof entry !== "string" || !STATE_INDEX.has(entry as ExperimentStateName)) {
        throw experimentConfigurationError(
          `gatedTransitions entry "${String(entry)}" is not one of: ${EXPERIMENT_STATE_NAMES.join(", ")}.`,
        );
      }
      const name = entry as ExperimentStateName;
      if (!gatedTransitions.includes(name)) gatedTransitions.push(name);
    }

    return { confirmationFrames, presenceThreshold, gatedTransitions };
  },

  createDecoder(configuration: Record<string, unknown>): ExperimentDecoder {
    const confirmationFrames = configuration.confirmationFrames as number;
    const presenceThreshold = configuration.presenceThreshold as number;
    const gatedPrevious = new Set(
      (configuration.gatedTransitions as ExperimentStateName[]).map((name) => STATE_INDEX.get(name) as number),
    );

    const decoder = new OnlineAmtOutputDecoder();

    // Last real selected state observed for each pitch; the transition test reads it.
    const previousState = new Map<number, number>();
    // Candidates held for confirmation, in proposal order.
    const held: HeldCandidate[] = [];
    // (midi, originFrameIndex) pairs already emitted, so a candidate emits at most once.
    const emitted = new Set<string>();

    return {
      onFrame(frame: ExperimentFrame): readonly ExperimentCandidateEvent[] {
        const out: ExperimentCandidateEvent[] = [];
        const hasInput = frame.containsInputSamples;

        // 1) Advance every candidate already waiting. Each delivered frame is one
        //    step of its confirmation window, and only a frame that actually carries
        //    evidence for the pitch can confirm it.
        for (let i = held.length - 1; i >= 0; i -= 1) {
          const candidate = held[i]!;
          const presence = hasInput ? frame.presenceProbability(candidate.midi) : null;
          if (presence === null || presence < presenceThreshold) {
            // Suppressed or padding/tail-flush frame (no evidence) or a real reading
            // below the threshold: the note did not confirm, so the candidate is
            // dropped rather than emitted.
            held.splice(i, 1);
            continue;
          }
          candidate.remaining -= 1;
          if (candidate.remaining === 0) {
            const key = `${candidate.midi}:${candidate.origin}`;
            if (!emitted.has(key)) {
              emitted.add(key);
              out.push({
                midi: candidate.midi,
                originFrameIndex: candidate.origin,
                reportedKind: candidate.kind,
              });
            }
            held.splice(i, 1);
          }
        }

        // 2) Read this frame through the shipped decoder. Its non-offset events are
        //    exactly the control's candidates; the gate post-processes them and the
        //    rest pass through untouched.
        const decoded = decoder.decode(
          frame.weightedScores,
          frame.selectedStates,
          frame.signalActive,
          frame.capturedAtMs,
        );
        for (const event of decoded.noteEvents) {
          if (event.type === "offset") continue;
          const current = frame.selectedState(event.midi);
          const previous = previousState.get(event.midi) ?? null;
          const isGatedTransition =
            hasInput &&
            current !== null &&
            previous !== null &&
            current === ONSET_STATE &&
            gatedPrevious.has(previous);
          if (isGatedTransition) {
            // Hold the candidate; the following frames confirm it or lose it.
            held.push({ midi: event.midi, origin: frame.index, remaining: confirmationFrames, kind: event.type });
          } else {
            const key = `${event.midi}:${frame.index}`;
            if (!emitted.has(key)) {
              emitted.add(key);
              out.push({ midi: event.midi, originFrameIndex: frame.index, reportedKind: event.type });
            }
          }
        }

        // 3) Remember each pitch's real selected state for the next frame's
        //    transition test. Suppressed and padding frames read no state, so they
        //    neither create candidates nor move the remembered state.
        if (hasInput) {
          for (let midi = frame.firstMidi; midi < frame.firstMidi + frame.pitchCount; midi += 1) {
            const state = frame.selectedState(midi);
            if (state !== null) previousState.set(midi, state);
          }
        }
        return out;
      },

      finish(): ExperimentDecoderCompletion {
        return {
          pendingCandidates: held.length,
          notes:
            `briefPitchConfirmation: ${held.length} candidate(s) still owed confirmation frames when the ` +
            "recording ended; reported here, not emitted.",
        };
      },
    };
  },
};

export default briefPitchConfirmation;
