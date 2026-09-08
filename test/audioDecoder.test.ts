import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyInputGain,
  audioConversionArguments,
  audioConverterVersion,
  decodeAudioFileToPcm,
  gainFactorFromDecibels,
  measureAudioLevel,
} from "../src/eval/index.js";

const SOURCE_RATE = 44_100;
const BURST_TIMES_MS = [200, 700, 1_500, 2_500];
const BURST_LENGTH_MS = 30;
const BURST_AMPLITUDE = 0.5;
const SOURCE_LENGTH_MS = 3_000;

/**
 * Original synthetic audio: silence with short windowed 1 kHz bursts at exact
 * times. Nothing about it is musical or derived from a recording; it exists so
 * the conversion can be checked for a sample-position shift.
 */
function burstSource(): Float32Array {
  const frames = Math.round(SOURCE_LENGTH_MS / 1_000 * SOURCE_RATE);
  const stereo = new Float32Array(frames * 2);
  const burstFrames = Math.round(BURST_LENGTH_MS / 1_000 * SOURCE_RATE);
  for (const startMs of BURST_TIMES_MS) {
    const start = Math.round(startMs / 1_000 * SOURCE_RATE);
    for (let index = 0; index < burstFrames; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / burstFrames);
      const value = BURST_AMPLITUDE * window *
        Math.sin(2 * Math.PI * 1_000 * index / SOURCE_RATE);
      // Identical channels, so the mono downmix cannot change the amplitude.
      stereo[(start + index) * 2] = value;
      stereo[(start + index) * 2 + 1] = value;
    }
  }
  return stereo;
}

function encodeMp3(
  samples: Float32Array,
  outputPath: string,
  channelCount = 2,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "f32le", "-ar", String(SOURCE_RATE), "-ac", String(channelCount), "-i", "-",
      "-codec:a", "libmp3lame", "-b:a", "192k",
      outputPath,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`libmp3lame exited with ${code}: ${Buffer.concat(errors).toString()}`));
    });
    child.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  });
}

/** Start of each burst in the decoded mono signal, by a moving-RMS threshold. */
function burstStartsMs(samples: Float32Array, sampleRateHz: number): number[] {
  const window = 64;
  const energy = new Float64Array(Math.max(0, samples.length - window));
  let peak = 0;
  for (let index = 0; index < energy.length; index += 1) {
    let sum = 0;
    for (let offset = 0; offset < window; offset += 1) {
      const value = samples[index + offset]!;
      sum += value * value;
    }
    energy[index] = Math.sqrt(sum / window);
    if (energy[index]! > peak) peak = energy[index]!;
  }
  const threshold = peak * 0.1;
  const starts: number[] = [];
  let inside = false;
  for (let index = 0; index < energy.length; index += 1) {
    if (!inside && energy[index]! > threshold) {
      starts.push(index / sampleRateHz * 1_000);
      inside = true;
    } else if (inside && energy[index]! <= threshold * 0.5) {
      inside = false;
    }
  }
  return starts;
}

const ffmpegVersion = await audioConverterVersion().catch(() => null);
const needsFfmpeg = ffmpegVersion === null
  ? "needs a local FFmpeg install, which is an evaluation-only prerequisite"
  : false;

test("the conversion path is fixed and names its input as the caller labels it", () => {
  const args = audioConversionArguments("gold/setup/take.mp3", 16_000);
  assert.deepEqual(args, [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", "gold/setup/take.mp3",
    "-map", "0:a:0", "-vn",
    "-ar", "16000",
    "-f", "wav", "-acodec", "pcm_f32le", "-",
  ]);
  // Nothing in the path normalizes, filters, trims, or re-times the recording,
  // and the converter never downmixes: its stereo rematrix is 3 dB louder than
  // the average, so the channels are averaged in the engine instead.
  for (const forbidden of ["-af", "-filter:a", "loudnorm", "dynaudnorm", "volume", "-ss", "-t", "-ac"]) {
    assert.equal(args.includes(forbidden), false, `the conversion applies ${forbidden}`);
  }
});

