import assert from "node:assert/strict";
import test from "node:test";

import {
  captureOnlineAmtTrace,
  loadExperimentDecoderModule,
  runExperimentDecoder,
  type OnlineAmtCaptureTrace,
} from "../../src/eval/index.js";

// The module under test is reached the way the runner reaches it: by id, through
// the eval entry point. A direct file import is what the boundary test forbids.

const LAG = 160;
/** The single pitch the synthetic trace drives; pitch index 39 is MIDI 60. */
const MIDI = 60;

type FrameSpec = { probability: number; state: number; active?: boolean };

/**
 * One synthetic take, written as the attack probability and selected state of a
 * single pitch per frame. Only MIDI 60 (pitch index 39) is ever driven; every
 * other pitch stays at `off`, so any attack the decoder reports is about MIDI 60.
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
    },
    new Float32Array((frames.length - tailFrames) * 512),
    { tailFlushSamples: tailFrames * 512 },
  );
}

/** A frame captured at (index+1) * 32 ms has its onset estimate at that minus the lag. */
function onsetMsOfFrame(frameIndex: number): number {
  return (frameIndex + 1) * 32 - LAG;
}

type Run = Awaited<ReturnType<typeof runExperimentDecoder>>;

/** Does `run` contain an attack for the driven pitch at the given origin frame? */
function hasEvent(run: Run, frameIndex: number): boolean {
  const onsetMs = onsetMsOfFrame(frameIndex);
  return run.events.some((event) => event.midi === MIDI && event.onsetMs === onsetMs);
}

function keySet(run: Run): Set<string> {
  return new Set(run.events.map((event) => `${event.midi}:${event.onsetMs}`));
}
/** Every `inner` key is present in `outer` — the module is a subset of the control. */
function isSubset(outer: Run, inner: Run): boolean {
  const outerKeys = keySet(outer);
  return [...keySet(inner)].every((key) => outerKeys.has(key));
}

async function runControl(trace: OnlineAmtCaptureTrace): Promise<Run> {
  return runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
}
async function runRearm(trace: OnlineAmtCaptureTrace, minSeparationFrames: number): Promise<Run> {
  return runExperimentDecoder(trace, {
    decoderId: "minSeparationRearm",
    configuration: { minSeparationFrames },
    onsetEstimateLagMs: LAG,
  });
}

test("minSeparationRearm declares its own id and file name", async () => {
  const module = await loadExperimentDecoderModule("minSeparationRearm");
  assert.equal(module.id, "minSeparationRearm");
  assert.equal(typeof module.summary, "string");
  assert.ok(module.summary.length > 0);
});

test("each frozen E05 configuration normalises to itself", async () => {
  const module = await loadExperimentDecoderModule("minSeparationRearm");
  // E05-B / E05-C / E05-D / E05-E
  assert.deepEqual(module.validateConfiguration({ minSeparationFrames: 1 }), { minSeparationFrames: 1 });
  assert.deepEqual(module.validateConfiguration({ minSeparationFrames: 2 }), { minSeparationFrames: 2 });
  assert.deepEqual(module.validateConfiguration({ minSeparationFrames: 3 }), { minSeparationFrames: 3 });
  assert.deepEqual(module.validateConfiguration({ minSeparationFrames: 4 }), { minSeparationFrames: 4 });
});

test("configuration validation rejects malformed parameters", async () => {
  const module = await loadExperimentDecoderModule("minSeparationRearm");
  assert.throws(() => module.validateConfiguration({ minSeparationFrames: 1, rearmThreshold: 0.15 }), /is not a parameter/);
  assert.throws(() => module.validateConfiguration({ minSeparationFrames: 1.5 }), /whole number/);
  assert.throws(() => module.validateConfiguration({ minSeparationFrames: 0 }), /at least 1/);
  assert.throws(() => module.validateConfiguration({ minSeparationFrames: 17 }), /at most 16/);
  assert.throws(() => module.validateConfiguration({ minSeparationFrames: "2" }), /must be a finite number/);
  assert.throws(() => module.validateConfiguration({}), /must be a finite number/);
  assert.throws(() => module.validateConfiguration(null), /must be a finite number/);
});

