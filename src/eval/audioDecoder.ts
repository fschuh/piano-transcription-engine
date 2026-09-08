/**
 * The one documented audio-to-PCM conversion path for offline evaluation.
 *
 * Every recognition measurement in a round has to start from the same samples,
 * so this module runs exactly one external command with one fixed argument list
 * and reports what it produced. It converts to the model's own mono 16 kHz
 * float format and nothing else: no normalization, no filtering, no gain, no
 * silence trimming, and no time stretching. Level, peak, and over-range counts
 * are measured and reported rather than corrected, because a recording's level
 * is evidence about the setup and not a defect to hide.
 *
 * FFmpeg is a local prerequisite of evaluation only. It is spawned here, never
 * installed, and no production module reaches this file.
 */

import { spawn } from "node:child_process";

import { ONLINE_AMT_SAMPLE_RATE } from "../index.js";

/** Default binary name; a caller may name another build explicitly. */
export const DEFAULT_FFMPEG_PATH = "ffmpeg";

export interface AudioLevelMeasurement {
  sampleCount: number;
  /** Largest absolute sample value. */
  peakAmplitude: number;
  rootMeanSquare: number;
  /** Peak in dBFS, or null when the interval is digital silence. */
  peakDbfs: number | null;
  /** RMS in dBFS, or null when the interval is digital silence. */
  rootMeanSquareDbfs: number | null;
  /**
   * Samples whose magnitude exceeds full scale. MP3 decoding legitimately
   * overshoots, so this counts float samples outside [-1, 1] rather than
   * claiming the original performance clipped.
   */
  overRangeSampleCount: number;
}

export interface DecodedPcmAudio {
  /** Mono samples at `sampleRateHz`, downmixed here rather than by the converter. */
  samples: Float32Array;
  sampleRateHz: number;
  channelCount: 1;
  /** Channels the decoded stream carried before the downmix. */
  sourceChannelCount: number;
  durationMs: number;
  level: AudioLevelMeasurement;
  /** The converter and the exact argument list that produced these samples. */
  conversion: AudioConversionCommand;
}

export interface AudioConversionCommand {
  tool: string;
  /** First line of the converter's own version banner. */
  version: string;
  arguments: readonly string[];
}

export interface DecodeAudioFileOptions {
  ffmpegPath?: string;
  /** Output rate; defaults to the model's own 16 kHz and is rarely overridden. */
  sampleRateHz?: number;
  /**
   * How the input is named in the returned conversion record. It defaults to
   * the path that was read, which is an absolute path on the machine that ran
   * the conversion; a caller archiving the record passes the recording's own
   * corpus-relative path instead, so the command identifies the recording
   * rather than the checkout it happened to sit in.
   */
  inputLabel?: string;
}

/**
 * The fixed conversion arguments, exposed so a report can state the path used.
 *
 * `-map 0:a:0` takes the first audio stream and `-vn` drops cover art, so a
 * tagged file converts the same way as an untagged one.
 *
 * The converter deliberately does **not** downmix. Its `-ac 1` rematrix is
 * energy preserving: it sums a stereo pair scaled by 1/sqrt(2), which is 3 dB
 * louder than the average for correlated channels, while a file that is already
 * mono passes through untouched. A corpus holding both would then be measured
 * at two different levels. The channels are averaged in this module instead,
 * the way the production capture worklet averages its inputs, so an offline
 * trace and a live session hear the same signal. The stream is requested as WAV
 * only so its header can state the channel count the samples are interleaved
 * at; the samples themselves are the same uncompressed floats.
 */
export function audioConversionArguments(
  inputPath: string,
  sampleRateHz: number,
): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ar",
    String(sampleRateHz),
    "-f",
    "wav",
    "-acodec",
    "pcm_f32le",
    "-",
  ];
}

interface WaveStream {
  channelCount: number;
  sampleRateHz: number;
  interleaved: Float32Array;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  // The whole expression is coerced, not just the top byte: a piped writer
  // leaves 0xffffffff here, and an int32 read would report it as -1.
  return ((bytes[offset] as number) | ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16) | ((bytes[offset + 3] as number) << 24)) >>> 0;
}

function chunkId(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] as number,
    bytes[offset + 1] as number,
    bytes[offset + 2] as number,
    bytes[offset + 3] as number,
  );
}

