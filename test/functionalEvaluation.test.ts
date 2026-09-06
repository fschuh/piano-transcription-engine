import assert from "node:assert/strict";
import test from "node:test";
import { LISTEN_MULTIDOMAIN_CANDIDATE_PROFILE_IDS } from "../src/index.js";

import {
  compareFunctionalMatcherConfigurations,
  DELIBERATELY_WORSE_DUPLICATE_ADVANCE_CONFIGURATION,
  DELIBERATELY_WORSE_FALSE_ADVANCE_CONFIGURATION,
  DELIBERATELY_WORSE_OMITTED_BASS_CONFIGURATION,
  DELIBERATELY_WORSE_SKIPPED_ADVANCE_CONFIGURATION,
  evaluateFunctionalFixture,
  evaluateFunctionalSuite,
  functionalClassificationCounts,
  PUBLIC_FUNCTIONAL_EVALUATION_FIXTURES,
  type FunctionalEvaluationFixture,
  type FunctionalEvaluationKind,
} from "../src/eval/index.js";

function fixture(id: string) {
  const found = PUBLIC_FUNCTIONAL_EVALUATION_FIXTURES.find((value) => value.id === id);
  assert.ok(found, `missing fixture ${id}`);
  return found;
}

/** One attack plus one settling frame, used to build focused boundary cases. */
function singleAttackFixture(
  maxAdvanceLatencyMs: number,
  advanceAtMs = 132,
): FunctionalEvaluationFixture {
  return {
    id: "boundary-single-attack",
    kind: "isolated",
    description: "One isolated attack with an explicit latency ceiling.",
    targets: [{
      id: "boundary-target",
      pitches: [69],
      attackAtMs: 100,
      maxAdvanceLatencyMs,
    }],
    frames: [
      {
        capturedAtMs: 100,
        processingTimeMs: 1,
        onsets: [{ midi: 69, confidence: 0.8, noteConfidence: 0.8, onsetTimeMs: 100 }],
        recognizedActivePitches: [{ midi: 69, confidence: 0.8 }],
        targetPitchEvidence: [{ midi: 69, confidence: 0.8 }],
        noteEvents: [{ midi: 69, type: "onset", confidence: 0.9, eventTimeMs: 100 }],
        physicalEventId: "boundary-attack",
        playedTargetId: "boundary-target",
      },
      {
        capturedAtMs: advanceAtMs,
        processingTimeMs: 1,
        onsets: [],
        recognizedActivePitches: [{ midi: 69, confidence: 0.8 }],
        targetPitchEvidence: [{ midi: 69, confidence: 0.8 }],
        noteEvents: [],
        physicalEventId: "boundary-attack",
        playedTargetId: "boundary-target",
      },
    ],
  };
}

test("public fixtures cover every active functional behavior", () => {
  const expectedKinds: readonly FunctionalEvaluationKind[] = [
    "isolated",
    "continuous-sequence",
    "dynamics",
    "repeated-chord",
    "omitted-bass",
    "false-advance",
    "skipped-advance",
    "duplicate-advance",
  ];
  assert.deepEqual(
    new Set(PUBLIC_FUNCTIONAL_EVALUATION_FIXTURES.map((value) => value.kind)),
    new Set(expectedKinds),
  );
});

test("baseline-v1 passes the public functional suite with bounded latency", () => {
  const result = evaluateFunctionalSuite(PUBLIC_FUNCTIONAL_EVALUATION_FIXTURES);
  assert.equal(
    result.passed,
    true,
    JSON.stringify(result.cases.filter((value) => !value.passed), null, 2),
  );
  assert.deepEqual(result.totals, {
    caseCount: 9,
    passedCaseCount: 9,
    failedCaseCount: 0,
    advanceCount: 12,
    falseAdvanceCount: 0,
    skippedAdvanceCount: 0,
    duplicateAdvanceCount: 0,
    lateAdvanceCount: 0,
    processingTimeMs: 37,
    maxAdvanceLatencyMs: 32,
  });
});

