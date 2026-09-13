import assert from "node:assert/strict";
import test from "node:test";

import {
  captureOnlineAmtTrace,
  loadExperimentDecoderModule,
  runExperimentDecoder,
  type OnlineAmtCaptureTrace,
} from "../../src/eval/index.js";

// The module under test is reached the way the runner reaches it: by id,
// through the eval entry point. A direct file import is what the boundary
// test forbids.

const LAG = 160;

// The four pitches the synthetic takes drive. p is the pitch whose repeat
// the rungs gate; the others sit at the chord distances the frozen ladder
// varies: q a second above p (in B, C and D), r a fourth above p (in B and
// C, not D) and s a sixth above p (in B only).
const P = 60;
const Q = 61;
const R = 63;
const S = 68;

const OFF = 0;
const OFFSET = 1;
const SUSTAIN = 2;
const ONSET = 3;
const REONSET = 4;

type FrameSpec = { p: number; q: number; r: number; s: number; active?: boolean };

const f = (p: number, q: number, r: number, s: number): FrameSpec => ({ p, q, r, s });
const fSuppressed = (p: number, q: number, r: number, s: number): FrameSpec => ({
  p,
  q,
  r,
  s,
  active: false,
});

/**
 * One synthetic take, written as the selected state of each driven pitch per
 * frame. The captured scores carry the same shape the E05 tests use, so the
 * trace is a legitimate one; the gate under test reads the selected states and
 * the shipped decoder's transitions, which the states alone determine.
 */
async function syntheticTrace(
  frames: FrameSpec[],
  tailFrames = 0,
): Promise<OnlineAmtCaptureTrace> {
  let index = 0;
  return captureOnlineAmtTrace(
    {
      reset() { index = 0; },
      async run() {
        const spec = frames[index++]!;
        const scores = new Float32Array(440);
        const states = new Uint8Array(88);
        const active = spec.active === undefined ? true : spec.active;
        if (active) {
          for (let pitch = 0; pitch < 88; pitch += 1) scores[pitch * 5] = 1;
        }
        const driven: [number, number][] = [
          [P, spec.p],
          [Q, spec.q],
          [R, spec.r],
          [S, spec.s],
        ];
        for (const [midi, state] of driven) {
          states[midi - 21] = state;
          if (active && state > 0) scores[(midi - 21) * 5 + state] = 0.9 * (state >= 3 ? 2 : 1);
        }
        return { scores, states, signalActive: active, inferenceTimeMs: 1 };
      },
    },
    new Float32Array((frames.length - tailFrames) * 512),
    { tailFlushSamples: tailFrames * 512 },
  );
}

type Run = Awaited<ReturnType<typeof runExperimentDecoder>>;
type RunEvent = Run["events"][number];

/** A frame captured at (index+1) * 32 ms has its onset estimate at that minus the lag. */
function onsetMsOfFrame(frameIndex: number): number {
  return (frameIndex + 1) * 32 - LAG;
}

/** The event key of the take table: midi and the origin frame's onset estimate. */
const k = (midi: number, frameIndex: number): string => `${midi}:${onsetMsOfFrame(frameIndex)}`;

function eventAt(run: Run, midi: number, frameIndex: number): RunEvent | undefined {
  return run.events.find((event) => event.midi === midi && event.onsetMs === onsetMsOfFrame(frameIndex));
}

function hasEvent(run: Run, midi: number, frameIndex: number): boolean {
  return eventAt(run, midi, frameIndex) !== undefined;
}

function keySet(run: Run): Set<string> {
  return new Set(run.events.map((event) => `${event.midi}:${event.onsetMs}`));
}

/** The run's emitted (midi, onsetMs) keys are exactly `keys`. */
function expectKeys(run: Run, keys: string[]): void {
  assert.deepEqual(
    [...keySet(run)].sort(),
    [...keys].sort(),
    `the run emits ${JSON.stringify(keys)}`,
  );
}

