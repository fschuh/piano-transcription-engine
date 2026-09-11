import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureOnlineAmtTrace,
  compareExperimentRecordings,
  delayDistribution,
  evaluateExperimentRecording,
  onlineAmtTraceMismatches,
  parseEvaluationProtocol,
  resolveStateWeights,
  runExperimentDecoder,
  verifiedDigitalSilence,
  type Attack,
  type EvaluationProtocol,
  type ExperimentRecordingResult,
  type OnlineAmtCaptureTrace,
  type OnlineAmtTraceMetadata,
} from "../../src/eval/index.js";

const LAG = 160;
const RECORDING = "silver/take";

const protocol: EvaluationProtocol = parseEvaluationProtocol({
  id: "test", round: "3", adoptedOn: "2026-09-11",
  goldRecordings: ["gold/take"],
  split: { development: [RECORDING], confirmation: ["silver/held-out"] },
  timing: { primaryOnsetWindowMs: 50, supplementalOnsetWindowMs: 100, alignmentOffsetMs: 0 },
  baseline: { inputGainDb: 0, tailFlushSamples: 2048 },
  experimentBudget: {
    hypothesisCycles: 6,
    minConfigurationsPerCycle: 3,
    maxConfigurationsPerCycle: 5,
    consecutiveUnproductiveCycles: 3,
  },
});

async function quietTrace(frameCount: number): Promise<OnlineAmtCaptureTrace> {
  return captureOnlineAmtTrace({
    reset() {},
    async run() {
      return {
        scores: new Float32Array(440),
        states: new Uint8Array(88),
        signalActive: true,
        inferenceTimeMs: 1,
      };
    },
  }, new Float32Array(frameCount * 512), { tailFlushSamples: 0 });
}

/** A decoder that emits exactly the frames it is told to, so a test owns the events. */
async function scriptedDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "experiment-scoring-"));
  await writeFile(join(root, "scripted.js"), `
    export default {
      id: "scripted",
      summary: "Emits a fixed script of attacks.",
      validateConfiguration(value) { return { script: value.script, wait: value.wait ?? 0 }; },
      createDecoder(configuration) {
        return {
          onFrame(frame) {
            return configuration.script
              .filter((entry) => entry.origin + configuration.wait === frame.index)
              .map((entry) => ({ midi: entry.midi, originFrameIndex: entry.origin }));
          },
        };
      },
    };
  `);
  return root;
}

async function scoreScript(
  root: string,
  script: { midi: number; origin: number }[],
  references: Attack[],
  wait = 0,
): Promise<ExperimentRecordingResult> {
  const trace = await quietTrace(40);
  const run = await runExperimentDecoder(trace, {
    decoderId: "scripted",
    configuration: { script, wait },
    onsetEstimateLagMs: LAG,
    directory: root,
  });
  return evaluateExperimentRecording({
    recordingId: RECORDING,
    role: "development",
    trace,
    references,
    protocol,
    run,
    quietRegions: [{ startMs: 500, endMs: 900, basis: "test" }],
  });
}