test("decoding keeps every attack at its own time", { skip: needsFfmpeg }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "piano-transcription-engine-decode-"));
  try {
    const path = join(root, "bursts.mp3");
    await encodeMp3(burstSource(), path);
    const decoded = await decodeAudioFileToPcm(path, { inputLabel: "synthetic/bursts.mp3" });

    assert.equal(decoded.sampleRateHz, 16_000);
    assert.equal(decoded.channelCount, 1);
    assert.equal(decoded.sourceChannelCount, 2);
    assert.ok(
      Math.abs(decoded.durationMs - SOURCE_LENGTH_MS) < 100,
      `decoded ${decoded.durationMs} ms of a ${SOURCE_LENGTH_MS} ms source`,
    );
    assert.equal(
      decoded.conversion.arguments.includes("synthetic/bursts.mp3"),
      true,
      "the archived command must name the recording, not the path it was read from",
    );
    assert.equal(decoded.conversion.arguments.includes(path), false);

    const starts = burstStartsMs(decoded.samples, decoded.sampleRateHz);
    assert.equal(starts.length, BURST_TIMES_MS.length, `found bursts at ${starts.join(", ")}`);
    const errors = starts.map((atMs, index) => atMs - BURST_TIMES_MS[index]!);
    for (const [index, error] of errors.entries()) {
      // An uncompensated MP3 encoder delay would shift every burst by about
      // 26 ms at 44.1 kHz, and a resampling mistake would grow the error with
      // time. Both are far outside this bound.
      assert.ok(
        Math.abs(error) < 12,
        `burst ${index} at ${starts[index]!.toFixed(1)} ms is ${error.toFixed(1)} ms out`,
      );
    }
    const drift = errors[errors.length - 1]! - errors[0]!;
    assert.ok(Math.abs(drift) < 6, `burst timing drifted ${drift.toFixed(1)} ms across the file`);

    // The level is the file's own. A lossy round trip rings around a burst
    // edge, so the peak is compared loosely and the far steadier RMS closely;
    // both would fail outright if the mono downmix halved or doubled the level.
    const source = burstSource();
    const mono = new Float32Array(source.length / 2);
    for (let index = 0; index < mono.length; index += 1) mono[index] = source[index * 2]!;
    const expected = measureAudioLevel(mono);
    assert.ok(
      decoded.level.peakAmplitude > BURST_AMPLITUDE * 0.8 &&
        decoded.level.peakAmplitude < BURST_AMPLITUDE * 1.8,
      `peak ${decoded.level.peakAmplitude} against a ${BURST_AMPLITUDE} source`,
    );
    assert.ok(
      Math.abs(decoded.level.rootMeanSquare - expected.rootMeanSquare) <
        expected.rootMeanSquare * 0.15,
      `RMS ${decoded.level.rootMeanSquare} against a ${expected.rootMeanSquare} source`,
    );
    assert.equal(decoded.level.overRangeSampleCount, 0);
    context.diagnostic(JSON.stringify({
      starts,
      errors,
      peak: decoded.level.peakAmplitude,
      rootMeanSquare: decoded.level.rootMeanSquare,
      sourceRootMeanSquare: expected.rootMeanSquare,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stereo recording decodes at the level of the same material in mono", {
  skip: needsFfmpeg,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "piano-transcription-engine-downmix-"));
  try {
    const stereoSource = burstSource();
    const monoSource = new Float32Array(stereoSource.length / 2);
    for (let index = 0; index < monoSource.length; index += 1) {
      monoSource[index] = stereoSource[index * 2]!;
    }
    const stereoPath = join(root, "stereo.mp3");
    const monoPath = join(root, "mono.mp3");
    await encodeMp3(stereoSource, stereoPath);
    await encodeMp3(monoSource, monoPath, 1);
    const stereo = await decodeAudioFileToPcm(stereoPath);
    const mono = await decodeAudioFileToPcm(monoPath);

    assert.equal(stereo.sourceChannelCount, 2);
    assert.equal(mono.sourceChannelCount, 1);
    // The channels are identical, so averaging them must reproduce the mono
    // file's level. FFmpeg's own `-ac 1` rematrix would make the stereo file
    // 3 dB louder here and leave the mono one alone, which would measure the
    // stereo gold takes and the mono silver repertoire at different levels.
    const ratio = stereo.level.rootMeanSquare / mono.level.rootMeanSquare;
    assert.ok(Math.abs(ratio - 1) < 0.05, `stereo is ${ratio.toFixed(3)}x the mono level`);
    context.diagnostic(JSON.stringify({
      ratio,
      stereoRootMeanSquare: stereo.level.rootMeanSquare,
      monoRootMeanSquare: mono.level.rootMeanSquare,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a converter that is absent or cannot read the input is reported plainly", async () => {
  await assert.rejects(
    decodeAudioFileToPcm("whatever.mp3", { ffmpegPath: "ffmpeg-that-is-not-installed" }),
    /was not found\. Offline evaluation decodes recordings with a local FFmpeg install/,
  );
  if (needsFfmpeg !== false) return;
  const root = await mkdtemp(join(tmpdir(), "piano-transcription-engine-decode-"));
  try {
    const path = join(root, "not-audio.mp3");
    await writeFile(path, "this is not an MPEG audio file");
    await assert.rejects(decodeAudioFileToPcm(path), /ffmpeg exited with 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("level is measured over a clamped range and reports over-range samples", () => {
  const samples = Float32Array.of(0, 0.5, -0.5, 1.5, -2, 0);
  const whole = measureAudioLevel(samples);
  assert.equal(whole.sampleCount, 6);
  assert.equal(whole.peakAmplitude, 2);
  assert.equal(whole.overRangeSampleCount, 2);
  assert.ok(Math.abs(whole.peakDbfs! - 6.0206) < 1e-3);

  const quiet = measureAudioLevel(samples, 1, 3);
  assert.equal(quiet.sampleCount, 2);
  assert.equal(quiet.peakAmplitude, 0.5);
  assert.equal(quiet.rootMeanSquare, 0.5);
  assert.equal(quiet.overRangeSampleCount, 0);

  // A range past the end reports what exists, and digital silence has no dBFS.
  assert.equal(measureAudioLevel(samples, 4, 99).sampleCount, 2);
  assert.deepEqual(measureAudioLevel(samples, 99, 200).sampleCount, 0);
  const silence = measureAudioLevel(new Float32Array(10));
  assert.equal(silence.peakDbfs, null);
  assert.equal(silence.rootMeanSquareDbfs, null);
});

test("unity gain leaves the samples untouched and other gains are reported", () => {
  const samples = Float32Array.of(0.25, -0.5, 0.75);
  const unity = applyInputGain(samples, 0);
  assert.equal(unity.samples, samples, "unity gain must not copy or scale the recording");

  assert.ok(Math.abs(gainFactorFromDecibels(6) - 1.99526) < 1e-4);
  assert.equal(gainFactorFromDecibels(0), 1);
  const louder = applyInputGain(samples, 6);
  assert.notEqual(louder.samples, samples);
  assert.ok(Math.abs(louder.samples[2]! - 0.75 * 1.99526) < 1e-4);
  // Gain that leaves full scale is reported, never limited.
  assert.equal(louder.level.overRangeSampleCount, 1);
  assert.ok(louder.level.peakAmplitude > 1);
  assert.throws(() => gainFactorFromDecibels(Number.NaN), /finite number of decibels/);
});
