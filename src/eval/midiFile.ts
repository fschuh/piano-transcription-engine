/**
 * Minimal Standard MIDI File reader for corpus validation.
 *
 * It exists so the private recording repository can check its own annotations
 * without shipping a MIDI library into the production engine. It reads note
 * attacks, releases, and the tempo map; it never writes, normalizes, or
 * re-times a source file, and it holds no score content of its own.
 */

/** One sounding note recovered from a note-on/note-off pair. */
export interface MidiNote {
  midi: number;
  channel: number;
  velocity: number;
  onsetMs: number;
  offsetMs: number;
  /** True when the file ended while the note was still held. */
  unterminated: boolean;
}

export interface MidiTempoChange {
  atMs: number;
  microsecondsPerQuarterNote: number;
}

export interface MidiFileContents {
  format: number;
  trackCount: number;
  ticksPerQuarterNote: number;
  /** Note-on events in capture order: onset time, then pitch. */
  notes: MidiNote[];
  tempoChanges: MidiTempoChange[];
  /** Time of the last event in the file, including non-note events. */
  durationMs: number;
}

const DEFAULT_MICROSECONDS_PER_QUARTER_NOTE = 500_000;

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  byte(): number {
    if (this.offset >= this.bytes.length) throw new Error("MIDI data ended unexpectedly.");
    const value = this.bytes[this.offset] as number;
    this.offset += 1;
    return value;
  }

  peek(): number {
    if (this.offset >= this.bytes.length) throw new Error("MIDI data ended unexpectedly.");
    return this.bytes[this.offset] as number;
  }

  uint16(): number {
    return (this.byte() << 8) | this.byte();
  }

  uint32(): number {
    return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
  }

  chunkType(): string {
    return String.fromCharCode(this.byte(), this.byte(), this.byte(), this.byte());
  }

  skip(count: number): void {
    if (this.offset + count > this.bytes.length) {
      throw new Error("MIDI data ended unexpectedly.");
    }
    this.offset += count;
  }

  /** Variable-length quantity, at most four bytes per the specification. */
  variableLength(): number {
    let value = 0;
    for (let index = 0; index < 4; index += 1) {
      const byte = this.byte();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("MIDI variable-length quantity is longer than four bytes.");
  }
}

interface TrackEvent {
  tick: number;
  track: number;
  index: number;
  status: number;
  data1: number;
  data2: number;
  /** Set for a tempo meta event. */
  microsecondsPerQuarterNote?: number;
}

function readTrack(bytes: Uint8Array, track: number, events: TrackEvent[]): void {
  const reader = new Reader(bytes);
  let tick = 0;
  let runningStatus = 0;
  let index = 0;
  while (!reader.done) {
    tick += reader.variableLength();
    let status = reader.peek();
    if (status >= 0x80) {
      reader.byte();
      if (status < 0xf0) runningStatus = status;
    } else {
      if (runningStatus === 0) throw new Error("MIDI running status used before any status byte.");
      status = runningStatus;
    }

    if (status === 0xff) {
      const type = reader.byte();
      const length = reader.variableLength();
      if (type === 0x51 && length === 3) {
        const microsecondsPerQuarterNote = (reader.byte() << 16) |
          (reader.byte() << 8) | reader.byte();
        events.push({
          tick,
          track,
          index: index += 1,
          status,
          data1: type,
          data2: 0,
          microsecondsPerQuarterNote,
        });
        continue;
      }
      reader.skip(length);
      events.push({ tick, track, index: index += 1, status, data1: type, data2: 0 });
      if (type === 0x2f) break;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      reader.skip(reader.variableLength());
      events.push({ tick, track, index: index += 1, status, data1: 0, data2: 0 });
      continue;
    }

    const command = status & 0xf0;
    const data1 = reader.byte();
    const data2 = command === 0xc0 || command === 0xd0 ? 0 : reader.byte();
    events.push({ tick, track, index: index += 1, status, data1, data2 });
  }
}

