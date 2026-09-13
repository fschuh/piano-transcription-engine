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
async function runGate(
  trace: OnlineAmtCaptureTrace,
  rearmFrames: number,
  rearmThreshold = 0.15,
): Promise<Run> {
  return runExperimentDecoder(trace, {
    decoderId: "rearmRepeatGate",
    configuration: { rearmFrames, rearmThreshold },
    onsetEstimateLagMs: LAG,
  });
}

test("rearmRepeatGate declares its own id and file name", async () => {
  const module = await loadExperimentDecoderModule("rearmRepeatGate");
  assert.equal(module.id, "rearmRepeatGate");
  assert.equal(typeof module.summary, "string");
  assert.ok(module.summary.length > 0);
});

test("each frozen E02 configuration normalises to itself", async () => {
  const module = await loadExperimentDecoderModule("rearmRepeatGate");
  // E02-B / E02-C / E02-D
  assert.deepEqual(module.validateConfiguration({ rearmFrames: 1, rearmThreshold: 0.15 }), { rearmFrames: 1, rearmThreshold: 0.15 });
  assert.deepEqual(module.validateConfiguration({ rearmFrames: 2, rearmThreshold: 0.15 }), { rearmFrames: 2, rearmThreshold: 0.15 });
  assert.deepEqual(module.validateConfiguration({ rearmFrames: 3, rearmThreshold: 0.15 }), { rearmFrames: 3, rearmThreshold: 0.15 });
});

test("configuration validation rejects malformed parameters", async () => {
  const module = await loadExperimentDecoderModule("rearmRepeatGate");
  const good = { rearmFrames: 1, rearmThreshold: 0.15 };
  assert.throws(() => module.validateConfiguration({ ...good, releaseThreshold: 0.15 }), /is not a parameter/);
  assert.throws(() => module.validateConfiguration({ ...good, rearmFrames: 1.5 }), /whole number/);
  assert.throws(() => module.validateConfiguration({ ...good, rearmFrames: 0 }), /at least 1/);
  assert.throws(() => module.validateConfiguration({ ...good, rearmFrames: 17 }), /at most 16/);
  assert.throws(() => module.validateConfiguration({ ...good, rearmThreshold: 1.5 }), /at most 1/);
  assert.throws(() => module.validateConfiguration({ ...good, rearmThreshold: -0.1 }), /at least 0/);
});

test("a renewed attack that fires before any sub-threshold release is dropped at every K", async () => {
  // off -> onset -> reOnset: the reOnset is a flicker one frame after the onset,
  // with no release valley in between, so the pitch is never armed to repeat.
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  for (const rearmFrames of [1, 2, 3]) {
    const control = await runControl(trace);
    const run = await runGate(trace, rearmFrames);
    assert.ok(hasEvent(control, 1), "the control emits the new-note onset");
    assert.ok(hasEvent(control, 2), "the control emits the renewed attack");
    assert.ok(hasEvent(run, 1), `the new-note onset is kept (K=${rearmFrames})`);
    assert.ok(!hasEvent(run, 2), `the not-yet-rearmed repeat is dropped (K=${rearmFrames})`);
  }
});

test("a genuine repeat preceded by a one-frame release is kept at K=1 and dropped at K=2", async () => {
  // off -> onset -> sustain(low) -> reOnset: the sustain is a one-frame release.
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  assert.ok(hasEvent(control, 3), "the control emits the released repeat");
  const kept = await runGate(trace, 1);
  assert.ok(hasEvent(kept, 3), "one low frame re-arms the pitch, so K=1 keeps the repeat");
  const strict = await runGate(trace, 2);
  assert.ok(!hasEvent(strict, 3), "K=2 needs two low frames, so the one-frame release is not enough");
});

test("a two-frame release re-arms at K=2 and a three-frame release is needed for K=3", async () => {
  const two: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2 },
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const three: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2 },
    { probability: 0.05, state: 2 },
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace2 = await syntheticTrace(two);
  assert.ok(hasEvent(await runGate(trace2, 2), 4), "two low frames re-arm at K=2");
  assert.ok(!hasEvent(await runGate(trace2, 3), 4), "two low frames are not enough for K=3");
  const trace3 = await syntheticTrace(three);
  assert.ok(hasEvent(await runGate(trace3, 3), 5), "three low frames re-arm at K=3");
});