test("a candidate is scored at both windows against the frozen reference", async () => {
  const root = await scriptedDirectory();
  try {
    // Frame 10 is captured at 352 ms, so its onset estimate is 192 ms.
    const result = await scoreScript(root, [
      { midi: 60, origin: 10 },
      { midi: 62, origin: 20 },
    ], [{ midi: 60, onsetMs: 200 }, { midi: 64, onsetMs: 300 }]);
    assert.equal(result.referenceCount, 2);
    assert.equal(result.predictionCount, 2);
    const [primary, supplemental] = result.windows;
    assert.equal(primary!.windowMs, 50);
    assert.equal(supplemental!.windowMs, 100);
    assert.equal(primary!.matched, 1);
    assert.equal(primary!.precision, 0.5);
    assert.equal(primary!.recall, 0.5);
    assert.equal(primary!.zeroObservedFalseAttacks, false);
    assert.equal(primary!.meanTimingErrorMs, -8);
    assert.equal(primary!.meanAbsoluteTimingErrorMs, 8);
    // Delay is reference onset to availability: 352 ms minus the 200 ms onset.
    assert.equal(primary!.detectionDelayMs.medianMs, 152);
    assert.equal(primary!.addedDelayMs.maxMs, 0);
    assert.equal(primary!.goldChords, null);
    assert.equal(result.mechanism.newPitch, 2);
    assert.equal(result.verifiedQuietPredictions, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("waiting is charged to the delay distribution, not hidden in the onset estimate", async () => {
  const root = await scriptedDirectory();
  try {
    const references = [{ midi: 60, onsetMs: 192 }];
    const immediate = await scoreScript(root, [{ midi: 60, origin: 10 }], references, 0);
    const delayed = await scoreScript(root, [{ midi: 60, origin: 10 }], references, 2);
    assert.equal(immediate.predictions[0]!.onsetMs, delayed.predictions[0]!.onsetMs);
    assert.equal(immediate.windows[0]!.meanTimingErrorMs, delayed.windows[0]!.meanTimingErrorMs);
    assert.equal(immediate.windows[0]!.detectionDelayMs.maxMs, 160);
    assert.equal(delayed.windows[0]!.detectionDelayMs.maxMs, 224);
    assert.equal(delayed.windows[0]!.addedDelayMs.maxMs, 64);
    assert.equal(delayed.decoder.maximumWaitedFrames, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a comparison names the events that changed rather than the aggregate that moved", async () => {
  const root = await scriptedDirectory();
  try {
    const references = [
      { midi: 60, onsetMs: 192 },
      { midi: 62, onsetMs: 512 },
    ];
    const control = await scoreScript(root, [
      { midi: 60, origin: 10 },
      { midi: 62, origin: 20 },
      { midi: 64, origin: 25 },
    ], references);
    const candidate = await scoreScript(root, [
      { midi: 60, origin: 10 },
      { midi: 65, origin: 25 },
    ], references, 1);
    const comparison = compareExperimentRecordings(control, candidate, 50);
    assert.equal(comparison.extrasRemoved, 1);
    assert.equal(comparison.extrasIntroduced, 1);
    assert.equal(comparison.matchesLost, 1);
    assert.equal(comparison.missesRecovered, 0);
    assert.equal(comparison.availabilityChanged, 1);
    assert.equal(comparison.unchangedPredictions, 0);
    const lost = comparison.changedEvents.find((entry) => entry.change === "match-lost");
    assert.equal(lost!.midi, 62);
    assert.equal(lost!.referenceOnsetMs, 512);
    const removed = comparison.changedEvents.find((entry) => entry.change === "extra-removed");
    assert.equal(removed!.midi, 64);
    const introduced = comparison.changedEvents.find((entry) => entry.change === "extra-introduced");
    assert.equal(introduced!.midi, 65);
    const moved = comparison.changedEvents.find((entry) => entry.change === "availability-changed");
    assert.equal(moved!.midi, 60);
    assert.equal(moved!.addedDelayMs, 32);
    assert.equal(moved!.candidateAvailableAtMs! - moved!.controlAvailableAtMs!, 32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recovered miss is reported as a recovery, not as an extra that vanished", async () => {
  const root = await scriptedDirectory();
  try {
    const references = [{ midi: 60, onsetMs: 192 }];
    const control = await scoreScript(root, [], references);
    const candidate = await scoreScript(root, [{ midi: 60, origin: 10 }], references);
    const comparison = compareExperimentRecordings(control, candidate, 50);
    assert.equal(comparison.missesRecovered, 1);
    assert.equal(comparison.extrasIntroduced, 0);
    assert.equal(comparison.matchesLost, 0);
    assert.equal(comparison.changedEvents[0]!.change, "miss-recovered");
    assert.equal(comparison.changedEvents[0]!.pitchName, "C4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two runs scored against different references are refused, not differenced", async () => {
  const root = await scriptedDirectory();
  try {
    const control = await scoreScript(root, [{ midi: 60, origin: 10 }], [{ midi: 60, onsetMs: 192 }]);
    const corrected = await scoreScript(root, [{ midi: 60, origin: 10 }], [{ midi: 60, onsetMs: 200 }]);
    assert.throws(
      () => compareExperimentRecordings(control, corrected, 50),
      /scored against different references/,
    );
    assert.throws(
      () => compareExperimentRecordings(control, control, 75),
      /must report the 75 ms window/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gold moments report complete and repeated chords through the experiment path", async () => {
  const root = await scriptedDirectory();
  try {
    const trace = await quietTrace(40);
    const run = await runExperimentDecoder(trace, {
      decoderId: "scripted",
      configuration: { script: [{ midi: 60, origin: 10 }, { midi: 64, origin: 10 }] },
      onsetEstimateLagMs: LAG,
      directory: root,
    });
    const result = evaluateExperimentRecording({
      recordingId: "gold/take",
      role: "gold",
      trace,
      references: [
        { midi: 60, onsetMs: 192 },
        { midi: 64, onsetMs: 192 },
        { midi: 60, onsetMs: 500 },
        { midi: 64, onsetMs: 500 },
      ],
      protocol,
      goldMoments: [
        { onsetMs: 192, pitches: [60, 64] },
        { onsetMs: 500, pitches: [60, 64] },
      ],
      run,
    });
    const chords = result.windows[0]!.goldChords!;
    assert.equal(chords.length, 2);
    assert.equal(chords[0]!.complete, true);
    assert.equal(chords[1]!.repeatedChord, true);
    assert.equal(chords[1]!.complete, false);
    assert.equal(result.windows[0]!.incompleteRepeatedChords, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the held-out half is refused, whatever a caller asks for", async () => {
  const root = await scriptedDirectory();
  try {
    const trace = await quietTrace(40);
    const run = await runExperimentDecoder(trace, {
      decoderId: "scripted",
      configuration: { script: [] },
      onsetEstimateLagMs: LAG,
      directory: root,
    });
    const score = (recordingId: string) => evaluateExperimentRecording({
      recordingId,
      role: "development",
      trace,
      references: [],
      protocol,
      run,
    });
    assert.throws(() => score("silver/held-out"), /confirmation half/);
    // The role a caller supplies is a label on the result; the protocol is what
    // decides, so naming it development does not make it scoreable.
    assert.equal(score(RECORDING).recordingId, RECORDING);
    assert.equal(score("gold/take").recordingId, "gold/take");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a delay distribution reports its tail, and an empty sample reports nothing", () => {
  assert.deepEqual(delayDistribution([]), {
    count: 0, meanMs: null, medianMs: null, p95Ms: null, maxMs: null,
  });
  const spread = delayDistribution([32, 32, 32, 32, 32, 32, 32, 32, 32, 640]);
  assert.equal(spread.medianMs, 32);
  assert.equal(spread.p95Ms, 640);
  assert.equal(spread.maxMs, 640);
  assert.equal(spread.meanMs, 92.8);
  assert.equal(delayDistribution([5]).p95Ms, 5);
});

test("only exact digital zero counts as verified silence, and its edges are trimmed", () => {
  const samples = new Float32Array(16_000);
  samples.fill(1e-7, 0, 8_000);
  const regions = verifiedDigitalSilence(samples, 16_000);
  assert.equal(regions.length, 1);
  // Zeros run from 8,000 to 16,000 samples: 500 ms to 1,000 ms, trimmed 120 each.
  assert.equal(regions[0]!.startMs, 620);
  assert.equal(regions[0]!.endMs, 880);
  assert.match(regions[0]!.basis, /exact digital zero/);
  const brief = new Float32Array(16_000).fill(0.5);
  brief.set(new Float32Array(3_000), 1_000);
  assert.deepEqual(verifiedDigitalSilence(brief, 16_000), []);
  assert.throws(() => verifiedDigitalSilence(samples, 0), /sample rate must be positive/);
  assert.throws(
    () => verifiedDigitalSilence(samples, 16_000, { minimumDurationMs: 100, edgeTrimMs: 60 }),
    /leaves nothing once/,
  );
});

test("a trace records the weighting its model applied, and refuses to be read by another", () => {
  assert.deepEqual(resolveStateWeights(undefined), [1, 1, 1, 2, 2]);
  assert.deepEqual(resolveStateWeights([1, 1, 1, 1.5, 2]), [1, 1, 1, 1.5, 2]);
  assert.throws(() => resolveStateWeights([1, 1, 1, 2]), /five positive numbers|5 positive numbers/);
  assert.throws(() => resolveStateWeights([1, 1, 1, 0, 2]), /positive/);
  const metadata = {
    model: { file: "m.onnx", byteLength: 1, sha256: "a" },
    audio: { sha256: "b", sampleRateHz: 16_000, inputGainDb: 0 },
    capture: { chunkSize: 512, tailFlushSampleCount: 2_048 },
  } as unknown as OnlineAmtTraceMetadata;
  const required = {
    modelSha256: "a", audioSha256: "b", sampleRateHz: 16_000, chunkSize: 512,
    inputGainDb: 0, tailFlushSampleCount: 2_048,
  };
  assert.deepEqual(onlineAmtTraceMismatches(metadata, required), []);
  assert.deepEqual(
    onlineAmtTraceMismatches(metadata, { ...required, stateWeights: [1, 1, 1, 1.5, 2] }),
    ["its state weighting is [1,1,1,2,2] but [1,1,1,1.5,2] was requested"],
  );
});
