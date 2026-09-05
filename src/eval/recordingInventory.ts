import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface RecordingFileInventory {
  root: string;
  audioFiles: string[];
  midiFiles: string[];
}

async function recordingFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await recordingFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(absolute.slice(root.length + 1).replaceAll("\\", "/"));
    }
  }
  return files;
}

/**
 * Lists recording inputs without decoding or modifying them.
 *
 * Task 07 extends this foundation with pairing, metadata, MIDI, and audio-span
 * validation. Keeping it under the eval entry point prevents filesystem code
 * from entering the production package graph.
 */
export async function inventoryRecordingFiles(
  recordingRoot: string,
): Promise<RecordingFileInventory> {
  const root = resolve(recordingRoot);
  const files = (await recordingFiles(root, root)).sort();
  return {
    root,
    audioFiles: files.filter((path) => path.toLowerCase().endsWith(".mp3")),
    midiFiles: files.filter((path) => (
      path.toLowerCase().endsWith(".mid") || path.toLowerCase().endsWith(".midi")
    )),
  };
}

