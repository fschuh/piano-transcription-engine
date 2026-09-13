/**
 * E06 — cross-pitch chord-context gate on the repeat family.
 *
 * The repeat family's predecessors each read one channel of one pitch: E01
 * and E03 its presence, E02 and E04 the depth and duration of its
 * attack-probability valley, E05 the age of its last emitted attack. All
 * three factors turned out non-separating on the close-repeat population, and
 * the E05 review registered the successor factor as this one: read other
 * pitches instead. A renewed attack on an already-sounding pitch is admitted
 * only if a different pitch a chord distance away (`relations`, in semitones,
 * either direction) is also attacking — an `onset` or `reOnset` selected
 * state — on any frame of a small window around the repeat
 * (`windowOffsets`, in frames). A trill or a chord figure attacks with its
 * neighbours; an isolated single-pitch flicker does not.
 *
 * The gated family is the one the family's predecessors gate, and the family
 * test is the same transition the runner derives for the event rather than a
 * second opinion about it: the module remembers each pitch's selected state
 * on the previous frame, or nothing at all when that frame was suppressed,
 * and a non-offset event is a repeat only when its target is `onset` or
 * `reOnset` and that previous state was a sounding one (`sustain`, `onset`,
 * or `reOnset`). A new note from `off` or `offset` — including one the model
 * labels a fresh onset because a suppressed frame zeroed the state between —
 * passes through exactly as the control emits it.
 *
 * The window and its clocks. A candidate on pitch p at frame t is admitted
 * when some other pitch q with |q - p| in `relations` holds an onset or
 * reOnset selected state on a frame of the window `t + windowOffsets`. The
 * window positions at or before the candidate's own frame are checked as that
 * frame is delivered: the first of them with a firing neighbour admits the
 * candidate and it is emitted on that frame, with no added delay. A candidate
 * the delivered positions do not rescue is held, and each later window
 * position is checked as its frame arrives: the first position with a firing
 * neighbour emits the candidate on that frame, paying the frame period for
 * each frame waited as added delay, and a position that closes the window
 * without evidence drops the candidate on the spot, as the E02/E04/E05
 * ladders did. A firing neighbour is firing evidence only: it is not
 * required to still be sounding when the candidate is admitted, because that
 * extra test is what made the E05-E rung lose the genuine second-apart
 * repeats. A neighbour that first fires after the window closed changes
 * nothing, and a candidate is emitted at most once.
 *
 * Suppressed frames (every accessor null) are missing evidence, not quiet
 * frames: they never supply neighbour evidence and never rescue a held
 * candidate, but they still occupy their position in the window — a window
 * is a set of frame indices, not a set of active frames — so a suppressed
 * closing position still closes it and drops what it fails to rescue.
 * Padding and tail-flush frames (containsInputSamples false) carry no
 * candidate of their own, but they may supply neighbour evidence like any
 * other active frame, so a repeat on the last input frame can be rescued by
 * a firing neighbour on the flush frame; a candidate whose window reaches
 * past the end of the recording is never rescued, and is reported through
 * finish() as pending rather than emitted.
 *
 * The gate only suppresses: the module wraps the shipped candidate
 * generation — the production decoder the `shipped` control runs — so every
 * event it emits is one the control also emitted, on the same frame, at the
 * same attribution. It adds no candidate, never re-times an event it keeps,
 * and a new note is never gated.
 *
 * This is a new module rather than a parameterisation of its predecessors,
 * because a cross-pitch test cannot be expressed through any of their
 * per-pitch parameters: the gate reads other pitches' selected states, and
 * the only state it keeps about its own candidates is the frame they were
 * born on, never a probability, a threshold, or an elapsed-attack count.
 */

import { OnlineAmtOutputDecoder } from "../../index.js";
import {
  experimentConfigurationError,
  experimentOnlyKeys,
  type ExperimentCandidateEvent,
  type ExperimentDecoder,
  type ExperimentDecoderCompletion,
  type ExperimentDecoderContext,
  type ExperimentDecoderModule,
  type ExperimentFrame,
} from "./types.js";

/** Sustain occupies index two; a note is sounding in these states. */
const SUSTAIN_STATE = 2;
const ONSET_STATE = 3;
const REONSET_STATE = 4;

const PARAMETER_KEYS = ["relations", "windowOffsets"];

/**
 * Reads one required whole-number array parameter.
 *
 * Returns the entries sorted and de-duplicated, so a configuration travels
 * through the runner in canonical form; the frozen rungs' sets are already
 * canonical, and a set written with repeats or out of order normalizes to
 * the same one.
 */
