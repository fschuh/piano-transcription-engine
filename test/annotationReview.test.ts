import assert from "node:assert/strict";
import test from "node:test";
import { applyAnnotationCorrections, createAnnotationReviewQueue, captureOnlineAmtTrace,
  evaluateRecognitionRecording, goldChordDiagnostics, matchAttacks, type EvaluationProtocol } from "../src/eval/index.js";

test("reviewed corrections address original MIDI indices and reject stale/unverified edits", () => {
  const original = [{ midi: 60, onsetMs: 100 }, { midi: 62, onsetMs: 200 }, { midi: 64, onsetMs: 300 }];
  const review = { verifiedBy: "Test listener", reason: "Original synthetic audio checked" };
  const edits = [
    { ...review, referenceIndex: 0, original: original[0]!, replacement: null },
    { ...review, referenceIndex: 2, original: original[2]!, replacement: { midi: 65, onsetMs: 310 } },
    { ...review, replacement: { midi: 61, onsetMs: 150 } },
  ];
  const changed = applyAnnotationCorrections(original, edits);
  assert.deepEqual(changed.map(({ midi, onsetMs }) => ({ midi, onsetMs })),
    [{ midi: 61, onsetMs: 150 }, original[1], { midi: 65, onsetMs: 310 }]);
  assert.deepEqual(changed.map((a) => a.annotationSource.referenceIndex), [null, 1, 2]);
  assert.deepEqual(changed.map((a) => a.annotationSource.correctionIndex), [2, null, 1]);
  assert.equal(original.length, 3);
  assert.throws(() => applyAnnotationCorrections(original, [{ ...edits[0]!, verifiedBy: "" }]));
  assert.throws(() => applyAnnotationCorrections(original, [edits[0]!, edits[0]!]));
  assert.throws(() => applyAnnotationCorrections(changed, [edits[0]!]));
  assert.throws(() => applyAnnotationCorrections(original, [{ ...review, replacement: { midi: 128, onsetMs: 0 } }]));
  // All configurations are rescored against one revised reference, without redoing inference.
  for (const delay of [150, 170]) {
    const predictions = changed.map((a) => ({ ...a, availableAtMs: a.onsetMs + delay }));
    assert.equal(matchAttacks(changed, predictions).f1, 1);
    assert.notEqual(matchAttacks(original, predictions).f1, 1);
  }
});

test("rolled gold chords retain performed per-pitch onsets", () => {
  const references = [{ midi: 60, onsetMs: 100 }, { midi: 64, onsetMs: 120 }];
  const metrics = matchAttacks(references, references.map((a) => ({ ...a, availableAtMs: 300 })));
  assert.equal(goldChordDiagnostics(references, metrics, [{ onsetMs: 100, pitches: [60,64], pitchOnsetsMs: [100,120] }])[0]!.complete, true);
  assert.throws(() => goldChordDiagnostics(references, metrics, [{ onsetMs: 100, pitches: [60,64], pitchOnsetsMs: [100] }]));
});

test("review queue retains neutral classifications, shared misses, replay and suppressed evidence", async () => {
  const trace = await captureOnlineAmtTrace({ reset() {}, async run() {
    return { scores: new Float32Array(440), states: new Uint8Array(88), signalActive: false, inferenceTimeMs: 1 };
  } }, new Float32Array(16000), { tailFlushSamples: 0 });
  const protocol: EvaluationProtocol = {
    id: "test", round: "3", adoptedOn: "2026-09-08", goldRecordings: ["gold"], split: { development: ["test"], confirmation: ["held"] },
    timing: { primaryOnsetWindowMs: 50, supplementalOnsetWindowMs: 100, alignmentOffsetMs: 0, recordingAlignmentOffsetMs: {} },
    scoringIntervals: [], excludedIntervals: [], noiseIntervals: [], baseline: { inputGainDb: 0, tailFlushSamples: 0 },
    experimentBudget: { hypothesisCycles: 6, minConfigurationsPerCycle: 3, maxConfigurationsPerCycle: 5, consecutiveUnproductiveCycles: 3 },
  };
  const report = evaluateRecognitionRecording({ recordingId: "test", trace, references: [{ midi: 60, onsetMs: 300 }], protocol });
  const queue = createAnnotationReviewQueue(report, trace);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.sharedConfigurationCount, 4);
  assert.equal(queue[0]!.reference!.pitchName, "C4");
  assert.equal(queue[0]!.status, "unresolved");
  assert.equal(queue[0]!.evidence.attackPeak, null);
  assert.equal(queue[0]!.replay.startMs, 0);
  assert.equal(queue[0]!.replay.endMs, 1000);
  assert.equal(queue[0]!.evidence.frames![0]!.evidence!.unweighted, null);
});

