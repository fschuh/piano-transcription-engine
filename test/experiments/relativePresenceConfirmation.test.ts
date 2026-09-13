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
 * The independent oracle for the gate: for the driven pitch, which frame indices
 * are an `off`/`offset` -> `onset` transition, and does the following K-frame
 * window keep presence at or above the fraction of the transition frame's own
 * presence. This mirrors the module's rule so a test can check the decision
 * without re-deriving it by hand.
 */
function gateOracle(frames: FrameSpec[], confirmationFrames: number, fraction: number) {
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
      if (presence === null) { confirms = false; break; }
      if (presence < fraction * frames[f]!.probability) { confirms = false; break; }
    }
    rows.push({ origin: f, confirms });
  }
  return rows;
}

test("relativePresenceConfirmation declares its own id and file name", async () => {
  const module = await loadExperimentDecoderModule("relativePresenceConfirmation");
  assert.equal(module.id, "relativePresenceConfirmation");
  assert.equal(typeof module.summary, "string");
  assert.ok(module.summary.length > 0);
});

test("each frozen E03 candidate configuration normalises to itself", async () => {
  const module = await loadExperimentDecoderModule("relativePresenceConfirmation");
  for (const presenceFraction of [0.5, 0.7, 0.9]) {
    const value = { confirmationFrames: 2, presenceFraction, gatedTransitions: ["off", "offset"] };
    assert.deepEqual(module.validateConfiguration(value), value);
  }
});

test("configuration validation rejects malformed parameters", async () => {
  const module = await loadExperimentDecoderModule("relativePresenceConfirmation");
  const good = { confirmationFrames: 2, presenceFraction: 0.5, gatedTransitions: ["off", "offset"] };
  assert.throws(() => module.validateConfiguration({ ...good, fraction: 0.3 }), /is not a parameter/);
  assert.throws(() => module.validateConfiguration({ ...good, confirmationFrames: 1.5 }), /whole number/);
  assert.throws(() => module.validateConfiguration({ ...good, confirmationFrames: 0 }), /at least 1/);
  assert.throws(() => module.validateConfiguration({ ...good, presenceFraction: 1.5 }), /at most 1/);
  assert.throws(() => module.validateConfiguration({ ...good, presenceFraction: -0.1 }), /at least 0/);
  assert.throws(() => module.validateConfiguration({ ...good, gatedTransitions: ["on"] }), /not one of/);
  assert.throws(() => module.validateConfiguration({ ...good, gatedTransitions: [] }), /non-empty/);
  assert.throws(() => module.validateConfiguration({ ...good, gatedTransitions: "off" }), /non-empty/);
});

test("a note whose follow-up holds most of a low onset survives the relative bar the absolute bar failed", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },        // f0 off
    { probability: 0.9, state: 3 },      // f1 off->onset: gated; onset presence ~0.9
    { probability: 0.47, state: 2 },    // f2 sustain: 0.47 is below the absolute 0.5 but a large share of 0.9
    { probability: 0.47, state: 2 },    // f3 sustain: second confirming frame -> emitted here
    { probability: 0, state: 0 },      // f4 off
  ];
  const trace = await syntheticTrace(frames);
  const absolute = await runExperimentDecoder(trace, {
    decoderId: "briefPitchConfirmation",
    configuration: { confirmationFrames: 2, presenceThreshold: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });
  const run = await runExperimentDecoder(trace, {
    decoderId: "relativePresenceConfirmation",
    configuration: { confirmationFrames: 2, presenceFraction: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });

  // The follow-up presence (0.47) sits below the absolute bar E01 used, so the
  // absolute gate trades this genuine note away — the recall collapse the E01
  // measurements recorded. The same reading is a large fraction of the onset's
  // own presence, so the relative gate keeps the note.
  assert.ok(
    !absolute.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1)),
    "the E01 absolute 0.5 bar drops a note whose follow-up presence is 0.47",
  );
  const event = run.events.find((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1));
  assert.ok(event, "the relative 50% bar keeps a note whose follow-up holds most of its onset");
  assert.equal(event!.addedDelayMs, 64);
  assert.equal(event!.waitedFrames, 2);
  assert.deepEqual(event!.transition, { from: "off", to: "onset" });
});