test("the K_min=1 anchor reproduces the control exactly on a mixed take", async () => {
  // Two notes: note A with a one-frame flicker and a three-frame-gap
  // sustain->onset repeat; note B with a two-frame-gap repeat and its own one-
  // frame flicker: the full shape the ladder will be read on, at the rung
  // expected to be a no-op.
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 }, // note A onset
    { probability: 0.9, state: 4 }, // flicker, gap 1
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 3 }, // repeat (sustain->onset), gap 3
    { probability: 0, state: 1 }, // offset
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 }, // note B onset
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 }, // repeat (sustain->reOnset), gap 2
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  const run = await runRearm(trace, 1);
  // The control really has the full attack list, so the equality below is not vacuous.
  assert.equal(control.events.length, 5);
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
    "K_min=1 admits everything the control admits, on the same frames",
  );
  // The anchor adds no latency and holds nothing: at K=1 a repeat is too close
  // only when it shares its frame with the last emitted attack, which the control
  // never produces.
  for (const event of run.events) {
    assert.equal(event.addedDelayMs, 0);
    assert.equal(event.waitedFrames, 0);
  }
  assert.equal(run.completion?.pendingCandidates, 0);
  assert.deepEqual(run.configuration, { minSeparationFrames: 1 });
});

test("a renewed attack one frame after the pitch's last emitted attack is dropped at K_min 2, 3 and 4, and kept at K_min=1", async () => {
  // off -> onset -> reOnset: the reOnset is a flicker one frame after the onset,
  // with no frame between the two attacks — the population E02-B's K=1 rung
  // suppressed unconditionally because no probability valley fits in one frame.
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.ok(hasEvent(control, 1), "the control emits the new-note onset");
  assert.ok(hasEvent(control, 2), "the control emits the renewed attack");
  assert.ok(hasEvent(await runRearm(trace, 1), 2), "K_min=1 keeps the one-frame-gap repeat");
  for (const k of [2, 3, 4]) {
    assert.ok(!hasEvent(await runRearm(trace, k), 2), `the one-frame-gap repeat is dropped at K_min=${k}`);
  }
});

test("a repeat two frames after the last emitted attack is kept at K_min 1 and 2, dropped at K_min 3 and 4", async () => {
  // off -> onset -> sustain -> reOnset: a genuine-looking repeat two frames
  // after the onset — the gap-2 population, the deepest rung K_min=3 suppresses
  // (it admits only frames at least three after the last emitted attack).
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  assert.ok(hasEvent(await runControl(trace), 3), "the control emits the released repeat");
  assert.ok(hasEvent(await runRearm(trace, 1), 3), "K_min=1 keeps the two-frame-gap repeat");
  assert.ok(hasEvent(await runRearm(trace, 2), 3), "K_min=2 keeps the two-frame-gap repeat");
  assert.ok(!hasEvent(await runRearm(trace, 3), 3), "K_min=3 drops the two-frame-gap repeat");
  assert.ok(!hasEvent(await runRearm(trace, 4), 3), "K_min=4 drops the two-frame-gap repeat");
});

test("a repeat three frames after the last emitted attack is kept at K_min 3, dropped at K_min 4", async () => {
  // off -> onset -> sustain -> sustain -> reOnset: the gap-3 rung, the population
  // E02's K=3 duration rung destroyed in bulk (genuine trill and close-repeat
  // attacks on 1-2 frame sustain runs).
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2 },
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  assert.ok(hasEvent(await runControl(trace), 4), "the control emits the released repeat");
  assert.ok(hasEvent(await runRearm(trace, 2), 4), "K_min=2 keeps the three-frame-gap repeat");
  assert.ok(hasEvent(await runRearm(trace, 3), 4), "K_min=3 keeps the three-frame-gap repeat");
  assert.ok(!hasEvent(await runRearm(trace, 4), 4), "K_min=4 drops the three-frame-gap repeat");
});

