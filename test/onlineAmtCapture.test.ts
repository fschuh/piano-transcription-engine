import assert from "node:assert/strict";
import test from "node:test";

import {
  captureFrameCount,
  captureOnlineAmtTrace,
  DEFAULT_TAIL_FLUSH_SAMPLES,
  frameCapturedAtMs,
  frameChunkStartMs,
  frameScores,
  frameStates,
  ONLINE_AMT_PITCH_COUNT,
  ONLINE_AMT_STATE_COUNT,
  type OnlineAmtCaptureFrame,
  type OnlineAmtCaptureSession,
} from "../src/eval/index.js";
import { ONLINE_AMT_CHUNK_SIZE, ONLINE_AMT_SAMPLE_RATE } from "../src/index.js";

const SCORES_PER_FRAME = ONLINE_AMT_PITCH_COUNT * ONLINE_AMT_STATE_COUNT;

/**
 * A session that answers with the frame index instead of running the model, so
 * the runner's framing, padding, flushing, and timing are checked on their own.
 */
class RecordingSession implements OnlineAmtCaptureSession {
  readonly chunks: Float32Array[] = [];
  resets = 0;
  private frame = 0;

  constructor(private readonly damage: {
    scoreLength?: number;
    stateLength?: number;
    atFrame?: number;
  } = {}) {}

  reset(): void {
    this.resets += 1;
    this.frame = 0;
  }

  run(audio: Float32Array): Promise<{
    scores: Float32Array;
    states: Uint8Array;
    signalActive: boolean;
    inferenceTimeMs: number;
  }> {
    // Keep the array we were handed; the runner must not edit it later.
    this.chunks.push(audio);
    const index = this.frame;
    this.frame += 1;
    const damaged = this.damage.atFrame === index;
    const scores = new Float32Array(
      damaged && this.damage.scoreLength !== undefined
        ? this.damage.scoreLength
        : SCORES_PER_FRAME,
    );
    scores.fill(index);
    const states = new Uint8Array(
      damaged && this.damage.stateLength !== undefined
        ? this.damage.stateLength
        : ONLINE_AMT_PITCH_COUNT,
    );
    states.fill(index % 5);
    return Promise.resolve({
      scores,
      states,
      // Alternate so the stored flags cannot pass by being uniformly one value.
      signalActive: index % 2 === 0,
      inferenceTimeMs: index / 4,
    });
  }
}

function ramp(length: number): Float32Array {
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) samples[index] = index + 1;
  return samples;
}

test("frame times follow the capture worklet's end-of-chunk convention", () => {
  const chunkMs = ONLINE_AMT_CHUNK_SIZE / ONLINE_AMT_SAMPLE_RATE * 1_000;
  assert.equal(chunkMs, 32);
  assert.equal(frameChunkStartMs(0), 0);
  assert.equal(frameCapturedAtMs(0), chunkMs);
  assert.equal(frameChunkStartMs(10), 10 * chunkMs);
  assert.equal(frameCapturedAtMs(10), 11 * chunkMs);
  // The decision for a frame exists only once its last sample has been heard.
  assert.equal(frameCapturedAtMs(7) - frameChunkStartMs(7), chunkMs);
});

test("captures whole chunks in order and resets the session first", async () => {
  const session = new RecordingSession();
  session.reset();
  const samples = ramp(ONLINE_AMT_CHUNK_SIZE * 3);
  const trace = await captureOnlineAmtTrace(session, samples, { tailFlushSamples: 0 });

  assert.equal(session.resets, 2, "the runner must reset the session it was given");
  assert.equal(trace.frameCount, 3);
  assert.equal(trace.inputFrameCount, 3);
  assert.equal(trace.paddedSampleCount, 0);
  assert.equal(trace.tailFlushSampleCount, 0);
  assert.equal(trace.inputSampleCount, samples.length);
  assert.equal(trace.inputDurationMs, trace.capturedDurationMs);
  assert.equal(session.chunks.length, 3);
  for (let frame = 0; frame < 3; frame += 1) {
    assert.deepEqual(
      Array.from(session.chunks[frame]!),
      Array.from(samples.subarray(frame * ONLINE_AMT_CHUNK_SIZE, (frame + 1) * ONLINE_AMT_CHUNK_SIZE)),
      `frame ${frame} received the wrong samples`,
    );
  }
  for (let frame = 0; frame < 3; frame += 1) {
    assert.deepEqual(Array.from(frameScores(trace, frame)), Array(SCORES_PER_FRAME).fill(frame));
    assert.deepEqual(
      Array.from(frameStates(trace, frame)),
      Array(ONLINE_AMT_PITCH_COUNT).fill(frame % 5),
    );
    assert.equal(trace.signalActive[frame], frame % 2 === 0 ? 1 : 0);
    assert.equal(trace.inferenceTimeMs[frame], frame / 4);
  }
});