/** Every emitted event is available on the frame that produced its origin. */
function expectNoDelay(run: Run): void {
  for (const event of run.events) {
    assert.equal(event.addedDelayMs, 0, `added delay on MIDI ${event.midi} from frame ${event.originFrameIndex}`);
    assert.equal(event.waitedFrames, 0, `waited frames on MIDI ${event.midi} from frame ${event.originFrameIndex}`);
  }
}

async function runControl(trace: OnlineAmtCaptureTrace): Promise<Run> {
  return runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
}

async function runGate(
  trace: OnlineAmtCaptureTrace,
  relations: readonly number[],
  windowOffsets: readonly number[] = [-1, 0, 1],
): Promise<Run> {
  return runExperimentDecoder(trace, {
    decoderId: "chordContextGate",
    configuration: { relations: [...relations], windowOffsets: [...windowOffsets] },
    onsetEstimateLagMs: LAG,
  });
}

const ROUNDS: { label: string; relations: number[] }[] = [
  { label: "B", relations: [1, 2, 3, 4, 8, 9] },
  { label: "C", relations: [1, 2, 3, 4] },
  { label: "D", relations: [1, 2] },
];

test("chordContextGate declares its own id and file name", async () => {
  const module = await loadExperimentDecoderModule("chordContextGate");
  assert.equal(module.id, "chordContextGate");
  assert.equal(typeof module.summary, "string");
  assert.ok(module.summary.length > 0);
});

test("each frozen E06 configuration normalises to itself", async () => {
  const module = await loadExperimentDecoderModule("chordContextGate");
  // E06-B: the anchor rung, seconds, thirds, fourths, fifths and sixths.
  assert.deepEqual(
    module.validateConfiguration({ relations: [1, 2, 3, 4, 8, 9], windowOffsets: [-1, 0, 1] }),
    { relations: [1, 2, 3, 4, 8, 9], windowOffsets: [-1, 0, 1] },
  );
  // E06-C: seconds, thirds, fourths, fifths.
  assert.deepEqual(
    module.validateConfiguration({ relations: [1, 2, 3, 4], windowOffsets: [-1, 0, 1] }),
    { relations: [1, 2, 3, 4], windowOffsets: [-1, 0, 1] },
  );
  // E06-D: the deepest rung, seconds only.
  assert.deepEqual(
    module.validateConfiguration({ relations: [1, 2], windowOffsets: [-1, 0, 1] }),
    { relations: [1, 2], windowOffsets: [-1, 0, 1] },
  );
  // A set written with repeats or out of order normalizes to the canonical
  // one, so the configuration that freezes is the one that ran.
  assert.deepEqual(
    module.validateConfiguration({ relations: [9, 1, 8], windowOffsets: [1, -1, 0] }),
    { relations: [1, 8, 9], windowOffsets: [-1, 0, 1] },
  );
  assert.deepEqual(
    module.validateConfiguration({ relations: [2, 1], windowOffsets: [0, 0] }),
    { relations: [1, 2], windowOffsets: [0] },
  );
});

test("configuration validation rejects malformed parameters", async () => {
  const module = await loadExperimentDecoderModule("chordContextGate");
  assert.throws(
    () => module.validateConfiguration({ relations: [1, 2], windowOffsets: [-1, 0, 1], extra: 1 }),
    /is not a parameter/,
  );
  assert.throws(
    () => module.validateConfiguration({ relations: "1 2", windowOffsets: [-1, 0, 1] }),
    /relations must be a non-empty array/,
  );
  assert.throws(
    () => module.validateConfiguration({ relations: [], windowOffsets: [-1, 0, 1] }),
    /non-empty/,
  );
  assert.throws(
    () => module.validateConfiguration({ relations: [1.5, 2], windowOffsets: [-1, 0, 1] }),
    /whole numbers/,
  );
  assert.throws(
    () => module.validateConfiguration({ relations: [0, 2], windowOffsets: [-1, 0, 1] }),
    /at least 1/,
  );
  assert.throws(
    () => module.validateConfiguration({ relations: [49], windowOffsets: [-1, 0, 1] }),
    /at most 48/,
  );
  assert.throws(
    () => module.validateConfiguration({ relations: [1, 2], windowOffsets: [-1, 1] }),
    /must include 0/,
  );
  assert.throws(
    () => module.validateConfiguration({ relations: [1, 2], windowOffsets: [-5, 0] }),
    /at most 4/,
  );
  assert.throws(
    () => module.validateConfiguration({ relations: [1, 2] }),
    /windowOffsets must be a non-empty array/,
  );
  assert.throws(
    () => module.validateConfiguration(null),
    /relations must be a non-empty array/,
  );
});