test("a fleeting off -> onset whose second follow-up collapses is dropped at every frozen fraction", async () => {
  // The gold transient signature from the E01 development inspection: presence
  // ~0.606 at detection, ~0.46 at the first follow-up frame, ~0.009 by the
  // second — collapsed to near zero, below any fraction of its own onset.
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },        // f0 off
    { probability: 0.6, state: 3 },      // f1 off->onset: gated; onset presence ~0.6
    { probability: 0.46, state: 2 },    // f2 sustain: a large fraction of the onset, so it passes
    { probability: 0.009, state: 2 },   // f3 sustain: near-zero, below every bar in the family
    { probability: 0, state: 0 },       // f4 off
  ];
  const trace = await syntheticTrace(frames);
  for (const presenceFraction of [0.5, 0.7, 0.9]) {
    const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
    const run = await runExperimentDecoder(trace, {
      decoderId: "relativePresenceConfirmation",
      configuration: { confirmationFrames: 2, presenceFraction, gatedTransitions: ["off", "offset"] },
      onsetEstimateLagMs: LAG,
    });
    assert.ok(
      control.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1)),
      `the control should emit the fleeting onset (fraction ${presenceFraction})`,
    );
    assert.ok(
      !run.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1)),
      `the transient must not be emitted at fraction ${presenceFraction}: its second follow-up is near zero`,
    );
    // It was rejected mid-recording by a delivered frame, not left pending.
    assert.equal(run.completion?.pendingCandidates ?? 0, 0);
  }
});

test("one factor, the fraction: the same 67% follow-up is kept at 0.5 and dropped at 0.7 and 0.9", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },        // f0 off
    { probability: 0.9, state: 3 },      // f1 off->onset: gated; onset presence ~0.9
    { probability: 0.6, state: 2 },     // f2 sustain: ~0.67 of the onset
    { probability: 0.6, state: 2 },     // f3 sustain
    { probability: 0, state: 0 },       // f4 off
  ];
  const trace = await syntheticTrace(frames);
  for (const [presenceFraction, keeps] of [[0.5, true], [0.7, false], [0.9, false]] as const) {
    const run = await runExperimentDecoder(trace, {
      decoderId: "relativePresenceConfirmation",
      configuration: { confirmationFrames: 2, presenceFraction, gatedTransitions: ["off", "offset"] },
      onsetEstimateLagMs: LAG,
    });
    const present = run.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1));
    assert.equal(present, keeps, `fraction ${presenceFraction} should ${keeps ? "keep" : "drop"} the note`);
    assert.equal(run.completion?.pendingCandidates ?? 0, 0, "no candidate is left pending on this take");
  }
});