test("pads the last chunk of input and labels the samples it added", async () => {
  const session = new RecordingSession();
  const samples = ramp(ONLINE_AMT_CHUNK_SIZE * 2 + 100);
  const trace = await captureOnlineAmtTrace(session, samples, { tailFlushSamples: 0 });

  assert.equal(trace.frameCount, 3);
  assert.equal(trace.inputFrameCount, 3);
  assert.equal(trace.paddedSampleCount, ONLINE_AMT_CHUNK_SIZE - 100);
  const last = session.chunks[2]!;
  assert.deepEqual(Array.from(last.subarray(0, 100)), Array.from(samples.subarray(1_024)));
  assert.deepEqual(Array.from(last.subarray(100)), Array(ONLINE_AMT_CHUNK_SIZE - 100).fill(0));
  // Padding never lengthens the performance the trace claims to hold.
  assert.equal(trace.inputDurationMs, samples.length / ONLINE_AMT_SAMPLE_RATE * 1_000);
});

test("flushes a fixed silent tail and marks its frames as holding no input", async () => {
  const session = new RecordingSession();
  const frames: OnlineAmtCaptureFrame[] = [];
  const samples = ramp(ONLINE_AMT_CHUNK_SIZE);
  const trace = await captureOnlineAmtTrace(session, samples, {
    tailFlushSamples: ONLINE_AMT_CHUNK_SIZE * 2,
    onFrame: (frame) => frames.push(frame),
  });

  assert.equal(trace.frameCount, 3);
  assert.equal(trace.inputFrameCount, 1);
  assert.equal(trace.tailFlushSampleCount, ONLINE_AMT_CHUNK_SIZE * 2);
  assert.deepEqual(frames.map((frame) => frame.containsInputSamples), [true, false, false]);
  assert.deepEqual(frames.map((frame) => frame.index), [0, 1, 2]);
  assert.deepEqual(frames.map((frame) => frame.capturedAtMs), [32, 64, 96]);
  for (const index of [1, 2]) {
    assert.deepEqual(
      Array.from(session.chunks[index]!),
      Array(ONLINE_AMT_CHUNK_SIZE).fill(0),
      "a flush frame must be silence, not a repeat of the last input",
    );
  }
  assert.equal(trace.capturedDurationMs - trace.inputDurationMs, 64);
});

test("the default tail flush is the model's own mel window", () => {
  assert.equal(DEFAULT_TAIL_FLUSH_SAMPLES, 2_048);
  assert.equal(DEFAULT_TAIL_FLUSH_SAMPLES % ONLINE_AMT_CHUNK_SIZE, 0);
  assert.equal(captureFrameCount(ONLINE_AMT_CHUNK_SIZE * 10), 14);
  assert.equal(captureFrameCount(1, 0), 1);
  assert.equal(captureFrameCount(ONLINE_AMT_CHUNK_SIZE + 1, 512), 3);
});

test("refuses input and a tail flush the runner cannot frame exactly", async () => {
  const session = new RecordingSession();
  await assert.rejects(
    captureOnlineAmtTrace(session, new Float32Array(0)),
    /at least one input sample/,
  );
  for (const tailFlushSamples of [-512, 1.5, 700]) {
    await assert.rejects(
      captureOnlineAmtTrace(session, ramp(512), { tailFlushSamples }),
      /Tail flush/,
      `accepted a ${tailFlushSamples}-sample tail flush`,
    );
  }
  assert.equal(session.chunks.length, 0, "a refused capture must not run the model");
});

test("refuses a session whose output is not one frame of model scores and states", async () => {
  await assert.rejects(
    captureOnlineAmtTrace(
      new RecordingSession({ scoreLength: SCORES_PER_FRAME - 5, atFrame: 1 }),
      ramp(ONLINE_AMT_CHUNK_SIZE * 3),
      { tailFlushSamples: 0 },
    ),
    /Frame 1 returned 435 scores and 88 states; expected 440 and 88/,
  );
  await assert.rejects(
    captureOnlineAmtTrace(
      new RecordingSession({ stateLength: 87, atFrame: 0 }),
      ramp(ONLINE_AMT_CHUNK_SIZE),
      { tailFlushSamples: 0 },
    ),
    /Frame 0 returned 440 scores and 87 states/,
  );
});
