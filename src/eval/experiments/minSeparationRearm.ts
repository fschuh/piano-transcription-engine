/**
 * E05 — minimum-separation rearm for renewed-attack events on an already-
 * sounding pitch: the last registered form of the rearm family.
 *
 * E02 found that the attack-probability valley's duration is not separable,
 * E04 found that its depth is not separable either (six extras cleared at
 * 6:1, one genuine match lost at every rung, tier F1 flat), and both ladders
 * destroyed the genuine close repeats they targeted because a trill's 1-2
 * frame sustain run is indistinguishable from a flicker by any reading of a
 * single probability channel. This module replaces the probability factor
 * with the time factor those cycles registered as the alternative: a pitch
 * re-arms only once its last emitted attack is at least `minSeparationFrames`
 * old. There is no probability valley anywhere in the rule.
 *
 * A "repeat" is the same family this module's predecessors gate: any
 * non-offset event whose target is `onset` or `reOnset` and whose previous
 * selected state was a sounding state (`sustain`, `onset`, or `reOnset`).
 * Gating the onset target as well as reOnset is what stops a repeat from
 * bypassing the gate by being reported as a fresh onset. A new note — an
 * `onset` from `off` or `offset` — is left exactly as the control emits it.
 *
 * The separation clock. For each pitch the module remembers the frame of the
 * most recent attack it has emitted for that pitch — a new note from off/
 * offset or an admitted repeat. A repeat candidate on pitch p at frame t is
 * emitted only if `t - t_last >= minSeparationFrames`; a suppressed repeat
 * never updates `t_last`, so the clock keeps pointing at the attack it
 * measured from and a chain of flickers is each judged against the same
 * baseline. A repeat whose pitch has no emitted attack in this recording
 * (the note was already sounding when the first frame arrived) has no
 * `t_last` to be too close to: it is admitted at every rung, and emitting it
 * starts the pitch's clock. Under this convention `minSeparationFrames: 1`
 * suppresses only a second attack in the very same frame, so the K=1
 * configuration reproduces the shipped control exactly (or differs only in
 * same-frame double-attack events) and serves as the ladder's plumbing
 * check; the rungs that suppress real populations are 2 (all one-frame-gap
 * repeats — the population no probability valley can fit in — plus same-
 * frame doubles), 3 (gap <= 2) and 4 (gap <= 3).
 *
 * Suppressed and padding/tail-flush frames are missing evidence, not quiet
 * frames: they carry no event, start no candidate, and can never be the
 * frame a candidate is attributed to. They still advance the frame-index
 * clock that measures the separation, because they are frames the decoder
 * was handed rather than a pause in time — a repeat two frames after the
 * last emitted attack is two frames away whether or not the frame between
 * them was suppressed.
 *
 * The module wraps the shipped candidate generation — the production
 * decoder, the same object the `shipped` control runs — so every candidate
 * it acts on is one the control also produced, on the same frame. It never
 * adds a candidate and it never re-times the ones it keeps; it only
 * suppresses the gated family, and it decides each repeat on the frame it
 * fires. Nothing is held, each candidate emits at most once, and `finish()`
 * reports zero pending: a suppressed repeat is dropped on the spot, exactly
 * as in the E02/E04 ladders, so the rule adds no latency while it still
 * costs the candidates whose evidence window it closes.
 *
 * This is a new module rather than a parameterisation of `rearmRepeatGate`,
 * because a pure time-based rearm cannot be expressed as `(rearmFrames,
 * rearmThreshold)`: any positive threshold still demands a probability
 * valley, which is precisely the factor being replaced, and a threshold of
 * zero would demand a probability reading of exactly zero, a different
 * mechanism.
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

/** The one factor this algorithm varies: how old the pitch's last emitted
 *  attack must be, in frames, before the pitch may fire another repeat. */
const PARAMETER_KEYS = ["minSeparationFrames"];