test("a suppressed following frame carries no confirmation evidence, so the candidate is lost", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },                   // f0 off
    { probability: 0.9, state: 3 },                 // f1 off->onset: gated, held
    { probability: 0.9, state: 2, active: false }, // f2 suppressed: every accessor reads null
    { probability: 0, state: 0 },                   // f3 off
  ];
  const trace = await syntheticTrace(frames);
  const run = await runExperimentDecoder(trace, {
    decoderId: "relativePresenceConfirmation",
    configuration: { confirmationFrames: 2, presenceFraction: 0.5, gatedTransitions: ["off", "offset"] },
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
    { probability: 0, state: 0 },      // f0 off
    { probability: 0.9, state: 3 },    // f1 off->onset: gated, but this is the last frame delivered
  ];
  const trace = await syntheticTrace(frames);
  const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const run = await runExperimentDecoder(trace, {
    decoderId: "relativePresenceConfirmation",
    configuration: { confirmationFrames: 2, presenceFraction: 0.5, gatedTransitions: ["off", "offset"] },
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

test("an offset -> onset candidate is gated like an off -> onset and confirmed on its own relative bar", async () => {
  const frames: FrameSpec[] = [
    { probability: 0.9, state: 3 },    // f0 onset at the first frame: no previous state, so not gated
    { probability: 0.9, state: 2 },    // f1 sustain
    { probability: 0.3, state: 1 },    // f2 offset
    { probability: 0.9, state: 3 },    // f3 offset->onset: gated; onset presence ~0.9
    { probability: 0.6, state: 2 },    // f4 sustain: a large fraction of the onset, confirms
    { probability: 0.6, state: 2 },    // f5 sustain: second confirming frame -> emitted here
    { probability: 0, state: 0 },      // f6 off
  ];
  const trace = await syntheticTrace(frames);
  const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const run = await runExperimentDecoder(trace, {
    decoderId: "relativePresenceConfirmation",
    configuration: { confirmationFrames: 2, presenceFraction: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });
  // The first frame's onset has no previous state to read, so it passes through.
  const immediate = run.events.find((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(0));
  assert.ok(immediate, "the first frame's onset is emitted, as by the control");
  assert.equal(immediate!.addedDelayMs, 0);
  // The offset -> onset candidate is held and confirmed on its own relative bar.
  const event = run.events.find((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(3));
  assert.ok(event, "the offset -> onset candidate is kept once its follow-ups hold their fraction");
  assert.equal(event!.addedDelayMs, 64);
  assert.equal(event!.waitedFrames, 2);
  assert.deepEqual(event!.transition, { from: "offset", to: "onset" });
  assert.ok(control.events.some((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(3)), "the control emits it too");
  assert.equal(run.completion?.pendingCandidates ?? 0, 0);
});

test("a non-gated onset (sustain -> onset) passes through immediately, exactly as the control", async () => {
  const frames: FrameSpec[] = [
    { probability: 0.9, state: 2 },    // f0 sustain
    { probability: 0.9, state: 3 },    // f1 onset from sustain: previous is not off/offset, so not gated
    { probability: 0.9, state: 2 },    // f2 sustain
  ];
  const trace = await syntheticTrace(frames);
  const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const run = await runExperimentDecoder(trace, {
    decoderId: "relativePresenceConfirmation",
    configuration: { confirmationFrames: 2, presenceFraction: 0.5, gatedTransitions: ["off", "offset"] },
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

test("the module never emits a candidate the control did not, and drops exactly what the relative oracle names", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },        // f0 off
    { probability: 0.9, state: 3 },      // f1 off->onset: gated; the 0.47 follow-ups are a large share of 0.9
    { probability: 0.47, state: 2 },    // f2 sustain: confirms f1
    { probability: 0.47, state: 2 },    // f3 sustain: confirms f1 -> emit here
    { probability: 0, state: 0 },       // f4 off
    { probability: 0.6, state: 3 },     // f5 off->onset: gated; the transient
    { probability: 0.46, state: 2 },    // f6 sustain: a large fraction of the onset, so it passes
    { probability: 0.009, state: 2 },   // f7 sustain: collapsed to near zero -> rejected
    { probability: 0, state: 0 },       // f8 off
    { probability: 0.9, state: 2 },     // f9 sustain
    { probability: 0.9, state: 3 },     // f10 sustain->onset: NOT gated, emitted immediately
    { probability: 0.9, state: 2 },     // f11 sustain
  ];
  const fraction = 0.5;
  const trace = await syntheticTrace(frames);
  const control = await runExperimentDecoder(trace, { decoderId: "shipped", onsetEstimateLagMs: LAG });
  const run = await runExperimentDecoder(trace, {
    decoderId: "relativePresenceConfirmation",
    configuration: { confirmationFrames: 2, presenceFraction: fraction, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });

  // Invariant one: the module only post-processes the control's candidates, so it
  // never adds an attack the control did not produce.
  const controlKeys = new Set(control.events.map((e) => `${e.midi}:${e.onsetMs}`));
  for (const event of run.events) {
    assert.ok(controlKeys.has(`${event.midi}:${event.onsetMs}`), "module emitted a candidate the control did not");
  }

  // Invariant two: every gated transition the oracle names is handled as expected.
  const oracle = gateOracle(frames, 2, fraction);
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
  const immediate = run.events.find((e) => `${e.midi}:${e.onsetMs}` === onsetKey(10));
  const controlImmediate = control.events.find((e) => `${e.midi}:${e.onsetMs}` === onsetKey(10));
  assert.ok(immediate && controlImmediate, "the sustain -> onset attack is present in both");
  assert.equal(immediate!.availableAtMs, controlImmediate!.availableAtMs);
  assert.equal(immediate!.addedDelayMs, 0);

  // On this take the absolute and relative gates disagree about the genuine note:
  // E01's bar drops both the 0.47 follow-up note and the transient, while the
  // relative bar keeps the note and drops only the transient.
  const absolute = await runExperimentDecoder(trace, {
    decoderId: "briefPitchConfirmation",
    configuration: { confirmationFrames: 2, presenceThreshold: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });
  assert.ok(
    !absolute.events.some((e) => `${e.midi}:${e.onsetMs}` === onsetKey(1)),
    "the absolute bar also drops the genuine note the relative bar keeps",
  );
  assert.ok(
    !absolute.events.some((e) => `${e.midi}:${e.onsetMs}` === onsetKey(5)),
    "the absolute bar drops the transient, as the relative bar does",
  );
  // No candidate on this take is left pending when the recording ends.
  assert.equal(run.completion?.pendingCandidates ?? 0, 0);
});

test("a candidate whose onset frame had zero presence gets a zero bar and is confirmed by any real reading", async () => {
  const frames: FrameSpec[] = [
    { probability: 0, state: 0 },        // f0 off
    { probability: 0, state: 3 },       // f1 off->onset: gated; onset presence is exactly zero
    { probability: 0.9, state: 2 },     // f2 sustain: any real reading is at least a 0 bar
    { probability: 0.9, state: 2 },     // f3 sustain: confirms -> emitted here
    { probability: 0, state: 0 },       // f4 off
  ];
  const trace = await syntheticTrace(frames);
  const run = await runExperimentDecoder(trace, {
    decoderId: "relativePresenceConfirmation",
    configuration: { confirmationFrames: 2, presenceFraction: 0.5, gatedTransitions: ["off", "offset"] },
    onsetEstimateLagMs: LAG,
  });
  const event = run.events.find((e) => e.midi === MIDI && e.onsetMs === onsetMsOfFrame(1));
  assert.ok(event, "with no onset-frame presence to measure against, any real follow-up reading confirms");
  assert.equal(event!.addedDelayMs, 64);
  assert.equal(event!.waitedFrames, 2);
});
