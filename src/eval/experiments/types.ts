/**
 * The frozen contract between the experiment runner and a candidate decoder.
 *
 * A candidate decoder is the only part of an experiment a research agent writes.
 * Everything it is allowed to see arrives through this file, and everything it
 * may say arrives back through this file, so the pipeline around it — which
 * recordings are scored, which reference it is scored against, which window
 * matches an attack, and when a decision counts as available — is not something
 * a candidate can reach, argue with, or accidentally redefine.
 *
 * Three properties are structural rather than documented, because a rule that
 * only a reviewer enforces is a rule an unattended loop will eventually break:
 *
 *  - A decoder is handed one frame at a time, in capture order, and is never
 *    handed the trace. A rule that waits for the next frame has to wait for it.
 *  - A decoder does not state when its decision became available. The runner
 *    stamps that from the frame the decoder was holding when it emitted, so
 *    added waiting cannot be subtracted back out of the availability clock.
 *  - A decoder states only the pitch and its estimated onset. Nothing here
 *    carries MIDI, the target score, the reference, or a reference-centred peak,
 *    so no candidate can be fitted to the answer it is being scored against.
 *
 * This file is prepared infrastructure and is fixed for the duration of a
 * research run. Changing it changes what every earlier measurement meant.
 */

/** States the model scores per pitch, in the order they occupy a frame. */
export const EXPERIMENT_STATE_NAMES = [
  "off",
  "offset",
  "sustain",
  "onset",
  "reOnset",
] as const;

export type ExperimentStateName = typeof EXPERIMENT_STATE_NAMES[number];

/**
 * One captured frame, as a causal decoder is allowed to see it.
 *
 * `weightedScores` and `selectedStates` are the bytes the capture recorded, in
 * the model's own pitch-major layout, so a decoder that wants the raw frame has
 * it without the runner reshaping 88 pitches on every frame. The accessors are
 * the same numbers named per pitch, with the state weighting divided back out.
 *
 * A suppressed frame is missing evidence, not evidence of silence: every
 * accessor returns null for it, and a rule that needs a quiet frame must not
 * count suppression as one.
 */
export interface ExperimentFrame {
  readonly index: number;
  /** Audio time of the chunk's first sample. */
  readonly chunkStartMs: number;
  /** Audio time of the chunk's last sample: the earliest this frame can be held. */
  readonly capturedAtMs: number;
  /** False while the model was holding its previous state over silence. */
  readonly signalActive: boolean;
  /** False for a frame made only of end padding or tail-flush silence. */
  readonly containsInputSamples: boolean;
  readonly pitchCount: number;
  readonly stateCount: number;
  /** Lowest MIDI number the model scores; pitch index zero. */
  readonly firstMidi: number;
  /** `pitchCount * stateCount` weighted scores, pitch-major, exactly as captured. */
  readonly weightedScores: Float32Array;
  /** One selected state per pitch as captured; meaningless when suppressed. */
  readonly selectedStates: Uint8Array;
  /** Selected state of one pitch, or null when this frame is suppressed. */
  selectedState(midi: number): number | null;
  /** Captured score with its state weight divided out, or null when suppressed. */
  unweighted(midi: number, state: number): number | null;
  /** Unweighted onset + re-onset probability, or null when suppressed. */
  attackProbability(midi: number): number | null;
  /** Unweighted sustain + onset + re-onset probability, or null when suppressed. */
  presenceProbability(midi: number): number | null;
}

/**
 * What a decoder is told before the first frame.
 *
 * It describes the shape of what is coming and the clocks in use. It carries no
 * frame, so nothing here lets a decoder look ahead, and no recording identity,
 * so a rule cannot be written for one particular take.
 */
export interface ExperimentDecoderContext {
  readonly frameCount: number;
  /** Frames holding at least one input sample; the rest are padding or flush. */
  readonly inputFrameCount: number;
  readonly chunkSizeSamples: number;
  readonly sampleRateHz: number;
  readonly pitchCount: number;
  readonly stateCount: number;
  readonly firstMidi: number;
  /** Time between consecutive frame decisions. */
  readonly framePeriodMs: number;
  /** The state weighting the capture applied, needed to read scores honestly. */
  readonly stateWeights: readonly number[];
  /**
   * Fixed lag subtracted from a frame's clock to estimate the onset it saw.
   *
   * A decoder emits the frame whose evidence it is attributing the attack to;
   * the runner turns that into an onset estimate with this lag. It is 160 ms for
   * Round 3 and is not a candidate parameter.
   */
  readonly onsetEstimateLagMs: number;
}