test("a spurious bass onset explains baseline safety versus the frozen candidates", () => {
  const definition = fixture("spurious-bass-onset-safety");
  assert.equal(evaluateFunctionalFixture(definition, "baseline-v1").passed, true);
  assert.equal(LISTEN_MULTIDOMAIN_CANDIDATE_PROFILE_IDS.length, 4);
  for (const profile of LISTEN_MULTIDOMAIN_CANDIDATE_PROFILE_IDS) {
    const result = evaluateFunctionalFixture(definition, profile);
    assert.equal(result.passed, false, profile);
    assert.equal(result.falseAdvanceCount, 1, profile);
  }
});

test("every expected score moment advances exactly once under baseline-v1", () => {
  for (const definition of PUBLIC_FUNCTIONAL_EVALUATION_FIXTURES) {
    const result = evaluateFunctionalFixture(definition);
    assert.deepEqual(
      result.advancedTargetIds,
      result.expectedAdvanceTargetIds,
      definition.id,
    );
    assert.deepEqual(functionalClassificationCounts(result), {
      "false-advance": 0,
      "skipped-advance": 0,
      "duplicate-advance": 0,
      "late-advance": 0,
    }, definition.id);
  }
});

test("the third repeat of a chord still needs its own fresh attack", () => {
  const repeated = fixture("repeated-chord-requires-reattack");
  assert.deepEqual(repeated.targets.map((target) => target.pitches), [
    [55, 60, 64],
    [55, 60, 64],
    [55, 60, 64],
  ]);

  // The same trace with the third re-attack removed: the chord keeps sounding,
  // but nothing re-attacks it. Carry-over evidence must not advance the third
  // moment, and the two earlier advances must survive unchanged.
  const withoutThirdAttack = {
    ...repeated,
    frames: repeated.frames.map((frame) => (
      frame.capturedAtMs < 340 ? frame : { ...frame, onsets: [], noteEvents: [] }
    )),
  };
  const result = evaluateFunctionalFixture(withoutThirdAttack);
  assert.deepEqual(result.advancedTargetIds, [
    "repeated-chord-first",
    "repeated-chord-second",
  ]);
  assert.equal(result.skippedAdvanceCount, 1);
  assert.equal(result.falseAdvanceCount, 0);
  assert.equal(result.duplicateAdvanceCount, 0);
  assert.equal(result.passed, false);
});

test("unsafe omitted-bass mutation creates a false advance regression", () => {
  const comparison = compareFunctionalMatcherConfigurations(
    [fixture("omitted-bass-safety")],
    DELIBERATELY_WORSE_OMITTED_BASS_CONFIGURATION,
  );
  assert.equal(comparison.baseline.passed, true);
  assert.equal(comparison.candidate.passed, false);
  assert.deepEqual(comparison.regressionCaseIds, ["omitted-bass-safety"]);
  assert.deepEqual(comparison.regressions[0]?.classifications, [
    "false-advance",
    "advance-order",
  ]);
  assert.equal(comparison.regressions[0]?.candidateCounts["false-advance"], 1);
  assert.equal(comparison.candidate.totals.falseAdvanceCount, 1);
});

test("over-strict onset mutation exposes a skipped advance", () => {
  const result = evaluateFunctionalFixture(
    fixture("clear-attack-does-not-skip"),
    DELIBERATELY_WORSE_SKIPPED_ADVANCE_CONFIGURATION,
  );
  assert.equal(result.passed, false);
  assert.equal(result.skippedAdvanceCount, 1);
  const comparison = compareFunctionalMatcherConfigurations(
    [fixture("clear-attack-does-not-skip")],
    DELIBERATELY_WORSE_SKIPPED_ADVANCE_CONFIGURATION,
  );
  assert.deepEqual(comparison.regressions[0]?.classifications, [
    "skipped-advance",
    "advance-order",
  ]);
});

test("permissive extra-note mutation exposes a false advance", () => {
  const result = evaluateFunctionalFixture(
    fixture("confident-extra-note-safety"),
    DELIBERATELY_WORSE_FALSE_ADVANCE_CONFIGURATION,
  );
  assert.equal(result.passed, false);
  assert.equal(result.falseAdvanceCount, 1);
});

