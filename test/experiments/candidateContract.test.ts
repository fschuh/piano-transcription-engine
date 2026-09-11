import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertExperimentDecoderId,
  captureOnlineAmtTrace,
  listExperimentDecoderIds,
  loadExperimentDecoderModule,
  readTraceAttacks,
  runExperimentDecoder,
  type ExperimentFrame,
  type OnlineAmtCaptureTrace,
} from "../../src/eval/index.js";

const LAG = 160;

/**
 * One synthetic take, written as the attack probability and selected state of a
 * single pitch per frame. Everything these tests assert is about clocks,
 * identity and causality, so one pitch is enough and the rest stays quiet.
 */
async function syntheticTrace(
  frames: { probability: number; state: number; active?: boolean }[],
  tailFrames = 0,
): Promise<OnlineAmtCaptureTrace> {
  let index = 0;
  return captureOnlineAmtTrace({
    reset() { index = 0; },
    async run() {
      const frame = frames[index++]!;
      const scores = new Float32Array(440);
      const states = new Uint8Array(88);
      const active = frame.active ?? true;
      if (active) {
        for (let pitch = 0; pitch < 88; pitch += 1) scores[pitch * 5] = 1;
        scores[39 * 5] = 1 - frame.probability;
        scores[39 * 5 + 3] = frame.probability * 2;
      }
      states[39] = frame.state;
      return { scores, states, signalActive: active, inferenceTimeMs: 1 };
    },
  }, new Float32Array((frames.length - tailFrames) * 512), { tailFlushSamples: tailFrames * 512 });
}

async function decoderDirectory(id: string, source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "experiment-decoder-"));
  await writeFile(join(root, `${id}.js`), source);
  return root;
}

test("the shipped control travels the candidate path and reproduces the shipped readout", async () => {
  const trace = await syntheticTrace([
    { probability: 0.9, state: 3 },
    { probability: 0.9, state: 3 },
    { probability: 0.9, state: 4 },
    { probability: 0.1, state: 2 },
    { probability: 0, state: 0 },
    { probability: 0.8, state: 3 },
  ]);
  const run = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const expected = readTraceAttacks(trace, "shipped", undefined, LAG);
  assert.deepEqual(
    run.events.map((event) => ({
      midi: event.midi,
      onsetMs: event.onsetMs,
      availableAtMs: event.availableAtMs,
    })),
    expected.map((event) => ({
      midi: event.midi,
      onsetMs: event.onsetMs,
      availableAtMs: event.availableAtMs,
    })),
  );
  assert.ok(run.events.length > 0);
  // The control waits for nothing, so every event is available on its own frame.
  assert.deepEqual([...new Set(run.events.map((event) => event.waitedFrames))], [0]);
  assert.equal(run.maximumWaitedFrames, 0);
  assert.deepEqual(run.configuration, {});
});

test("the shipped control refuses a parameter, because it has none to set", async () => {
  const module = await loadExperimentDecoderModule("shipped");
  assert.throws(() => module.validateConfiguration({ threshold: 0.3 }), /threshold is not a parameter/);
  assert.deepEqual(module.validateConfiguration({}), {});
  assert.ok((await listExperimentDecoderIds()).includes("shipped"));
});