test("gold pitch onset alignment shifts once and corrections reach every readout", async () => {
  const trace = await captureOnlineAmtTrace({ reset() {}, async run() {
    const scores = new Float32Array(440), states = new Uint8Array(88);
    scores[39 * 5 + 3] = 1.8;
    states[39] = 3;
    return { scores, states, signalActive: true, inferenceTimeMs: 1 };
  } }, new Float32Array(512), { tailFlushSamples: 0 });
  const protocol: EvaluationProtocol = {
    id: "test", round: "3", adoptedOn: "2026-09-08", goldRecordings: ["gold"], split: { development: ["test"], confirmation: ["held"] },
    timing: { primaryOnsetWindowMs: 1, supplementalOnsetWindowMs: 2, alignmentOffsetMs: 12, recordingAlignmentOffsetMs: {} },
    scoringIntervals: [{ recordingId: "gold", startMs: 0, endMs: 100 }], excludedIntervals: [], noiseIntervals: [], baseline: { inputGainDb: 0, tailFlushSamples: 0 },
    experimentBudget: { hypothesisCycles: 6, minConfigurationsPerCycle: 3, maxConfigurationsPerCycle: 5, consecutiveUnproductiveCycles: 3 },
  };
  // The input duration is 32 ms; use an onset estimate inside its half-open interval.
  const references = applyAnnotationCorrections([{ midi: 61, onsetMs: 19 }], [{
    referenceIndex: 0, original: { midi: 61, onsetMs: 19 }, replacement: { midi: 60, onsetMs: 19 },
    verifiedBy: "Synthetic test", reason: "Known generated attack",
  }]);
  const report = evaluateRecognitionRecording({ recordingId: "gold", trace, references, protocol,
    onsetEstimateLagMs: 1, goldMoments: [{ onsetMs: 19, pitches: [60], pitchOnsetsMs: [19] }] });
  for (const c of report.comparisons) {
    assert.equal(c.windows[0]!.f1, 1);
    assert.equal(c.windows[0]!.goldChords![0]!.complete, true);
    assert.equal(c.windows[0]!.meanDetectionDelayMs, 1);
  }
  const missedReport = evaluateRecognitionRecording({
    recordingId: "gold", trace, protocol, onsetEstimateLagMs: 1,
    references: applyAnnotationCorrections([{ midi: 62, onsetMs: 19 }], []),
  });
  const missed = createAnnotationReviewQueue(missedReport, trace).find((q) => q.reference)!;
  assert.equal(missed.reference!.onsetMs, 31);
  assert.deepEqual(missed.annotationSource, {
    referenceIndex: 0, original: { midi: 62, onsetMs: 19 }, correctionIndex: null,
  });
  const falseReport = evaluateRecognitionRecording({ recordingId: "gold", trace, references: [], protocol, onsetEstimateLagMs: 1 });
  const queue = createAnnotationReviewQueue(falseReport, trace);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.prediction!.midi, 60);
  assert.equal(queue[0]!.reference, null);
  assert.equal(queue[0]!.sharedConfigurationCount, 4);
  assert.match(queue[0]!.classification, /possible missing annotation or hallucination/);
});