test("a repeat whose neighbour fires on its own frame is kept at every rung, with no added delay", async () => {
  // p is sounding from frame 1 and re-attacks on frame 3; q, a second above
  // p, attacks on that same frame, so the window position t itself holds a
  // firing neighbour at every rung.
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, ONSET, OFF, OFF),
    f(OFFSET, OFFSET, OFF, OFF),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(control.events.length, 3, "the control emits both p attacks and q's new note");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    expectKeys(run, [k(P, 1), k(P, 3), k(Q, 3)]);
    expectNoDelay(run);
    assert.equal(run.completion?.pendingCandidates, 0);
    assert.deepEqual(
      run.configuration,
      { relations: round.relations, windowOffsets: [-1, 0, 1] },
      `the frozen rung ${round.label} travels through the runner unchanged`,
    );
  }
});

test("a repeat whose neighbour fired one frame earlier is kept at every rung, with no added delay", async () => {
  // q attacks on t-1 and is only sustaining at t: the firing itself is the
  // sounding evidence, so the t-1 position rescues the repeat even though q
  // is no longer firing when p re-attacks.
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, ONSET, OFF, OFF),
    f(REONSET, SUSTAIN, OFF, OFF),
    f(OFFSET, OFFSET, OFF, OFF),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(control.events.length, 3, "the control emits both p attacks and q's new note");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    expectKeys(run, [k(P, 1), k(P, 3), k(Q, 2)]);
    expectNoDelay(run);
    assert.equal(run.completion?.pendingCandidates, 0);
  }
});

test("a repeat whose only rescuing neighbour fires one frame later is held, then emitted at that frame, paying the frame period", async () => {
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, OFF, OFF, OFF),
    f(OFFSET, ONSET, OFF, OFF),
    f(OFF, OFFSET, OFF, OFF),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(control.events.length, 3, "the control emits both p attacks and q's new note");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    expectKeys(run, [k(P, 1), k(P, 3), k(Q, 4)]);
    assert.equal(
      run.completion?.pendingCandidates,
      0,
      "a window that resolves inside the recording leaves nothing pending",
    );
    assert.equal(run.maximumWaitedFrames, 1, `rung ${round.label} waits one frame for the t+1 position`);
    const repeat = eventAt(run, P, 3)!;
    assert.equal(repeat.addedDelayMs, 32, "the wait for the t+1 position costs the frame period");
    assert.equal(repeat.waitedFrames, 1);
    assert.equal(repeat.availableAtMs, 5 * 32, "availability is stamped from the frame the decoder was holding");
    assert.equal(repeat.onsetMs, onsetMsOfFrame(3), "the onset estimate stays with the frame the attack is attributed to");
    assert.equal(eventAt(run, Q, 4)!.addedDelayMs, 0, "the rescuing new note itself is never gated");
  }
});

test("a repeat with no firing neighbour anywhere in its window is dropped, and a later firing does not resurrect it", async () => {
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(OFFSET, ONSET, OFF, OFF),
    f(OFF, OFFSET, OFF, OFF),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(control.events.length, 3, "the control emits both p attacks and q's late new note");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    expectKeys(run, [k(P, 1), k(Q, 5)]);
    assert.ok(!hasEvent(run, P, 3), `the window closed without a neighbour at rung ${round.label}`);
    expectNoDelay(run);
    assert.equal(run.completion?.pendingCandidates, 0);
  }
});

