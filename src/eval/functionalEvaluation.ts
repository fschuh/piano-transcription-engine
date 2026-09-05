import {
  ExactChordMatcher,
  matcherOptionsForListenMatcherProfile,
  type ChordMatcherOptions,
  type ListenMatcherProfileId,
  type RecognizerResult,
} from "../index.js";

/** Functional behavior represented by one public-safe recognition trace. */
export type FunctionalEvaluationKind =
  | "isolated"
  | "continuous-sequence"
  | "dynamics"
  | "repeated-chord"
  | "omitted-bass"
  | "false-advance"
  | "skipped-advance"
  | "duplicate-advance";

export interface FunctionalEvaluationTarget {
  /** Unique score-moment identifier within the fixture. */
  id: string;
  pitches: readonly number[];
  /** False for a safety target that the physical performance must not advance. */
  shouldAdvance?: boolean;
  /** Capture-clock time of the intended physical attack, used for latency. */
  attackAtMs?: number;
  /** Inclusive latency ceiling for this score moment. */
  maxAdvanceLatencyMs?: number;
}

/**
 * A recognizer result with replay-only attribution metadata. Generation is
 * supplied by the replayer so a fixture cannot accidentally encode navigation
 * state.
 */
export type FunctionalRecognitionFrame = Omit<RecognizerResult, "generation"> & {
  /** Identifies one physical attack across its attack and settling frames. */
  physicalEventId?: string;
  /** The score moment actually played, or null for a deliberately wrong event. */
  playedTargetId?: string | null;
};

export interface FunctionalEvaluationFixture {
  id: string;
  kind: FunctionalEvaluationKind;
  description: string;
  targets: readonly FunctionalEvaluationTarget[];
  frames: readonly FunctionalRecognitionFrame[];
  startedAtMs?: number;
}

/** A named production profile or a mutation of baseline-v1 for experiments. */
export type FunctionalMatcherConfiguration =
  | ListenMatcherProfileId
  | Readonly<Partial<ChordMatcherOptions>>;

export interface FunctionalAdvance {
  targetId: string;
  targetIndex: number;
  capturedAtMs: number;
  physicalEventId?: string;
  playedTargetId?: string | null;
  latencyMs?: number;
  falseAdvance: boolean;
  duplicateAdvance: boolean;
  lateAdvance: boolean;
}

export interface FunctionalEvaluationResult {
  fixtureId: string;
  kind: FunctionalEvaluationKind;
  passed: boolean;
  expectedAdvanceTargetIds: string[];
  advancedTargetIds: string[];
  advances: FunctionalAdvance[];
  falseAdvanceCount: number;
  skippedAdvanceCount: number;
  duplicateAdvanceCount: number;
  lateAdvanceCount: number;
  processingTimeMs: number;
  maxAdvanceLatencyMs: number | null;
}

export interface FunctionalEvaluationTotals {
  caseCount: number;
  passedCaseCount: number;
  failedCaseCount: number;
  advanceCount: number;
  falseAdvanceCount: number;
  skippedAdvanceCount: number;
  duplicateAdvanceCount: number;
  lateAdvanceCount: number;
  processingTimeMs: number;
  maxAdvanceLatencyMs: number | null;
}

export interface FunctionalEvaluationSuiteResult {
  passed: boolean;
  cases: FunctionalEvaluationResult[];
  totals: FunctionalEvaluationTotals;
}

/** One way a replayed case can be unsafe or incorrect, reported on its own. */
export type FunctionalSafetyClassification =
  | "false-advance"
  | "skipped-advance"
  | "duplicate-advance"
  | "late-advance"
  | "advance-order";

/** Per-classification counts for one replayed case. */
export interface FunctionalClassificationCounts {
  "false-advance": number;
  "skipped-advance": number;
  "duplicate-advance": number;
  "late-advance": number;
}

/**
 * One case that got worse, with the classifications that got worse named
 * individually. A candidate that trades one classification for another is a
 * regression here even though its pass/fail boolean and the suite totals could
 * hide the trade.
 */
export interface FunctionalCaseRegression {
  fixtureId: string;
  kind: FunctionalEvaluationKind;
  classifications: FunctionalSafetyClassification[];
  baselineCounts: FunctionalClassificationCounts;
  candidateCounts: FunctionalClassificationCounts;
  baselineAdvancedTargetIds: string[];
  candidateAdvancedTargetIds: string[];
}

export interface FunctionalEvaluationComparison {
  baseline: FunctionalEvaluationSuiteResult;
  candidate: FunctionalEvaluationSuiteResult;
  /** Every case that got worse, per case and per classification. */
  regressions: FunctionalCaseRegression[];
  /** Convenience view of `regressions`; never the only recorded detail. */
  regressionCaseIds: string[];
}

function optionsForConfiguration(
  configuration: FunctionalMatcherConfiguration,
): ChordMatcherOptions {
  if (typeof configuration === "string") {
    return matcherOptionsForListenMatcherProfile(configuration);
  }
  return {
    ...matcherOptionsForListenMatcherProfile("baseline-v1"),
    ...configuration,
  };
}