/** Reads a format 0 or 1 file with metrical (ticks-per-quarter-note) timing. */
export function parseMidiFile(bytes: Uint8Array): MidiFileContents {
  const reader = new Reader(bytes);
  if (reader.chunkType() !== "MThd") throw new Error("File does not start with an MThd chunk.");
  const headerLength = reader.uint32();
  if (headerLength < 6) throw new Error("MIDI header chunk is too short.");
  const format = reader.uint16();
  const trackCount = reader.uint16();
  const division = reader.uint16();
  reader.skip(headerLength - 6);
  if ((division & 0x8000) !== 0) {
    throw new Error("SMPTE-timed MIDI files are not supported by the corpus reader.");
  }
  if (division === 0) throw new Error("MIDI division is zero.");
  if (format !== 0 && format !== 1) {
    throw new Error(`Unsupported MIDI format ${format}; expected 0 or 1.`);
  }

  const events: TrackEvent[] = [];
  let readTracks = 0;
  while (!reader.done) {
    const type = reader.chunkType();
    const length = reader.uint32();
    const start = reader.position;
    if (type === "MTrk") {
      readTrack(bytes.subarray(start, start + length), readTracks, events);
      readTracks += 1;
    }
    reader.skip(length);
  }
  if (readTracks !== trackCount) {
    throw new Error(`MIDI header declares ${trackCount} tracks but the file contains ${readTracks}.`);
  }

  events.sort((left, right) => (
    left.tick - right.tick || left.track - right.track || left.index - right.index
  ));

  const notes: MidiNote[] = [];
  const tempoChanges: MidiTempoChange[] = [];
  const sounding = new Map<number, MidiNote[]>();
  let microsecondsPerQuarterNote = DEFAULT_MICROSECONDS_PER_QUARTER_NOTE;
  let lastTick = 0;
  let elapsedMs = 0;

  const advanceTo = (tick: number): number => {
    elapsedMs += (tick - lastTick) * microsecondsPerQuarterNote / division / 1_000;
    lastTick = tick;
    return elapsedMs;
  };

  for (const event of events) {
    const atMs = advanceTo(event.tick);
    if (event.microsecondsPerQuarterNote !== undefined) {
      microsecondsPerQuarterNote = event.microsecondsPerQuarterNote;
      tempoChanges.push({ atMs, microsecondsPerQuarterNote });
      continue;
    }
    const command = event.status & 0xf0;
    if (command !== 0x90 && command !== 0x80) continue;
    const channel = event.status & 0x0f;
    const key = channel * 128 + event.data1;
    if (command === 0x90 && event.data2 > 0) {
      const note: MidiNote = {
        midi: event.data1,
        channel,
        velocity: event.data2,
        onsetMs: atMs,
        offsetMs: atMs,
        unterminated: true,
      };
      notes.push(note);
      const open = sounding.get(key);
      if (open === undefined) sounding.set(key, [note]);
      else open.push(note);
      continue;
    }
    const open = sounding.get(key);
    const note = open?.shift();
    if (note !== undefined) {
      note.offsetMs = atMs;
      note.unterminated = false;
    }
  }

  const durationMs = advanceTo(events[events.length - 1]?.tick ?? 0);
  for (const open of sounding.values()) {
    for (const note of open) note.offsetMs = durationMs;
  }
  notes.sort((left, right) => left.onsetMs - right.onsetMs || left.midi - right.midi);

  return { format, trackCount, ticksPerQuarterNote: division, notes, tempoChanges, durationMs };
}

/**
 * Groups note attacks a performer struck together into score moments.
 *
 * A moment ends where the gap to the next attack exceeds the tolerance, so a
 * rolled or spread chord stays one moment while a deliberate next moment starts
 * a new one. The tolerance describes the performance, not a matcher setting.
 */
export function groupMidiNotesIntoMoments(
  notes: readonly MidiNote[],
  toleranceMs: number,
): MidiNote[][] {
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    throw new Error("Moment tolerance must be a non-negative number.");
  }
  const moments: MidiNote[][] = [];
  let current: MidiNote[] = [];
  let previousOnsetMs = 0;
  for (const note of notes) {
    if (current.length > 0 && note.onsetMs - previousOnsetMs > toleranceMs) {
      moments.push(current);
      current = [];
    }
    current.push(note);
    previousOnsetMs = note.onsetMs;
  }
  if (current.length > 0) moments.push(current);
  return moments;
}