test("a suppressed repeat never updates the separation clock", async () => {
  // off -> onset -> reOnset -> sustain -> onset: the first repeat (gap 1) is
  // suppressed at K_min=3, and the second repeat (a sustain->onset three frames
  // after the onset) is still measured from the onset. If the suppressed repeat
  // had moved the clock, the second would be a two-frame gap, below the
  // K_min=3 bar, and the take would lose both repeats instead of one.
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.9, state: 4 },
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 3 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.ok(hasEvent(control, 1) && hasEvent(control, 2) && hasEvent(control, 4), "the control emits the onset and both repeats");
  const k1 = await runRearm(trace, 1);
  assert.ok(hasEvent(k1, 2) && hasEvent(k1, 4), "K_min=1 keeps both repeats");
  const k2 = await runRearm(trace, 2);
  assert.ok(!hasEvent(k2, 2), "the one-frame-gap repeat is suppressed at K_min=2");
  assert.ok(hasEvent(k2, 4), "the suppressed repeat does not move the clock, so the gap-3 repeat survives K_min=2");
  const k3 = await runRearm(trace, 3);
  assert.ok(!hasEvent(k3, 2), "the one-frame-gap repeat is suppressed at K_min=3");
  assert.ok(hasEvent(k3, 4), "the suppressed repeat does not move the clock, so the gap-3 repeat survives K_min=3");
  const k4 = await runRearm(trace, 4);
  assert.ok(!hasEvent(k4, 2) && !hasEvent(k4, 4), "K_min=4 needs a four-frame gap, so both repeats are dropped");
});

test("a suppressed frame between the attacks still counts toward the separation", async () => {
  // off -> onset -> (suppressed) -> reOnset: the frame between the two attacks
  // carries no reading at all, but it is still a frame the decoder was handed,
  // so the gap is two frames, not one. (In the valley family a suppressed frame
  // broke the run; here it only advances the clock.)
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2, active: false },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.ok(hasEvent(control, 3), "the control emits the renewed attack across the suppressed frame");
  assert.ok(hasEvent(await runRearm(trace, 1), 3), "K_min=1 keeps the repeat");
  assert.ok(hasEvent(await runRearm(trace, 2), 3), "the suppressed frame advances the clock, so the gap is two and K_min=2 keeps the repeat");
  assert.ok(!hasEvent(await runRearm(trace, 3), 3), "K_min=3 needs a three-frame gap, so the repeat is dropped");
});

test("a new note from off/offset passes through exactly as the control, with no added delay, and starts the pitch's separation clock", async () => {
  // off -> onset -> sustain -> offset -> off -> onset -> reOnset: the second
  // onset is a new note from off (never gated, at any K) and it restarts the
  // clock, so the following one-frame flicker is judged against it.
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2 },
    { probability: 0, state: 1 },
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  for (const frameIndex of [1, 5, 6]) {
    assert.ok(hasEvent(control, frameIndex), `the control emits the frame-${frameIndex} attack`);
  }
  for (const k of [1, 2, 3, 4]) {
    const run = await runRearm(trace, k);
    const controlOnset = control.events.find((event) => event.midi === MIDI && event.onsetMs === onsetMsOfFrame(5))!;
    const onset = run.events.find((event) => event.midi === MIDI && event.onsetMs === onsetMsOfFrame(5));
    assert.ok(onset, `the new note from off is never gated (K_min=${k})`);
    assert.equal(onset!.onsetMs, controlOnset.onsetMs);
    assert.equal(onset!.availableAtMs, controlOnset.availableAtMs);
    assert.equal(onset!.addedDelayMs, 0);
    assert.equal(onset!.waitedFrames, 0);
    if (k === 1) {
      assert.ok(hasEvent(run, 6), "K_min=1 keeps the one-frame flicker after the new note");
    } else {
      assert.ok(!hasEvent(run, 6), `the flicker is judged against the new note and dropped at K_min=${k}`);
    }
  }
});

test("a repeat on a pitch whose previous attack was never emitted in this recording is admitted at every rung", async () => {
  // The first frame is already sustain: the note was sounding before the
  // recording, so the decoder emits no onset for it and the decoder has no
  // emitted attack to measure a gap against. The repeat is admitted at every
  // rung — including K_min=1, which is exactly what keeps the anchor an exact
  // reproduction of the control — and the emission starts the pitch's clock.
  const frames: FrameSpec[] = [
    { probability: 0.2, state: 2 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.equal(control.events.length, 1, "the control emits only the renewed attack, not an onset for the first frame");
  assert.ok(hasEvent(control, 1), "the control emits the repeat");
  for (const k of [1, 2, 3, 4]) {
    const run = await runRearm(trace, k);
    assert.ok(isSubset(control, run), `the module never emits a candidate the control did not (K_min=${k})`);
    assert.ok(hasEvent(run, 1), `a pitch with no emitted attack has no gap to be too close (K_min=${k})`);
    assert.equal(run.completion?.pendingCandidates, 0);
  }
});

test("a tail-flush frame never carries a candidate and the module stays a subset of the control at every rung", async () => {
  // The last real frame is a reOnset one frame after a released sustain; the
  // following frame is end padding (no input samples).
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 },
  ];
  const trace = await syntheticTrace(frames, 1); // one trailing tail-flush frame
  const control = await runControl(trace);
  assert.ok(hasEvent(control, 1) && hasEvent(control, 3), "the control emits both attacks on real frames");
  assert.ok(!hasEvent(control, 4), "the control emits nothing on the tail-flush frame");
  for (const k of [1, 2, 3, 4]) {
    const run = await runRearm(trace, k);
    assert.ok(isSubset(control, run), `the module never emits a candidate the control did not (K_min=${k})`);
    assert.ok(!hasEvent(run, 4), `no candidate is attributed to the tail-flush frame (K_min=${k})`);
    assert.ok(hasEvent(run, 1), `the new note passes through (K_min=${k})`);
  }
  assert.ok(hasEvent(await runRearm(trace, 2), 3), "the two-frame-gap repeat survives K_min=2");
  assert.ok(!hasEvent(await runRearm(trace, 4), 3), "the two-frame-gap repeat is dropped at K_min=4");
});