test("a new note from off/offset passes through exactly as the control, with no added delay", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  const run = await runGate(trace, 1);
  const controlEvent = control.events.find((event) => event.midi === MIDI && event.onsetMs === onsetMsOfFrame(1));
  const event = run.events.find((event) => event.midi === MIDI && event.onsetMs === onsetMsOfFrame(1));
  assert.ok(controlEvent && event, "the new-note onset is present in both the control and the module");
  assert.equal(event!.onsetMs, controlEvent!.onsetMs);
  assert.equal(event!.availableAtMs, controlEvent!.availableAtMs);
  assert.equal(event!.addedDelayMs, 0);
  assert.equal(event!.waitedFrames, 0);
});

test("a suppressed frame in the middle of a release breaks the valley, so the repeat is dropped", async () => {
  const released: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2 },
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  // Identical to `released` except the second low frame is suppressed: a suppressed
  // frame reads null for every accessor, so it supplies no valley evidence.
  const interrupted: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2 },
    { probability: 0.05, state: 2, active: false },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const traceA = await syntheticTrace(released);
  const traceB = await syntheticTrace(interrupted);
  assert.ok(hasEvent(await runGate(traceA, 2), 4), "two low frames re-arm the pitch (K=2)");
  assert.ok(!hasEvent(await runGate(traceB, 2), 4), "a suppressed frame breaks the run, so the repeat is dropped (K=2)");
});

test("tail-flush frames supply no valley evidence and are not treated as a release", async () => {
  // The last frame is a tail-flush frame (no input samples). A repeat on the last
  // real frame is still decided only on evidence that arrived; the flush adds none.
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 },
  ];
  const trace = await syntheticTrace(frames, 1); // one trailing tail-flush frame
  const control = await runControl(trace);
  const run = await runGate(trace, 1);
  // The module only post-processes the control: whatever it emits is in the control.
  assert.ok(isSubset(control, run), "the module never emits a candidate the control did not");
  // And the one-frame release keeps the repeat at K=1.
  assert.ok(hasEvent(control, 3), "the control emits the released repeat");
  assert.ok(hasEvent(run, 3), "K=1 keeps the released repeat");
});

test("a pending count is zero because the gate decides each repeat on the frame it fires", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const run = await runGate(trace, 1);
  assert.equal(run.completion?.pendingCandidates, 0);
});

test("on a mixed take the module is a subset of the control, strictly monotone in K, and adds no delay", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 }, // note A onset
    { probability: 0.9, state: 4 }, // flicker (no release)
    { probability: 0.05, state: 2 }, // release begins
    { probability: 0.05, state: 2 },
    { probability: 0.9, state: 4 }, // genuine reOnset after release
    { probability: 0.9, state: 4 }, // immediate second reOnset (no new release)
    { probability: 0, state: 1 }, // offset
    { probability: 0, state: 0 },
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 }, // note B onset
    { probability: 0.9, state: 4 }, // flicker
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  const k1 = await runGate(trace, 1);
  const k2 = await runGate(trace, 2);
  const k3 = await runGate(trace, 3);
  // Invariant one: the gate only post-processes the control's candidates.
  assert.ok(isSubset(control, k1), "the module never emits a candidate the control did not (K=1)");
  assert.ok(isSubset(control, k2), "the module never emits a candidate the control did not (K=2)");
  // Invariant two: a stricter K can only suppress more, never less.
  assert.ok(isSubset(k1, k2), "K=2 is a subset of K=1");
  assert.ok(isSubset(k2, k3), "K=3 is a subset of K=2");
  // Invariant three: the gate decides on the firing frame, so it adds no delay.
  for (const run of [k1, k2, k3]) {
    for (const event of run.events) {
      assert.equal(event.addedDelayMs, 0);
      assert.equal(event.waitedFrames, 0);
    }
  }
});

