import assert from "node:assert/strict";
import test from "node:test";
import {
  captureOnlineAmtTrace, matchAttacks, inspectScoreFrame, readTraceAttacks,
  diagnoseRawAttacks, goldChordDiagnostics, evaluateRecognitionRecording, meanRecordingMetrics,
  type Attack, type PredictedAttack, type EvaluationProtocol,
} from "../src/eval/index.js";

const ref = (onsetMs: number, midi = 60): Attack => ({ onsetMs, midi });
const pred = (onsetMs: number, midi = 60, availableAtMs = onsetMs): PredictedAttack => ({ onsetMs, midi, availableAtMs });

test("extra/missing annotations affect local matches, not subsequent attacks", () => {
  const predictions = [pred(100), pred(300), pred(500), pred(700)];
  const extra = matchAttacks([ref(100), ref(200), ref(300), ref(500), ref(700)], predictions);
  assert.deepEqual(extra.unmatchedReferences, [1]);
  assert.equal(extra.matches.length, 4);
  const missing = matchAttacks([ref(100), ref(500), ref(700)], predictions);
  assert.deepEqual(missing.unmatchedPredictions, [1]);
  assert.deepEqual(missing.matches.map((m) => m.predictionIndex), [0, 2, 3]);
});

test("close repeats, ties, unsorted arrays and timing boundaries use one-to-one maximum matching", () => {
  assert.equal(matchAttacks([ref(100), ref(150)], [pred(125)]).matches.length, 1);
  // Nearest-first would consume 140 for reference 130, losing the second match.
  assert.equal(matchAttacks([ref(130), ref(190)], [pred(90), pred(140)]).matches.length, 2);
  const tied = matchAttacks([ref(100), ref(100)], [pred(100), pred(100)]);
  assert.deepEqual(tied.matches.map((m) => m.predictionIndex), [0, 1]);
  assert.deepEqual(matchAttacks([ref(300), ref(100)], [pred(100), pred(300)]).matches.map((m) => m.predictionIndex), [1, 0]);
  for (const time of [50, 150]) assert.equal(matchAttacks([ref(100)], [pred(time)]).matches.length, 1);
  assert.equal(matchAttacks([ref(100)], [pred(150.001)]).matches.length, 0);
  assert.equal(matchAttacks([ref(100)], [pred(200)], 100).matches.length, 1);
  assert.equal(matchAttacks([ref(100)], [pred(100, 61)]).matches.length, 0);
});

test("false attacks, silence, empty sets and availability have explicit metrics", () => {
  assert.equal(matchAttacks([], []).f1, 1);
  assert.equal(matchAttacks([], [pred(100)]).f1, 0);
  assert.equal(matchAttacks([ref(100)], []).f1, 0);
  assert.equal(matchAttacks([], []).meanDetectionDelayMs, null);
  const result = matchAttacks([ref(100)], [pred(110, 60, 160), pred(300)]);
  assert.equal(result.precision, 0.5);
  assert.equal(result.recall, 1);
  assert.equal(result.meanTimingErrorMs, 10);
  assert.equal(result.meanDetectionDelayMs, 60);
  assert.throws(() => matchAttacks([], [], -1));
  assert.throws(() => matchAttacks([], [pred(100, 60, 90)]));
  assert.equal(meanRecordingMetrics([result, matchAttacks([], [])]).precision, 0.75);
});

async function syntheticTrace(frames: { probability: number; state: number; active?: boolean }[], tail = 0) {
  let index = 0;
  return captureOnlineAmtTrace({ reset() { index = 0; }, async run() {
    const frame = frames[index++]!;
    const scores = new Float32Array(440), states = new Uint8Array(88);
    const active = frame.active ?? true;
    if (active) {
      for (let pitch = 0; pitch < 88; pitch++) scores[pitch * 5] = 1;
      scores[39 * 5] = 1 - frame.probability;
      scores[39 * 5 + 3] = frame.probability * 2;
    }
    states[39] = frame.state;
    return { scores, states, signalActive: active, inferenceTimeMs: 1 };
  } }, new Float32Array((frames.length - tail) * 512), { tailFlushSamples: tail * 512 });
}

