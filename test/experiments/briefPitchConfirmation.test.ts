import assert from "node:assert/strict";
import test from "node:test";

import {
  captureOnlineAmtTrace,
  loadExperimentDecoderModule,
  runExperimentDecoder,
  type OnlineAmtCaptureTrace,
} from "../../src/eval/index.js";

// The module under test is reached the same way the runner reaches it: by id,
// through the eval entry point. The direct file import the boundary test exists
// to forbid would let a test reach the module without travelling the candidate
// loading path, so the module is loaded with `loadExperimentDecoderModule`.

const LAG = 160;
/** The single pitch the synthetic trace drives; pitch index 39 is MIDI 60. */
const MIDI = 60;

type FrameSpec = { probability: number; state: number; active?: boolean };

/**
 * One synthetic take, written as the attack probability and selected state of a
 * single pitch per frame. Only MIDI 60 (pitch index 39) is ever driven; every
 * other pitch stays at `off`, so any onset the decoder reports is about MIDI 60.
 */
async function syntheticTrace(
  frames: FrameSpec[],
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

/** A frame captured at (index+1) * 32 ms, so its onset estimate is that minus the lag. */
function onsetMsOfFrame(frameIndex: number): number {
  return (frameIndex + 1) * 32 - LAG;
}
function onsetKey(frameIndex: number): string {
  return `${MIDI}:${onsetMsOfFrame(frameIndex)}`;
}

/**
 * The independent oracle for the gate: for the driven pitch, which frame indices are
 * an `off`/`offset` -> `onset` transition, and does the following K-frame window keep
 * presence at or above the threshold. This mirrors the module's rule so a test can
 * check the decision without re-deriving it by hand.
 */
function gateOracle(frames: FrameSpec[], confirmationFrames: number, threshold: number) {
  const rows: { origin: number; confirms: boolean }[] = [];
  for (let f = 0; f < frames.length; f += 1) {
    const current = frames[f]!.state;
    const previous = f > 0 ? frames[f - 1]!.state : -1;
    const isGated = current === 3 && (previous === 0 || previous === 1);
    if (!isGated) continue;
    let confirms = true;
    for (let k = 1; k <= confirmationFrames; k += 1) {
      const follow = f + k;
      if (follow >= frames.length) { confirms = false; break; }
      const frame = frames[follow]!;
      const presence = frame.active === false ? null : frame.probability;
      if (presence === null || presence < threshold) { confirms = false; break; }
    }
    rows.push({ origin: f, confirms });
  }
  return rows;
}

test("briefPitchConfirmation declares its own id and file name", async () => {
  const briefPitchConfirmation = await loadExperimentDecoderModule("briefPitchConfirmation");
  assert.equal(briefPitchConfirmation.id, "briefPitchConfirmation");
  assert.equal(typeof briefPitchConfirmation.summary, "string");
  assert.ok(briefPitchConfirmation.summary.length > 0);
});

test("a valid E01-B configuration normalises to itself", async () => {
  const module = await loadExperimentDecoderModule("briefPitchConfirmation");
  const value = { confirmationFrames: 1, presenceThreshold: 0.5, gatedTransitions: ["off", "offset"] };
  assert.deepEqual(module.validateConfiguration(value), value);
});

test("a valid E01-C configuration (two-frame confirmation) normalises to itself", async () => {
  const module = await loadExperimentDecoderModule("briefPitchConfirmation");
  const value = { confirmationFrames: 2, presenceThreshold: .5, gatedTransitions: ["off", "offset"] };
  assert.deepEqual(module.validateConfiguration(value), value);
});

test("configuration validation rejects malformed parameters", async () => {
  const module = await loadExperimentDecoderModule("briefPitchConfirmation");
  const good = { confirmationFrames: 1, presenceThreshold: 0.5, gatedTransitions: ["off", "offset"] };
  assert.throws(() => module.validateConfiguration({ ...good, threshold: 0.3 }), /is not a parameter/);
  assert.throws(() => module.validateConfiguration({ ...good, confirmationFrames: 1.5 }), /whole number/);
  assert.throws(() => module.validateConfiguration({ ...good, confirmationFrames: 0 }), /at least 1/);
  assert.throws(() => module.validateConfiguration({ ...good, presenceThreshold: 1.5 }), /at most 1/);
  assert.throws(() => module.validateConfiguration({ ...good, presenceThreshold: -0.1 }), /at least 0/);
  assert.throws(() => module.validateConfiguration({ ...good, gatedTransitions: ["on"] }), /not one of/);
  assert.throws(() => module.validateConfiguration({ ...good, gatedTransitions: [] }), /non-empty/);
  assert.throws(() => module.validateConfiguration({ ...good, gatedTransitions: "off" }), /non-empty/);
});

test("a sustained off -> onset is kept but its availability is delayed one frame (E01-B)", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },     // off
    { probability: 0.9, state: 3 },   // onset: gated, held
    { probability: 0.9, state: 2 },   // sustain: presence 0.9 confirms
    { probability: 0, state: 0 },     // off
  ];
  const trace = await syntheticTrace(frames);
  const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const run = await runExperimentDecoder(trace, {
    decoderId: "briefPitchConfirmation",
    configuration: { confirmationFrames: 1, presenceThreshold: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });

  // The control sees the off -> onset attack; the module must keep it, too.
  assert.ok(
    control.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1)),
    "the control should emit the sustained onset",
  );
  const event = run.events.find((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1));
  assert.ok(event, "the gated onset is preserved once its following frame confirms it");
  // The decision is unchanged; only the availability moves one frame later.
  assert.equal(event!.addedDelayMs, 32);
  assert.equal(event!.waitedFrames, 1);
  assert.deepEqual(event!.transition, { from: "off", to: "onset" });
});