test("a suppressed frame in the window never supplies neighbour evidence and still closes the window", async () => {
  // The t+1 rescue shape from the previous test, except the frame that would
  // carry the rescuing q attack is suppressed: every accessor reads null, so
  // the position holds no evidence and the candidate is dropped when the
  // position is delivered. The later, active q attack is a new note, not a
  // resurrection of the held candidate.
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, OFF, OFF, OFF),
    fSuppressed(OFFSET, ONSET, OFF, OFF),
    f(OFF, ONSET, OFF, OFF),
    f(OFF, OFFSET, OFF, OFF),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(
    control.events.length,
    3,
    "the control emits both p attacks and q's new note after the suppressed frame",
  );
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    expectKeys(run, [k(P, 1), k(Q, 5)]);
    assert.ok(!hasEvent(run, P, 3), `the suppressed frame supplies no evidence at rung ${round.label}`);
    assert.equal(
      run.completion?.pendingCandidates,
      0,
      "the window closed on the suppressed frame: the drop is decided, not deferred",
    );
  }
});

test("an active tail-flush frame supplies neighbour evidence like any other active frame", async () => {
  // The last input frame carries p's repeat; the flush frame that follows
  // carries q's attack. The flush frame is a frame the decoder was handed,
  // and its states are real, so it may rescue the candidate.
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, OFF, OFF, OFF),
    f(SUSTAIN, ONSET, OFF, OFF),
  ];
  const trace = await syntheticTrace(frames, 1);
  const control = await runControl(trace);
  assert.equal(control.events.length, 3, "the control emits both p attacks and q's new note on the flush frame");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    expectKeys(run, [k(P, 1), k(P, 3), k(Q, 4)]);
    assert.equal(run.completion?.pendingCandidates, 0);
    assert.equal(run.maximumWaitedFrames, 1);
    const repeat = eventAt(run, P, 3)!;
    assert.equal(repeat.addedDelayMs, 32, "the rescue arrives on the flush frame, one period after the attack");
    assert.equal(repeat.waitedFrames, 1);
    assert.equal(
      run.eventsAvailableAfterInput,
      2,
      "both events become available on the flush frame, past the input",
    );
  }
});

test("a repeat born on the last frame of the recording is reported pending through finish(), not emitted", async () => {
  // No window position after the last frame can ever be delivered, so a
  // candidate born there that its delivered positions do not rescue is
  // pending: the cost of the wait is reported, not recovered.
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, OFF, OFF, OFF),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(control.events.length, 2, "the control emits the onset and the renewed attack");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    expectKeys(run, [k(P, 1)]);
    assert.ok(!hasEvent(run, P, 3), `the final-frame candidate is not emitted at rung ${round.label}`);
    assert.equal(run.completion?.pendingCandidates, 1, "the held candidate is reported at the end, not emitted");
  }
  // The same take with q firing on the final frame: a delivered position
  // rescues the candidate, nothing is pending, and the admission is on the
  // candidate's own frame.
  const rescued: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, ONSET, OFF, OFF),
  ];
  const trace2 = await syntheticTrace(rescued);
  for (const round of ROUNDS) {
    const run = await runGate(trace2, round.relations);
    expectKeys(run, [k(P, 1), k(P, 3), k(Q, 3)]);
    expectNoDelay(run);
    assert.equal(run.completion?.pendingCandidates, 0);
  }
});

test("a fourth above the repeat rescues it at the anchor and anchor-minus-sixths rungs, and not at the seconds-only rung", async () => {
  // r sits a fourth (three semitones) above p: in B and C, not in D.
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, OFF, OFF, OFF),
    f(OFFSET, OFF, ONSET, OFF),
    f(OFF, OFF, OFFSET, OFF),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(control.events.length, 3, "the control emits both p attacks and r's new note");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    if (round.relations.includes(3)) {
      expectKeys(run, [k(P, 1), k(P, 3), k(R, 4)]);
      assert.equal(eventAt(run, P, 3)!.addedDelayMs, 32, `rung ${round.label} rescues the repeat one frame late`);
    } else {
      expectKeys(run, [k(P, 1), k(R, 4)]);
      assert.ok(!hasEvent(run, P, 3), `rung ${round.label} drops the repeat no second rescues`);
      expectNoDelay(run);
    }
    assert.equal(run.completion?.pendingCandidates, 0);
  }
});