test("time-only refractory mutation exposes a duplicate advance", () => {
  const result = evaluateFunctionalFixture(
    fixture("duplicate-onset-tail-safety"),
    DELIBERATELY_WORSE_DUPLICATE_ADVANCE_CONFIGURATION,
  );
  assert.equal(result.passed, false);
  assert.equal(result.duplicateAdvanceCount, 1);
  assert.equal(result.falseAdvanceCount, 1);
  const comparison = compareFunctionalMatcherConfigurations(
    [fixture("duplicate-onset-tail-safety")],
    DELIBERATELY_WORSE_DUPLICATE_ADVANCE_CONFIGURATION,
  );
  assert.deepEqual(comparison.regressions[0]?.classifications, [
    "false-advance",
    "duplicate-advance",
  ]);
});

test("an unchanged candidate configuration reports no regression", () => {
  const comparison = compareFunctionalMatcherConfigurations(
    PUBLIC_FUNCTIONAL_EVALUATION_FIXTURES,
    "baseline-v1",
  );
  assert.deepEqual(comparison.regressions, []);
  assert.deepEqual(comparison.regressionCaseIds, []);
});

test("a case that only trades one unsafe classification for another still regresses", () => {
  // The baseline already fails this deliberately unreachable latency ceiling, so
  // a per-case pass/fail comparison would report no regression at all.
  const alreadyLate = singleAttackFixture(0);
  const baseline = evaluateFunctionalFixture(alreadyLate);
  assert.equal(baseline.passed, false);
  assert.equal(baseline.lateAdvanceCount, 1);
  assert.equal(baseline.skippedAdvanceCount, 0);

  const comparison = compareFunctionalMatcherConfigurations(
    [alreadyLate],
    DELIBERATELY_WORSE_SKIPPED_ADVANCE_CONFIGURATION,
  );
  assert.deepEqual(comparison.regressionCaseIds, ["boundary-single-attack"]);
  assert.deepEqual(comparison.regressions[0]?.classifications, [
    "skipped-advance",
    "advance-order",
  ]);
  assert.deepEqual(comparison.regressions[0]?.baselineCounts, {
    "false-advance": 0,
    "skipped-advance": 0,
    "duplicate-advance": 0,
    "late-advance": 1,
  });
  assert.deepEqual(comparison.regressions[0]?.candidateCounts, {
    "false-advance": 0,
    "skipped-advance": 1,
    "duplicate-advance": 0,
    "late-advance": 0,
  });
});

test("the per-target latency ceiling is inclusive", () => {
  const atCeiling = evaluateFunctionalFixture(singleAttackFixture(32));
  assert.equal(atCeiling.maxAdvanceLatencyMs, 32);
  assert.equal(atCeiling.lateAdvanceCount, 0);
  assert.equal(atCeiling.passed, true);

  const overCeiling = evaluateFunctionalFixture(singleAttackFixture(31));
  assert.equal(overCeiling.lateAdvanceCount, 1);
  assert.equal(overCeiling.passed, false);
  assert.equal(overCeiling.advances[0]?.lateAdvance, true);
});

test("a fixture that cannot be replayed honestly is rejected instead of scored", () => {
  const base = singleAttackFixture(64);
  assert.throws(
    () => evaluateFunctionalFixture({ ...base, targets: [] }),
    /has no targets/,
  );
  assert.throws(
    () => evaluateFunctionalFixture({
      ...base,
      targets: [
        { id: "same", pitches: [60] },
        { id: "same", pitches: [62] },
      ],
    }),
    /repeats target id same/,
  );
  assert.throws(
    () => evaluateFunctionalFixture({
      ...base,
      targets: [{ id: "duplicated-pitch", pitches: [60, 60] }],
    }),
    /invalid target duplicated-pitch/,
  );
  assert.throws(
    () => evaluateFunctionalFixture({
      ...base,
      targets: [{ id: "fractional-pitch", pitches: [60.5] }],
    }),
    /invalid target fractional-pitch/,
  );
  assert.throws(
    () => evaluateFunctionalFixture({
      ...base,
      frames: [...base.frames].reverse(),
    }),
    /has unordered frames/,
  );
});
