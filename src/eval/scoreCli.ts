#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { evaluationRecordingRoleOf, parseEvaluationProtocol } from "./evaluationProtocol.js";
import { applyAnnotationCorrections, createAnnotationReviewQueue } from "./annotationReview.js";
import { parseMidiFile } from "./midiFile.js";
import { evaluateRecognitionRecording, type GoldMoment } from "./recognitionEvaluation.js";
import { readOnlineAmtTrace } from "./traceStore.js";

try {
  const { values } = parseArgs({
    options: {
      trace: { type: "string" },
      midi: { type: "string" },
      protocol: { type: "string" },
      output: { type: "string" },
      "onset-lag-ms": { type: "string" },
      "gold-moments": { type: "string" },
      corrections: { type: "string" },
      "review-output": { type: "string" },
      "raw-frames": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: piano-transcription-score --trace DIR --midi FILE --protocol FILE " +
      "--output FILE --onset-lag-ms NUMBER [--gold-moments FILE] [--raw-frames] [--corrections FILE] [--review-output FILE]\n" +
      "Gold moments: JSON array of { onsetMs, pitches, pitchOnsetsMs? } in unaligned MIDI time.",
    );
  } else {
    if (!values.trace || !values.midi || !values.protocol || !values.output ||
      values["onset-lag-ms"] === undefined) {
      throw new Error("Required: --trace, --midi, --protocol, --output, --onset-lag-ms. See --help.");
    }
    const { trace, metadata } = await readOnlineAmtTrace(values.trace);
    const protocol = parseEvaluationProtocol(JSON.parse(await readFile(values.protocol, "utf8")));
    const role = evaluationRecordingRoleOf(protocol, metadata.recordingId);
    if (!role) throw new Error(`Protocol does not assign ${metadata.recordingId}.`);

    const original = parseMidiFile(await readFile(values.midi)).notes;
    const corrections = values.corrections ? JSON.parse(await readFile(values.corrections, "utf8")) : [];
    if (!Array.isArray(corrections)) throw new Error("Corrections must be a JSON array of reviewed edits.");
    const references = applyAnnotationCorrections(original, corrections);
    let goldMoments: GoldMoment[] | undefined;
    if (values["gold-moments"]) {
      const parsed: unknown = JSON.parse(await readFile(values["gold-moments"], "utf8"));
      const invalidPitch = (pitch: unknown) => typeof pitch !== "number" ||
        !Number.isInteger(pitch) || pitch < 0 || pitch > 127;
      if (!Array.isArray(parsed) || parsed.some((moment) =>
        !moment || !Number.isFinite(moment.onsetMs) ||
        !Array.isArray(moment.pitches) || !moment.pitches.length ||
        moment.pitches.some(invalidPitch))) {
        throw new Error("Invalid gold moments: expected an array of { onsetMs, pitches: MIDI[] }.");
      }
      goldMoments = parsed as GoldMoment[];
    }
    const report = evaluateRecognitionRecording({
      recordingId: metadata.recordingId,
      trace,
      references,
      protocol,
      onsetEstimateLagMs: Number(values["onset-lag-ms"]),
      includeRawFrames: values["raw-frames"] ?? false,
      ...(goldMoments ? { goldMoments } : {}),
    });
    const document = { role, protocol, capture: metadata, annotationFile: values.midi, corrections, report };
    await writeFile(values.output, JSON.stringify(document, null, 2) + "\n");
    if (values["review-output"]) {
      await writeFile(values["review-output"], JSON.stringify(createAnnotationReviewQueue(report, trace), null, 2) + "\n");
    }
    console.log(
      `Wrote ${values.output}: ${report.references.length} reference attacks, ` +
      `${report.comparisons.length} readouts. ` +
      (role === "confirmation" ? "Confirmation: do not use failure details to tune." : ""),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
