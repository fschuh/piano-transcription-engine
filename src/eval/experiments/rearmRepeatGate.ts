/**
 * E02 — rearm gate for renewed-attack events on an already-sounding pitch.
 *
 * A model that is holding a note can flicker its attack state: it reports a
 * re-onset (or a fresh onset) on a pitch that is already sustaining, for a
 * single frame, with no release in between. Those are spurious re-onsets. A
 * genuine restrike, by contrast, is always preceded by a real release: the
 * unweighted attack probability (onset + re-onset) drops to a low "valley" for
 * a stretch of frames and then climbs again for the new attack.
 *
 * This module turns that difference into a gate on the one transition family
 * the baseline over-produces: a renewed attack on a pitch that is already
 * sounding. It wraps the shipped candidate generation — the production decoder,
 * the same object the `shipped` control runs — so every candidate it acts on is
 * one the control also produced, on the same frame. It never adds a candidate
 * and it never re-times the ones it keeps; it only suppresses the gated family.
 *
 * A "repeat" is any non-offset event whose target is `onset` or `reOnset` and
 * whose previous selected state is a sounding state (`sustain`, `onset`, or
 * `reOnset`). Gating the onset target as well as reOnset is what stops a repeat
 * from bypassing the gate by being reported as a fresh onset. A new note — an
 * `onset` from `off` or `offset` — is left exactly as the control emits it.
 *
 * The rearm latch. For each pitch the module keeps a run of consecutive active
 * frames whose unweighted attack probability is at or below `rearmThreshold`,
 * and an "armed" flag. A run that reaches `rearmFrames` arms the pitch: it may
 * then emit one repeat. The gate decides a repeat on the frame it fires — there
 * is no holding — so the decision uses only the valley that has already arrived:
 *
 *  - a repeat whose pitch is armed is emitted, attributed to the frame it
 *    fired on, exactly as the control emitted it; emitting it disarms the pitch
 *    and restarts its run, so the next repeat needs its own release.
 *  - a repeat whose pitch is not armed is suppressed: the attack came before any
 *    sub-threshold release, which is the signature of a flicker, not a restrike.
 *  - an emitted new note likewise disarms its pitch and restarts the run, so a
 *    flicker landing immediately on a fresh onset cannot ride the release that
 *    precedes that onset.
 *
 * Suppressed and padding/tail-flush frames are missing evidence, not a valley:
 * they supply no low-attack-probability frame at all, so they break the run and
 * never arm a pitch. A repeat is emitted at most once, and only to a frame the
 * decoder has been handed.
 */

import { OnlineAmtOutputDecoder } from "../../index.js";
import {
  experimentNumber,
  experimentOnlyKeys,
  type ExperimentCandidateEvent,
  type ExperimentDecoder,
  type ExperimentDecoderCompletion,
  type ExperimentDecoderModule,
  type ExperimentFrame,
} from "./types.js";

/** Sustain occupies index two; a note is sounding in these states. */
const SUSTAIN_STATE = 2;
const ONSET_STATE = 3;
const REONSET_STATE = 4;

/** The one factor this algorithm varies: how many low-attack-probability frames
 *  a release must hold before a pitch re-arms to fire another repeat. */
const PARAMETER_KEYS = ["rearmFrames", "rearmThreshold"];