test("a decoder file that was never named in the runner loads by its id alone", async () => {
  const root = await decoderDirectory("alwaysAtFrameThree", `
    export default {
      id: "alwaysAtFrameThree",
      summary: "Emits MIDI 60 once, from frame three.",
      validateConfiguration(value) {
        if (typeof value?.midi !== "number") throw new Error("midi is required");
        return { midi: value.midi };
      },
      createDecoder(configuration) {
        return {
          onFrame(frame) {
            return frame.index === 3 ? [{ midi: configuration.midi, originFrameIndex: 3 }] : [];
          },
        };
      },
    };
  `);
  try {
    const trace = await syntheticTrace(Array.from({ length: 6 }, () => ({ probability: 0, state: 0 })));
    const run = await runExperimentDecoder(trace, {
      decoderId: "alwaysAtFrameThree",
      configuration: { midi: 60 },
      onsetEstimateLagMs: LAG,
      directory: root,
    });
    assert.deepEqual(run.events.map((event) => [event.midi, event.onsetMs, event.availableAtMs]),
      [[60, 128 - LAG, 128]]);
    assert.deepEqual(await listExperimentDecoderIds(root), ["alwaysAtFrameThree"]);
    await assert.rejects(
      runExperimentDecoder(trace, {
        decoderId: "alwaysAtFrameThree",
        configuration: {},
        onsetEstimateLagMs: LAG,
        directory: root,
      }),
      /midi is required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a candidate cannot attribute an attack to a frame it has not been handed", async () => {
  const root = await decoderDirectory("readsTheFuture", `
    export default {
      id: "readsTheFuture",
      summary: "Attributes its first emission to a later frame.",
      validateConfiguration() { return {}; },
      createDecoder() {
        return { onFrame(frame) { return frame.index === 1 ? [{ midi: 60, originFrameIndex: 4 }] : []; } };
      },
    };
  `);
  try {
    const trace = await syntheticTrace(Array.from({ length: 6 }, () => ({ probability: 0, state: 0 })));
    await assert.rejects(
      runExperimentDecoder(trace, {
        decoderId: "readsTheFuture",
        onsetEstimateLagMs: LAG,
        directory: root,
      }),
      /cannot read a frame it has not been handed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waiting for confirmation moves availability and leaves the onset estimate alone", async () => {
  const root = await decoderDirectory("waitsOneFrame", `
    export default {
      id: "waitsOneFrame",
      summary: "Proposes on an onset frame and emits one frame later if presence holds.",
      validateConfiguration(value) {
        return { threshold: typeof value?.threshold === "number" ? value.threshold : 0.5 };
      },
      createDecoder(configuration) {
        let pending = null;
        return {
          onFrame(frame) {
            const emitted = [];
            if (pending !== null) {
              const presence = frame.presenceProbability(60);
              if (presence !== null && presence >= configuration.threshold) {
                emitted.push({ midi: 60, originFrameIndex: pending, reportedKind: "confirmed" });
              }
              pending = null;
            }
            if (frame.selectedState(60) === 3) pending = frame.index;
            return emitted;
          },
          finish() { return { pendingCandidates: pending === null ? 0 : 1, notes: "end of take" }; },
        };
      },
    };
  `);
  try {
    const trace = await syntheticTrace([
      { probability: 0, state: 0 },
      { probability: 0.9, state: 3 },
      { probability: 0.9, state: 2 },
      { probability: 0, state: 0 },
      { probability: 0.9, state: 3 },
    ]);
    const run = await runExperimentDecoder(trace, {
      decoderId: "waitsOneFrame",
      onsetEstimateLagMs: LAG,
      directory: root,
    });
    assert.equal(run.events.length, 1);
    const [event] = run.events;
    // Frame 1's decision is what it always was; the waiting shows up as delay.
    assert.equal(event!.onsetMs, 64 - LAG);
    assert.equal(event!.availableAtMs, 96);
    assert.equal(event!.addedDelayMs, 32);
    assert.equal(event!.waitedFrames, 1);
    assert.deepEqual(event!.transition, { from: "off", to: "onset" });
    assert.equal(event!.reportedKind, "confirmed");
    // The candidate proposed on the final frame and never got its evidence.
    assert.equal(run.completion.pendingCandidates, 1);
    assert.equal(run.completion.notes, "end of take");
    assert.deepEqual(run.configuration, { threshold: 0.5 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a candidate may be emitted at most once", async () => {
  const root = await decoderDirectory("emitsTwice", `
    export default {
      id: "emitsTwice",
      summary: "Emits the same candidate from two different frames.",
      validateConfiguration() { return {}; },
      createDecoder() {
        return { onFrame(frame) { return frame.index >= 2 ? [{ midi: 60, originFrameIndex: 2 }] : []; } };
      },
    };
  `);
  try {
    const trace = await syntheticTrace(Array.from({ length: 5 }, () => ({ probability: 0, state: 0 })));
    await assert.rejects(
      runExperimentDecoder(trace, { decoderId: "emitsTwice", onsetEstimateLagMs: LAG, directory: root }),
      /emitted MIDI 60 from frame 2 twice/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a suppressed frame reads as missing evidence, never as a quiet frame", async () => {
  const seen: { index: number; presence: number | null; state: number | null; input: boolean }[] = [];
  const root = await decoderDirectory("recordsWhatItSaw", `
    export default {
      id: "recordsWhatItSaw",
      summary: "Emits nothing and reports what each frame looked like.",
      validateConfiguration(value) { return { sink: value.sink }; },
      createDecoder(configuration) {
        return { onFrame(frame) { configuration.sink.push({
          index: frame.index,
          presence: frame.presenceProbability(60),
          state: frame.selectedState(60),
          input: frame.containsInputSamples,
        }); } };
      },
    };
  `);
  try {
    const trace = await syntheticTrace([
      { probability: 0.9, state: 3 },
      { probability: 0, state: 2, active: false },
      { probability: 0, state: 0 },
      { probability: 0, state: 0 },
    ], 1);
    const module = await loadExperimentDecoderModule("recordsWhatItSaw", root);
    const decoder = module.createDecoder({ sink: seen } as never, {
      frameCount: trace.frameCount,
      inputFrameCount: trace.inputFrameCount,
      chunkSizeSamples: trace.chunkSize,
      sampleRateHz: trace.sampleRateHz,
      pitchCount: trace.pitchCount,
      stateCount: trace.stateCount,
      firstMidi: 21,
      framePeriodMs: 32,
      stateWeights: [1, 1, 1, 2, 2],
      onsetEstimateLagMs: LAG,
    });
    assert.equal(typeof decoder.onFrame, "function");
    const run = await runExperimentDecoder(trace, {
      decoderId: "recordsWhatItSaw",
      configuration: { sink: seen } as never,
      onsetEstimateLagMs: LAG,
      directory: root,
    });
    assert.equal(run.events.length, 0);
    const frames = seen.slice(-trace.frameCount);
    assert.ok(Math.abs(frames[0]!.presence! - 0.9) < 1e-6);
    assert.equal(frames[0]!.state, 3);
    // Suppression is the model holding its previous state, so nothing is known.
    assert.equal(frames[1]!.presence, null);
    assert.equal(frames[1]!.state, null);
    assert.equal(frames[0]!.input, true);
    assert.equal(frames[trace.frameCount - 1]!.input, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a decoder id names one module and cannot climb out of the candidate directory", async () => {
  for (const bad of ["../shipped", "sub/dir", "Shipped", "", "shipped.js", "a-b", 7, null]) {
    assert.throws(() => assertExperimentDecoderId(bad), /plain lowerCamelCase module name/);
  }
  assert.equal(assertExperimentDecoderId("delayedConfirmation"), "delayedConfirmation");
  await assert.rejects(loadExperimentDecoderModule("notAnAlgorithm"), /No candidate decoder/);
});

test("a module whose declared id disagrees with its file name is refused", async () => {
  const root = await decoderDirectory("honest", `
    export default {
      id: "dishonest",
      summary: "Claims to be a different algorithm.",
      validateConfiguration() { return {}; },
      createDecoder() { return { onFrame() {} }; },
    };
  `);
  try {
    await assert.rejects(loadExperimentDecoderModule("honest", root), /declares the id "dishonest"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the frame view hands over the captured bytes and the unweighted reading of them", async () => {
  const captured: ExperimentFrame[] = [];
  const root = await decoderDirectory("keepsFrames", `
    export default {
      id: "keepsFrames",
      summary: "Keeps the frames it is handed.",
      validateConfiguration(value) { return { sink: value.sink }; },
      createDecoder(configuration) { return { onFrame(frame) { configuration.sink.push(frame); } }; },
    };
  `);
  try {
    const trace = await syntheticTrace([{ probability: 0.5, state: 3 }]);
    await runExperimentDecoder(trace, {
      decoderId: "keepsFrames",
      configuration: { sink: captured } as never,
      onsetEstimateLagMs: LAG,
      directory: root,
    });
    const frame = captured[0]!;
    assert.equal(frame.weightedScores.length, 440);
    assert.equal(frame.selectedStates.length, 88);
    // The stored score carries the model's own doubling of the attack states.
    assert.ok(Math.abs(frame.weightedScores[39 * 5 + 3]! - 1) < 1e-6);
    assert.ok(Math.abs(frame.unweighted(60, 3)! - 0.5) < 1e-6);
    assert.ok(Math.abs(frame.attackProbability(60)! - 0.5) < 1e-6);
    assert.equal(frame.capturedAtMs, 32);
    assert.equal(frame.chunkStartMs, 0);
    assert.throws(() => frame.unweighted(20, 0), /outside the 88 pitches/);
    assert.throws(() => frame.unweighted(60, 5), /outside the 5 states/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
