import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureOnlineAmtTrace,
  captureProvenanceWarnings,
  describeEngine,
  engineIsUnattributable,
  engineProvenanceWarning,
  identifyEngine,
  type CaptureProvenance,
  type OnlineAmtTraceEngine,
  ONLINE_AMT_PITCH_COUNT,
  ONLINE_AMT_STATE_COUNT,
  ONLINE_AMT_TRACE_FORMAT_VERSION,
  onlineAmtTraceMismatches,
  openCachedOnlineAmtTrace,
  readOnlineAmtTrace,
  traceDirectoryFor,
  writeOnlineAmtTrace,
  type OnlineAmtCaptureSession,
  type OnlineAmtTraceIdentification,
  type OnlineAmtTraceRequirements,
} from "../src/eval/index.js";
import { ONLINE_AMT_CHUNK_SIZE } from "../src/index.js";

const SCORES_PER_FRAME = ONLINE_AMT_PITCH_COUNT * ONLINE_AMT_STATE_COUNT;

const countingSession: OnlineAmtCaptureSession = (() => {
  let frame = 0;
  return {
    reset() {
      frame = 0;
    },
    run() {
      const scores = new Float32Array(SCORES_PER_FRAME);
      for (let index = 0; index < scores.length; index += 1) scores[index] = frame + index / 1_000;
      const states = new Uint8Array(ONLINE_AMT_PITCH_COUNT);
      states.fill((frame % 4) + 1);
      const result = {
        scores,
        states,
        signalActive: frame % 3 !== 0,
        inferenceTimeMs: frame,
      };
      frame += 1;
      return Promise.resolve(result);
    },
  };
})();

const identification: OnlineAmtTraceIdentification = {
  capturedAt: "2026-09-08T00:00:00.000Z",
  recordingId: "tier/name",
  engine: {
    name: "test",
    version: "0.0.0",
    revision: "1111111111111111111111111111111111111111",
    revisionSource: "caller",
    uncommitted: null,
    callerRevision: "1111111111111111111111111111111111111111",
  },
  model: { file: "model.onnx", byteLength: 3, sha256: "model-digest" },
  conversion: { tool: "ffmpeg", version: "test", arguments: ["-i", "tier/name.mp3"] },
  audio: {
    file: "tier/name.mp3",
    sha256: "audio-digest",
    sampleRateHz: 16_000,
    channelCount: 1,
    sourceChannelCount: 2,
    durationMs: 100,
    decodedLevel: {
      sampleCount: 1_600,
      peakAmplitude: 0.5,
      rootMeanSquare: 0.25,
      peakDbfs: -6,
      rootMeanSquareDbfs: -12,
      overRangeSampleCount: 0,
    },
    capturedLevel: {
      sampleCount: 1_600,
      peakAmplitude: 0.5,
      rootMeanSquare: 0.25,
      peakDbfs: -6,
      rootMeanSquareDbfs: -12,
      overRangeSampleCount: 0,
    },
    inputGainDb: 0,
  },
};

async function withTemporaryDirectory(
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "piano-transcription-engine-trace-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a written trace reads back with the same frames, states, and timing", async () => {
  await withTemporaryDirectory(async (root) => {
    const trace = await captureOnlineAmtTrace(
      countingSession,
      new Float32Array(ONLINE_AMT_CHUNK_SIZE * 4 + 7),
      { tailFlushSamples: ONLINE_AMT_CHUNK_SIZE },
    );
    const directory = traceDirectoryFor(root, "tier/name");
    assert.equal(directory, join(root, "tier__name"));
    const written = await writeOnlineAmtTrace(directory, identification, trace);
    assert.equal(written.formatVersion, ONLINE_AMT_TRACE_FORMAT_VERSION);
    assert.equal(written.capture.frameCount, 6);
    assert.equal(written.capture.inputFrameCount, 5);
    assert.equal(written.capture.paddedSampleCount, ONLINE_AMT_CHUNK_SIZE - 7);
    assert.match(written.frameTimeMsExpression, /frameIndex \+ 1/);

    const restored = await readOnlineAmtTrace(directory);
    assert.deepEqual(restored.metadata, written);
    assert.deepEqual(Array.from(restored.trace.scores), Array.from(trace.scores));
    assert.deepEqual(Array.from(restored.trace.states), Array.from(trace.states));
    assert.deepEqual(Array.from(restored.trace.signalActive), Array.from(trace.signalActive));
    assert.deepEqual(
      Array.from(restored.trace.inferenceTimeMs),
      Array.from(trace.inferenceTimeMs),
    );
    assert.equal(restored.trace.elapsedMs, trace.elapsedMs);
  });
});

