import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_MOMENT_TOLERANCE_MS,
  groupMidiNotesIntoMoments,
  inventoryRecordingCorpus,
  parseMidiFile,
  parseMp3Metadata,
  parseSetupMetadata,
} from "../dist/eval/index.js";

const TICKS_PER_QUARTER_NOTE = 96;
/** Default tempo is 500,000 µs per quarter note, so one tick is 5.2083 ms. */
const MS_PER_TICK = 500_000 / TICKS_PER_QUARTER_NOTE / 1_000;

function variableLength(value) {
  const bytes = [value & 0x7f];
  let rest = value >> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
}

/** Builds a format 0 file from `{ deltaTicks, bytes }` events. */
function midiFile(events, { format = 0 } = {}) {
  const track = events.flatMap((event) => [...variableLength(event.deltaTicks), ...event.bytes]);
  track.push(0x00, 0xff, 0x2f, 0x00);
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    0, format, 0, 1,
    TICKS_PER_QUARTER_NOTE >> 8, TICKS_PER_QUARTER_NOTE & 0xff,
  ];
  const length = track.length;
  return Uint8Array.from([
    ...header,
    0x4d, 0x54, 0x72, 0x6b,
    (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff,
    ...track,
  ]);
}

/** One chord: every pitch attacked together, released `durationTicks` later. */
function chordEvents(pitches, gapTicks, durationTicks) {
  const events = [];
  pitches.forEach((midi, index) => {
    events.push({ deltaTicks: index === 0 ? gapTicks : 0, bytes: [0x90, midi, 0x64] });
  });
  pitches.forEach((midi, index) => {
    events.push({ deltaTicks: index === 0 ? durationTicks : 0, bytes: [0x80, midi, 0x40] });
  });
  return events;
}

const MPEG1_LAYER3_STEREO_128 = [0xff, 0xfb, 0x90, 0x00];
const FRAME_BYTES = Math.floor(1152 / 8 * 128_000 / 44_100);
const FRAME_MS = 1152 / 44_100 * 1_000;

function mp3File(frameCount, { id3v2 = false, xingFrame = false } = {}) {
  const bytes = [];
  if (id3v2) {
    bytes.push(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0));
  }
  if (xingFrame) {
    const frame = new Array(FRAME_BYTES).fill(0);
    frame.splice(0, 4, ...MPEG1_LAYER3_STEREO_128);
    frame.splice(36, 4, 0x58, 0x69, 0x6e, 0x67); // "Xing"
    bytes.push(...frame);
  }
  for (let index = 0; index < frameCount; index += 1) {
    bytes.push(...MPEG1_LAYER3_STEREO_128, ...new Array(FRAME_BYTES - 4).fill(0));
  }
  return Uint8Array.from(bytes);
}

test("the MIDI reader recovers attacks, releases, and tempo timing", () => {
  const bytes = midiFile([
    ...chordEvents([60, 64, 67], 0, 96),
    ...chordEvents([62], 96, 48),
  ]);
  const parsed = parseMidiFile(bytes);
  assert.equal(parsed.format, 0);
  assert.equal(parsed.ticksPerQuarterNote, TICKS_PER_QUARTER_NOTE);
  assert.deepEqual(parsed.notes.map((note) => note.midi), [60, 64, 67, 62]);
  assert.deepEqual(parsed.notes.map((note) => Math.round(note.onsetMs)), [0, 0, 0, 1_000]);
  assert.deepEqual(parsed.notes.map((note) => Math.round(note.offsetMs)), [500, 500, 500, 1_250]);
  assert.equal(parsed.notes.every((note) => !note.unterminated), true);
});