test("review neighborhoods classify both sides and order by shared count then actual time", async () => {
  const trace = await captureOnlineAmtTrace({ reset() {}, async run() {
    return { scores: new Float32Array(440), states: new Uint8Array(88),
      signalActive: false, inferenceTimeMs: 1 };
  } }, new Float32Array(64000), { tailFlushSamples: 0 });
  const references = [500, 100, 3000].map((onsetMs) => ({ midi: 60, onsetMs }));
  const predictions = [
    [[580, 60], [620, 61], [750, 62], [750.001, 63], [200, 64]],
    [[500, 60]],
  ].map((events) => events.map(([onsetMs, midi]) => ({
    onsetMs: onsetMs!, midi: midi!, availableAtMs: onsetMs! + 160,
  })));
  const report = {
    recordingId: "synthetic", references, alignmentOffsetMs: 0, onsetEstimateLagMs: 160,
    stateWeights: [1, 1, 1, 2, 2] as const,
    comparisons: predictions.map((events, i) => ({
      configuration: i === 0 ? "shipped" as const
        : { threshold: 0.3, releaseThreshold: 0.15, minimumSeparationMs: 64 },
      predictions: events,
      windows: [matchAttacks(references, events, 50)],
    })),
  };
  // Only fields consumed by review export are needed for this event-level fixture.
  const queue = createAnnotationReviewQueue(
    report as Parameters<typeof createAnnotationReviewQueue>[0], trace,
  );
  const refs = queue.filter((q) => q.reference);
  assert.deepEqual(refs.map((q) => [q.sharedConfigurationCount, q.eventTimeMs]),
    [[2, 100], [2, 3000], [1, 500]]);
  const late = refs[2]!;
  assert.match(late.timingConcern!, /same-pitch/);
  assert.match(late.pitchConcern!, /different-pitch/);
  assert.deepEqual(late.nearbyPredictions.map((a) => a.midi), [60, 61, 62, 60]);
  assert.deepEqual(late.nearbyReferences.map((a) => a.onsetMs), [500]);
  assert.equal(refs[0]!.timingConcern, null);
  assert.match(refs[0]!.pitchConcern!, /different-pitch/);
  const predicted = queue.find((q) => q.prediction?.onsetMs === 580)!;
  assert.match(predicted.timingConcern!, /same-pitch/);
  assert.equal(predicted.pitchConcern, null);
  assert.deepEqual(predicted.nearbyReferences.map((a) => a.onsetMs), [500]);
  const substitution = queue.find((q) => q.prediction?.midi === 61)!;
  assert.match(substitution.pitchConcern!, /different-pitch/);
  assert.equal(substitution.timingConcern, null);
  assert.equal(predicted.evidence.eventSource, "prediction");
  assert.equal(predicted.evidence.optimisticReferenceInformed, false);
  assert.equal(predicted.evidence.event.midi, 60);
  assert.equal("reference" in predicted.evidence, false);
  assert.equal(late.evidence.eventSource, "reference");
  assert.equal(late.evidence.optimisticReferenceInformed, true);
  // The first two single-readout events are inside the replay-start clamp;
  // sorting by replay.startMs would lose their actual chronological ordering.
  const singles = queue.filter((q) => q.sharedConfigurationCount === 1);
  assert.deepEqual(singles.map((q) => q.eventTimeMs), [200, 500, 580, 620, 750, 750.001]);
});