test("inspection undoes weights without renormalizing and labels suppressed scores unavailable", async () => {
  const trace = await syntheticTrace([{ probability: 0.4, state: 3 }, { probability: 0, state: 0, active: false }]);
  const frame = inspectScoreFrame(trace, 0);
  assert.ok(Math.abs(frame.pitches[39]!.attackProbability! - 0.4) < 1e-6);
  assert.ok(Math.abs(frame.pitches[39]!.weighted[3]! - 0.8) < 1e-6);
  assert.equal(inspectScoreFrame(trace, 1).pitches[39]!.unweighted, null);
  const diagnosis = diagnoseRawAttacks(trace, [ref(32)])[0]!;
  assert.equal(diagnosis.optimisticReferenceInformed, true);
  assert.equal(diagnosis.suppressedFrames, 1);
  assert.equal(diagnosis.attackPeak!.timeMs, 32);
  assert.equal(diagnoseRawAttacks(trace, [ref(1000)])[0]!.attackPeak, null);
});

test("shipped transitions and causal hysteresis separate repeats and preserve availability", async () => {
  const trace = await syntheticTrace([
    { probability: 0.5, state: 3 }, { probability: 0.5, state: 3 },
    { probability: 0, state: 0, active: false }, { probability: 0.5, state: 3 },
    { probability: 0.1, state: 2 }, { probability: 0.5, state: 4 },
  ]);
  assert.deepEqual(readTraceAttacks(trace).map((event) => event.onsetMs), [32, 128, 192]);
  const config = { threshold: 0.3, releaseThreshold: 0.15, minimumSeparationMs: 64 };
  assert.deepEqual(readTraceAttacks(trace, config), [pred(32), pred(192)]);
  assert.deepEqual(readTraceAttacks(trace, { ...config, minimumSeparationMs: 200 }), [pred(32)]);
  const prefix = await syntheticTrace([{ probability: 0.5, state: 3 }, { probability: 0.5, state: 3 }]);
  assert.deepEqual(readTraceAttacks(prefix, config), readTraceAttacks(trace, config).filter((event) => event.availableAtMs <= 64));
  assert.throws(() => readTraceAttacks(trace, { ...config, threshold: 0.1 }));
  const silence = await syntheticTrace([{ probability: 0, state: 0, active: false }]);
  assert.deepEqual(readTraceAttacks(silence), []);
  assert.deepEqual(readTraceAttacks(silence, config), []);
});

test("gold complete and repeated chord recovery never borrows an earlier attack", () => {
  const references = [ref(100, 60), ref(100, 64), ref(200, 60), ref(200, 64)];
  const result = matchAttacks(references, [pred(100, 60), pred(100, 64), pred(200, 60)]);
  const chords = goldChordDiagnostics(references, result, [{ onsetMs: 100, pitches: [60, 64] }, { onsetMs: 200, pitches: [64, 60] }]);
  assert.equal(chords[0]!.complete, true);
  assert.equal(chords[1]!.repeatedChord, true);
  assert.equal(chords[1]!.complete, false);
  assert.deepEqual(chords[1]!.recoveredPitches, [60]);
});

const protocol: EvaluationProtocol = {
  id: "synthetic", round: "3", adoptedOn: "2026-09-08", goldRecordings: ["test"],
  split: { development: [], confirmation: [] }, timing: { primaryOnsetWindowMs: 50, supplementalOnsetWindowMs: 100, alignmentOffsetMs: 10, recordingAlignmentOffsetMs: {} },
  scoringIntervals: [], excludedIntervals: [], noiseIntervals: [], baseline: { inputGainDb: 0, tailFlushSamples: 0 },
  experimentBudget: { hypothesisCycles: 6, minConfigurationsPerCycle: 3, maxConfigurationsPerCycle: 5, consecutiveUnproductiveCycles: 3 },
};

test("recording comparison shares windows/exclusions, retains pre-roll state and excludes tail time", async () => {
  const trace = await syntheticTrace([
    { probability: 0.5, state: 3 }, { probability: 0.5, state: 3 },
    { probability: 0, state: 2 }, { probability: 0.5, state: 4 },
    { probability: 0, state: 2 }, { probability: 0.5, state: 4 },
    { probability: 0, state: 2 }, { probability: 0.5, state: 4 },
  ], 1);
  const region = { recordingId: "test", startMs: 120, endMs: 140 };
  const report = evaluateRecognitionRecording({ recordingId: "test", trace,
    references: [ref(22), ref(118), ref(182), ref(246)],
    protocol: { ...protocol, scoringIntervals: [{ recordingId: "test", startMs: 40, endMs: 1000 }],
      excludedIntervals: [region, { ...region, startMs: 130, endMs: 150 }] } });
  assert.equal(report.excludedDurationMs, 30);
  assert.equal(report.excludedReferenceCount, 1);
  for (const comparison of report.comparisons) {
    assert.deepEqual(comparison.predictions, [pred(192)]);
    assert.equal(comparison.excludedPredictionCount, 1);
    assert.deepEqual(comparison.windows.map((window) => window.windowMs), [50, 100]);
    assert.equal(comparison.windows[0]!.f1, 1);
  }
});

