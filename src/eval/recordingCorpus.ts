/**
 * Corpus validation for a private recording repository.
 *
 * The engine owns the implementation; the recordings, their annotations, and
 * every derived per-recording export stay in the private repository that calls
 * this. Nothing here embeds a score: annotations arrive as caller data, and the
 * inventory reads its inputs without decoding audio or rewriting a file.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseMp3Metadata, type Mp3Metadata } from "./audioFile.js";
import { groupMidiNotesIntoMoments, parseMidiFile } from "./midiFile.js";
import { inventoryRecordingFiles } from "./recordingInventory.js";

/**
 * Default gap that separates two score moments.
 *
 * Measured against the five gold takes, every tolerance from 33 ms to 161 ms
 * yields their 27 moments, so this sits near the middle of the window that
 * holds for the slowest and the fastest take alike.
 */
export const DEFAULT_MOMENT_TOLERANCE_MS = 80;

/**
 * How far a MIDI note attack may fall outside its paired audio before it is an
 * error. Frame-header duration and a decoder's duration differ by up to about
 * one encoder delay, so a small allowance keeps the check about annotation
 * mistakes rather than about MP3 padding.
 */
export const DEFAULT_AUDIO_SPAN_TOLERANCE_MS = 250;

export type RecordingTier = "gold" | "silver";

/** One score moment of a private annotation, supplied by the caller as data. */
export interface ScoreMomentAnnotation {
  measure?: number;
  moment?: number;
  pitches: readonly number[];
}

/** A private score annotation applied to every take of one setup. */
export interface ScoreAnnotation {
  id: string;
  /** Setup id the annotation applies to, such as `gold/mario-course-clear`. */
  appliesToSetupId: string;
  moments: readonly ScoreMomentAnnotation[];
}

export interface RecordingSetupSource {
  instrument?: string;
  microphone?: string;
  /** Extra descriptive keys the metadata file carried. */
  additional?: Record<string, string>;
}

export interface RecordingMidiSummary {
  format: number;
  ticksPerQuarterNote: number;
  noteCount: number;
  momentCount: number;
  firstOnsetMs: number;
  lastOnsetMs: number;
  lastOffsetMs: number;
  tempoChangeCount: number;
}

export interface RecordingTakeInventory {
  id: string;
  audioFile: string;
  midiFile: string;
  audio: Mp3Metadata;
  midi: RecordingMidiSummary;
  /** Annotation this take was checked against, when one applied. */
  annotationId: string | null;
  errors: string[];
}

export interface RecordingSetupInventory {
  id: string;
  tier: RecordingTier;
  /** True when the setup came from a `metadata.yaml` directory. */
  described: boolean;
  source: RecordingSetupSource;
  takes: RecordingTakeInventory[];
  errors: string[];
}

export interface RecordingTierSummary {
  tier: RecordingTier;
  setupCount: number;
  pairCount: number;
  totalDurationMs: number;
}

export interface RecordingCorpusInventory {
  root: string;
  ok: boolean;
  tiers: RecordingTierSummary[];
  setups: RecordingSetupInventory[];
  unpairedAudioFiles: string[];
  unpairedMidiFiles: string[];
  duplicateAudioFileGroups: string[][];
  duplicateMidiFileGroups: string[][];
  /** Every error in the corpus, including the per-setup and per-take ones. */
  errors: string[];
}

export interface RecordingCorpusOptions {
  annotations?: readonly ScoreAnnotation[];
  momentToleranceMs?: number;
  audioSpanToleranceMs?: number;
}

function tierOf(path: string): RecordingTier | null {
  if (path.startsWith("gold/")) return "gold";
  if (path.startsWith("silver/")) return "silver";
  return null;
}

function basenameWithoutExtension(path: string): string {
  return path.slice(0, path.lastIndexOf("."));
}

/**
 * Reads the descriptive `key: value` lines of a setup metadata file.
 *
 * A nested or list-valued document is rejected rather than partly understood,
 * because silently dropping a key would misdescribe the setup.
 */