function experimentWholeArray(
  value: unknown,
  name: string,
  bounds: { readonly minimum: number; readonly maximum: number },
  required: readonly number[],
): number[] {
  if (value === null || typeof value !== "object" || !Array.isArray(value)) {
    throw experimentConfigurationError(
      `${name} must be a non-empty array of whole numbers.`,
    );
  }
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry)) {
      throw experimentConfigurationError(
        `${name} entries must be whole numbers, received ${String(entry)}.`,
      );
    }
    if (entry < bounds.minimum || entry > bounds.maximum) {
      throw experimentConfigurationError(
        `${name} entries must be at least ${bounds.minimum} and at most ${bounds.maximum}, ` +
        `received ${entry}.`,
      );
    }
    seen.add(entry);
  }
  if (seen.size === 0) {
    throw experimentConfigurationError(
      `${name} must be a non-empty array of whole numbers.`,
    );
  }
  for (const wanted of required) {
    if (!seen.has(wanted)) {
      throw experimentConfigurationError(`${name} must include ${wanted}.`);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

const chordContextGate: ExperimentDecoderModule = {
  id: "chordContextGate",
  summary:
    "Wraps the shipped candidate generation and holds a renewed attack (an onset or reOnset on a pitch " +
    "that was sounding on the previous frame) until a different pitch a `relations` semitone chord " +
    "distance away carries an onset or reOnset selected state within the `windowOffsets` frame window " +
    "around it; a suppressed frame never supplies neighbour evidence and a window position that closes " +
    "without one drops the candidate, an admitted repeat emits as soon as its window shows evidence and " +
    "pays the frame period for each frame it waits, and a new note from off/offset passes through.",

  validateConfiguration(value: unknown): Record<string, unknown> {
    experimentOnlyKeys(value ?? {}, PARAMETER_KEYS);
    const parameters = (value ?? {}) as Record<string, unknown>;
    // The chord distances a rescuing neighbour may sit at, in semitones, in
    // either direction. The frozen ladder varies this one factor: the anchor
    // rung reaches seconds, thirds, fourths, fifths and sixths, narrowing
    // toward seconds only.
    const relations = experimentWholeArray(
      parameters.relations,
      "relations",
      { minimum: 1, maximum: 48 },
      [],
    );
    // Frame offsets, relative to the candidate's frame, of the window
    // positions a rescuing neighbour may fire on. The candidate's own frame
    // must be one of them: the window is the rule's whole evidence set.
    const windowOffsets = experimentWholeArray(
      parameters.windowOffsets,
      "windowOffsets",
      { minimum: -4, maximum: 4 },
      [0],
    );
    return { relations, windowOffsets };
  },

  createDecoder(
    configuration: Record<string, unknown>,
    context: ExperimentDecoderContext,
  ): ExperimentDecoder {
    const relations = configuration.relations as number[];
    const windowOffsets = configuration.windowOffsets as number[];
    const maxWindowOffset = windowOffsets[windowOffsets.length - 1]!;
    const windowPosition = new Set<number>(windowOffsets);

    const firstMidi = context.firstMidi;
    const lastMidi = context.firstMidi + context.pitchCount - 1;

    const decoder = new OnlineAmtOutputDecoder();

    // Each pitch's selected state on the previous delivered frame, or null
    // while that frame was suppressed (or before the first frame). This is
    // the reading the runner derives as the event's transition `from`, so
    // the family test below is the runner's own transition rather than a
    // second opinion about it.
    const previousFrameState = new Map<number, number | null>();
    let havePreviousFrame = false;
    // Pitches carrying an onset or reOnset selected state on the previous
    // delivered frame. A suppressed frame leaves the set empty: missing
    // evidence is not quiet evidence.
    let previousFiring = new Set<number>();
    // Repeat candidates whose window still has a position the recording has
    // not delivered. Each is born on the frame that gated it and is resolved
    // by the first delivered window position after its birth.
    const held: { midi: number; origin: number; kind: string }[] = [];
    // (midi, originFrame) pairs already emitted; a candidate emits at most
    // once, and the runner refuses a second emission of the same one.
    const emitted = new Set<string>();

    /** Some other pitch a rung distance from `pitch` is firing in `firing`. */
    const hasFiringNeighbour = (pitch: number, firing: ReadonlySet<number>): boolean => {
      for (const distance of relations) {
        const above = pitch + distance;
        if (above <= lastMidi && firing.has(above)) return true;
        const below = pitch - distance;
        if (below >= firstMidi && firing.has(below)) return true;
      }
      return false;
    };

    return {
      onFrame(frame: ExperimentFrame): readonly ExperimentCandidateEvent[] {
        const out: ExperimentCandidateEvent[] = [];
        const emit = (midi: number, origin: number, kind: string): void => {
          const key = `${midi}:${origin}`;
          if (emitted.has(key)) return;
          emitted.add(key);
          out.push({ midi, originFrameIndex: origin, reportedKind: kind });
        };

        // Pitches firing (onset or reOnset selected state) on this frame. A
        // suppressed frame (every accessor null) supplies no evidence at
        // all; an active padding or tail-flush frame supplies its real
        // states, like any other active frame.
        const firingNow = new Set<number>();
        if (frame.signalActive) {
          for (let midi = firstMidi; midi <= lastMidi; midi += 1) {
            const state = frame.selectedState(midi);
            if (state === ONSET_STATE || state === REONSET_STATE) firingNow.add(midi);
          }
        }

        // 1) Resolve the candidates whose next window position is this frame.
        if (held.length > 0) {
          const stillHeld: typeof held = [];
          for (const candidate of held) {
            const offset = frame.index - candidate.origin;
            if (offset <= 0 || !windowPosition.has(offset)) {
              // A gap the window never occupies: the candidate is resolved
              // by a later position still.
              stillHeld.push(candidate);
            } else if (hasFiringNeighbour(candidate.midi, firingNow)) {
              emit(candidate.midi, candidate.origin, candidate.kind);
            } else if (offset >= maxWindowOffset) {
              // The window's last position closed without evidence: the
              // candidate is dropped on the spot and never emitted later.
            } else {
              stillHeld.push(candidate);
            }
          }
          held.length = 0;
          held.push(...stillHeld);
        }

        // 2) Read the frame through the shipped decoder and gate its repeat
        //    family. The control's own candidate generation is untouched:
        //    every event considered here is one it emitted on this frame.
        const decoded = decoder.decode(
          frame.weightedScores,
          frame.selectedStates,
          frame.signalActive,
          frame.capturedAtMs,
        );
        for (const event of decoded.noteEvents) {
          if (event.type === "offset") continue;
          const current = frame.selectedState(event.midi);
          if (current === null) continue;
          const previous = havePreviousFrame
            ? previousFrameState.get(event.midi) ?? null
            : null;
          const isRepeat =
            (current === ONSET_STATE || current === REONSET_STATE) &&
            (previous === SUSTAIN_STATE || previous === ONSET_STATE || previous === REONSET_STATE);
          if (!isRepeat) {
            // A new note from off/offset is left exactly as the control
            // emits it, on the frame that produced it.
            emit(event.midi, frame.index, event.type);
            continue;
          }
          if (
            hasFiringNeighbour(event.midi, previousFiring) ||
            hasFiringNeighbour(event.midi, firingNow)
          ) {
            // A firing neighbour in the part of the window already
            // delivered: the candidate is admitted and emits on this frame,
            // with no added delay.
            emit(event.midi, frame.index, event.type);
          } else if (maxWindowOffset > 0) {
            // No evidence in the delivered part of the window: the candidate
            // waits for the next delivered position, and pays the frame
            // period as added delay for each frame it waits when it is
            // admitted. A candidate whose remaining positions are beyond the
            // last captured frame is never admitted; finish() reports it.
            held.push({ midi: event.midi, origin: frame.index, kind: event.type });
          }
        }

        // 3) Hand this frame's reading to the next frame's decisions.
        if (frame.signalActive) {
          for (let midi = firstMidi; midi <= lastMidi; midi += 1) {
            previousFrameState.set(midi, frame.selectedState(midi)!);
          }
        } else {
          for (let midi = firstMidi; midi <= lastMidi; midi += 1) {
            previousFrameState.set(midi, null);
          }
        }
        previousFiring = firingNow;
        havePreviousFrame = true;

        // A frame's events are returned in the order of the attacks they
        // attribute, so a held candidate's admission precedes anything this
        // frame itself produced.
        out.sort((a, b) => a.originFrameIndex - b.originFrameIndex || a.midi - b.midi);
        return out;
      },

      finish(): ExperimentDecoderCompletion {
        // A candidate held at the end of the recording was waiting on a
        // window position the recording never delivered. It is reported,
        // not emitted: losing the candidates whose evidence never arrived is
        // the visible cost of the waiting the gate performs.
        const pending = held.length;
        held.length = 0;
        return {
          pendingCandidates: pending,
          notes:
            "chordContextGate: admitted repeats were emitted on the frame that admitted them and " +
            "dropped repeats on the frame their window closed; the count is the candidates still " +
            "waiting on window positions past the end of the recording.",
        };
      },
    };
  },
};

export default chordContextGate;