const minSeparationRearm: ExperimentDecoderModule = {
  id: "minSeparationRearm",
  summary:
    "Wraps the shipped candidate generation and suppresses a renewed attack (an onset or reOnset on a " +
    "pitch already in sustain/onset/reOnset) unless its frame is at least minSeparationFrames after the " +
    "pitch's last emitted attack; a suppressed repeat never moves that clock, a pitch with no emitted " +
    "attack in this recording is never too close, suppressed and tail-flush frames carry no candidate but " +
    "still advance the frame clock, each candidate is decided on the frame it fires and emitted at most " +
    "once, and a new note from off/offset passes through.",

  validateConfiguration(value: unknown): Record<string, unknown> {
    experimentOnlyKeys(value ?? {}, PARAMETER_KEYS);
    const minSeparationFrames = experimentNumber(value, "minSeparationFrames", {
      minimum: 1,
      maximum: 16,
      integer: true,
    });
    return { minSeparationFrames };
  },

  createDecoder(configuration: Record<string, unknown>): ExperimentDecoder {
    const minSeparationFrames = configuration.minSeparationFrames as number;

    const decoder = new OnlineAmtOutputDecoder();

    // Last real selected state seen per pitch; the transition test reads it.
    const previousState = new Map<number, number>();
    // Per pitch: the frame of the most recent attack this decoder has emitted
    // for it — a new note from off/offset or an admitted repeat. A suppressed
    // repeat never updates it, so a chain of flickers is each judged against
    // the same baseline attack.
    const lastEmitted = new Map<number, number>();
    // (midi, originFrameIndex) pairs already emitted, so a candidate emits at most once.
    const emitted = new Set<string>();

    const isSounding = (state: number | null): boolean =>
      state === SUSTAIN_STATE || state === ONSET_STATE || state === REONSET_STATE;

    return {
      onFrame(frame: ExperimentFrame): readonly ExperimentCandidateEvent[] {
        const out: ExperimentCandidateEvent[] = [];

        // 1) Read this frame through the shipped decoder and gate its repeat
        //    events. The separation test uses the clock as it stands after the
        //    previous frame, so a repeat only ever sees attacks that have
        //    already been emitted — a repeat can never be too close to a
        //    frame it has not been handed.
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
            const last = lastEmitted.get(event.midi);
            // A pitch whose previous attack was never emitted in this
            // recording has no frame to be too close to: the gap is
            // unbounded, the repeat is admitted, and the emission starts
            // the pitch's clock. Otherwise the repeat is admitted only if
            // its frame is at least minSeparationFrames after the last
            // emitted attack; a suppressed repeat leaves the clock where it
            // is and is never emitted later.
            if (last === undefined || frame.index - last >= minSeparationFrames) {
              const key = `${event.midi}:${frame.index}`;
              if (!emitted.has(key)) {
                emitted.add(key);
                out.push({ midi: event.midi, originFrameIndex: frame.index, reportedKind: event.type });
              }
              lastEmitted.set(event.midi, frame.index);
            }
          } else {
            const key = `${event.midi}:${frame.index}`;
            if (!emitted.has(key)) {
              emitted.add(key);
              out.push({ midi: event.midi, originFrameIndex: frame.index, reportedKind: event.type });
            }
            // A new attack (an onset from off/offset) opens a fresh
            // separation cycle for the pitch.
            if (current === ONSET_STATE || current === REONSET_STATE) {
              lastEmitted.set(event.midi, frame.index);
            }
          }
        }

        // 2) Remember each pitch's real selected state for the next frame's
        //    transition test. Suppressed and padding/tail-flush frames read
        //    no state, so they neither start candidates nor move the
        //    remembered state — but, like every frame, they advance the
        //    frame-index clock the separation is measured in.
        if (frame.containsInputSamples) {
          for (let midi = frame.firstMidi; midi < frame.firstMidi + frame.pitchCount; midi += 1) {
            const state = frame.selectedState(midi);
            if (state !== null) previousState.set(midi, state);
          }
        }
        return out;
      },

      finish(): ExperimentDecoderCompletion {
        // The rule decides each repeat on the frame it fires, so nothing is
        // held: an admitted repeat is emitted at once, a suppressed one is
        // dropped on the spot, and a candidate pending at the end of the
        // recording is counted rather than emitted. For this module the
        // count is always zero.
        return {
          pendingCandidates: 0,
          notes:
            "minSeparationRearm: every repeat is resolved on the frame it fires — admitted repeats are " +
            "emitted, unseparated repeats are dropped, so no candidate is left pending at the end.",
        };
      },
    };
  },
};

export default minSeparationRearm;