// --- E04: the depth ladder. The rearm frame is held at 1 (E02-B's K) and the
// single varied factor is how far below 0.15 the minimum unweighted attack
// probability since the previous attack must fall: 0.15 (the E02-B anchor),
// 0.10, 0.05.

test("each frozen E04 configuration normalises to itself", async () => {
  const module = await loadExperimentDecoderModule("rearmRepeatGate");
  // E04-B / E04-C / E04-D: rearmFrames held at 1, the depth varies.
  assert.deepEqual(
    module.validateConfiguration({ rearmFrames: 1, rearmThreshold: 0.15 }),
    { rearmFrames: 1, rearmThreshold: 0.15 },
  );
  assert.deepEqual(
    module.validateConfiguration({ rearmFrames: 1, rearmThreshold: 0.1 }),
    { rearmFrames: 1, rearmThreshold: 0.1 },
  );
  assert.deepEqual(
    module.validateConfiguration({ rearmFrames: 1, rearmThreshold: 0.05 }),
    { rearmFrames: 1, rearmThreshold: 0.05 },
  );
});

test("a one-frame dip to (0.10, 0.15] re-arms at 0.15 but not at 0.10 or 0.05", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.12, state: 2 }, // shallow dip: crosses 0.15, never bottoms at 0.10
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  assert.ok(hasEvent(await runControl(trace), 3), "the control emits the renewed attack");
  assert.ok(hasEvent(await runGate(trace, 1, 0.15), 3), "0.12 is at or below 0.15, so the anchor keeps the repeat");
  assert.ok(!hasEvent(await runGate(trace, 1, 0.1), 3), "0.12 never bottoms at or below 0.10, so the deeper step drops it");
  assert.ok(!hasEvent(await runGate(trace, 1, 0.05), 3), "0.12 never bottoms at or below 0.05, so the deepest step drops it");
});

test("a one-frame dip to (0.05, 0.10] re-arms at 0.15 and 0.10 but not at 0.05", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.08, state: 2 }, // moderate dip: crosses 0.10, never bottoms at 0.05
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  assert.ok(hasEvent(await runControl(trace), 3), "the control emits the renewed attack");
  assert.ok(hasEvent(await runGate(trace, 1, 0.15), 3), "0.08 is at or below 0.15, so the anchor keeps the repeat");
  assert.ok(hasEvent(await runGate(trace, 1, 0.1), 3), "0.08 is at or below 0.10, so the middle step keeps the repeat");
  assert.ok(!hasEvent(await runGate(trace, 1, 0.05), 3), "0.08 never bottoms at or below 0.05, so the deepest step drops it");
});

test("a one-frame dip to <=0.05 re-arms at every frozen depth", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.03, state: 2 }, // a real-release dip: at or below every frozen depth
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  assert.ok(hasEvent(await runControl(trace), 3), "the control emits the renewed attack");
  assert.ok(hasEvent(await runGate(trace, 1, 0.15), 3), "the anchor keeps the deep-dip repeat");
  assert.ok(hasEvent(await runGate(trace, 1, 0.1), 3), "the middle step keeps the deep-dip repeat");
  assert.ok(hasEvent(await runGate(trace, 1, 0.05), 3), "the deepest step keeps the deep-dip repeat");
});