test("on a mixed take the module is a subset of the control, adds no delay, and each rung admits exactly the gaps it was frozen for", async () => {
  // One note with a one-frame flicker and two released repeats, then a second
  // note with its own one-frame flicker. The gap of a repeat is measured from
  // the pitch's last *emitted* attack, so a rung that drops one repeat measures
  // the next one against a different baseline: at K_min=3 the gap-3 repeat at
  // frame 4 is admitted and re-arms the clock, which drops the frame-6 repeat;
  // at K_min=4 the frame-4 repeat is itself dropped, the clock stays at the
  // onset, and the frame-6 repeat is admitted. The rungs are therefore not a
  // nested-subset family, and the assertion is the exact per-rung set.
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 }, // note A onset
    { probability: 0.9, state: 4 }, // flicker, gap 1
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 }, // released repeat, gap 3 from the onset
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 }, // repeat, gap 2 from the frame-4 repeat
    { probability: 0, state: 1 }, // offset
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 }, // note B onset
    { probability: 0.9, state: 4 }, // flicker B, gap 1
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  const expect = (frameIndexes: number[]) =>
    new Set(
      frameIndexes.map((index) => `${MIDI}:${onsetMsOfFrame(index)}`),
    );
  assert.deepEqual(
    keySet(control),
    expect([1, 2, 4, 6, 9, 10]),
    "the control emits all six attacks of the take",
  );
  const k1 = await runRearm(trace, 1);
  const k2 = await runRearm(trace, 2);
  const k3 = await runRearm(trace, 3);
  const k4 = await runRearm(trace, 4);
  // Invariant one: the rule only post-processes the control's candidates.
  for (const [run, k] of [[k1, 1], [k2, 2], [k3, 3], [k4, 4]] as const) {
    assert.ok(isSubset(control, run), `the module never emits a candidate the control did not (K_min=${k})`);
  }
  // Invariant two: the exact per-rung admission, hand-computed from the
  // frozen convention (emit a repeat only if its frame is at least K_min after
  // the pitch's last emitted attack; a suppressed repeat never moves that
  // clock; a new note always passes and resets it).
  assert.deepEqual(keySet(k1), expect([1, 2, 4, 6, 9, 10]), "K_min=1 is the control");
  assert.deepEqual(keySet(k2), expect([1, 4, 6, 9]), "K_min=2 drops both one-frame flickers and keeps both released repeats");
  assert.deepEqual(keySet(k3), expect([1, 4, 9]), "K_min=3 keeps the gap-3 repeat, which re-arms the clock and drops the gap-2 repeat");
  assert.deepEqual(keySet(k4), expect([1, 6, 9]), "K_min=4 drops the gap-3 repeat, so the clock still points at the onset and the frame-6 repeat is admitted");
  // Invariant three: the rule decides on the firing frame, so it adds no delay
  // and holds nothing, at every rung.
  for (const [run, k] of [[k1, 1], [k2, 2], [k3, 3], [k4, 4]] as const) {
    for (const event of run.events) {
      assert.equal(event.addedDelayMs, 0);
      assert.equal(event.waitedFrames, 0);
    }
    assert.equal(run.completion?.pendingCandidates, 0, `a suppressed repeat is dropped on the spot, never held (K_min=${k})`);
  }
});