/**
 * Reads a 32-bit float WAV stream written to a pipe.
 *
 * A piped writer cannot go back and fill in the RIFF and data sizes, so both
 * arrive as placeholders and the payload is whatever follows the `data` header.
 * Anything that is not the float format this conversion asked for is refused
 * rather than reinterpreted.
 */
function parseFloat32Wave(bytes: Uint8Array): WaveStream {
  if (bytes.byteLength < 12 || chunkId(bytes, 0) !== "RIFF" || chunkId(bytes, 8) !== "WAVE") {
    throw new Error("The converter did not produce a WAVE stream.");
  }
  let channelCount = 0;
  let sampleRateHz = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = chunkId(bytes, offset);
    const declared = readUint32(bytes, offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      const format = (bytes[body] as number) | ((bytes[body + 1] as number) << 8);
      const bitsPerSample = (bytes[body + 14] as number) | ((bytes[body + 15] as number) << 8);
      // 3 is IEEE float; 0xfffe is extensible, whose sub-format this conversion
      // always sets to the same float type.
      if ((format !== 3 && format !== 0xfffe) || bitsPerSample !== 32) {
        throw new Error(
          `The converter produced WAVE format ${format} at ${bitsPerSample} bits, not 32-bit float.`,
        );
      }
      channelCount = (bytes[body + 2] as number) | ((bytes[body + 3] as number) << 8);
      sampleRateHz = readUint32(bytes, body + 4);
    } else if (id === "data") {
      const remaining = bytes.byteLength - body;
      // A piped stream declares 0 or 0xffffffff here; only a real, fitting size
      // is believed.
      const length = declared > 0 && declared <= remaining ? declared : remaining;
      if (channelCount <= 0 || sampleRateHz <= 0) {
        throw new Error("The converter's WAVE stream has audio data before its format.");
      }
      if (length % (Float32Array.BYTES_PER_ELEMENT * channelCount) !== 0) {
        throw new Error(
          `The converter produced ${length} bytes, which is not whole ${channelCount}-channel frames.`,
        );
      }
      return {
        channelCount,
        sampleRateHz,
        interleaved: new Float32Array(
          bytes.buffer.slice(bytes.byteOffset + body, bytes.byteOffset + body + length),
        ),
      };
    }
    // Chunks are word aligned, and an unusable declared size ends the walk.
    if (declared <= 0 || body + declared > bytes.byteLength) break;
    offset = body + declared + (declared % 2);
  }
  throw new Error("The converter's WAVE stream holds no audio data.");
}

/**
 * Averages interleaved channels into one, exactly as the capture worklet does.
 *
 * A single-channel stream is returned as it is, so a mono recording is never
 * copied or scaled on its way to the model.
 */
function downmixToMono(stream: WaveStream): Float32Array {
  if (stream.channelCount === 1) return stream.interleaved;
  const frames = stream.interleaved.length / stream.channelCount;
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const base = frame * stream.channelCount;
    for (let channel = 0; channel < stream.channelCount; channel += 1) {
      sum += stream.interleaved[base + channel] as number;
    }
    mono[frame] = sum / stream.channelCount;
  }
  return mono;
}

interface CommandOutput {
  stdout: Buffer;
  stderr: string;
}

function runCommand(command: string, args: readonly string[]): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new Error(
            `${command} was not found. Offline evaluation decodes recordings with a ` +
            "local FFmpeg install; it is not a dependency of the engine package.",
          )
          : error,
      );
    });
    child.on("close", (code, signal) => {
      const output = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (code === 0) resolve(output);
      else {
        reject(new Error(
          `${command} exited with ${signal ?? code}${output.stderr === "" ? "" : `: ${output.stderr}`}`,
        ));
      }
    });
  });
}