test("on a mixed take the gate is strictly monotone in depth at K=1, adds no delay, and holds nothing", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 }, // note A onset
    { probability: 0.9, state: 4 }, // flicker, no release
    { probability: 0.12, state: 2 }, // shallow dip: re-arms at 0.15 only
    { probability: 0.9, state: 4 }, // R1
    { probability: 0.08, state: 2 }, // moderate dip: re-arms at 0.15 and 0.10
    { probability: 0.9, state: 4 }, // R2
    { probability: 0.03, state: 2 }, // deep dip: re-arms at every depth
    { probability: 0.9, state: 4 }, // R3
    { probability: 0, state: 1 }, // offset
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 }, // note B onset
    { probability: 0.9, state: 4 }, // flicker B, no release
    { probability: 0, state: 0 },
  ];
  const trace = await syntheticTrace(frames);
  const control = await runControl(trace);
  const loose = await runGate(trace, 1, 0.15);
  const mid = await runGate(trace, 1, 0.1);
  const deep = await runGate(trace, 1, 0.05);
  // The control's full attack list: both onsets, all three released repeats, both flickers.
  assert.ok(
    hasEvent(control, 1) && hasEvent(control, 2) && hasEvent(control, 4)
      && hasEvent(control, 6) && hasEvent(control, 8) && hasEvent(control, 11) && hasEvent(control, 12),
    "the control emits every attack of the take",
  );
  // Invariant one: the gate only post-processes the control's candidates.
  assert.ok(isSubset(control, loose), "the 0.15 module never emits a candidate the control did not");
  // Invariant two: a deeper bar can only suppress more, never less — strictly, here.
  assert.ok(isSubset(loose, mid), "0.10 is a subset of 0.15");
  assert.ok(isSubset(mid, deep), "0.05 is a subset of 0.10");
  // And each step removes exactly what its band predicts on this take.
  assert.ok(hasEvent(loose, 4) && !hasEvent(mid, 4), "the shallow dip re-arms at 0.15 only, so R1 survives the anchor alone");
  assert.ok(hasEvent(mid, 6) && !hasEvent(deep, 6), "the moderate dip re-arms at 0.15 and 0.10, so R2 survives them alone");
  assert.ok(hasEvent(deep, 8), "the true-release dip re-arms at every depth, so R3 survives the deepest bar");
  assert.ok(!hasEvent(loose, 2) && !hasEvent(loose, 12), "the flickers without any release are dropped at the anchor too");
  // Invariant three: the gate decides on the firing frame, so it adds no delay
  // and holds nothing, at every depth.
  for (const run of [loose, mid, deep]) {
    for (const event of run.events) {
      assert.equal(event.addedDelayMs, 0);
      assert.equal(event.waitedFrames, 0);
    }
    assert.equal(run.completion?.pendingCandidates, 0, "a suppressed repeat is dropped on the spot, never held");
  }
});

test("a suppressed frame is not a low-probability frame at K=1, and a real low frame before it keeps the arm", async () => {
  // The release frame is real; a suppressed frame lands between the release and
  // the repeat. The arm is sticky at K=1, so the repeat survives the gap.
  const kept: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.08, state: 2 },
    { probability: 0.08, state: 2, active: false },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  // The would-be release frame is suppressed, so no low reading ever arrives.
  const unbacked: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.08, state: 2, active: false },
    { probability: 0.9, state: 4 },
    { probability: 0, state: 0 },
  ];
  const traceKept = await syntheticTrace(kept);
  const traceUnbacked = await syntheticTrace(unbacked);
  assert.ok(hasEvent(await runGate(traceKept, 1, 0.1), 4), "a real low frame arms the pitch even when the next frame is suppressed");
  assert.ok(!hasEvent(await runGate(traceUnbacked, 1, 0.15), 3), "a suppressed frame supplies no low reading, so the repeat is dropped at 0.15");
  assert.ok(!hasEvent(await runGate(traceUnbacked, 1, 0.1), 3), "… and at 0.10");
  assert.ok(!hasEvent(await runGate(traceUnbacked, 1, 0.05), 3), "… and at 0.05");
});

test("a tail-flush frame never supplies a low reading, at the deeper E04 depths", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },
    { probability: 0.9, state: 3 },
    { probability: 0.08, state: 2 },
    { probability: 0.9, state: 4 },
  ];
  const trace = await syntheticTrace(frames, 1); // one trailing tail-flush frame
  const control = await runControl(trace);
  const mid = await runGate(trace, 1, 0.1);
  const deep = await runGate(trace, 1, 0.05);
  assert.ok(isSubset(control, mid), "the module never emits a candidate the control did not (0.10)");
  assert.ok(isSubset(control, deep), "the module never emits a candidate the control did not (0.05)");
  assert.ok(hasEvent(mid, 3), "the 0.08 release arrived before the flush, so 0.10 keeps the repeat");
  assert.ok(!hasEvent(deep, 3), "0.08 never bottoms at or below 0.05, so the deepest step drops the repeat; the flush adds no evidence either way");
});
