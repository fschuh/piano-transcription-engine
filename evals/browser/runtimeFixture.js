import {
  ONLINE_AMT_CHUNK_SIZE,
  OnlineAmtOutputDecoder,
  OnlineAmtSession,
} from "../../dist/index.js";

// The fixture is a synthesized 440 Hz harmonic signal, so A4 is the only pitch
// worth asking the decoder about. Naming it exercises the target-evidence path
// that listen mode uses in production.
const FIXTURE_TARGET_PITCHES = [69];
const FRAME_INTERVAL_MS = 32;

/** FNV-1a over raw bytes. Only equality between two runs is meaningful. */
function byteHash(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash = Math.imul(hash ^ bytes[index], 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function textHash(text) {
  return byteHash(new TextEncoder().encode(text));
}

/**
 * Replays the deterministic runtime fixture through the production session and
 * output decoder. The caller supplies the bytes and the session's model and
 * WASM sources, so the identical code runs in a browser and offline in Node.
 */
export async function runRuntimeFixture({ load, session: sessionSource, onProgress = () => {} }) {
  onProgress("Loading the runtime fixture…");
  const [metadataBytes, audioBytes, scoreBytes, stateBytes, activeBytes] = await Promise.all([
    load("metadata.json"),
    load("audio.f32"),
    load("scores.f32"),
    load("states.u8"),
    load("signal-active.u8"),
  ]);
  const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
  if (metadata.chunkSize !== ONLINE_AMT_CHUNK_SIZE) {
    throw new Error(`Fixture chunk size ${metadata.chunkSize} is not the protocol's.`);
  }
  const audio = new Float32Array(
    audioBytes.buffer, audioBytes.byteOffset, audioBytes.byteLength / 4,
  );
  const expectedScores = new Float32Array(
    scoreBytes.buffer, scoreBytes.byteOffset, scoreBytes.byteLength / 4,
  );
  const framePitchStates = metadata.pitches * metadata.states;

  onProgress("Loading the online_amt model…");
  const session = await OnlineAmtSession.create({
    ...sessionSource,
    numThreads: 1,
    graphOptimizationLevel: "all",
    enableCpuMemArena: true,
    enableMemPattern: true,
    executionMode: "sequential",
  });

  const decoder = new OnlineAmtOutputDecoder();
  const observedScores = new Float32Array(expectedScores.length);
  const observedStates = new Uint8Array(stateBytes.length);
  const observedActive = new Uint8Array(activeBytes.length);
  const onsets = [];
  const noteEvents = [];
  const activePitchFrames = [];
  const targetEvidenceFrames = [];
  let maximumAbsoluteScoreError = 0;
  let stateMismatches = 0;
  let signalActiveMismatches = 0;

  try {
    for (let frame = 0; frame < metadata.frames; frame += 1) {
      if (frame % 60 === 0) onProgress(`Running frame ${frame} of ${metadata.frames}…`);
      const chunkStart = frame * metadata.chunkSize;
      const step = await session.run(
        audio.subarray(chunkStart, chunkStart + metadata.chunkSize),
      );
      observedScores.set(step.scores, frame * framePitchStates);
      observedStates.set(step.states, frame * metadata.pitches);
      observedActive[frame] = step.signalActive ? 1 : 0;

      for (let index = 0; index < step.scores.length; index += 1) {
        maximumAbsoluteScoreError = Math.max(
          maximumAbsoluteScoreError,
          Math.abs(step.scores[index] - expectedScores[frame * framePitchStates + index]),
        );
      }
      for (let pitch = 0; pitch < metadata.pitches; pitch += 1) {
        if (step.states[pitch] !== stateBytes[frame * metadata.pitches + pitch]) {
          stateMismatches += 1;
        }
      }
      if (observedActive[frame] !== activeBytes[frame]) signalActiveMismatches += 1;

      const decoded = decoder.decode(
        step.scores,
        step.states,
        step.signalActive,
        frame * FRAME_INTERVAL_MS,
        FIXTURE_TARGET_PITCHES,
      );
      for (const onset of decoded.onsets) onsets.push({ frame, ...onset });
      for (const event of decoded.noteEvents ?? []) noteEvents.push({ frame, ...event });
      if (decoded.recognizedActivePitches.length > 0) {
        activePitchFrames.push([frame, decoded.recognizedActivePitches.map(({ midi }) => midi)]);
      }
      if (decoded.targetPitchEvidence.length > 0) {
        targetEvidenceFrames.push([frame, decoded.targetPitchEvidence.map(({ midi }) => midi)]);
      }
    }
  } finally {
    await session.dispose();
  }

  // Structure excludes confidences: pitches, event kinds, and timing must be
  // identical across environments, while the last bits of a float need not be.
  const structure = JSON.stringify({
    onsets: onsets.map(({ frame, midi, onsetTimeMs }) => [frame, midi, onsetTimeMs]),
    noteEvents: noteEvents.map(({ frame, midi, type, eventTimeMs }) => (
      [frame, midi, type, eventTimeMs]
    )),
    activePitchFrames,
    targetEvidenceFrames,
  });

  return {
    frames: metadata.frames,
    maximumAbsoluteScoreError,
    stateMismatches,
    signalActiveMismatches,
    onsetCount: onsets.length,
    noteEventCount: noteEvents.length,
    activePitchFrameCount: activePitchFrames.length,
    targetEvidenceFrameCount: targetEvidenceFrames.length,
    recognitionStructureHash: textHash(structure),
    statesHash: byteHash(observedStates),
    signalActiveHash: byteHash(observedActive),
    scoresHash: byteHash(observedScores),
  };
}