export function parseSetupMetadata(text: string): RecordingSetupSource {
  const additional: Record<string, string> = {};
  const source: RecordingSetupSource = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("-") || rawLine.startsWith(" ") || rawLine.startsWith("\t")) {
      throw new Error(`Unsupported nested or list metadata line: ${line}`);
    }
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`Metadata line is not \`key: value\`: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value.length === 0) throw new Error(`Metadata key ${key} has no value.`);
    if (key === "instrument") source.instrument = value;
    else if (key === "microphone") source.microphone = value;
    else additional[key] = value;
  }
  if (Object.keys(additional).length > 0) source.additional = additional;
  return source;
}

function sortedPitches(pitches: readonly number[]): number[] {
  return [...pitches].sort((left, right) => left - right);
}

function checkAnnotation(
  take: RecordingTakeInventory,
  annotation: ScoreAnnotation,
  moments: number[][],
): void {
  const expectedNoteCount = annotation.moments
    .reduce((sum, moment) => sum + moment.pitches.length, 0);
  if (take.midi.noteCount !== expectedNoteCount) {
    take.errors.push(
      `has ${take.midi.noteCount} note attacks but annotation ${annotation.id} has ${expectedNoteCount}`,
    );
  }
  if (moments.length !== annotation.moments.length) {
    take.errors.push(
      `has ${moments.length} score moments but annotation ${annotation.id} has ${annotation.moments.length}`,
    );
    return;
  }
  for (const [index, expected] of annotation.moments.entries()) {
    const actual = moments[index] ?? [];
    const wanted = sortedPitches(expected.pitches);
    if (actual.length !== wanted.length || actual.some((midi, at) => midi !== wanted[at])) {
      take.errors.push(
        `moment ${index + 1} is [${actual.join(", ")}] but annotation ${annotation.id} expects [${wanted.join(", ")}]`,
      );
    }
  }
}

async function readTake(
  root: string,
  id: string,
  audioFile: string,
  midiFile: string,
  momentToleranceMs: number,
  audioSpanToleranceMs: number,
): Promise<{ take: RecordingTakeInventory; moments: number[][] }> {
  const audioBytes = new Uint8Array(await readFile(resolve(root, audioFile)));
  const midiBytes = new Uint8Array(await readFile(resolve(root, midiFile)));
  const audio = parseMp3Metadata(audioBytes);
  const parsed = parseMidiFile(midiBytes);
  const grouped = groupMidiNotesIntoMoments(parsed.notes, momentToleranceMs);
  const moments = grouped.map((moment) => sortedPitches(moment.map((note) => note.midi)));
  const firstOnsetMs = parsed.notes[0]?.onsetMs ?? 0;
  const lastOnsetMs = parsed.notes[parsed.notes.length - 1]?.onsetMs ?? 0;
  const lastOffsetMs = parsed.notes.reduce((latest, note) => Math.max(latest, note.offsetMs), 0);

  const take: RecordingTakeInventory = {
    id,
    audioFile,
    midiFile,
    audio,
    midi: {
      format: parsed.format,
      ticksPerQuarterNote: parsed.ticksPerQuarterNote,
      noteCount: parsed.notes.length,
      momentCount: moments.length,
      firstOnsetMs,
      lastOnsetMs,
      lastOffsetMs,
      tempoChangeCount: parsed.tempoChanges.length,
    },
    annotationId: null,
    errors: [],
  };

  if (parsed.notes.length === 0) {
    take.errors.push("contains no MIDI note attacks");
  } else {
    if (firstOnsetMs < -audioSpanToleranceMs) {
      take.errors.push(`first note attack is ${firstOnsetMs.toFixed(0)} ms, before its audio starts`);
    }
    if (lastOnsetMs > audio.durationMs + audioSpanToleranceMs) {
      take.errors.push(
        `last note attack at ${lastOnsetMs.toFixed(0)} ms is past its ${audio.durationMs.toFixed(0)} ms audio`,
      );
    }
  }
  return { take, moments };
}

function duplicateGroups(digests: Map<string, string[]>): string[][] {
  return [...digests.values()]
    .filter((paths) => paths.length > 1)
    .map((paths) => [...paths].sort())
    .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
}

/**
 * Validates a private recording corpus in place.
 *
 * Files are read but never written, decoded, resampled, or normalized, and no
 * recording-derived material is returned beyond the descriptive summary above.
 */
export async function inventoryRecordingCorpus(
  recordingRoot: string,
  options: RecordingCorpusOptions = {},
): Promise<RecordingCorpusInventory> {
  const momentToleranceMs = options.momentToleranceMs ?? DEFAULT_MOMENT_TOLERANCE_MS;
  const audioSpanToleranceMs = options.audioSpanToleranceMs ?? DEFAULT_AUDIO_SPAN_TOLERANCE_MS;
  const files = await inventoryRecordingFiles(recordingRoot);
  const root = files.root;

  const midiByStem = new Map<string, string>();
  for (const midiFile of files.midiFiles) midiByStem.set(basenameWithoutExtension(midiFile), midiFile);
  const audioByStem = new Map<string, string>();
  for (const audioFile of files.audioFiles) audioByStem.set(basenameWithoutExtension(audioFile), audioFile);

  const unpairedAudioFiles = files.audioFiles.filter((path) => !midiByStem.has(basenameWithoutExtension(path)));
  const unpairedMidiFiles = files.midiFiles.filter((path) => !audioByStem.has(basenameWithoutExtension(path)));

  const audioDigests = new Map<string, string[]>();
  const midiDigests = new Map<string, string[]>();
  for (const [paths, digests] of [
    [files.audioFiles, audioDigests] as const,
    [files.midiFiles, midiDigests] as const,
  ]) {
    for (const path of paths) {
      const digest = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
      digests.set(digest, [...(digests.get(digest) ?? []), path]);
    }
  }

  const annotationsBySetup = new Map<string, ScoreAnnotation>();
  for (const annotation of options.annotations ?? []) {
    if (annotationsBySetup.has(annotation.appliesToSetupId)) {
      throw new Error(`Two annotations apply to setup ${annotation.appliesToSetupId}.`);
    }
    annotationsBySetup.set(annotation.appliesToSetupId, annotation);
  }

  const setups = new Map<string, RecordingSetupInventory>();
  const errors: string[] = [];

  for (const audioFile of files.audioFiles) {
    const stem = basenameWithoutExtension(audioFile);
    const midiFile = midiByStem.get(stem);
    if (midiFile === undefined) continue;
    const tier = tierOf(audioFile);
    if (tier === null) {
      errors.push(`${audioFile} is outside the gold and silver tiers`);
      continue;
    }
    const directory = dirname(audioFile);
    const describedDirectory = directory !== tier;
    const setupId = describedDirectory ? directory : stem;

    let setup = setups.get(setupId);
    if (setup === undefined) {
      setup = {
        id: setupId,
        tier,
        described: describedDirectory,
        source: {},
        takes: [],
        errors: [],
      };
      if (describedDirectory) {
        try {
          setup.source = parseSetupMetadata(
            await readFile(resolve(root, directory, "metadata.yaml"), "utf8"),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setup.errors.push(`metadata.yaml could not be read: ${message}`);
        }
      }
      setups.set(setupId, setup);
    }

    try {
      const { take, moments } = await readTake(
        root,
        // A take of a described setup is named within it; a loose pair is its
        // own setup, so its take carries the file's own name.
        describedDirectory ? stem.slice(directory.length + 1) : stem.slice(tier.length + 1),
        audioFile,
        midiFile,
        momentToleranceMs,
        audioSpanToleranceMs,
      );
      const annotation = annotationsBySetup.get(setupId);
      if (annotation !== undefined) {
        take.annotationId = annotation.id;
        checkAnnotation(take, annotation, moments);
      }
      setup.takes.push(take);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setup.errors.push(`${audioFile} could not be inventoried: ${message}`);
    }
  }

  for (const annotation of annotationsBySetup.values()) {
    if (!setups.has(annotation.appliesToSetupId)) {
      errors.push(
        `annotation ${annotation.id} applies to missing setup ${annotation.appliesToSetupId}`,
      );
    }
  }

  const orderedSetups = [...setups.values()].sort((left, right) => left.id.localeCompare(right.id));
  for (const setup of orderedSetups) {
    setup.takes.sort((left, right) => left.audioFile.localeCompare(right.audioFile));
  }

  const duplicateAudioFileGroups = duplicateGroups(audioDigests);
  const duplicateMidiFileGroups = duplicateGroups(midiDigests);

  for (const path of unpairedAudioFiles) errors.push(`${path} has no paired MIDI file`);
  for (const path of unpairedMidiFiles) errors.push(`${path} has no paired MP3 file`);
  for (const group of duplicateAudioFileGroups) errors.push(`identical MP3 files: ${group.join(", ")}`);
  for (const group of duplicateMidiFileGroups) errors.push(`identical MIDI files: ${group.join(", ")}`);
  for (const setup of orderedSetups) {
    for (const message of setup.errors) errors.push(`${setup.id}: ${message}`);
    for (const take of setup.takes) {
      for (const message of take.errors) errors.push(`${take.audioFile}: ${message}`);
    }
  }

  const tiers: RecordingTierSummary[] = (["gold", "silver"] as const).map((tier) => {
    const tierSetups = orderedSetups.filter((setup) => setup.tier === tier);
    const takes = tierSetups.flatMap((setup) => setup.takes);
    return {
      tier,
      setupCount: tierSetups.length,
      pairCount: takes.length,
      totalDurationMs: takes.reduce((sum, take) => sum + take.audio.durationMs, 0),
    };
  });

  return {
    root,
    ok: errors.length === 0,
    tiers,
    setups: orderedSetups,
    unpairedAudioFiles,
    unpairedMidiFiles,
    duplicateAudioFileGroups,
    duplicateMidiFileGroups,
    errors,
  };
}