test("a trace whose bytes changed is refused rather than replayed as evidence", async () => {
  await withTemporaryDirectory(async (root) => {
    const trace = await captureOnlineAmtTrace(
      countingSession,
      new Float32Array(ONLINE_AMT_CHUNK_SIZE * 3),
      { tailFlushSamples: 0 },
    );
    const directory = traceDirectoryFor(root, "tier/name");
    await writeOnlineAmtTrace(directory, identification, trace);

    // One flipped score keeps every claimed length intact, so only recomputing
    // the digest can catch it.
    const scores = await readFile(join(directory, "scores.f32"));
    scores[0] = scores[0]! ^ 0x01;
    await writeFile(join(directory, "scores.f32"), scores);
    await assert.rejects(readOnlineAmtTrace(directory), /scores does not match its recorded digest/);
  });
});

test("a truncated or mislabelled trace is refused before it is read as frames", async () => {
  await withTemporaryDirectory(async (root) => {
    const trace = await captureOnlineAmtTrace(
      countingSession,
      new Float32Array(ONLINE_AMT_CHUNK_SIZE * 3),
      { tailFlushSamples: 0 },
    );
    const directory = traceDirectoryFor(root, "tier/name");
    const metadata = await writeOnlineAmtTrace(directory, identification, trace);

    const states = await readFile(join(directory, "states.u8"));
    await writeFile(join(directory, "states.u8"), states.subarray(0, states.length - 88));
    await assert.rejects(readOnlineAmtTrace(directory), /states but claims 264/);
    await writeFile(join(directory, "states.u8"), states);

    await writeFile(
      join(directory, "metadata.json"),
      JSON.stringify({ ...metadata, formatVersion: metadata.formatVersion + 1 }),
    );
    await assert.rejects(readOnlineAmtTrace(directory), /this build reads 3/);
  });
});

test("a trace whose own sample counts do not frame its audio is refused on write", async () => {
  await withTemporaryDirectory(async (root) => {
    const trace = await captureOnlineAmtTrace(
      countingSession,
      new Float32Array(ONLINE_AMT_CHUNK_SIZE * 2),
      { tailFlushSamples: ONLINE_AMT_CHUNK_SIZE },
    );
    await assert.rejects(
      writeOnlineAmtTrace(
        traceDirectoryFor(root, "bad/padding"),
        identification,
        { ...trace, paddedSampleCount: trace.paddedSampleCount + 1 },
      ),
      /which is not 3 frames of 512/,
    );
    await assert.rejects(
      writeOnlineAmtTrace(
        traceDirectoryFor(root, "bad/frames"),
        identification,
        { ...trace, inputFrameCount: trace.inputFrameCount + 1 },
      ),
      /claims 3 input frames/,
    );
  });
});

test("a trace needs a recording to name", () => {
  assert.throws(() => traceDirectoryFor("/traces", "   "), /non-empty recording id/);
});

/** What the trace above was captured under: a compatible request looks like this. */
function requirements(): OnlineAmtTraceRequirements {
  return {
    modelSha256: "model-digest",
    audioSha256: "audio-digest",
    sampleRateHz: 16_000,
    chunkSize: ONLINE_AMT_CHUNK_SIZE,
    inputGainDb: 0,
    tailFlushSampleCount: ONLINE_AMT_CHUNK_SIZE,
  };
}