/**
 * One attack a decoder is emitting, attributed to one frame it has seen.
 *
 * `originFrameIndex` is the frame the attack is being attributed to, which may
 * be earlier than the frame being decided — that is exactly what a confirmation
 * rule does. The runner turns it into the onset estimate and refuses a frame the
 * decoder cannot have seen yet, so an estimate can neither run ahead of the
 * evidence nor hide the waiting that produced it.
 */
export interface ExperimentCandidateEvent {
  readonly midi: number;
  readonly originFrameIndex: number;
  /**
   * The decoder's own words for why it emitted. Recorded as self-reported and
   * never used as a measurement; the runner derives the state transition and
   * repeat spacing itself.
   */
  readonly reportedKind?: string;
}

/** What a decoder reports once the last frame has been delivered. */
export interface ExperimentDecoderCompletion {
  /**
   * Candidates still waiting for confirmation when the recording ended.
   *
   * They are not emitted: a rule that waits must lose the candidates whose
   * evidence never arrived, and that loss has to be visible rather than
   * recovered opportunistically after the fact.
   */
  readonly pendingCandidates?: number;
  /** Free-text notes kept with the measurement as the decoder's own account. */
  readonly notes?: string;
}

export interface ExperimentDecoder {
  /**
   * Decides one frame and returns the attacks that become available with it.
   *
   * Called once per captured frame in order. Returning nothing is normal: a
   * confirmation rule emits on the frame that confirms, not the frame that
   * proposed.
   */
  onFrame(frame: ExperimentFrame): readonly ExperimentCandidateEvent[] | undefined | void;
  /** Called after the final frame, for candidates that never resolved. */
  finish?(): ExperimentDecoderCompletion | undefined | void;
}

/**
 * A candidate algorithm, as the runner loads it.
 *
 * The runner finds a module by its id alone, so adding an algorithm is adding a
 * file: no dispatch table, registry, or runner edit is involved. One module is
 * one algorithm; its parameters are configuration, and a parameter setting is
 * never a new module.
 */
export interface ExperimentDecoderModule {
  /** Must equal the module's own file name, so an id names exactly one file. */
  readonly id: string;
  /** One line a report can print about what this algorithm does. */
  readonly summary: string;
  /**
   * Accepts this algorithm's parameters, or throws explaining what is wrong.
   *
   * The returned object is what gets frozen into the cycle record and handed
   * back to `createDecoder`, so a default that is applied here is a default that
   * is written down rather than one that has to be remembered.
   */
  validateConfiguration(value: unknown): Record<string, unknown>;
  createDecoder(
    configuration: Record<string, unknown>,
    context: ExperimentDecoderContext,
  ): ExperimentDecoder;
}

/** Rejects a configuration, in the one shape the runner reports. */
export function experimentConfigurationError(message: string): Error {
  return new Error(`Invalid decoder configuration: ${message}`);
}

/**
 * Reads one required finite number from a candidate's parameters.
 *
 * Every candidate needs this and none of them should write it again, so it lives
 * with the contract rather than in each algorithm.
 */
export function experimentNumber(
  value: unknown,
  name: string,
  bounds: { readonly minimum?: number; readonly maximum?: number; readonly integer?: boolean } = {},
): number {
  const parameters = value as Record<string, unknown> | null;
  const parsed = parameters === null || typeof parameters !== "object"
    ? undefined
    : parameters[name];
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw experimentConfigurationError(`${name} must be a finite number.`);
  }
  if (bounds.integer === true && !Number.isInteger(parsed)) {
    throw experimentConfigurationError(`${name} must be a whole number, received ${parsed}.`);
  }
  if (bounds.minimum !== undefined && parsed < bounds.minimum) {
    throw experimentConfigurationError(
      `${name} must be at least ${bounds.minimum}, received ${parsed}.`,
    );
  }
  if (bounds.maximum !== undefined && parsed > bounds.maximum) {
    throw experimentConfigurationError(
      `${name} must be at most ${bounds.maximum}, received ${parsed}.`,
    );
  }
  return parsed;
}

/** Refuses any parameter the algorithm does not define, so a typo is not a default. */
export function experimentOnlyKeys(value: unknown, allowed: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw experimentConfigurationError("parameters must be an object.");
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw experimentConfigurationError(
      `${unexpected.join(", ")} is not a parameter of this algorithm; it defines ` +
      `${allowed.join(", ") || "none"}.`,
    );
  }
}
