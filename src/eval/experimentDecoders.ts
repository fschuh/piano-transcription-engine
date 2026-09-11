/**
 * Runs a candidate decoder over a captured trace, and holds it to the contract.
 *
 * The runner owns everything a candidate is not allowed to decide. It builds the
 * per-frame view, delivers frames in order, stamps availability from the frame
 * the decoder was holding, and refuses an event that could not have been
 * produced causally. A candidate is therefore free to be wrong about music and
 * unable to be wrong about time.
 *
 * The module-loading convention is deliberately dull: a decoder id names a file
 * in `experiments/`, and that is the whole of it. Adding an algorithm never
 * touches this file, so the dispatch a research loop would otherwise have to
 * edit does not exist.
 */

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  frameCapturedAtMs,
  frameChunkStartMs,
  frameScores,
  frameStates,
  type OnlineAmtCaptureTrace,
} from "./onlineAmtCapture.js";
import { BASELINE_STATE_WEIGHTS, type PredictedAttack, type StateWeights } from "./recognitionEvaluation.js";
import {
  EXPERIMENT_STATE_NAMES,
  type ExperimentCandidateEvent,
  type ExperimentDecoderCompletion,
  type ExperimentDecoderContext,
  type ExperimentDecoderModule,
  type ExperimentFrame,
} from "./experiments/types.js";

const FIRST_PIANO_MIDI = 21;
const CLOCK_TOLERANCE_MS = 1e-6;
const DECODER_ID = /^[a-z][A-Za-z0-9]*$/;

/** Where the built candidate modules live, relative to this module. */
function defaultDecoderDirectory(): string {
  return fileURLToPath(new URL("./experiments/", import.meta.url));
}

/**
 * Refuses an id that is not a plain module name.
 *
 * An id becomes a file path, so anything that could climb out of the candidate
 * directory is refused here rather than resolved and then regretted.
 */
export function assertExperimentDecoderId(id: unknown): string {
  if (typeof id !== "string" || !DECODER_ID.test(id)) {
    throw new Error(
      `A decoder id must be a plain lowerCamelCase module name, received ${JSON.stringify(id)}.`,
    );
  }
  return id;
}

/** The candidate modules present in a build, by id. */
export async function listExperimentDecoderIds(directory?: string): Promise<string[]> {
  const root = directory ?? defaultDecoderDirectory();
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries
    .filter((name) => name.endsWith(".js") && !name.endsWith(".d.ts"))
    .map((name) => name.slice(0, -".js".length))
    .filter((name) => DECODER_ID.test(name) && name !== "types")
    .sort();
}

/**
 * Loads one candidate module by id and checks it is the module it claims to be.
 *
 * A module whose `id` disagrees with its file name would let two ids resolve to
 * one algorithm, which is how a frozen configuration stops naming what actually
 * ran, so the two must agree.
 */