async function cachedTrace(root: string): Promise<string> {
  const trace = await captureOnlineAmtTrace(
    countingSession,
    new Float32Array(ONLINE_AMT_CHUNK_SIZE * 2),
    { tailFlushSamples: ONLINE_AMT_CHUNK_SIZE },
  );
  const directory = traceDirectoryFor(root, "tier/name");
  await writeOnlineAmtTrace(directory, identification, trace);
  return directory;
}

test("a cached trace is reused only for the request it answers", async () => {
  await withTemporaryDirectory(async (root) => {
    const directory = await cachedTrace(root);
    const reused = await openCachedOnlineAmtTrace(directory, requirements());
    assert.notEqual(reused, null);
    assert.equal(reused!.metadata.recordingId, "tier/name");

    // Every input that decides what the model saw. A trace that differs in any
    // of them cannot stand in for the capture, however intact it is.
    const incompatible: Array<[string, Partial<OnlineAmtTraceRequirements>, RegExp]> = [
      ["a louder input gain", { inputGainDb: 6 }, /input gain is 0 dB but 6 dB was requested/],
      [
        "a longer tail flush",
        { tailFlushSampleCount: 4_096 },
        /tail flush is 512 samples but 4096 samples was requested/,
      ],
      ["another model", { modelSha256: "other" }, /model is model-digest but other was requested/],
      ["another recording", { audioSha256: "other" }, /recording is audio-digest but other/],
      ["another sample rate", { sampleRateHz: 22_050 }, /sample rate is 16000 Hz but 22050 Hz/],
      ["another chunk size", { chunkSize: 1_024 }, /chunk size is 512 but 1024 was requested/],
    ];
    for (const [description, change, expected] of incompatible) {
      await assert.rejects(
        openCachedOnlineAmtTrace(directory, { ...requirements(), ...change }),
        expected,
        `a cached trace was reused for ${description}`,
      );
      await assert.rejects(
        openCachedOnlineAmtTrace(directory, { ...requirements(), ...change }),
        /Capture into a different directory to keep both, or pass --force to replace it/,
      );
    }

    // The reported +6 dB, 4,096-sample request: both differences are named, not
    // just the first one found.
    const both = onlineAmtTraceMismatches(
      (await readOnlineAmtTrace(directory)).metadata,
      { ...requirements(), inputGainDb: 6, tailFlushSampleCount: 4_096 },
    );
    assert.equal(both.length, 2);
    assert.deepEqual(onlineAmtTraceMismatches(
      (await readOnlineAmtTrace(directory)).metadata,
      requirements(),
    ), []);
  });
});

test("nothing cached is not the same as something incompatible", async () => {
  await withTemporaryDirectory(async (root) => {
    assert.equal(
      await openCachedOnlineAmtTrace(traceDirectoryFor(root, "tier/absent"), requirements()),
      null,
    );
  });
});

const OTHER_REVISION = "cd485c67b4f08c3e3cce5804a950367af73b866c";

function engineAt(overrides: Partial<OnlineAmtTraceEngine> = {}): OnlineAmtTraceEngine {
  return {
    name: "@fschuh/piano-transcription-engine",
    version: "0.1.0",
    revision: "1111111111111111111111111111111111111111",
    revisionSource: "checkout",
    uncommitted: false,
    callerRevision: null,
    ...overrides,
  };
}

function provenance(overrides: Partial<CaptureProvenance> = {}): CaptureProvenance {
  return {
    recordingId: "tier/name",
    cached: true,
    engine: engineAt(),
    converterVersion: "ffmpeg 9",
    ...overrides,
  };
}

