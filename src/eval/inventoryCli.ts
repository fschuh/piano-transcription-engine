#!/usr/bin/env node

/**
 * Recording inventory command.
 *
 * The private evaluation repository runs this against its own `./recordings`
 * directory and its own annotation file. Both are inputs: nothing about a
 * specific corpus, score, or recording lives in this repository.
 */

import { readFile } from "node:fs/promises";

import {
  inventoryRecordingCorpus,
  type RecordingCorpusInventory,
  type ScoreAnnotation,
} from "./recordingCorpus.js";

function usage(): string {
  return [
    "Usage: eval:inventory [recordings-directory] [options]",
    "",
    "  --annotations <file>   JSON file of private score annotations",
    "  --moment-tolerance <ms>  Gap that separates two score moments",
    "  --json                 Print the full inventory as JSON",
  ].join("\n");
}

function parseAnnotations(text: string, path: string): ScoreAnnotation[] {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { annotations?: unknown }).annotations;
  if (!Array.isArray(list)) {
    throw new Error(`${path} must be an array of annotations or {"annotations": [...]}.`);
  }
  return list.map((entry, index) => {
    const annotation = entry as Partial<ScoreAnnotation>;
    if (typeof annotation.id !== "string" || annotation.id.length === 0) {
      throw new Error(`${path} annotation ${index} has no id.`);
    }
    if (typeof annotation.appliesToSetupId !== "string" || annotation.appliesToSetupId.length === 0) {
      throw new Error(`${path} annotation ${annotation.id} has no appliesToSetupId.`);
    }
    if (!Array.isArray(annotation.moments) || annotation.moments.length === 0) {
      throw new Error(`${path} annotation ${annotation.id} has no moments.`);
    }
    for (const [at, moment] of annotation.moments.entries()) {
      const pitches = (moment as { pitches?: unknown }).pitches;
      if (!Array.isArray(pitches) || pitches.length === 0 ||
        pitches.some((pitch) => !Number.isInteger(pitch))) {
        throw new Error(`${path} annotation ${annotation.id} moment ${at + 1} has invalid pitches.`);
      }
    }
    return annotation as ScoreAnnotation;
  });
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function report(inventory: RecordingCorpusInventory): string {
  const lines = [`Recording corpus: ${inventory.root}`];
  for (const tier of inventory.tiers) {
    lines.push(
      `\n${tier.tier}: ${tier.pairCount} MP3/MIDI pairs in ${tier.setupCount} setup(s), ${seconds(tier.totalDurationMs)} of audio`,
    );
    for (const setup of inventory.setups.filter((value) => value.tier === tier.tier)) {
      const described = setup.described
        ? `${setup.source.instrument ?? "unspecified instrument"} / ${setup.source.microphone ?? "unspecified microphone"}`
        : "unknown source setup";
      lines.push(`  ${setup.id} — ${setup.takes.length} take(s), ${described}`);
      for (const take of setup.takes) {
        // Report what the comparison found, never the mere fact that one ran.
        const annotated = take.annotationId === null
          ? ""
          : take.errors.length === 0
            ? `, matches ${take.annotationId}`
            : `, DIFFERS from ${take.annotationId}`;
        lines.push(
          `    ${take.id}: ${take.midi.noteCount} attacks in ${take.midi.momentCount} moments, ` +
          `${seconds(take.audio.durationMs)} ${take.audio.sampleRateHz} Hz ` +
          `${take.audio.channelCount === 1 ? "mono" : "stereo"} ` +
          `${take.audio.averageBitrateKbps} kbit/s ${take.audio.constantBitrate ? "CBR" : "VBR"}${annotated}`,
        );
      }
    }
  }
  lines.push(
    `\nUnpaired MP3 files: ${inventory.unpairedAudioFiles.length}`,
    `Unpaired MIDI files: ${inventory.unpairedMidiFiles.length}`,
    `Duplicate MP3 groups: ${inventory.duplicateAudioFileGroups.length}`,
    `Duplicate MIDI groups: ${inventory.duplicateMidiFileGroups.length}`,
  );
  if (inventory.errors.length === 0) {
    lines.push("\nNo errors.");
  } else {
    lines.push(`\n${inventory.errors.length} error(s):`);
    for (const message of inventory.errors) lines.push(`  ${message}`);
  }
  return lines.join("\n");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

let recordingRoot = "evals/fixtures";
let annotationsPath: string | undefined;
let momentToleranceMs: number | undefined;
let asJson = false;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index] as string;
  if (argument === "--json") asJson = true;
  else if (argument === "--annotations") annotationsPath = args[index += 1];
  else if (argument === "--moment-tolerance") momentToleranceMs = Number(args[index += 1]);
  else if (argument.startsWith("--")) throw new Error(`Unknown option ${argument}\n\n${usage()}`);
  else recordingRoot = argument;
}

try {
  const annotations = annotationsPath === undefined
    ? undefined
    : parseAnnotations(await readFile(annotationsPath, "utf8"), annotationsPath);
  const inventory = await inventoryRecordingCorpus(recordingRoot, {
    ...(annotations === undefined ? {} : { annotations }),
    ...(momentToleranceMs === undefined ? {} : { momentToleranceMs }),
  });
  console.log(asJson ? JSON.stringify(inventory, null, 2) : report(inventory));
  if (!inventory.ok) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not inventory ${recordingRoot}: ${message}`);
  process.exitCode = 1;
}