test("a sixth above the repeat rescues it only at the anchor rung", async () => {
  // s sits a sixth (eight semitones) above p: in B, not in C or D.
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, OFF, OFF, OFF),
    f(OFFSET, OFF, OFF, ONSET),
    f(OFF, OFF, OFF, OFFSET),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(control.events.length, 3, "the control emits both p attacks and s's new note");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    if (round.relations.includes(8)) {
      expectKeys(run, [k(P, 1), k(P, 3), k(S, 4)]);
      assert.equal(eventAt(run, P, 3)!.addedDelayMs, 32, "the anchor rescues the repeat one frame late");
    } else {
      expectKeys(run, [k(P, 1), k(S, 4)]);
      assert.ok(!hasEvent(run, P, 3), `rung ${round.label} drops the repeat no third rescues`);
      expectNoDelay(run);
    }
    assert.equal(run.completion?.pendingCandidates, 0);
  }
});

test("a repeat's own firing is not evidence for itself; a different pitch's is", async () => {
  // p re-attacks on a frame it is itself firing on, and nothing else sounds:
  // at every rung the candidate has no other pitch to be rescued by and is
  // dropped.
  const alone: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, OFF, OFF, OFF),
    f(OFFSET, OFF, OFF, OFF),
  ];
  const trace = await syntheticTrace(alone);
  const control = await runControl(trace);
  assert.equal(control.events.length, 2, "the control emits the onset and the renewed attack");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    expectKeys(run, [k(P, 1)]);
    assert.ok(!hasEvent(run, P, 3), `rung ${round.label} does not count the candidate's own firing`);
    assert.equal(run.completion?.pendingCandidates, 0);
  }
  // The same take with q firing on the repeat frame: now the candidate has
  // a different pitch to be rescued by, and every rung keeps it.
  const accompanied: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(REONSET, ONSET, OFF, OFF),
    f(OFFSET, OFFSET, OFF, OFF),
  ];
  const trace2 = await syntheticTrace(accompanied);
  for (const round of ROUNDS) {
    const run = await runGate(trace2, round.relations);
    expectKeys(run, [k(P, 1), k(P, 3), k(Q, 3)]);
    expectNoDelay(run);
    assert.equal(run.completion?.pendingCandidates, 0);
  }
});

test("a renewed attack on the first frame, which has no earlier frame to read a previous state from, is never gated", async () => {
  // The recording's first frame is already the pitch's renewed attack: the
  // note was sounding before the recording began. The runner derives no from
  // state for such an event (there is no frame before the first), so the
  // family the gate acts on — a repeat whose previous state was a sounding
  // one — does not reach it at any rung, and the module leaves it exactly
  // as the control emits it.
  const frames: FrameSpec[] = [
    f(REONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, OFF, OFF),
    f(OFFSET, OFF, OFF, OFF),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(control.events.length, 1, "the control emits only the renewed attack on the first frame");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    expectKeys(run, [k(P, 0)]);
    expectNoDelay(run);
    assert.equal(run.completion?.pendingCandidates, 0);
    assert.deepEqual(
      run.events.map((event) => ({
        midi: event.midi,
        onsetMs: event.onsetMs,
        availableAtMs: event.availableAtMs,
        transition: event.transition,
        reportedKind: event.reportedKind,
      })),
      control.events.map((event) => ({
        midi: event.midi,
        onsetMs: event.onsetMs,
        availableAtMs: event.availableAtMs,
        transition: event.transition,
        reportedKind: event.reportedKind,
      })),
      `rung ${round.label} passes the no-previous-frame repeat through untouched`,
    );
  }
});