const rearmRepeatGate: ExperimentDecoderModule = {
  id: "rearmRepeatGate",
  summary:
    "Wraps the shipped candidate generation and suppresses a renewed attack (an onset or reOnset on a " +
    "pitch already in sustain/onset/reOnset) until the unweighted attack probability has held at or below " +
    "rearmThreshold for rearmFrames consecutive active frames; suppressed and tail-flush frames supply no " +
    "valley evidence, each repeat is emitted at most once, and a new note from off/offset passes through.",

  validateConfiguration(value: unknown): Record<string, unknown> {
    experimentOnlyKeys(value ?? {}, PARAMETER_KEYS);
    const rearmFrames = experimentNumber(value, "rearmFrames", {
      minimum: 1,
      maximum: 16,
      integer: true,
    });
    const rearmThreshold = experimentNumber(value, "rearmThreshold", {
      minimum: 0,
      maximum: 1,
    });
    return { rearmFrames, rearmThreshold };
  },

  createDecoder(configuration: Record<string, unknown>): ExperimentDecoder {
    const rearmFrames = configuration.rearmFrames as number;
    const rearmThreshold = configuration.rearmThreshold as number;

    const decoder = new OnlineAmtOutputDecoder();

    // Last real selected state seen per pitch; the transition test reads it.
    const previousState = new Map<number, number>();
    // Per pitch: the run of consecutive active frames at or below the threshold.
    const lowRun = new Map<number, number>();
    // Per pitch: true once a release has armed the pitch to emit one repeat.
    const armed = new Map<number, boolean>();
    // (midi, originFrameIndex) pairs already emitted, so a candidate emits at most once.
    const emitted = new Set<string>();

    const isSounding = (state: number | null): boolean =>
      state === SUSTAIN_STATE || state === ONSET_STATE || state === REONSET_STATE;

    return {
      onFrame(frame: ExperimentFrame): readonly ExperimentCandidateEvent[] {
        const out: ExperimentCandidateEvent[] = [];
        const hasInput = frame.containsInputSamples;
        // A frame carries valley evidence only if it is not tail/padding and is
        // not suppressed; a suppressed frame reads null for every accessor.
        const hasEvidence = hasInput && frame.attackProbability(frame.firstMidi) !== null;

        // 1) Read this frame through the shipped decoder and gate its repeat
        //    events. The decision uses the rearm latch as it stands after the
        //    previous frame, so a repeat only sees a valley that has arrived.
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
          const isRepeat =
            current !== null &&
            isSounding(previous) &&
            (current === ONSET_STATE || current === REONSET_STATE);
          if (isRepeat) {
            if (armed.get(event.midi) === true) {
              const key = `${event.midi}:${frame.index}`;
              if (!emitted.has(key)) {
                emitted.add(key);
                out.push({ midi: event.midi, originFrameIndex: frame.index, reportedKind: event.type });
              }
              // A fired repeat spends the arm; the next one needs a new release.
              armed.set(event.midi, false);
              lowRun.set(event.midi, 0);
            }
            // Otherwise not armed: the repeat is suppressed, not emitted.
          } else {
            const key = `${event.midi}:${frame.index}`;
            if (!emitted.has(key)) {
              emitted.add(key);
              out.push({ midi: event.midi, originFrameIndex: frame.index, reportedKind: event.type });
            }
            // A new attack opens a fresh rearm cycle for the pitch.
            if (current === ONSET_STATE || current === REONSET_STATE) {
              armed.set(event.midi, false);
              lowRun.set(event.midi, 0);
            }
          }
        }

        // 2) Advance each pitch's low-attack-probability run over the delivered
        //    frame. Only a frame that actually carries a reading for the pitch can
        //    count; a suppressed or padding/tail-flush frame breaks the run and
        //    never arms the pitch.
        if (hasEvidence) {
          for (let midi = frame.firstMidi; midi < frame.firstMidi + frame.pitchCount; midi += 1) {
            const probability = frame.attackProbability(midi);
            if (probability !== null && probability <= rearmThreshold) {
              const run = (lowRun.get(midi) ?? 0) + 1;
              lowRun.set(midi, run);
              if (run >= rearmFrames) armed.set(midi, true);
            } else {
              lowRun.set(midi, 0);
            }
          }
        } else {
          for (const midi of lowRun.keys()) lowRun.set(midi, 0);
        }

        // 3) Remember each pitch's real selected state for the next frame's
        //    transition test. Suppressed and padding frames read no state, so
        //    they neither start candidates nor move the remembered state.
        if (hasInput) {
          for (let midi = frame.firstMidi; midi < frame.firstMidi + frame.pitchCount; midi += 1) {
            const state = frame.selectedState(midi);
            if (state !== null) previousState.set(midi, state);
          }
        }
        return out;
      },

      finish(): ExperimentDecoderCompletion {
        // The gate decides each repeat on the frame it fires, so nothing is held:
        // a suppressed repeat is dropped on the spot and a pending count is zero.
        return {
          pendingCandidates: 0,
          notes:
            "rearmRepeatGate: every repeat is resolved on the frame it fires — armed repeats are " +
            "emitted, un-armed repeats are dropped, so no candidate is left pending at the end.",
        };
      },
    };
  },
};

export default rearmRepeatGate;