test("fixed onset lag corrects estimates while retaining the full causal delay", async () => {
  const trace = await syntheticTrace([
    ...Array.from({ length: 5 }, () => ({ probability: 0, state: 0 })),
    { probability: 0.5, state: 3 },
  ]);
  const events = readTraceAttacks(trace, "shipped", undefined, 160);
  assert.deepEqual(events, [pred(32, 60, 192)]);
  const metrics = matchAttacks([ref(32)], events);
  assert.equal(metrics.meanTimingErrorMs, 0);
  assert.equal(metrics.meanDetectionDelayMs, 160);
  assert.equal(diagnoseRawAttacks(trace, [ref(32)], 0, undefined, 160)[0]!.attackPeak!.timeMs, 192);
});

test("gold repetition uses performed adjacency before interval and exclusion filtering", async () => {
  const trace = await syntheticTrace(Array.from({ length: 20 }, () => ({ probability: 0, state: 0 })));
  const goldMoments = [
    { onsetMs: 100, pitches: [60, 64] },
    { onsetMs: 300, pitches: [62, 65] },
    { onsetMs: 500, pitches: [60, 64] },
  ];
  const references = goldMoments.flatMap((moment) => moment.pitches.map((midi) => ref(moment.onsetMs, midi)));
  const evaluate = (excludedIntervals: EvaluationProtocol["excludedIntervals"], startMs = 0) =>
    evaluateRecognitionRecording({
      recordingId: "test", trace, references, goldMoments, readouts: [],
      protocol: {
        ...protocol,
        timing: { ...protocol.timing, alignmentOffsetMs: 0 },
        scoringIntervals: [{ recordingId: "test", startMs, endMs: 600 }],
        excludedIntervals,
      },
    }).comparisons[0]!.windows[0]!.goldChords!;
  const unfiltered = evaluate([]);
  const excluded = evaluate([{ recordingId: "test", startMs: 290, endMs: 310 }]);
  assert.deepEqual(excluded.map((moment) => moment.onsetMs), [100, 500]);
  assert.equal(excluded[1]!.repeatedChord, false);
  assert.equal(excluded[1]!.repeatedChord, unfiltered[2]!.repeatedChord);

  // A real repeat stays a repeat even when its predecessor is outside the interval.
  goldMoments[2]!.pitches = [62, 65];
  const trimmed = evaluate([], 400);
  assert.equal(trimmed[0]!.repeatedChord, true);
});

test("suppressed held states are unavailable in frame and detailed attack inspection", async () => {
  const trace = await syntheticTrace([
    { probability: 0.5, state: 4 },
    { probability: 0, state: 4, active: false },
  ]);
  assert.equal(inspectScoreFrame(trace, 0).pitches[39]!.selectedState, 4);
  assert.equal(trace.states[88 + 39], 4);
  const suppressed = inspectScoreFrame(trace, 1).pitches[39]!;
  assert.equal(suppressed.selectedState, null);
  assert.equal(suppressed.unweighted, null);
  const details = diagnoseRawAttacks(trace, [ref(64)], 0, undefined, 0, true);
  assert.equal(details[0]!.frames![0]!.evidence!.selectedState, null);
});

test("raw frame details are opt-in and preserve the same compact summaries", async () => {
  const trace = await syntheticTrace([
    { probability: 0.5, state: 3 },
    { probability: 0, state: 0, active: false },
  ]);
  const options = { recordingId: "test", trace, references: [ref(22)], protocol };
  const compact = evaluateRecognitionRecording(options);
  const detailed = evaluateRecognitionRecording({ ...options, includeRawFrames: true });
  assert.equal(Object.hasOwn(compact.rawDiagnostics[0]!, "frames"), false);
  const { frames, ...summary } = detailed.rawDiagnostics[0]!;
  assert.equal(frames!.length, 2);
  assert.deepEqual(summary, compact.rawDiagnostics[0]);
  assert.ok(JSON.stringify(detailed.rawDiagnostics).length > JSON.stringify(compact.rawDiagnostics).length * 3);
});

