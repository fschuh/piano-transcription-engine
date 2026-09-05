/**
 * Descriptive MP3 header reader for corpus validation.
 *
 * It reports what a recording already is — sample rate, channel count,
 * duration, and bitrate — by walking frame headers. It never decodes, resamples,
 * normalizes, or rewrites audio, and the private corpus files it describes are
 * read only.
 */

export interface Mp3Metadata {
  mpegVersion: "1" | "2" | "2.5";
  layer: 1 | 2 | 3;
  sampleRateHz: number;
  channelCount: number;
  frameCount: number;
  durationMs: number;
  /** Mean bitrate over the audio frames, rounded to the nearest kbit/s. */
  averageBitrateKbps: number;
  /** False when the file mixes frame bitrates, as a VBR encoder produces. */
  constantBitrate: boolean;
  /** Bytes of leading ID3v2 tag skipped before the first frame. */
  id3v2Bytes: number;
  /**
   * True when the first frame is a Xing/Info/VBRI header frame. It carries no
   * audio, so it is excluded from the frame count, duration, and bitrate; a
   * CBR file would otherwise look variable because that frame is smaller.
   */
  hasVbrHeaderFrame: boolean;
}

const MPEG1_LAYER3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG2_LAYER3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
const MPEG1_LAYER2_BITRATES = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
];
const MPEG1_LAYER1_BITRATES = [
  0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0,
];
const MPEG2_LAYER1_BITRATES = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
];
const SAMPLE_RATES: Record<string, readonly number[]> = {
  "1": [44_100, 48_000, 32_000],
  "2": [22_050, 24_000, 16_000],
  "2.5": [11_025, 12_000, 8_000],
};

interface FrameHeader {
  mpegVersion: "1" | "2" | "2.5";
  layer: 1 | 2 | 3;
  bitrateKbps: number;
  sampleRateHz: number;
  channelCount: number;
  samplesPerFrame: number;
  byteLength: number;
}

function bitrateTable(version: "1" | "2" | "2.5", layer: 1 | 2 | 3): readonly number[] {
  if (layer === 3) return version === "1" ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES;
  if (layer === 2) return version === "1" ? MPEG1_LAYER2_BITRATES : MPEG2_LAYER3_BITRATES;
  return version === "1" ? MPEG1_LAYER1_BITRATES : MPEG2_LAYER1_BITRATES;
}

function readFrameHeader(bytes: Uint8Array, offset: number): FrameHeader | null {
  if (offset + 4 > bytes.length) return null;
  const first = bytes[offset] as number;
  const second = bytes[offset + 1] as number;
  const third = bytes[offset + 2] as number;
  const fourth = bytes[offset + 3] as number;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return null;

  const versionBits = (second >> 3) & 0x03;
  if (versionBits === 1) return null;
  const mpegVersion = versionBits === 3 ? "1" : versionBits === 2 ? "2" : "2.5";
  const layerBits = (second >> 1) & 0x03;
  if (layerBits === 0) return null;
  const layer = (4 - layerBits) as 1 | 2 | 3;

  const bitrateKbps = bitrateTable(mpegVersion, layer)[(third >> 4) & 0x0f] ?? 0;
  if (bitrateKbps === 0) return null;
  const sampleRateHz = SAMPLE_RATES[mpegVersion]?.[(third >> 2) & 0x03] ?? 0;
  if (sampleRateHz === 0) return null;

  const padding = (third >> 1) & 0x01;
  const channelCount = ((fourth >> 6) & 0x03) === 3 ? 1 : 2;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 || mpegVersion === "1" ? 1_152 : 576;
  const byteLength = layer === 1
    ? (Math.floor(12 * bitrateKbps * 1_000 / sampleRateHz) + padding) * 4
    : Math.floor(samplesPerFrame / 8 * bitrateKbps * 1_000 / sampleRateHz) + padding;
  if (byteLength <= 4) return null;

  return {
    mpegVersion,
    layer,
    bitrateKbps,
    sampleRateHz,
    channelCount,
    samplesPerFrame,
    byteLength,
  };
}

function isVbrHeaderFrame(bytes: Uint8Array, offset: number, frameLength: number): boolean {
  const end = Math.min(offset + frameLength, bytes.length);
  for (let index = offset + 4; index + 4 <= end; index += 1) {
    const tag = String.fromCharCode(
      bytes[index] as number,
      bytes[index + 1] as number,
      bytes[index + 2] as number,
      bytes[index + 3] as number,
    );
    if (tag === "Xing" || tag === "Info" || tag === "VBRI") return true;
  }
  return false;
}

function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const flags = bytes[5] as number;
  const size = ((bytes[6] as number) & 0x7f) << 21 | ((bytes[7] as number) & 0x7f) << 14 |
    ((bytes[8] as number) & 0x7f) << 7 | ((bytes[9] as number) & 0x7f);
  return 10 + size + ((flags & 0x10) !== 0 ? 10 : 0);
}

/** Reads MPEG audio frame headers and reports the file's own properties. */
export function parseMp3Metadata(bytes: Uint8Array): Mp3Metadata {
  const id3v2Bytes = id3v2Length(bytes);
  let offset = id3v2Bytes;
  let first: FrameHeader | null = null;
  let frameCount = 0;
  let durationMs = 0;
  let bitrateSumKbps = 0;
  let constantBitrate = true;

  // Resynchronize once before the first frame; afterwards frames are contiguous.
  while (offset < bytes.length && first === null) {
    first = readFrameHeader(bytes, offset);
    if (first === null) offset += 1;
  }
  if (first === null) throw new Error("No MPEG audio frame header was found.");

  const hasVbrHeaderFrame = isVbrHeaderFrame(bytes, offset, first.byteLength);
  if (hasVbrHeaderFrame) {
    offset += first.byteLength;
    const afterHeaderFrame = readFrameHeader(bytes, offset);
    if (afterHeaderFrame === null) {
      throw new Error("The Xing/Info header frame is not followed by an audio frame.");
    }
    first = afterHeaderFrame;
  }

  let header: FrameHeader | null = first;
  while (header !== null) {
    frameCount += 1;
    durationMs += header.samplesPerFrame * 1_000 / header.sampleRateHz;
    bitrateSumKbps += header.bitrateKbps;
    if (header.bitrateKbps !== first.bitrateKbps) constantBitrate = false;
    offset += header.byteLength;
    header = readFrameHeader(bytes, offset);
  }

  return {
    mpegVersion: first.mpegVersion,
    layer: first.layer,
    sampleRateHz: first.sampleRateHz,
    channelCount: first.channelCount,
    frameCount,
    durationMs,
    averageBitrateKbps: Math.round(bitrateSumKbps / frameCount),
    constantBitrate,
    id3v2Bytes,
    hasVbrHeaderFrame,
  };
}
