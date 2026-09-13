/**
 * E03 — relative presence confirmation for newly detected notes.
 *
 * The E01 cycle's absolute bar (a follow-up frame must keep unweighted presence
 * at or above a fixed level) trades notes for extras: a genuine short note whose
 * onset-frame presence sits below the absolute level loses every follow-up frame
 * to the gate, while the only population the bar reliably catches is the
 * transient whose follow-up collapses to near zero. The separator the E01 cycle
 * recorded as its successor is scale-free: a fleeting false activation's
 * follow-up presence collapses to near zero while a genuine note's follow-up
 * presence remains a substantial fraction of its own (typically lower)
 * onset-frame presence.
 *
 * This module turns that difference into a gate on the one transition family
 * the baseline over-produces: an `off` or `offset` state stepping into `onset`.
 * It wraps the shipped candidate generation — the production decoder, the same
 * object the `shipped` control runs — so every candidate it can act on is one
 * the control also produced, on the same frame. It never adds a candidate and
 * it never re-times the ones it keeps; it only post-processes the targeted
 * transition.
 *
 * A candidate the control emitted for an `off`/`offset` -> `onset` step is
 * *held*, and its bar is fixed when it is proposed: the unweighted pitch
 * presence of its own onset frame (the frame the candidate is attributed to)
 * multiplied by `presenceFraction`. The candidate is released, attributed to
 * its original frame, only if each of the next `confirmationFrames` frames still
 * shows unweighted presence at or above that per-candidate bar. Every other
 * candidate the control emitted is passed straight through, unchanged, so the
 * control is reproduced exactly except for the gate.
 *
 * What the gate does to a held candidate, as each following frame is delivered:
 *
 *  - a frame whose presence is at or above the candidate's own bar (the
 *    fraction of the onset frame's presence) confirms one step; once
 *    `confirmationFrames` such frames have confirmed, the candidate is emitted.
 *    Its onset estimate is the original frame's, so only its availability moves
 *    later — the waiting is charged to the delay distribution, not hidden.
 *  - a frame whose presence is a real reading below the bar rejects the
 *    candidate: the note fell away from its own onset faster than the fraction
 *    allows, so the transient extra is dropped.
 *  - a frame that is suppressed, or that is padding or tail flush, carries no
 *    confirmation evidence. Such a frame resolves the candidate as unconfirmed
 *    and it is not emitted; it is not counted as a low-presence frame and its
 *    window is not stretched past the missing evidence.
 *  - a candidate whose confirmation window has not finished by the time the
 *    recording ends is still owed evidence that will never arrive; it is
 *    reported through `finish()` as pending, not emitted.
 *
 * Because the bar is a fraction of the candidate's own onset presence, a short
 * note whose onset was weak but whose note held most of it survives a bar the
 * absolute gate failed, and a fleeting activation whose second follow-up
 * frame collapses to near zero fails every bar in the family. The degenerate
 * case of a candidate whose onset frame had zero presence gets a zero bar: any
 * real follow-up reading confirms it, because there is no scale to measure
 * against.
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
type HeldCandidate = {
  midi: number;
  origin: number;
  remaining: number;
  kind: string;
  /** Unweighted presence of the pitch on the candidate's own onset frame: the scale of the bar. */
  onsetPresence: number;
};

/** The only parameters this algorithm defines; any other key is a typo, not a default. */
const PARAMETER_KEYS = ["confirmationFrames", "presenceFraction", "gatedTransitions"];

const relativePresenceConfirmation: ExperimentDecoderModule = {
  id: "relativePresenceConfirmation",
  summary:
    "Wraps the shipped candidate generation and holds each off/offset -> onset candidate for the " +
    "following confirmationFrames, emitting it only while each of those frames keeps unweighted presence at " +
    "or above presenceFraction of the candidate's own onset-frame presence; a lower, suppressed, or " +
    "tail-flush frame ends the wait and the candidate is lost, and an end-of-recording candidate that never " +
    "confirms is reported, not emitted.",

  validateConfiguration(value: unknown): Record<string, unknown> {
    experimentOnlyKeys(value ?? {}, PARAMETER_KEYS);

    const confirmationFrames = experimentNumber(value, "confirmationFrames", {
      minimum: 1,
      maximum: 16,
      integer: true,
    });
    const presenceFraction = experimentNumber(value, "presenceFraction", {
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

    return { confirmationFrames, presenceFraction, gatedTransitions };
  },

  createDecoder(configuration: Record<string, unknown>): ExperimentDecoder {
    const confirmationFrames = configuration.confirmationFrames as number;
    const presenceFraction = configuration.presenceFraction as number;
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
        //    evidence for the pitch can confirm or reject it. The bar is the
        //    candidate's own: presenceFraction of the presence of its onset frame.
        for (let i = held.length - 1; i >= 0; i -= 1) {
          const candidate = held[i]!;
          const presence = hasInput ? frame.presenceProbability(candidate.midi) : null;
          if (presence === null) {
            // Suppressed or padding/tail-flush frame: missing evidence, not a quiet
            // frame. The candidate is resolved as unconfirmed, not held past it.
            held.splice(i, 1);
            continue;
          }
          const bar = candidate.onsetPresence * presenceFraction;
          if (presence < bar) {
            // A real reading below the candidate's own relative bar: the note did
            // not hold its own onset, so the transient extra is dropped.
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
            // The onset frame's own unweighted presence is the scale of this
            // candidate's bar. A selected onset state on a non-suppressed frame
            // always has a reading; if it did not, there would be no scale to
            // measure the follow-up against, so the candidate is not held.
            const onsetPresence = frame.presenceProbability(event.midi);
            if (onsetPresence === null) continue;
            held.push({
              midi: event.midi,
              origin: frame.index,
              remaining: confirmationFrames,
              kind: event.type,
              onsetPresence,
            });
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
            `relativePresenceConfirmation: ${held.length} candidate(s) still owed confirmation frames when the ` +
            "recording ended; reported here, not emitted.",
        };
      },
    };
  },
};

export default relativePresenceConfirmation;