test("a measured checkout outranks whatever revision the caller asserted", async () => {
  const engine = await identifyEngine();
  assert.equal(engine.name, "@fschuh/piano-transcription-engine");
  // This repository is a checkout, so the revision is measured, not left unknown.
  assert.equal(engine.revisionSource, "checkout");
  assert.match(engine.revision ?? "", /^[0-9a-f]{40}$/);
  assert.equal(typeof engine.uncommitted, "boolean");
  assert.equal(engine.callerRevision, null);

  // A caller cannot know that the tree in front of it differs from the pin it
  // names, so its claim must not overwrite what was measured.
  const asserted = await identifyEngine(OTHER_REVISION);
  assert.equal(asserted.revisionSource, "checkout");
  assert.equal(asserted.revision, engine.revision);
  assert.equal(asserted.uncommitted, engine.uncommitted);
  // The claim is kept so a wrong one stays visible instead of disappearing.
  assert.equal(asserted.callerRevision, OTHER_REVISION);
  assert.match(
    captureProvenanceWarnings(asserted, "ffmpeg 9", []).join("\n"),
    /--engine-revision named cd485c67.*this package is a checkout at .*The supplied revision was ignored/s,
  );
  // An agreeing claim is not worth a warning.
  assert.deepEqual(
    captureProvenanceWarnings(
      { ...asserted, callerRevision: asserted.revision },
      "ffmpeg 9",
      [],
    ),
    [],
  );
});

test("a caller revision is used only where nothing can be measured", () => {
  const installed = engineAt({
    revision: OTHER_REVISION,
    revisionSource: "caller",
    uncommitted: null,
    callerRevision: OTHER_REVISION,
  });
  // A named revision the caller installed is committed code: self-reported, and
  // the trace records that it came from the caller rather than from a checkout.
  assert.equal(engineIsUnattributable(installed), false);
  assert.match(describeEngine(installed), /working tree unknown/);

  const dirty = engineAt({ uncommitted: true });
  assert.equal(engineIsUnattributable(dirty), true);
  assert.match(describeEngine(dirty), /UNCOMMITTED CHANGES/);
  assert.match(engineProvenanceWarning(dirty) ?? "", /exists nowhere else/);

  const anonymous = engineAt({ revision: null, revisionSource: "none" });
  assert.equal(engineIsUnattributable(anonymous), true);
  assert.match(engineProvenanceWarning(anonymous) ?? "", /Pass --engine-revision/);
  assert.equal(engineProvenanceWarning(engineAt()), null);
});

test("a reused trace is judged on its own provenance, not the current build's", () => {
  const clean = engineAt();
  const dirty = engineAt({ uncommitted: true });

  // The reported case: a clean current build reusing a trace written by a dirty
  // one at the same commit. The revisions match, so only the trace's own
  // provenance can catch it.
  const warnings = captureProvenanceWarnings(clean, "ffmpeg 9", [
    provenance({ engine: dirty }),
    provenance({ recordingId: "tier/other", engine: clean }),
  ]);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0]!, /1 reused trace\(s\) cannot be attributed to committed code/);
  assert.match(warnings[0]!, /tier\/name/);
  assert.match(warnings[0]!, /Recapture them with --force/);

  // And the same when the current build only asserted the matching revision.
  const assertedClean = engineAt({
    revisionSource: "caller",
    uncommitted: null,
    callerRevision: clean.revision,
  });
  assert.match(
    captureProvenanceWarnings(assertedClean, "ffmpeg 9", [provenance({ engine: dirty })]).join("\n"),
    /cannot be attributed to committed code/,
  );

  // A trace this run wrote is judged against the build that wrote it, and only
  // when something was actually written.
  assert.deepEqual(captureProvenanceWarnings(dirty, "ffmpeg 9", []), []);
  assert.deepEqual(
    captureProvenanceWarnings(dirty, "ffmpeg 9", [provenance({ engine: clean })]),
    [],
  );
  assert.match(
    captureProvenanceWarnings(dirty, "ffmpeg 9", [
      provenance({ cached: false, engine: dirty }),
    ]).join("\n"),
    /1 trace\(s\) captured by this run cannot be attributed to committed code/,
  );
});

test("a reused trace from another build or converter is reported", () => {
  const clean = engineAt();
  const elsewhere = engineAt({ revision: OTHER_REVISION });
  const warnings = captureProvenanceWarnings(clean, "ffmpeg 9", [
    provenance({ engine: elsewhere }),
    provenance({ recordingId: "tier/old", converterVersion: "ffmpeg 6" }),
  ]);
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings[0]!, /captured by a different engine build/);
  assert.match(warnings[1]!, /decoded by a different converter, such as tier\/old \(ffmpeg 6\)/);
});