test("on a mixed take each rung admits exactly the repeats its relation set reaches, and nothing else moves", async () => {
  // p re-attacks twice. The first repeat has a fourth (r) firing on t-1 and
  // a second (q) firing on t; the second has a sixth (s) firing on t-1 and
  // nothing after. B reaches all three neighbours, C all but the sixth, D
  // only the second.
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(SUSTAIN, OFF, ONSET, OFF),
    f(REONSET, ONSET, SUSTAIN, OFF),
    f(SUSTAIN, SUSTAIN, OFF, ONSET),
    f(REONSET, SUSTAIN, OFF, SUSTAIN),
    f(OFFSET, OFFSET, OFF, OFFSET),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.deepEqual(
    [...keySet(control)].sort(),
    [k(P, 1), k(P, 3), k(P, 5), k(Q, 3), k(R, 2), k(S, 4)].sort(),
    "the control emits the take's six attacks",
  );
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    if (round.relations.includes(8)) {
      expectKeys(run, [k(P, 1), k(P, 3), k(P, 5), k(Q, 3), k(R, 2), k(S, 4)]);
    } else {
      expectKeys(run, [k(P, 1), k(P, 3), k(Q, 3), k(R, 2), k(S, 4)]);
    }
    // The gate only ever admits on a delivered window position, and none of
    // this take's admissions waits past its frame.
    expectNoDelay(run);
    assert.equal(run.completion?.pendingCandidates, 0);
  }
});

test("a third-apart pair of repeats rescues each other at the third-reaching rungs, while the seconds-only rung holds both for a rescuing second", async () => {
  // p and r are three semitones apart: a chordal pair in B and C, outside
  // D. They re-attack on the same frame, so at B and C each repeat is
  // rescued by the other on the frame itself; at D neither reaches the other,
  // so both are held until q, a second above p and a third above r, fires
  // one frame later.
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, ONSET, OFF),
    f(SUSTAIN, OFF, SUSTAIN, OFF),
    f(REONSET, OFF, REONSET, OFF),
    f(OFFSET, ONSET, OFFSET, OFF),
    f(OFF, OFFSET, OFF, OFF),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.deepEqual(
    [...keySet(control)].sort(),
    [k(P, 1), k(P, 3), k(R, 1), k(R, 3), k(Q, 4)].sort(),
    "the control emits the take's five attacks",
  );
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    expectKeys(run, [k(P, 1), k(P, 3), k(R, 1), k(R, 3), k(Q, 4)]);
    if (round.relations.includes(3)) {
      // The pair hears itself: each repeat is admitted on its own frame.
      assert.equal(eventAt(run, P, 3)!.addedDelayMs, 0, `rung ${round.label} admits the p repeat on the frame r fires`);
      assert.equal(eventAt(run, R, 3)!.addedDelayMs, 0, `rung ${round.label} admits the r repeat on the frame p fires`);
      assert.equal(run.maximumWaitedFrames, 0);
    } else {
      // Seconds only reaches neither of them: both are held until q's
      // second fires, and pay the frame period for the wait.
      assert.equal(eventAt(run, P, 3)!.addedDelayMs, 32, `rung ${round.label} holds the p repeat for q's frame`);
      assert.equal(eventAt(run, R, 3)!.addedDelayMs, 32, `rung ${round.label} holds the r repeat for q's frame`);
      assert.equal(run.maximumWaitedFrames, 1);
    }
    assert.equal(run.completion?.pendingCandidates, 0);
  }
});

test("a take with no repeat family passes through the gate exactly as the control emits it", async () => {
  // Two new notes on p, separated by an offset: every event is a new note,
  // so the gate has nothing to act on and the module's output is the
  // control's, field for field.
  const frames: FrameSpec[] = [
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(OFFSET, OFF, OFF, OFF),
    f(OFF, OFF, OFF, OFF),
    f(ONSET, OFF, OFF, OFF),
    f(OFFSET, OFF, OFF, OFF),
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(control.events.length, 2, "the control emits both new notes");
  for (const round of ROUNDS) {
    const run = await runGate(trace, round.relations);
    assert.deepEqual(
      run.events.map((event) => ({
        midi: event.midi,
        onsetMs: event.onsetMs,
        availableAtMs: event.availableAtMs,
        transition: event.transition,
        reportedKind: event.reportedKind,
      })),
      control.events.map((event) => ({
        midi: event.midi,
        onsetMs: event.onsetMs,
        availableAtMs: event.availableAtMs,
        transition: event.transition,
        reportedKind: event.reportedKind,
      })),
      `rung ${round.label} leaves a repeat-free take untouched`,
    );
    expectNoDelay(run);
    assert.equal(run.completion?.pendingCandidates, 0);
  }
});
