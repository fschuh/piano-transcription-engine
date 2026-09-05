import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ONLINE_AMT_CHUNK_SIZE,
  ONLINE_AMT_SAMPLE_RATE,
} from "../src/runtime/onlineAmtProtocol.js";
import { OnlineAmtSession } from "../src/runtime/onlineAmtSession.js";

interface FixtureMetadata {
  frames: number;
  chunkSize: number;
  pitches: number;
  states: number;
}

const repositoryRoot = resolve(process.cwd());
const fixtureRoot = join(repositoryRoot, "evals", "fixtures", "online_amt_runtime");

async function float32Fixture(name: string): Promise<Float32Array> {
  const bytes = await readFile(join(fixtureRoot, name));
  assert.equal(bytes.byteLength % Float32Array.BYTES_PER_ELEMENT, 0);
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

test("session matches the canonical 180-frame runtime fixture faster than its audio cadence", {
  timeout: 30_000,
}, async (context) => {
  const [metadataBytes, audio, expectedScores, expectedActive, expectedStates, model, wasm] =
    await Promise.all([
      readFile(join(fixtureRoot, "metadata.json")),
      float32Fixture("audio.f32"),
      float32Fixture("scores.f32"),
      readFile(join(fixtureRoot, "signal-active.u8")),
      readFile(join(fixtureRoot, "states.u8")),
      readFile(join(repositoryRoot, "assets", "models", "online_amt_streaming.onnx")),
      readFile(join(
        repositoryRoot,
        "node_modules",
        "onnxruntime-web",
        "dist",
        "ort-wasm-simd-threaded.wasm",
      )),
    ]);
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as FixtureMetadata;
  assert.deepEqual(metadata, {
    frames: 180,
    chunkSize: ONLINE_AMT_CHUNK_SIZE,
    pitches: 88,
    states: 5,
  });
  assert.equal(audio.length, metadata.frames * metadata.chunkSize);
  assert.equal(expectedScores.length, metadata.frames * metadata.pitches * metadata.states);
  assert.equal(expectedActive.length, metadata.frames);
  assert.equal(expectedStates.length, metadata.frames * metadata.pitches);

  const session = await OnlineAmtSession.create({
    modelData: model,
    wasmBinary: wasm,
  });
  let maxAbsoluteScoreError = 0;
  let stateMismatches = 0;
  let signalActiveMismatches = 0;
  let elapsedMs = 0;
  try {
    await assert.rejects(
      session.run(new Float32Array(ONLINE_AMT_CHUNK_SIZE - 1)),
      /requires 512 samples, received 511/,
    );

    const startedAt = performance.now();
    for (let frame = 0; frame < metadata.frames; frame += 1) {
      const chunkStart = frame * metadata.chunkSize;
      const chunk = audio.subarray(chunkStart, chunkStart + metadata.chunkSize);
      const output = await session.run(chunk);

      const scoreStart = frame * metadata.pitches * metadata.states;
      assert.equal(output.scores.length, metadata.pitches * metadata.states);
      for (let index = 0; index < output.scores.length; index += 1) {
        maxAbsoluteScoreError = Math.max(
          maxAbsoluteScoreError,
          Math.abs(output.scores[index]! - expectedScores[scoreStart + index]!),
        );
      }

      const stateStart = frame * metadata.pitches;
      assert.equal(output.states.length, metadata.pitches);
      for (let pitch = 0; pitch < metadata.pitches; pitch += 1) {
        if (output.states[pitch] !== expectedStates[stateStart + pitch]) {
          stateMismatches += 1;
        }
      }
      if (output.signalActive !== (expectedActive[frame] !== 0)) {
        signalActiveMismatches += 1;
      }
    }
    elapsedMs = performance.now() - startedAt;

    session.reset();
    const resetOutput = await session.run(audio.subarray(0, metadata.chunkSize));
    assert.deepEqual(
      Array.from(resetOutput.states),
      Array.from(expectedStates.subarray(0, metadata.pitches)),
    );
    assert.equal(resetOutput.signalActive, expectedActive[0] !== 0);
    for (let index = 0; index < resetOutput.scores.length; index += 1) {
      assert.ok(Math.abs(resetOutput.scores[index]! - expectedScores[index]!) <= 2e-4);
    }
  } finally {
    await session.dispose();
  }

  assert.ok(maxAbsoluteScoreError <= 2e-4, String(maxAbsoluteScoreError));
  assert.equal(stateMismatches, 0);
  assert.equal(signalActiveMismatches, 0);
  const audioDurationMs = metadata.frames * metadata.chunkSize / ONLINE_AMT_SAMPLE_RATE * 1_000;
  assert.ok(
    elapsedMs < audioDurationMs,
    `processed ${audioDurationMs} ms of audio in ${elapsedMs} ms`,
  );
  context.diagnostic(JSON.stringify({
    frames: metadata.frames,
    audioDurationMs,
    elapsedMs,
    maxAbsoluteScoreError,
    stateMismatches,
    signalActiveMismatches,
  }));
});