test("a note-on with zero velocity releases, and running status is honored", () => {
  const parsed = parseMidiFile(midiFile([
    { deltaTicks: 0, bytes: [0x90, 60, 0x64] },
    { deltaTicks: 96, bytes: [72, 0x64] },        // running status: another note-on
    { deltaTicks: 96, bytes: [60, 0x00] },        // running status: zero-velocity release
  ]));
  assert.deepEqual(parsed.notes.map((note) => note.midi), [60, 72]);
  assert.equal(Math.round(parsed.notes[0].offsetMs), 1_000);
  assert.equal(parsed.notes[0].unterminated, false);
  // The held note is closed at the end of the file and reported as unterminated.
  assert.equal(parsed.notes[1].unterminated, true);
  assert.equal(Math.round(parsed.notes[1].offsetMs), 1_000);
});

test("a tempo change re-times every following attack", () => {
  const parsed = parseMidiFile(midiFile([
    { deltaTicks: 0, bytes: [0x90, 60, 0x64] },
    { deltaTicks: 96, bytes: [0xff, 0x51, 0x03, 0x03, 0xd0, 0x90] }, // 250,000 µs per quarter
    { deltaTicks: 96, bytes: [0x90, 62, 0x64] },
  ]));
  assert.equal(parsed.tempoChanges.length, 1);
  assert.equal(Math.round(parsed.notes[0].onsetMs), 0);
  // 96 ticks at the default tempo, then 96 ticks at half that quarter length.
  assert.equal(Math.round(parsed.notes[1].onsetMs), 500 + 250);
});

test("SMPTE timing and a wrong track count are refused, not guessed at", () => {
  const smpte = midiFile([{ deltaTicks: 0, bytes: [0x90, 60, 0x64] }]);
  smpte[12] = 0xe8;
  assert.throws(() => parseMidiFile(smpte), /SMPTE/);

  const wrongTrackCount = midiFile([{ deltaTicks: 0, bytes: [0x90, 60, 0x64] }]);
  wrongTrackCount[11] = 3;
  assert.throws(() => parseMidiFile(wrongTrackCount), /declares 3 tracks/);
});

test("moments split on the gap between attacks, not on a fixed window", () => {
  const notes = [0, 20, 40, 400, 420, 900].map((onsetMs) => ({ midi: 60, onsetMs }));
  // A chord spread across 40 ms stays one moment even though it exceeds no
  // single-note window; the 360 ms gap starts the next moment.
  assert.deepEqual(
    groupMidiNotesIntoMoments(notes, DEFAULT_MOMENT_TOLERANCE_MS).map((moment) => moment.length),
    [3, 2, 1],
  );
  assert.deepEqual(groupMidiNotesIntoMoments(notes, 10).map((moment) => moment.length),
    [1, 1, 1, 1, 1, 1]);
  assert.throws(() => groupMidiNotesIntoMoments(notes, -1), /non-negative/);
});

test("the MP3 reader reports the file's own properties", () => {
  const parsed = parseMp3Metadata(mp3File(10));
  assert.equal(parsed.mpegVersion, "1");
  assert.equal(parsed.layer, 3);
  assert.equal(parsed.sampleRateHz, 44_100);
  assert.equal(parsed.channelCount, 2);
  assert.equal(parsed.frameCount, 10);
  assert.equal(parsed.averageBitrateKbps, 128);
  assert.equal(parsed.constantBitrate, true);
  assert.equal(Math.round(parsed.durationMs), Math.round(10 * FRAME_MS));
  assert.equal(parsed.id3v2Bytes, 0);
  assert.equal(parsed.hasVbrHeaderFrame, false);
});

test("an ID3v2 tag is skipped and a Xing header frame is not counted as audio", () => {
  const tagged = parseMp3Metadata(mp3File(10, { id3v2: true }));
  assert.equal(tagged.id3v2Bytes, 20);
  assert.equal(tagged.frameCount, 10);

  const xing = parseMp3Metadata(mp3File(10, { id3v2: true, xingFrame: true }));
  assert.equal(xing.hasVbrHeaderFrame, true);
  assert.equal(xing.frameCount, 10, "the Xing frame carries no audio");
  assert.equal(Math.round(xing.durationMs), Math.round(10 * FRAME_MS));
});