test("a fleeting off -> onset that dies a frame later is removed", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },     // off
    { probability: 0.9, state: 3 },   // onset: gated, held
    { probability: 0, state: 0 },     // off: presence collapses below the threshold
    { probability: 0, state: 0 },     // off
  ];
  const trace = await syntheticTrace(frames);
  const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const run = await runExperimentDecoder(trace, {
    decoderId: "briefPitchConfirmation",
    configuration: { confirmationFrames: 1, presenceThreshold: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });

  // The control emits the transient extra; that is precisely what the gate exists to drop.
  assert.ok(
    control.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1)),
    "the control should emit the fleeting onset",
  );
  assert.ok(
    !run.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1)),
    "the fleeting onset must not be emitted once its following presence is gone",
  );
  // It was rejected mid-recording by a delivered frame, not left pending.
  assert.equal(run.completion?.pendingCandidates ?? 0, 0);
});

test("a suppressed following frame carries no confirmation evidence, so the candidate is lost", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },              // off
    { probability: 0.9, state: 3 },           // onset: gated, held
    { probability: 0.9, state: 2, active: false }, // suppressed: every accessor reads null
    { probability: 0, state: 0 },              // off
  ];
  const trace = await syntheticTrace(frames);
  const run = await runExperimentDecoder(trace, {
    decoderId: "briefPitchConfirmation",
    configuration: { confirmationFrames: 1, presenceThreshold: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });
  assert.ok(
    !run.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1)),
    "a candidate whose following frame is suppressed is not confirmed and is not emitted",
  );
  // The suppression resolved the candidate on a delivered frame, so it is not pending.
  assert.equal(run.completion?.pendingCandidates ?? 0, 0);
});

test("an end-of-recording candidate that never confirms is reported as pending, not emitted", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },    // off
    { probability: 0.9, state: 3 },  // onset: gated, but this is the last frame delivered
  ];
  const trace = await syntheticTrace(frames);
  const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const run = await runExperimentDecoder(trace, {
    decoderId: "briefPitchConfirmation",
    configuration: { confirmationFrames: 1, presenceThreshold: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });
  assert.ok(
    control.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1)),
    "the control should emit the onset at the end of the take",
  );
  assert.ok(
    !run.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1)),
    "the unconfirmed end-of-take candidate is not emitted",
  );
  assert.equal(run.completion?.pendingCandidates, 1);
  assert.ok(String(run.completion?.notes ?? "").includes("owed confirmation"), "the pending note explains the loss");
});