export async function loadExperimentDecoderModule(
  id: string,
  directory?: string,
): Promise<ExperimentDecoderModule> {
  const decoderId = assertExperimentDecoderId(id);
  const root = directory ?? defaultDecoderDirectory();
  const specifier = pathToFileURL(resolve(root, `${decoderId}.js`));
  const loaded = await import(specifier.href).catch((error: unknown) => {
    throw new Error(
      `No candidate decoder ${decoderId} in ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }) as { default?: unknown };
  const module = loaded.default as ExperimentDecoderModule | undefined;
  if (module === undefined || typeof module !== "object" ||
    typeof module.validateConfiguration !== "function" ||
    typeof module.createDecoder !== "function" ||
    typeof module.summary !== "string") {
    throw new Error(
      `${decoderId} must default-export an ExperimentDecoderModule with summary, ` +
      "validateConfiguration and createDecoder.",
    );
  }
  if (module.id !== decoderId) {
    throw new Error(`${decoderId} declares the id ${JSON.stringify(module.id)}.`);
  }
  return module;
}

function assertWeights(weights: StateWeights, stateCount: number): void {
  if (weights.length !== stateCount ||
    weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error("State weights must be positive, finite, and one per model state.");
  }
}

/** One frame of the trace, in the only shape a candidate ever sees it. */
function viewFrame(
  trace: OnlineAmtCaptureTrace,
  index: number,
  weights: StateWeights,
): ExperimentFrame {
  const weightedScores = frameScores(trace, index);
  const selectedStates = frameStates(trace, index);
  const signalActive = Boolean(trace.signalActive[index]);
  const pitchOf = (midi: number): number => {
    const pitch = midi - FIRST_PIANO_MIDI;
    if (!Number.isInteger(pitch) || pitch < 0 || pitch >= trace.pitchCount) {
      throw new Error(`MIDI ${midi} is outside the ${trace.pitchCount} pitches the model scores.`);
    }
    return pitch;
  };
  const unweighted = (midi: number, state: number): number | null => {
    if (!signalActive) return null;
    if (!Number.isInteger(state) || state < 0 || state >= trace.stateCount) {
      throw new Error(`State ${state} is outside the ${trace.stateCount} states the model scores.`);
    }
    return weightedScores[pitchOf(midi) * trace.stateCount + state]! / weights[state]!;
  };
  const sum = (midi: number, states: readonly number[]): number | null => {
    if (!signalActive) return null;
    let total = 0;
    for (const state of states) total += unweighted(midi, state)!;
    return total;
  };
  return {
    index,
    chunkStartMs: frameChunkStartMs(index),
    capturedAtMs: frameCapturedAtMs(index),
    signalActive,
    containsInputSamples: index < trace.inputFrameCount,
    pitchCount: trace.pitchCount,
    stateCount: trace.stateCount,
    firstMidi: FIRST_PIANO_MIDI,
    weightedScores,
    selectedStates,
    selectedState: (midi) => signalActive ? selectedStates[pitchOf(midi)]! : null,
    unweighted,
    attackProbability: (midi) => sum(midi, [3, 4]),
    presenceProbability: (midi) => sum(midi, [2, 3, 4]),
  };
}

/**
 * An event as the runner records it: what the candidate said, plus what the
 * runner measured about it.
 *
 * `onsetMs` and `availableAtMs` are the two clocks the whole experiment turns
 * on, and neither is a candidate's to state. `transition` and `sincePreviousMs`
 * are read from the trace rather than from `reportedKind`, so the mechanism
 * breakdown a report prints is a measurement and not a self-description.
 */
export interface ExperimentDecodedEvent extends PredictedAttack {
  /** Frame whose evidence the attack was attributed to. */
  originFrameIndex: number;
  /** Frame the decoder was holding when it emitted. */
  availableFrameIndex: number;
  /** Frames the decoder waited between the two; zero for immediate emission. */
  waitedFrames: number;
  /** Delay those frames added beyond immediate emission. */
  addedDelayMs: number;
  /** Selected state at the origin frame, and the frame before it. */
  transition: { from: string | null; to: string | null };
  /** Signed gap to this pitch's previous emitted onset estimate, or null. */
  sincePreviousMs: number | null;
  /** True when the emitting frame held no input samples. */
  availableAfterInput: boolean;
  reportedKind: string | null;
}

export interface ExperimentDecoderRun {
  decoderId: string;
  summary: string;
  configuration: Record<string, unknown>;
  events: ExperimentDecodedEvent[];
  completion: ExperimentDecoderCompletion;
  /** Frames delivered, and how many of them the model was holding state over. */
  frameCount: number;
  suppressedFrames: number;
  /** Events emitted on a padding or tail-flush frame; evidence past the input. */
  eventsAvailableAfterInput: number;
  /** Longest wait any emitted event incurred, in frames. */
  maximumWaitedFrames: number;
  stateWeights: readonly number[];
  onsetEstimateLagMs: number;
}

export interface ExperimentDecoderRunOptions {
  decoderId: string;
  configuration?: unknown;
  weights?: StateWeights;
  /** Fixed candidate-onset lag; 160 ms for Round 3. */
  onsetEstimateLagMs: number;
  /** Candidate directory override; tests use it, the loop does not. */
  directory?: string;
}

/**
 * Streams one trace through a candidate decoder and validates every event.
 *
 * The checks are not defensive politeness. A decoder that attributed an attack
 * to a frame it had not been handed would be reading the future; one that
 * emitted the same candidate twice would inflate its own recall; one whose onset
 * estimate sat off the frame grid would be inventing precision the model never
 * had. Each of those produces a number that looks like a result, so each is
 * refused here rather than reported.
 */
export async function runExperimentDecoder(
  trace: OnlineAmtCaptureTrace,
  options: ExperimentDecoderRunOptions,
): Promise<ExperimentDecoderRun> {
  const weights = options.weights ?? BASELINE_STATE_WEIGHTS;
  assertWeights(weights, trace.stateCount);
  const lag = options.onsetEstimateLagMs;
  if (!Number.isFinite(lag) || lag < 0) {
    throw new Error("onsetEstimateLagMs must be finite and non-negative.");
  }
  const module = await loadExperimentDecoderModule(options.decoderId, options.directory);
  const configuration = module.validateConfiguration(options.configuration ?? {});
  if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new Error(`${module.id}.validateConfiguration must return a parameter object.`);
  }
  const framePeriodMs = trace.chunkSize / trace.sampleRateHz * 1_000;
  const context: ExperimentDecoderContext = {
    frameCount: trace.frameCount,
    inputFrameCount: trace.inputFrameCount,
    chunkSizeSamples: trace.chunkSize,
    sampleRateHz: trace.sampleRateHz,
    pitchCount: trace.pitchCount,
    stateCount: trace.stateCount,
    firstMidi: FIRST_PIANO_MIDI,
    framePeriodMs,
    stateWeights: [...weights],
    onsetEstimateLagMs: lag,
  };
  const decoder = module.createDecoder(configuration, context);
  if (decoder === null || typeof decoder !== "object" || typeof decoder.onFrame !== "function") {
    throw new Error(`${module.id}.createDecoder must return a decoder with an onFrame method.`);
  }

  const stateNameAt = (frameIndex: number, midi: number): string | null => {
    if (frameIndex < 0 || frameIndex >= trace.frameCount) return null;
    if (!trace.signalActive[frameIndex]) return null;
    const state = frameStates(trace, frameIndex)[midi - FIRST_PIANO_MIDI];
    return state === undefined ? null : EXPERIMENT_STATE_NAMES[state] ?? null;
  };

  const events: ExperimentDecodedEvent[] = [];
  const emitted = new Set<string>();
  const previousOnsetMs = new Map<number, number>();
  for (let index = 0; index < trace.frameCount; index += 1) {
    const frame = viewFrame(trace, index, weights);
    const produced = decoder.onFrame(frame) ?? [];
    if (!Array.isArray(produced)) {
      throw new Error(`${module.id} returned ${typeof produced} from onFrame; expected an array.`);
    }
    for (const candidate of produced as readonly ExperimentCandidateEvent[]) {
      const event = validateCandidate(module.id, candidate, index, trace, lag, framePeriodMs);
      const identity = `${event.midi}@${event.originFrameIndex}`;
      if (emitted.has(identity)) {
        throw new Error(
          `${module.id} emitted MIDI ${event.midi} from frame ${event.originFrameIndex} twice; ` +
          "a candidate may be emitted at most once.",
        );
      }
      emitted.add(identity);
      const previous = previousOnsetMs.get(event.midi);
      events.push({
        ...event,
        availableFrameIndex: index,
        waitedFrames: index - event.originFrameIndex,
        addedDelayMs: (index - event.originFrameIndex) * framePeriodMs,
        transition: {
          from: stateNameAt(event.originFrameIndex - 1, event.midi),
          to: stateNameAt(event.originFrameIndex, event.midi),
        },
        sincePreviousMs: previous === undefined ? null : event.onsetMs - previous,
        availableAfterInput: index >= trace.inputFrameCount,
        reportedKind: typeof candidate.reportedKind === "string" ? candidate.reportedKind : null,
      });
      previousOnsetMs.set(event.midi, event.onsetMs);
    }
  }
  const completion = (decoder.finish?.() ?? {}) as ExperimentDecoderCompletion;
  if (completion.pendingCandidates !== undefined &&
    (!Number.isInteger(completion.pendingCandidates) || completion.pendingCandidates < 0)) {
    throw new Error(`${module.id} reported a non-whole pendingCandidates count.`);
  }
  return {
    decoderId: module.id,
    summary: module.summary,
    configuration,
    events,
    completion,
    frameCount: trace.frameCount,
    suppressedFrames: Array.from(trace.signalActive).filter((active) => !active).length,
    eventsAvailableAfterInput: events.filter((event) => event.availableAfterInput).length,
    maximumWaitedFrames: events.reduce((most, event) => Math.max(most, event.waitedFrames), 0),
    stateWeights: [...weights],
    onsetEstimateLagMs: lag,
  };
}

/** Everything about one emitted event that is checkable without the reference. */
function validateCandidate(
  decoderId: string,
  candidate: ExperimentCandidateEvent,
  currentFrame: number,
  trace: OnlineAmtCaptureTrace,
  lag: number,
  framePeriodMs: number,
): PredictedAttack & { originFrameIndex: number } {
  if (candidate === null || typeof candidate !== "object") {
    throw new Error(`${decoderId} emitted ${String(candidate)} instead of an event object.`);
  }
  const { midi, originFrameIndex } = candidate;
  if (!Number.isInteger(midi) ||
    midi < FIRST_PIANO_MIDI || midi >= FIRST_PIANO_MIDI + trace.pitchCount) {
    throw new Error(
      `${decoderId} emitted MIDI ${String(midi)}, which is not one of the ` +
      `${trace.pitchCount} pitches the model scores.`,
    );
  }
  if (!Number.isInteger(originFrameIndex) || originFrameIndex < 0) {
    throw new Error(`${decoderId} emitted a non-frame origin ${String(originFrameIndex)}.`);
  }
  if (originFrameIndex > currentFrame) {
    throw new Error(
      `${decoderId} attributed MIDI ${midi} to frame ${originFrameIndex} while deciding frame ` +
      `${currentFrame}; a causal decoder cannot read a frame it has not been handed.`,
    );
  }
  const onsetMs = frameCapturedAtMs(originFrameIndex) - lag;
  const availableAtMs = frameCapturedAtMs(currentFrame);
  // The onset estimate is derived here, never accepted, so the added waiting a
  // confirmation rule incurs cannot be subtracted back out of availability.
  const grid = (onsetMs + lag) / framePeriodMs;
  if (Math.abs(grid - Math.round(grid)) > CLOCK_TOLERANCE_MS) {
    throw new Error(`${decoderId} produced an onset estimate off the ${framePeriodMs} ms frame grid.`);
  }
  if (onsetMs > availableAtMs + CLOCK_TOLERANCE_MS) {
    throw new Error(`${decoderId} produced an onset estimate later than its own availability.`);
  }
  return { midi, onsetMs, availableAtMs, originFrameIndex };
}
