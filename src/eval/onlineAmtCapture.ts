/**
 * Sequential offline capture of the online-AMT model's own output.
 *
 * The runner feeds one recording's samples to the production session in order,
 * 512 samples at a time, keeping the recurrent state through the whole take and
 * resetting it before each one. It records every frame's five state scores per
 * pitch, the selected states, the signal-active flag, and the audio time at
 * which the frame's decision first exists — before any event decoding or
 * matcher filtering, so downstream work can be redone from the trace.
 *
 * Nothing here resamples, normalizes, or time-stretches the performance: the
 * samples it receives are the samples it feeds.
 */

import {
  ONLINE_AMT_CHUNK_SIZE,
  ONLINE_AMT_SAMPLE_RATE,
} from "../index.js";

/** Pitches the model scores: the 88 keys starting at MIDI 21. */
export const ONLINE_AMT_PITCH_COUNT = 88;

/** Per-pitch states the model scores: off, offset, sustain, onset, re-onset. */
export const ONLINE_AMT_STATE_COUNT = 5;

/**
 * Silence appended after the last input sample, in samples.
 *
 * The model's mel frame is computed from the newest 2,048 samples of its audio
 * buffer, so the final input sample is only fully inside a mel window once that
 * many further samples have arrived. Flushing exactly that many gives the last
 * real attack the same evidence an earlier one had, and no more. The count is
 * fixed and its frames are labelled in the trace, so scoring can refuse to
 * treat flushed time as recorded performance.
 */
export const DEFAULT_TAIL_FLUSH_SAMPLES = 2_048;

/** The part of `OnlineAmtSession` a capture needs, so tests can substitute one. */
export interface OnlineAmtCaptureSession {
  reset(): void;
  run(audio: Float32Array): Promise<{
    scores: Float32Array;
    states: Uint8Array;
    signalActive: boolean;
    inferenceTimeMs: number;
  }>;
}

export interface OnlineAmtCaptureFrame {
  index: number;
  /** Audio time of the chunk's first sample. */
  chunkStartMs: number;
  /**
   * Audio time of the chunk's last sample: the earliest moment a causal reader
   * could hold this frame's decision. Execution time is measured separately.
   */
  capturedAtMs: number;
  /** False for a frame made only of end padding or tail flush silence. */
  containsInputSamples: boolean;
  scores: Float32Array;
  states: Uint8Array;
  signalActive: boolean;
  inferenceTimeMs: number;
}

export interface OnlineAmtCaptureTrace {
  frameCount: number;
  /** Frames holding at least one input sample; the rest are padding or flush. */
  inputFrameCount: number;
  chunkSize: number;
  pitchCount: number;
  stateCount: number;
  sampleRateHz: number;
  inputSampleCount: number;
  /** Zeros added to complete the final chunk of input. */
  paddedSampleCount: number;
  tailFlushSampleCount: number;
  inputDurationMs: number;
  /** Duration actually fed, including the padding and the tail flush. */
  capturedDurationMs: number;
  /** `frameCount * pitchCount * stateCount` scores in frame order. */
  scores: Float32Array;
  /** `frameCount * pitchCount` selected states in frame order. */
  states: Uint8Array;
  /** One flag per frame. */
  signalActive: Uint8Array;
  /** Per-frame inference time; a performance measurement, not a detection delay. */
  inferenceTimeMs: Float32Array;
  /** Wall-clock time spent running the model over the whole take. */
  elapsedMs: number;
}

export interface OnlineAmtCaptureOptions {
  tailFlushSamples?: number;
  /** Receives each frame as it is produced, for streaming inspection. */
  onFrame?: (frame: OnlineAmtCaptureFrame) => void;
}

/** Audio time of a frame's first sample. */
export function frameChunkStartMs(frameIndex: number): number {
  return frameIndex * ONLINE_AMT_CHUNK_SIZE / ONLINE_AMT_SAMPLE_RATE * 1_000;
}

/**
 * Audio time of a frame's last sample.
 *
 * This is the convention the production capture worklet already posts with each
 * chunk, so an offline trace and a live session time the same decision alike.
 */
export function frameCapturedAtMs(frameIndex: number): number {
  return (frameIndex + 1) * ONLINE_AMT_CHUNK_SIZE / ONLINE_AMT_SAMPLE_RATE * 1_000;
}

/** Frames a recording of this many samples produces, padding and flush included. */
export function captureFrameCount(
  inputSampleCount: number,
  tailFlushSamples: number = DEFAULT_TAIL_FLUSH_SAMPLES,
): number {
  return Math.ceil(inputSampleCount / ONLINE_AMT_CHUNK_SIZE) +
    Math.ceil(tailFlushSamples / ONLINE_AMT_CHUNK_SIZE);
}

function validateTailFlushSamples(tailFlushSamples: number): void {
  if (!Number.isInteger(tailFlushSamples) || tailFlushSamples < 0) {
    throw new Error(
      `Tail flush must be a non-negative whole number of samples, received ${tailFlushSamples}.`,
    );
  }
  if (tailFlushSamples % ONLINE_AMT_CHUNK_SIZE !== 0) {
    throw new Error(
      `Tail flush must be a multiple of ${ONLINE_AMT_CHUNK_SIZE} samples so its frames can be ` +
      `counted exactly, received ${tailFlushSamples}.`,
    );
  }
}