test("metadata is read as flat descriptive keys or refused", () => {
  assert.deepEqual(
    parseSetupMetadata("instrument: Upright\nmicrophone: Laptop\nroom: Studio A\n"),
    { instrument: "Upright", microphone: "Laptop", additional: { room: "Studio A" } },
  );
  assert.throws(() => parseSetupMetadata("instrument: Yamaha\n  make: GC1\n"), /nested/);
  assert.throws(() => parseSetupMetadata("microphone:\n"), /has no value/);
  assert.throws(() => parseSetupMetadata("instrument\n"), /not `key: value`/);
});

/** A corpus shaped like the private one: a described gold setup and loose silver pairs. */
async function buildCorpus(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "piano-transcription-corpus-"));
  const goldDirectory = join(root, "gold", "described-setup");
  await mkdir(goldDirectory, { recursive: true });
  await mkdir(join(root, "silver"), { recursive: true });
  await writeFile(
    join(goldDirectory, "metadata.yaml"),
    "instrument: Test Upright\nmicrophone: Test Microphone\n",
  );

  // Two takes of the same two moments at different tempos, as real takes differ.
  for (const [take, gapTicks, frameCount] of [["take-one", 96, 80], ["take-two", 192, 90]]) {
    await writeFile(
      join(goldDirectory, `${take}.mid`),
      midiFile([...chordEvents([60, 64], 0, 48), ...chordEvents([67], gapTicks, 48)]),
    );
    await writeFile(join(goldDirectory, `${take}.mp3`), mp3File(frameCount));
  }
  await writeFile(join(root, "silver", "loose.mid"), midiFile(chordEvents([72], 0, 48)));
  await writeFile(join(root, "silver", "loose.mp3"), mp3File(70));
  await overrides.extra?.(root, goldDirectory);
  return root;
}

const goldAnnotation = {
  id: "test-annotation",
  appliesToSetupId: "gold/described-setup",
  moments: [{ pitches: [60, 64] }, { pitches: [67] }],
};

