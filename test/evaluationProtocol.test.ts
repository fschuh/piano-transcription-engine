import assert from "node:assert/strict";
import test from "node:test";

import {
  alignmentOffsetMsFor,
  evaluationRecordingRoleOf,
  parseEvaluationProtocol,
  protocolRecordingIds,
  scoringIntervalFor,
} from "../src/eval/index.js";

/** A minimal well-formed document; each test changes one thing about it. */
function document(): Record<string, unknown> {
  return {
    id: "round-three-baseline",
    round: "3",
    adoptedOn: "2026-09-08",
    goldRecordings: ["gold/setup/take-1", "gold/setup/take-2"],
    split: {
      development: ["silver/one", "silver/two"],
      confirmation: ["silver/three"],
    },
    timing: {
      primaryOnsetWindowMs: 50,
      supplementalOnsetWindowMs: 100,
      alignmentOffsetMs: 0,
      recordingAlignmentOffsetMs: { "silver/two": 12 },
    },
    scoringIntervals: [{ recordingId: "silver/one", startMs: 1_000, endMs: 60_000 }],
    excludedIntervals: [],
    noiseIntervals: [
      { recordingId: "gold/setup/take-1", startMs: 0, endMs: 800, attackGuardMs: 120 },
    ],
    baseline: { inputGainDb: 0, tailFlushSamples: 2_048 },
    experimentBudget: {
      hypothesisCycles: 6,
      minConfigurationsPerCycle: 3,
      maxConfigurationsPerCycle: 5,
      consecutiveUnproductiveCycles: 3,
    },
  };
}

function rejects(change: (value: Record<string, unknown>) => void, expected: RegExp): void {
  const value = document();
  change(value);
  assert.throws(() => parseEvaluationProtocol(value, "protocol.json"), expected);
}

test("parses a complete protocol and reports how each recording is used", () => {
  const protocol = parseEvaluationProtocol(document(), "protocol.json");
  assert.deepEqual(protocolRecordingIds(protocol), [
    "gold/setup/take-1",
    "gold/setup/take-2",
    "silver/one",
    "silver/two",
    "silver/three",
  ]);
  assert.equal(evaluationRecordingRoleOf(protocol, "gold/setup/take-2"), "gold");
  assert.equal(evaluationRecordingRoleOf(protocol, "silver/one"), "development");
  assert.equal(evaluationRecordingRoleOf(protocol, "silver/three"), "confirmation");
  assert.equal(evaluationRecordingRoleOf(protocol, "silver/absent"), null);

  assert.equal(alignmentOffsetMsFor(protocol, "silver/two"), 12);
  assert.equal(alignmentOffsetMsFor(protocol, "silver/one"), 0);

  // A recording without a configured interval is scored whole; a configured one
  // never claims more audio than the recording holds.
  assert.deepEqual(scoringIntervalFor(protocol, "silver/two", 40_000), { startMs: 0, endMs: 40_000 });
  assert.deepEqual(
    scoringIntervalFor(protocol, "silver/one", 45_000),
    { startMs: 1_000, endMs: 45_000 },
  );
  assert.deepEqual(
    scoringIntervalFor(protocol, "silver/one", 90_000),
    { startMs: 1_000, endMs: 60_000 },
  );
});

test("an omitted interval list is an empty one, not a missing document", () => {
  const value = document();
  delete value.scoringIntervals;
  delete value.excludedIntervals;
  delete value.noiseIntervals;
  delete (value.timing as Record<string, unknown>).recordingAlignmentOffsetMs;
  const protocol = parseEvaluationProtocol(value, "protocol.json");
  assert.deepEqual(protocol.scoringIntervals, []);
  assert.deepEqual(protocol.excludedIntervals, []);
  assert.deepEqual(protocol.noiseIntervals, []);
  assert.equal(alignmentOffsetMsFor(protocol, "silver/two"), 0);
});

test("refuses a split that puts one recording on both sides or names it twice", () => {
  rejects(
    (value) => {
      (value.split as { confirmation: string[] }).confirmation = ["silver/one"];
    },
    /split\.confirmation repeats silver\/one/,
  );
  rejects(
    (value) => {
      (value.split as { development: string[] }).development = ["silver/one", "silver/one"];
    },
    /split\.development names silver\/one twice/,
  );
  rejects(
    (value) => {
      (value.split as { confirmation: string[] }).confirmation = ["gold/setup/take-1"];
    },
    /split\.confirmation repeats gold\/setup\/take-1/,
  );
  rejects(
    (value) => {
      (value.split as { confirmation: string[] }).confirmation = [];
    },
    /split\.confirmation names no recording/,
  );
});

test("refuses timing rules that cannot be applied as written", () => {
  rejects(
    (value) => {
      (value.timing as Record<string, unknown>).supplementalOnsetWindowMs = 25;
    },
    /narrower than the primary window/,
  );
  rejects(
    (value) => {
      (value.timing as Record<string, unknown>).primaryOnsetWindowMs = 0;
    },
    /primaryOnsetWindowMs must be greater than zero/,
  );
  rejects(
    (value) => {
      (value.timing as Record<string, unknown>).recordingAlignmentOffsetMs = { "silver/absent": 5 };
    },
    /names silver\/absent, which the protocol does not assign/,
  );
});

test("refuses an interval that names an unassigned recording or measures nothing", () => {
  rejects(
    (value) => {
      value.scoringIntervals = [{ recordingId: "silver/absent", startMs: 0, endMs: 10 }];
    },
    /scoringIntervals names silver\/absent/,
  );
  rejects(
    (value) => {
      value.scoringIntervals = [{ recordingId: "silver/one", startMs: 500, endMs: 500 }];
    },
    /ends at 500 ms, which is not after its 500 ms start/,
  );
  rejects(
    (value) => {
      value.scoringIntervals = [
        { recordingId: "silver/one", startMs: 0, endMs: 10 },
        { recordingId: "silver/one", startMs: 20, endMs: 30 },
      ];
    },
    /gives silver\/one more than one interval/,
  );
  rejects(
    (value) => {
      value.noiseIntervals = [
        { recordingId: "silver/one", startMs: 0, endMs: 100, attackGuardMs: 120 },
      ];
    },
    /leaves nothing to measure once its 120 ms attack guard is trimmed/,
  );
});

test("refuses a baseline the capture runner could not frame or apply", () => {
  rejects(
    (value) => {
      (value.baseline as Record<string, unknown>).tailFlushSamples = 700;
    },
    /must be a multiple of 512/,
  );
  rejects(
    (value) => {
      (value.baseline as Record<string, unknown>).tailFlushSamples = -512;
    },
    /must be a non-negative whole number/,
  );
  rejects(
    (value) => {
      (value.baseline as Record<string, unknown>).inputGainDb = "loud";
    },
    /baseline\.inputGainDb must be a finite number/,
  );
});

test("refuses an experiment budget that contradicts itself", () => {
  rejects(
    (value) => {
      (value.experimentBudget as Record<string, unknown>).maxConfigurationsPerCycle = 2;
    },
    /is below its minimum \(3\)/,
  );
  rejects(
    (value) => {
      (value.experimentBudget as Record<string, unknown>).hypothesisCycles = 0;
    },
    /hypothesisCycles must be a positive whole number/,
  );
});

test("names the document it refused", () => {
  assert.throws(
    () => parseEvaluationProtocol([], "private/round-three.json"),
    /^Error: private\/round-three\.json: the protocol must be an object\.$/,
  );
  assert.throws(() => parseEvaluationProtocol(null), /^Error: protocol: the protocol must be an object\.$/);
});