function validateFixture(fixture: FunctionalEvaluationFixture): void {
  if (fixture.targets.length === 0) {
    throw new Error(`Functional fixture ${fixture.id} has no targets.`);
  }
  const targetIds = new Set<string>();
  for (const target of fixture.targets) {
    if (targetIds.has(target.id)) {
      throw new Error(`Functional fixture ${fixture.id} repeats target id ${target.id}.`);
    }
    targetIds.add(target.id);
    if (
      target.pitches.length === 0 ||
      target.pitches.some((pitch) => !Number.isInteger(pitch)) ||
      new Set(target.pitches).size !== target.pitches.length
    ) {
      throw new Error(`Functional fixture ${fixture.id} has invalid target ${target.id}.`);
    }
  }
  for (let index = 1; index < fixture.frames.length; index += 1) {
    const previous = fixture.frames[index - 1];
    const current = fixture.frames[index];
    if (previous !== undefined && current !== undefined &&
      current.capturedAtMs < previous.capturedAtMs) {
      throw new Error(`Functional fixture ${fixture.id} has unordered frames.`);
    }
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Replays one target-independent recognizer trace through the public matcher.
 * At most one score moment may advance per recognition frame.
 */
export function evaluateFunctionalFixture(
  fixture: FunctionalEvaluationFixture,
  configuration: FunctionalMatcherConfiguration = "baseline-v1",
): FunctionalEvaluationResult {
  validateFixture(fixture);
  const matcher = new ExactChordMatcher(optionsForConfiguration(configuration));
  const advances: FunctionalAdvance[] = [];
  const usedPhysicalEvents = new Set<string>();
  let targetIndex = 0;
  let generation = 1;
  const firstTarget = fixture.targets[0];
  if (firstTarget === undefined) {
    throw new Error(`Functional fixture ${fixture.id} has no first target.`);
  }
  matcher.setTarget(firstTarget.pitches, generation, fixture.startedAtMs ?? 0);

  let processingTimeMs = 0;
  for (const frame of fixture.frames) {
    if (targetIndex >= fixture.targets.length) break;
    processingTimeMs += frame.processingTimeMs;
    const { physicalEventId, playedTargetId, ...recognizerFrame } = frame;
    const update = matcher.consume({ ...recognizerFrame, generation });
    if (!update.matched) continue;

    const target = fixture.targets[targetIndex];
    if (target === undefined) break;
    const duplicateAdvance = physicalEventId !== undefined &&
      usedPhysicalEvents.has(physicalEventId);
    const falseAdvance = target.shouldAdvance === false || (
      playedTargetId !== undefined && playedTargetId !== target.id
    );
    const latencyMs = target.attackAtMs === undefined
      ? undefined
      : frame.capturedAtMs - target.attackAtMs;
    const lateAdvance = latencyMs !== undefined &&
      target.maxAdvanceLatencyMs !== undefined &&
      latencyMs > target.maxAdvanceLatencyMs;
    const advance: FunctionalAdvance = {
      targetId: target.id,
      targetIndex,
      capturedAtMs: frame.capturedAtMs,
      falseAdvance,
      duplicateAdvance,
      lateAdvance,
    };
    if (physicalEventId !== undefined) {
      advance.physicalEventId = physicalEventId;
      usedPhysicalEvents.add(physicalEventId);
    }
    if (playedTargetId !== undefined) advance.playedTargetId = playedTargetId;
    if (latencyMs !== undefined) advance.latencyMs = latencyMs;
    advances.push(advance);

    targetIndex += 1;
    generation += 1;
    const nextTarget = fixture.targets[targetIndex];
    if (nextTarget !== undefined) {
      matcher.setTarget(nextTarget.pitches, generation, frame.capturedAtMs);
    }
  }

  const expectedAdvanceTargetIds = fixture.targets
    .filter((target) => target.shouldAdvance !== false)
    .map((target) => target.id);
  const advancedTargetIds = advances.map((advance) => advance.targetId);
  const advancedTargetIdSet = new Set(advancedTargetIds);
  const falseAdvanceCount = advances.filter((advance) => advance.falseAdvance).length;
  const skippedAdvanceCount = expectedAdvanceTargetIds
    .filter((targetId) => !advancedTargetIdSet.has(targetId)).length;
  const duplicateAdvanceCount = advances
    .filter((advance) => advance.duplicateAdvance).length;
  const lateAdvanceCount = advances.filter((advance) => advance.lateAdvance).length;
  const measuredLatencies = advances
    .map((advance) => advance.latencyMs)
    .filter((latency): latency is number => latency !== undefined);
  const maxAdvanceLatencyMs = measuredLatencies.length === 0
    ? null
    : Math.max(...measuredLatencies);
  const passed = arraysEqual(advancedTargetIds, expectedAdvanceTargetIds) &&
    falseAdvanceCount === 0 &&
    skippedAdvanceCount === 0 &&
    duplicateAdvanceCount === 0 &&
    lateAdvanceCount === 0;

  return {
    fixtureId: fixture.id,
    kind: fixture.kind,
    passed,
    expectedAdvanceTargetIds,
    advancedTargetIds,
    advances,
    falseAdvanceCount,
    skippedAdvanceCount,
    duplicateAdvanceCount,
    lateAdvanceCount,
    processingTimeMs,
    maxAdvanceLatencyMs,
  };
}

/** Runs a discoverable set of functional fixtures and aggregates safety metrics. */
export function evaluateFunctionalSuite(
  fixtures: readonly FunctionalEvaluationFixture[],
  configuration: FunctionalMatcherConfiguration = "baseline-v1",
): FunctionalEvaluationSuiteResult {
  const cases = fixtures.map((fixture) => evaluateFunctionalFixture(fixture, configuration));
  const measuredLatencies = cases
    .map((result) => result.maxAdvanceLatencyMs)
    .filter((latency): latency is number => latency !== null);
  const totals: FunctionalEvaluationTotals = {
    caseCount: cases.length,
    passedCaseCount: cases.filter((result) => result.passed).length,
    failedCaseCount: cases.filter((result) => !result.passed).length,
    advanceCount: cases.reduce((sum, result) => sum + result.advances.length, 0),
    falseAdvanceCount: cases.reduce((sum, result) => sum + result.falseAdvanceCount, 0),
    skippedAdvanceCount: cases.reduce((sum, result) => sum + result.skippedAdvanceCount, 0),
    duplicateAdvanceCount: cases.reduce(
      (sum, result) => sum + result.duplicateAdvanceCount,
      0,
    ),
    lateAdvanceCount: cases.reduce((sum, result) => sum + result.lateAdvanceCount, 0),
    processingTimeMs: cases.reduce((sum, result) => sum + result.processingTimeMs, 0),
    maxAdvanceLatencyMs: measuredLatencies.length === 0
      ? null
      : Math.max(...measuredLatencies),
  };
  return {
    passed: totals.failedCaseCount === 0,
    cases,
    totals,
  };
}

/** Reduces one replayed case to the counts a safety comparison is made from. */
export function functionalClassificationCounts(
  result: FunctionalEvaluationResult,
): FunctionalClassificationCounts {
  return {
    "false-advance": result.falseAdvanceCount,
    "skipped-advance": result.skippedAdvanceCount,
    "duplicate-advance": result.duplicateAdvanceCount,
    "late-advance": result.lateAdvanceCount,
  };
}

/**
 * Compares a candidate with a known baseline without historical artifact files.
 *
 * The comparison is made per case and per classification. A corpus-wide total
 * or a per-case pass/fail boolean can hide a candidate that removes one unsafe
 * classification while introducing another, so neither is used to decide
 * whether a case regressed.
 */
export function compareFunctionalMatcherConfigurations(
  fixtures: readonly FunctionalEvaluationFixture[],
  candidateConfiguration: FunctionalMatcherConfiguration,
  baselineConfiguration: FunctionalMatcherConfiguration = "baseline-v1",
): FunctionalEvaluationComparison {
  const baseline = evaluateFunctionalSuite(fixtures, baselineConfiguration);
  const candidate = evaluateFunctionalSuite(fixtures, candidateConfiguration);
  const baselineCases = new Map(
    baseline.cases.map((result) => [result.fixtureId, result]),
  );

  const regressions: FunctionalCaseRegression[] = [];
  for (const candidateCase of candidate.cases) {
    const baselineCase = baselineCases.get(candidateCase.fixtureId);
    if (baselineCase === undefined) {
      throw new Error(
        `Candidate case ${candidateCase.fixtureId} has no baseline counterpart.`,
      );
    }
    const baselineCounts = functionalClassificationCounts(baselineCase);
    const candidateCounts = functionalClassificationCounts(candidateCase);
    const classifications: FunctionalSafetyClassification[] = [];
    for (const classification of [
      "false-advance",
      "skipped-advance",
      "duplicate-advance",
      "late-advance",
    ] as const) {
      if (candidateCounts[classification] > baselineCounts[classification]) {
        classifications.push(classification);
      }
    }
    if (!arraysEqual(candidateCase.advancedTargetIds, baselineCase.advancedTargetIds)) {
      classifications.push("advance-order");
    }
    if (classifications.length === 0) continue;
    regressions.push({
      fixtureId: candidateCase.fixtureId,
      kind: candidateCase.kind,
      classifications,
      baselineCounts,
      candidateCounts,
      baselineAdvancedTargetIds: [...baselineCase.advancedTargetIds],
      candidateAdvancedTargetIds: [...candidateCase.advancedTargetIds],
    });
  }

  return {
    baseline,
    candidate,
    regressions,
    regressionCaseIds: regressions.map((regression) => regression.fixtureId),
  };
}