test("interval and exclusion counts partition both event sets at half-open boundaries", async () => {
  const trace = await syntheticTrace(Array.from({ length: 10 }, (_, index) => ({
    probability: index % 2 === 0 ? 0.5 : 0,
    state: index % 2 === 0 ? 3 : 2,
  })));
  const references = [32, 96, 160, 224, 288].map((time) => ref(time));
  const report = evaluateRecognitionRecording({
    recordingId: "test", trace, references, readouts: [],
    protocol: {
      ...protocol,
      timing: { ...protocol.timing, alignmentOffsetMs: 0 },
      scoringIntervals: [{ recordingId: "test", startMs: 96, endMs: 288 }],
      excludedIntervals: [{ recordingId: "test", startMs: 160, endMs: 224 }],
    },
  });
  const comparison = report.comparisons[0]!;
  assert.deepEqual(report.references.map((event) => event.onsetMs), [96, 224]);
  assert.deepEqual(comparison.predictions.map((event) => event.onsetMs), [96, 224]);
  assert.equal(report.outsideIntervalReferenceCount, 2);
  assert.equal(comparison.outsideIntervalPredictionCount, 2);
  assert.equal(report.excludedReferenceCount, 1);
  assert.equal(comparison.excludedPredictionCount, 1);
  assert.equal(report.references.length + report.outsideIntervalReferenceCount + report.excludedReferenceCount, 5);
  assert.equal(comparison.predictions.length + comparison.outsideIntervalPredictionCount + comparison.excludedPredictionCount, 5);
});

test("metric and event guards reject incompatible windows and malformed attacks", () => {
  assert.throws(() => meanRecordingMetrics([matchAttacks([], [], 50), matchAttacks([], [], 100)]), /different timing windows/);
  for (const midi of [-1, 128, 60.5, NaN]) {
    assert.throws(() => matchAttacks([ref(0, midi)], []), /MIDI/);
    assert.throws(() => matchAttacks([], [pred(0, midi)]), /MIDI/);
  }
  assert.throws(() => matchAttacks([ref(Infinity)], []), /finite onset/);
});

test("trace inspection rejects malformed shapes, weights, frame indices and onset lags", async () => {
  const trace = await syntheticTrace([{ probability: 0, state: 0 }]);
  for (const change of [
    { pitchCount: 87 }, { stateCount: 4 }, { sampleRateHz: 8000 }, { chunkSize: 256 },
    { scores: new Float32Array(439) }, { states: new Uint8Array(87) },
    { signalActive: new Uint8Array(0) },
  ]) {
    assert.throws(() => inspectScoreFrame({ ...trace, ...change }, 0), /capture trace/);
  }
  for (const weight of [0, -1, NaN, Infinity]) {
    assert.throws(() => inspectScoreFrame(trace, 0, [1, 1, 1, weight, 2]), /weights/);
  }
  assert.throws(() => inspectScoreFrame(trace, 0, [] as unknown as [number, number, number, number, number]), /weights/);
  for (const frame of [-1, 1, 0.5, NaN]) {
    assert.throws(() => inspectScoreFrame(trace, frame), /Frame index/);
  }
  assert.throws(() => readTraceAttacks(trace, "shipped", undefined, -1), /onsetEstimateLagMs/);
  assert.throws(() => diagnoseRawAttacks(trace, [], 100, undefined, -1), /onsetEstimateLagMs/);
});

test("gold moment guards reject non-increasing times and duplicate or empty pitches", () => {
  const metrics = matchAttacks([], []);
  for (const time of [100, 99]) {
    assert.throws(() => goldChordDiagnostics([], metrics, [
      { onsetMs: 100, pitches: [60] }, { onsetMs: time, pitches: [64] },
    ]), /strictly increasing/);
  }
  for (const pitches of [[60, 60], []]) {
    assert.throws(() => goldChordDiagnostics([], metrics, [{ onsetMs: 100, pitches }]), /distinct pitches/);
  }
});
