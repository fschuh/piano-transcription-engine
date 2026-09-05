import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as production from "../dist/index.js";
import * as browser from "../dist/browser/index.js";
import { inventoryRecordingFiles } from "../dist/eval/index.js";

test("keeps production, browser, and evaluation exports separate", () => {
  assert.deepEqual(Object.keys(production), []);
  assert.deepEqual(Object.keys(browser), []);
  assert.equal("inventoryRecordingFiles" in production, false);
  assert.equal("inventoryRecordingFiles" in browser, false);
  assert.equal(typeof inventoryRecordingFiles, "function");
});

test("evaluation inventory lists inputs without reading their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "piano-transcription-engine-inventory-"));
  try {
    await mkdir(join(root, "gold", "take"), { recursive: true });
    await mkdir(join(root, "silver"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "gold", "take", "one.mp3"), "not audio"),
      writeFile(join(root, "gold", "take", "one.mid"), "not midi"),
      writeFile(join(root, "silver", "two.MP3"), "not audio"),
      writeFile(join(root, "silver", "two.MIDI"), "not midi"),
      writeFile(join(root, "README.md"), "ignored"),
    ]);
    const inventory = await inventoryRecordingFiles(root);
    assert.equal(inventory.root, root);
    assert.deepEqual(inventory.audioFiles, ["gold/take/one.mp3", "silver/two.MP3"]);
    assert.deepEqual(inventory.midiFiles, ["gold/take/one.mid", "silver/two.MIDI"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