test("a healthy corpus reports gold and silver separately with no errors", async () => {
  const root = await buildCorpus();
  try {
    const inventory = await inventoryRecordingCorpus(root, { annotations: [goldAnnotation] });
    assert.deepEqual(inventory.errors, []);
    assert.equal(inventory.ok, true);
    assert.deepEqual(inventory.tiers.map((tier) => [tier.tier, tier.setupCount, tier.pairCount]), [
      ["gold", 1, 2],
      ["silver", 1, 1],
    ]);

    const gold = inventory.setups.find((setup) => setup.tier === "gold");
    assert.equal(gold.described, true);
    assert.deepEqual(gold.source, {
      instrument: "Test Upright",
      microphone: "Test Microphone",
    });
    assert.deepEqual(gold.takes.map((take) => take.id), ["take-one", "take-two"]);
    for (const take of gold.takes) {
      assert.equal(take.annotationId, "test-annotation");
      assert.deepEqual(take.errors, []);
      assert.equal(take.midi.noteCount, 3);
      assert.equal(take.midi.momentCount, 2);
      assert.equal(take.audio.sampleRateHz, 44_100);
      assert.ok(take.audio.durationMs > take.midi.lastOnsetMs);
    }

    // Each loose silver pair is its own setup with an unknown source.
    const silver = inventory.setups.find((setup) => setup.tier === "silver");
    assert.equal(silver.described, false);
    assert.deepEqual(silver.source, {});
    assert.equal(silver.takes.length, 1);
    assert.equal(silver.id, "silver/loose");
    assert.equal(silver.takes[0].id, "loose");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an annotation that does not match the recorded MIDI is reported", async () => {
  const root = await buildCorpus();
  try {
    const wrongPitch = await inventoryRecordingCorpus(root, {
      annotations: [{ ...goldAnnotation, moments: [{ pitches: [60, 65] }, { pitches: [67] }] }],
    });
    assert.equal(wrongPitch.ok, false);
    assert.equal(wrongPitch.errors.length, 2, "both takes are checked");
    assert.match(wrongPitch.errors[0], /moment 1 is \[60, 64\].*expects \[60, 65\]/);

    const wrongMomentCount = await inventoryRecordingCorpus(root, {
      annotations: [{ ...goldAnnotation, moments: [{ pitches: [60, 64, 67] }] }],
    });
    assert.equal(wrongMomentCount.ok, false);
    assert.match(
      wrongMomentCount.errors[0],
      /has 2 score moments but annotation test-annotation has 1/,
    );

    const wrongNoteCount = await inventoryRecordingCorpus(root, {
      annotations: [{ ...goldAnnotation, moments: [{ pitches: [60, 64] }, { pitches: [67, 69] }] }],
    });
    assert.equal(wrongNoteCount.ok, false);
    assert.match(wrongNoteCount.errors[0], /3 note attacks but annotation test-annotation has 4/);

    const missingSetup = await inventoryRecordingCorpus(root, {
      annotations: [{ ...goldAnnotation, appliesToSetupId: "gold/absent" }],
    });
    assert.equal(missingSetup.ok, false);
    assert.match(missingSetup.errors[0], /applies to missing setup gold\/absent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unpaired, duplicated, and out-of-span files each fail the inventory", async () => {
  const unpaired = await buildCorpus({
    extra: async (root) => {
      await writeFile(join(root, "silver", "orphan.mp3"), mp3File(5));
      await writeFile(join(root, "silver", "orphan-midi.mid"), midiFile(chordEvents([60], 0, 48)));
    },
  });
  const duplicated = await buildCorpus({
    extra: async (root) => {
      await writeFile(join(root, "silver", "copy.mp3"), mp3File(70));
      await writeFile(join(root, "silver", "copy.mid"), midiFile(chordEvents([72], 0, 48)));
    },
  });
  const outOfSpan = await buildCorpus({
    extra: async (root) => {
      await writeFile(join(root, "silver", "late.mid"), midiFile(chordEvents([60], 96 * 40, 48)));
      await writeFile(join(root, "silver", "late.mp3"), mp3File(4));
    },
  });
  try {
    const unpairedResult = await inventoryRecordingCorpus(unpaired);
    assert.deepEqual(unpairedResult.unpairedAudioFiles, ["silver/orphan.mp3"]);
    assert.deepEqual(unpairedResult.unpairedMidiFiles, ["silver/orphan-midi.mid"]);
    assert.equal(unpairedResult.ok, false);

    const duplicatedResult = await inventoryRecordingCorpus(duplicated);
    assert.deepEqual(duplicatedResult.duplicateAudioFileGroups, [
      ["silver/copy.mp3", "silver/loose.mp3"],
    ]);
    assert.deepEqual(duplicatedResult.duplicateMidiFileGroups, [
      ["silver/copy.mid", "silver/loose.mid"],
    ]);
    assert.equal(duplicatedResult.ok, false);

    const outOfSpanResult = await inventoryRecordingCorpus(outOfSpan);
    assert.equal(outOfSpanResult.ok, false);
    assert.match(
      outOfSpanResult.errors.join("\n"),
      /late\.mp3: last note attack at \d+ ms is past its \d+ ms audio/,
    );
  } finally {
    for (const root of [unpaired, duplicated, outOfSpan]) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a pair outside the gold and silver tiers is an error, not a silent skip", async () => {
  const root = await buildCorpus({
    extra: async (value) => {
      await writeFile(join(value, "stray.mid"), midiFile(chordEvents([60], 0, 48)));
      await writeFile(join(value, "stray.mp3"), mp3File(5));
    },
  });
  try {
    const inventory = await inventoryRecordingCorpus(root);
    assert.equal(inventory.ok, false);
    assert.match(inventory.errors.join("\n"), /stray\.mp3 is outside the gold and silver tiers/);
    assert.equal(inventory.setups.some((setup) => setup.id === "stray"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two annotations for one setup are refused rather than silently ranked", async () => {
  const root = await buildCorpus();
  try {
    await assert.rejects(
      inventoryRecordingCorpus(root, {
        annotations: [goldAnnotation, { ...goldAnnotation, id: "second-annotation" }],
      }),
      /Two annotations apply to setup gold\/described-setup/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