test("a non-gated onset (sustain -> onset) passes through immediately, exactly as the control", async () => {
  const frames: FrameSpec[] = [
    { probability: 0.9, state: 2 },  // sustain
    { probability: 0.9, state: 3 },  // onset from sustain: previous is not off/offset, so not gated
    { probability: 0.9, state: 2 },  // sustain
  ];
  const trace = await syntheticTrace(frames);
  const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const run = await runExperimentDecoder(trace, {
    decoderId: "briefPitchConfirmation",
    configuration: { confirmationFrames: 1, presenceThreshold: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });
  const controlEvent = control.events.find((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1));
  const event = run.events.find((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1));
  assert.ok(controlEvent && event, "the sustain -> onset attack is emitted by both");
  // Not gated, so it is not delayed: same availability, same onset, no added delay.
  assert.equal(event!.onsetMs, controlEvent!.onsetMs);
  assert.equal(event!.availableAtMs, controlEvent!.availableAtMs);
  assert.equal(event!.addedDelayMs, 0);
  assert.equal(event!.waitedFrames, 0);
});

test("a two-frame confirmation window (E01-C) waits twice as long before emitting", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },     // off
    { probability: 0.9, state: 3 },   // onset: gated, held for two frames
    { probability: 0.9, state: 2 },   // sustain: confirms frame one
    { probability: 0.9, state: 2 },   // sustain: confirms frame two -> emit here
    { probability: 0, state: 0 },     // off
  ];
  const trace = await syntheticTrace(frames);
  const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const run = await runExperimentDecoder(trace, {
    decoderId: "briefPitchConfirmation",
    configuration: { confirmationFrames: 2, presenceThreshold: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });
  const event = run.events.find((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1));
  assert.ok(event, "a sustained onset is preserved across a two-frame confirmation window");
  assert.ok(
    control.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1)),
    "the control emits the same onset",
  );
  assert.equal(event!.addedDelayMs, 64);
  assert.equal(event!.waitedFrames, 2);
});

test("the module never emits a candidate the control did not, and drops exactly the unconfirmed gates", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },     // f0 off
    { probability: 0.9, state: 3 },   // f1 off->onset: gated, confirmed by f2
    { probability: 0.9, state: 2 },   // f2 sustain (confirms f1)
    { probability: 0, state: 0 },     // f3 off
    { probability: 0.9, state: 3 },   // f4 off->onset: gated, rejected (f5 presence 0)
    { probability: 0, state: 0 },     // f5 off
    { probability: 0.9, state: 2 },   // f6 sustain
    { probability: 0.9, state: 3 },   // f7 sustain->onset: NOT gated, emitted immediately
    { probability: 0.9, state: 2 },   // f8 sustain
  ];
  const threshold = 0.5;
  const trace = await syntheticTrace(frames);
  const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const run = await runExperimentDecoder(trace, {
    decoderId: "briefPitchConfirmation",
    configuration: { confirmationFrames: 1, presenceThreshold: threshold, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });

  // Invariant one: the module only post-processes the control's candidates, so it
  // never adds an attack the control did not produce.
  const controlKeys = new Set(control.events.map((e) => `${e.midi}:${e.onsetMs}`));
  for (const event of run.events) {
    assert.ok(controlKeys.has(`${event.midi}:${event.onsetMs}`), "module emitted a candidate the control did not");
  }

  // Invariant two: every gated transition the oracle names is handled as expected.
  const oracle = gateOracle(frames, 1, threshold);
  for (const row of oracle) {
    const key = onsetKey(row.origin);
    const inModule = run.events.some((e) => `${e.midi}:${e.onsetMs}` === key);
    if (row.confirms) {
      assert.ok(inModule, `confirmed gated onset at frame ${row.origin} was dropped by the module`);
    } else {
      assert.ok(!inModule, `unconfirmed gated onset at frame ${row.origin} was emitted by the module`);
    }
  }

  // Invariant three: a non-gated onset is passed through with unchanged timing.
  const immediate = run.events.find((e) => `${e.midi}:${e.onsetMs}` === onsetKey(7));
  const controlImmediate = control.events.find((e) => `${e.midi}:${e.onsetMs}` === onsetKey(7));
  assert.ok(immediate && controlImmediate, "the sustain -> onset attack is present in both");
  assert.equal(immediate!.availableAtMs, controlImmediate!.availableAtMs);
  assert.equal(immediate!.addedDelayMs, 0);
});