test("correction provenance preserves original MIDI metadata and survives alignment", async () => {
  const original = [{ midi: 60, onsetMs: 200, channel: 1, velocity: 80,
    offsetMs: 900, unterminated: false }];
  const corrected = applyAnnotationCorrections(original, [{ referenceIndex: 0,
    original: { midi: 60, onsetMs: 200 }, replacement: { midi: 62, onsetMs: 250 },
    verifiedBy: "Listener", reason: "Synthetic fixture" }]);
  assert.deepEqual(corrected[0]!.annotationSource.original, original[0]);
  assert.deepEqual(Object.keys(corrected[0]!).sort(), ["annotationSource", "midi", "onsetMs"]);
  // Alignment affects only the evaluated attack, never the correction guard/source.
  const aligned = { ...corrected[0]!, onsetMs: corrected[0]!.onsetMs + 34 };
  assert.deepEqual(aligned.annotationSource, {
    referenceIndex: 0, original: original[0], correctionIndex: 0,
  });
  assert.equal(aligned.onsetMs, 284);
});

test("reviewed additions reject duplicate identities before scoring", () => {
  const original = [{ midi: 60, onsetMs: 300 }];
  const verified = { verifiedBy: "Listener", reason: "Synthetic attack review" };
  const add = (midi: number, onsetMs: number) => ({ ...verified, replacement: { midi, onsetMs } });
  assert.throws(() => applyAnnotationCorrections(original, [add(60, 300)]), /Duplicate reference attack identity:/);
  assert.throws(() => applyAnnotationCorrections(original, [add(62, 400), add(62, 400)]),
    /Duplicate reference attack identity:/);
  const replace = { ...verified, referenceIndex: 0, original: original[0]!,
    replacement: { midi: 62, onsetMs: 400 } };
  for (const edits of [[replace, add(62, 400)], [add(62, 400), replace]]) {
    assert.throws(() => applyAnnotationCorrections(original, edits), /Duplicate reference attack identity:/);
  }
  // Distinct repeated attacks and simultaneous different pitches remain valid.
  assert.deepEqual(applyAnnotationCorrections(original, [add(60, 301), add(62, 300)])
    .map(({ midi, onsetMs }) => ({ midi, onsetMs })),
  [{ midi: 60, onsetMs: 300 }, { midi: 62, onsetMs: 300 }, { midi: 60, onsetMs: 301 }]);
});

test("final reference validation catches replacement collisions and allows freed identities", () => {
  const original = [{ midi: 60, onsetMs: 100 }, { midi: 62, onsetMs: 200 }];
  const verified = { verifiedBy: "Listener", reason: "Synthetic correction review" };
  const replace = (referenceIndex: number, replacement: { midi: number; onsetMs: number } | null) => ({
    ...verified, referenceIndex, original: original[referenceIndex]!, replacement,
  });
  assert.throws(() => applyAnnotationCorrections(original, [replace(1, original[0]!)]),
    /Duplicate reference attack identity: 60:100\./);
  const destination = { midi: 64, onsetMs: 500 };
  for (const edits of [
    [replace(0, destination), replace(1, destination)],
    [replace(1, destination), replace(0, destination)],
  ]) {
    assert.throws(() => applyAnnotationCorrections(original, edits),
      /Duplicate reference attack identity: 64:500\./);
  }
  const addition = { ...verified, replacement: original[0]! };
  for (const change of [replace(0, null), replace(0, destination)]) {
    for (const edits of [[change, addition], [addition, change]]) {
      const result = applyAnnotationCorrections(original, edits);
      assert.deepEqual(result.map(({ midi, onsetMs }) => ({ midi, onsetMs })),
        change.replacement === null ? original : [...original, destination]);
      const reused = result.find((a) => a.midi === 60 && a.onsetMs === 100)!;
      assert.deepEqual(reused.annotationSource, {
        referenceIndex: null, original: null, correctionIndex: edits.indexOf(addition),
      });
    }
  }
  // Simultaneous moves can swap identities without producing a duplicate final state.
  assert.deepEqual(applyAnnotationCorrections(original,
    [replace(0, original[1]!), replace(1, original[0]!)])
    .map((a) => a.annotationSource.referenceIndex), [1, 0]);
  assert.throws(() => applyAnnotationCorrections([original[0]!, original[0]!], []),
    /Duplicate reference attack identity: 60:100\./);
});