/**
 * Runs one recording through the model and returns its raw trace.
 *
 * The session is reset first, so a caller that reuses one session across a
 * corpus never carries one recording's recurrent state into the next.
 */
export async function captureOnlineAmtTrace(
  session: OnlineAmtCaptureSession,
  samples: Float32Array,
  options: OnlineAmtCaptureOptions = {},
): Promise<OnlineAmtCaptureTrace> {
  const tailFlushSamples = options.tailFlushSamples ?? DEFAULT_TAIL_FLUSH_SAMPLES;
  validateTailFlushSamples(tailFlushSamples);
  if (samples.length === 0) {
    throw new Error("A capture needs at least one input sample.");
  }

  const inputFrameCount = Math.ceil(samples.length / ONLINE_AMT_CHUNK_SIZE);
  const frameCount = inputFrameCount + tailFlushSamples / ONLINE_AMT_CHUNK_SIZE;
  const scoresPerFrame = ONLINE_AMT_PITCH_COUNT * ONLINE_AMT_STATE_COUNT;
  const scores = new Float32Array(frameCount * scoresPerFrame);
  const states = new Uint8Array(frameCount * ONLINE_AMT_PITCH_COUNT);
  const signalActive = new Uint8Array(frameCount);
  const inferenceTimeMs = new Float32Array(frameCount);

  session.reset();
  const startedAt = performance.now();
  for (let frame = 0; frame < frameCount; frame += 1) {
    const chunkStart = frame * ONLINE_AMT_CHUNK_SIZE;
    const available = Math.max(0, Math.min(ONLINE_AMT_CHUNK_SIZE, samples.length - chunkStart));
    // A fresh chunk per frame, so an implementation that keeps the array it was
    // handed keeps that frame's audio rather than a buffer the next frame edits.
    const chunk = new Float32Array(ONLINE_AMT_CHUNK_SIZE);
    if (available > 0) chunk.set(samples.subarray(chunkStart, chunkStart + available));
    const step = await session.run(chunk);
    if (step.scores.length !== scoresPerFrame || step.states.length !== ONLINE_AMT_PITCH_COUNT) {
      throw new Error(
        `Frame ${frame} returned ${step.scores.length} scores and ${step.states.length} states; ` +
        `expected ${scoresPerFrame} and ${ONLINE_AMT_PITCH_COUNT}.`,
      );
    }
    scores.set(step.scores, frame * scoresPerFrame);
    states.set(step.states, frame * ONLINE_AMT_PITCH_COUNT);
    signalActive[frame] = step.signalActive ? 1 : 0;
    inferenceTimeMs[frame] = step.inferenceTimeMs;
    options.onFrame?.({
      index: frame,
      chunkStartMs: frameChunkStartMs(frame),
      capturedAtMs: frameCapturedAtMs(frame),
      containsInputSamples: available > 0,
      scores: step.scores,
      states: step.states,
      signalActive: step.signalActive,
      inferenceTimeMs: step.inferenceTimeMs,
    });
  }
  const elapsedMs = performance.now() - startedAt;

  const paddedSampleCount = inputFrameCount * ONLINE_AMT_CHUNK_SIZE - samples.length;
  return {
    frameCount,
    inputFrameCount,
    chunkSize: ONLINE_AMT_CHUNK_SIZE,
    pitchCount: ONLINE_AMT_PITCH_COUNT,
    stateCount: ONLINE_AMT_STATE_COUNT,
    sampleRateHz: ONLINE_AMT_SAMPLE_RATE,
    inputSampleCount: samples.length,
    paddedSampleCount,
    tailFlushSampleCount: tailFlushSamples,
    inputDurationMs: samples.length / ONLINE_AMT_SAMPLE_RATE * 1_000,
    capturedDurationMs: frameCount * ONLINE_AMT_CHUNK_SIZE / ONLINE_AMT_SAMPLE_RATE * 1_000,
    scores,
    states,
    signalActive,
    inferenceTimeMs,
    elapsedMs,
  };
}

/** The five state scores of one pitch in one frame, as stored in the trace. */
export function frameScores(
  trace: Pick<OnlineAmtCaptureTrace, "scores" | "pitchCount" | "stateCount">,
  frameIndex: number,
): Float32Array {
  const perFrame = trace.pitchCount * trace.stateCount;
  return trace.scores.subarray(frameIndex * perFrame, (frameIndex + 1) * perFrame);
}

/** The selected states of one frame, as stored in the trace. */
export function frameStates(
  trace: Pick<OnlineAmtCaptureTrace, "states" | "pitchCount">,
  frameIndex: number,
): Uint8Array {
  return trace.states.subarray(
    frameIndex * trace.pitchCount,
    (frameIndex + 1) * trace.pitchCount,
  );
}