/** Reads the converter's own version banner so a trace can name its producer. */
export async function audioConverterVersion(
  ffmpegPath: string = DEFAULT_FFMPEG_PATH,
): Promise<string> {
  const { stdout } = await runCommand(ffmpegPath, ["-hide_banner", "-version"]);
  return stdout.toString("utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function decibels(amplitude: number): number | null {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : null;
}

/**
 * Measures level over a half-open sample range without altering the audio.
 *
 * The range is clamped to the available samples and an empty range is reported
 * as an empty measurement, so a caller that asks about an interval the file
 * does not contain learns that rather than receiving a level for other audio.
 */
export function measureAudioLevel(
  samples: Float32Array,
  startSample = 0,
  endSample = samples.length,
): AudioLevelMeasurement {
  const start = Math.max(0, Math.min(Math.trunc(startSample), samples.length));
  const end = Math.max(start, Math.min(Math.trunc(endSample), samples.length));
  let peakAmplitude = 0;
  let sumOfSquares = 0;
  let overRangeSampleCount = 0;
  for (let index = start; index < end; index += 1) {
    const sample = samples[index] as number;
    const magnitude = Math.abs(sample);
    if (magnitude > peakAmplitude) peakAmplitude = magnitude;
    if (magnitude > 1) overRangeSampleCount += 1;
    sumOfSquares += sample * sample;
  }
  const sampleCount = end - start;
  const rootMeanSquare = sampleCount === 0 ? 0 : Math.sqrt(sumOfSquares / sampleCount);
  return {
    sampleCount,
    peakAmplitude,
    rootMeanSquare,
    peakDbfs: decibels(peakAmplitude),
    rootMeanSquareDbfs: decibels(rootMeanSquare),
    overRangeSampleCount,
  };
}

/** Converts a decibel gain to the linear factor a caller would multiply by. */
export function gainFactorFromDecibels(decibelGain: number): number {
  if (!Number.isFinite(decibelGain)) {
    throw new Error(`Input gain must be a finite number of decibels, received ${decibelGain}.`);
  }
  return 10 ** (decibelGain / 20);
}

/**
 * Applies a fixed gain and reports what it produced.
 *
 * Unity gain returns the samples unchanged rather than multiplying by one, so a
 * baseline capture is bit-identical to a capture with no gain stage at all. A
 * gain that pushes samples past full scale is reported, not limited: an
 * experiment has to see the over-range count it caused.
 */
export function applyInputGain(
  samples: Float32Array,
  decibelGain: number,
): { samples: Float32Array; level: AudioLevelMeasurement } {
  if (decibelGain === 0) return { samples, level: measureAudioLevel(samples) };
  const factor = gainFactorFromDecibels(decibelGain);
  const amplified = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    amplified[index] = (samples[index] as number) * factor;
  }
  return { samples: amplified, level: measureAudioLevel(amplified) };
}

/**
 * Decodes one audio file to mono float PCM at the model's sample rate.
 *
 * The samples are whatever the file holds at its own level. The returned
 * conversion record names the tool, its version, and the exact arguments, so a
 * later run can be compared against the path that produced an archived trace.
 */
export async function decodeAudioFileToPcm(
  inputPath: string,
  options: DecodeAudioFileOptions = {},
): Promise<DecodedPcmAudio> {
  const ffmpegPath = options.ffmpegPath ?? DEFAULT_FFMPEG_PATH;
  const sampleRateHz = options.sampleRateHz ?? ONLINE_AMT_SAMPLE_RATE;
  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error(`Decode sample rate must be a positive integer, received ${sampleRateHz}.`);
  }
  const args = audioConversionArguments(inputPath, sampleRateHz);
  const [version, { stdout }] = await Promise.all([
    audioConverterVersion(ffmpegPath),
    runCommand(ffmpegPath, args),
  ]);
  const recordedArgs = audioConversionArguments(options.inputLabel ?? inputPath, sampleRateHz);
  const stream = parseFloat32Wave(stdout);
  if (stream.sampleRateHz !== sampleRateHz) {
    throw new Error(
      `${ffmpegPath} produced ${stream.sampleRateHz} Hz audio, not the ${sampleRateHz} Hz asked for.`,
    );
  }
  const samples = downmixToMono(stream);
  if (samples.length === 0) {
    throw new Error(`${inputPath} decoded to no audio samples.`);
  }
  return {
    samples,
    sampleRateHz,
    channelCount: 1,
    sourceChannelCount: stream.channelCount,
    durationMs: samples.length / sampleRateHz * 1_000,
    level: measureAudioLevel(samples),
    conversion: { tool: ffmpegPath, version, arguments: recordedArgs },
  };
}
