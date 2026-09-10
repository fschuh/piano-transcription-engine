# Piano transcription engine

[EXTRACTION.md](https://github.com/fschuh/piano-transcription-engine/blob/main/EXTRACTION.md) records what each repository owns, the revision
both consumers pin, and the commands that qualify a later engine revision.
Round 1/2 decisions and source provenance are archived in
[legacy/rounds-1-2](https://github.com/fschuh/piano-transcription-engine/blob/main/legacy/rounds-1-2/README.md). Historical emitters and verifiers
are non-active; the production default remains `baseline-v1`.

`@fschuh/piano-transcription-engine` owns the reusable online-AMT recognition,
exact-chord matching, browser recognition, and evaluation code used by the sheet
music viewer. It is installed directly from Git at an exact commit and is not
published to npm (`private: true`).

The production entry point exposes the platform-neutral recognition contracts,
online-AMT output decoder, exact-chord matcher, matcher diagnostics, immutable
profile registry, and 16 kHz/512-sample protocol constants. The browser entry
point exposes the injected `BrowserOnlineAmtRecognizer`; the evaluation entry
exposes the public-safe functional trace replayer and the recording-corpus
inventory that the private repository runs against its own recordings.

## Commands

```text
npm ci
npm run typecheck
npm test
npm run build
npm run eval:inventory -- [recordings-directory]
npm pack --dry-run
```

Two commands are installed as binaries, which is how the private corpus
repository invokes them: `piano-transcription-eval` validates a corpus and
`piano-transcription-capture` runs recordings through the model. Only the
capture command decodes audio, and it is the only thing here that needs a local
FFmpeg install.

With no recordings directory, `eval:inventory` inspects the public-safe
`evals/fixtures` directory:

```text
piano-transcription-eval ./recordings --annotations ./annotations/<file>.json
```

It pairs MP3 and MIDI files, reports gold and silver tiers separately, treats a
`metadata.yaml` directory as one instrument/microphone setup and each loose pair
as its own unknown-source setup, and fails on unpaired files, byte-identical
duplicates, note attacks outside their paired audio, or a take that does not
match its annotation. Sample rate, channel count, duration, and bitrate are read
from frame headers and reported as-is; no input is decoded, resampled,
normalized, or rewritten.

Score annotations are **caller data**. This repository contains no score
sequence, no recording, and no annotation of its own: the private repository
passes its annotation file in at run time, and every check compares a take
against what it was given.

## Offline capture

```text
piano-transcription-capture ./recordings --protocol ./protocol/<file>.json \
  --traces ./traces --wasm ./node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm
```

`piano-transcription-capture` decodes each recording the protocol names, runs it
through the production `OnlineAmtSession` in order, and caches the raw model
output so later work replays the same frames instead of re-running inference.
Every path is the caller's: the recordings, the protocol, the trace cache, and
ONNX Runtime's WASM binary, which this package still does not resolve for its
consumer. `--model` defaults to the packaged canonical model, and `--recording`
and `--role` select a subset.

### When a cached trace may stand in for a capture

A trace is reused only when it answers the request that was made. Before the
cache is consulted the run establishes what the model would see — the model's
digest, the recording's own bytes, the sample rate and chunk size, the input
gain, and the tail flush — and a cached trace that differs in any of them is
refused, naming every difference. Reusing one would compare two configurations
while reporting one, which is worse than the capture it saved. Capture into a
different `--traces` directory to keep both, or pass `--force` to replace the
cached trace.

Two things a digest cannot settle are reported rather than enforced: a reused
trace captured by a different engine build, and one decoded by a different
converter version. Matching builds are required for a claimed production
comparison, not for every research experiment, so the run says which traces
those are and leaves the judgement to the caller.

### Which engine build captured a trace

A package version does not identify code — several revisions share one, and a
working tree can differ from every revision that exists — so every trace records
the revision as well.

The two sources are not equal, and a measurement wins. When this package is its
own checkout, that checkout is read directly: it is the code that actually ran,
and it also establishes whether the tree carried uncommitted changes. An
installed package cannot be measured — npm does not leave the revision inside
it, and this package will not guess — so a consumer passes the revision it
pinned with `--engine-revision`, and that is used only where there is nothing to
measure. A caller cannot know that the working tree in front of it differs from
the pin it names, so its claim never overwrites the checkout; it is recorded
alongside, and a claim that disagrees is reported rather than lost. Each trace
says which source its revision came from, so a caller-supplied one stays legible
as self-reported.

A run reports what it cannot vouch for. It says when the traces it wrote came
from a tree with uncommitted changes or from a build with no revision at all —
the first case being the one that matters most, since that code exists nowhere
else. Reused traces are judged on the provenance they carry rather than on the
build doing the reusing, so a clean checkout cannot launder evidence a dirty one
produced at the same commit, and a matching revision string is not enough to
make a trace attributable.

An evaluation protocol is caller data in the same way an annotation is. The
engine owns `parseEvaluationProtocol`, which fixes the shape — the gold takes,
the development/confirmation split, the onset windows and alignment offsets, the
scored and excluded intervals, the intervals noise may be estimated from, the
baseline capture settings, and the experiment budget — and refuses a document
that assigns one recording twice, names a recording it did not assign, gives a
supplemental window narrower than the primary one, or asks for a tail flush that
is not a whole number of model chunks. The recordings and their ids stay in the
private repository.

### The conversion path

Decoding needs FFmpeg on the local machine. It is a prerequisite of evaluation
only: it is not a package dependency, `prepare` does not install it, and no
production module reaches the code that spawns it. One fixed argument list
converts every recording, and it neither normalizes, filters, trims, nor
re-times anything:

```text
ffmpeg -nostdin -hide_banner -loglevel error -i <recording> -map 0:a:0 -vn \
  -ar 16000 -f wav -acodec pcm_f32le -
```

The channels are averaged to mono here rather than by `-ac 1`. FFmpeg's
stereo-to-mono rematrix is energy preserving — it sums the pair scaled by
1/sqrt(2), which is 3 dB above the average for correlated channels — while a
file that is already mono passes through untouched, so a corpus holding both
would be measured at two different levels. Averaging in the engine also
reproduces what the capture worklet does with a live input device, so an offline
trace and a live session hear the same signal.

### What a trace holds

A trace is a directory of typed-array files beside one metadata document:
`scores.f32` (five state scores for each of 88 pitches per frame), `states.u8`
(the selected state per pitch), `signal-active.u8`, and `inference-ms.f32`, all
in frame order. The metadata identifies the artifact and the build that produced it — the engine
package, version, and revision, the model's digest and size, the converter and
its version, the recording's own digest, level, and channel count, the input
gain, and the framing — and states how a frame index becomes an audio time. Frame `i` covers samples
`[i*512, i*512+512)` and its `capturedAtMs` is the time of its **last** sample,
the same convention the capture worklet posts with each live chunk, so an
offline measurement and a live one time the same decision alike.

Samples that were not in the recording are counted, never hidden: the zeros that
complete the final chunk of input are reported as `paddedSampleCount`, and the
fixed silent tail flush as `tailFlushSampleCount`. The default flush is 2,048
samples, the model's own mel window, which is exactly what the last real sample
needs to sit fully inside a mel frame and no more.

`readOnlineAmtTrace` recomputes each array's digest from the bytes on disk and
compares it against the metadata, so a truncated, swapped, or edited trace is
refused rather than replayed as evidence.

Git installation runs `prepare`, which builds JavaScript and declarations into
`dist`. A checkout therefore needs a supported Node/npm toolchain during
installation; consumers do not need a sibling viewer checkout.

## Package surface

- `@fschuh/piano-transcription-engine` is the platform-neutral production API.
- `@fschuh/piano-transcription-engine/browser` is the browser recognizer API.
- `@fschuh/piano-transcription-engine/eval` is the filesystem/evaluation API and
  must never be imported by production engine modules or the viewer.
- `@fschuh/piano-transcription-engine/assets/models/online_amt_streaming.onnx`
  and `@fschuh/piano-transcription-engine/assets/worklets/online-amt-capture.js`
  are explicit asset subpaths for consumer preparation scripts.

The package allowlist contains compiled code, declarations, the canonical model,
its license notice, and the capture worklet. Source evaluation fixtures, results,
reports, tools, and legacy material are excluded from the installed package.

The production core has no DOM, React, filesystem, viewer, benchmark, or report
dependency. Recognition results and recognizer lifecycle contracts are engine
types; viewer feedback state and presentation defaults remain application-owned.
Output decoding is target-aware only for emitting pitch evidence and does not
import or select a matcher profile. Consumers choose a profile explicitly with
`matcherOptionsForListenMatcherProfile`.

## Functional evaluation

`PUBLIC_FUNCTIONAL_EVALUATION_FIXTURES` contains nine original numeric traces
covering isolated recognition, continuous sequencing, dynamics, repeated
chords, omitted-bass and false-advance safety, and skipped/duplicate advance
correctness. `evaluateFunctionalFixture`, `evaluateFunctionalSuite`, and
`compareFunctionalMatcherConfigurations` replay them through the production
matcher and report advancement, processing-time, and latency metrics. Under
`baseline-v1` every one of the twelve expected score moments advances exactly
once, with no false, skipped, duplicate, or late advance in any case. The
repeated-chord trace holds three consecutive identical moments, mirroring the
private corpus's repeated chord, so the matcher must re-arm twice in a row while
the chord keeps sounding; removing the third attack leaves that moment
unadvanced rather than satisfied by carry-over evidence.

A comparison reports regressions per case and per classification
(`false-advance`, `skipped-advance`, `duplicate-advance`, `late-advance`, and a
changed advance order), never from a suite total or a per-case pass/fail
boolean. A candidate that removes one unsafe classification while introducing
another is therefore still reported as a regression of the classification it
made worse.

`npm test` builds the package, discards `.test-dist`, compiles the TypeScript
tests, and then discovers `test/**/*.test.mjs` and `.test-dist/test/**/*.test.js`
instead of naming each entry point. Intentional omitted-bass, extra-note,
onset-gate, and refractory mutations demonstrate that the relevant safety and
correctness cases fail when matcher behavior regresses, and boundary tests cover
the inclusive latency ceiling and the fixture validation that refuses to score an
unreplayable trace.

Enforced, not merely documented: `test/eval-boundary.test.mjs` fails if an
evaluation module imports anything but the public production entry and its
siblings, if the replayer or its fixtures reach the filesystem, network, or
process state, if a production module imports evaluation code, or if any active
test imports application code, a viewer path, or a historical Round 1/2
artifact. The boundary scanners share `tools/moduleSpecifiers.mjs`, which also
sees bare side-effect imports such as `import "react";`.

## Model and runtime

`assets/models/online_amt_streaming.onnx` is a fixed-shape, state-explicit export
of the pretrained `model-180000.pt` checkpoint from `jdasam/online_amt`.

- Upstream revision: `f353035175cc3436ebdc411530a9e73c966d2077`
- Upstream checkpoint SHA-256:
  `54ab4907b517dbfa2dbbee834db18d31d103ee25d690860595181162d235e3a0`
- Exported ONNX SHA-256:
  `a77be8262d3742ce4d9e7d29146d8b17f5755650a7d2aee952bf5bf5ed190ac4`
- Exported size: 71,955,821 bytes
- License: MIT; the required notice is next to the model and reproduced in
  `THIRD_PARTY_NOTICES.md`.

The graph consumes one mono `[1, 512]` float32 audio chunk at 16 kHz plus its
explicit recurrent state. `onnxruntime-web` 1.27.0 is an exact runtime dependency,
not a transitive viewer implementation detail.

`OnlineAmtSession` owns the eight recurrent tensors in their frozen order:
`audio_buffer`, `mel_buffer`, `cnn_cache_1`, `cnn_cache_2`, `lstm_h`, `lstm_c`,
`previous_output`, and `silence_count`. Its defaults remain one WASM thread,
full graph optimization, CPU arena and memory-pattern allocation enabled, and
sequential execution.

Every session names two sources, and neither has a default:

| Source | From a URL | From bytes |
| --- | --- | --- |
| Model | `modelUrl` | `modelData` |
| ONNX Runtime WASM | `wasmUrl` | `wasmBinary` |

Browser callers pass `modelUrl` and `wasmUrl`; offline callers pass `modelData`
and `wasmBinary`, so inference needs no HTTP server or filesystem dependency in
production code. The options type accepts exactly one of each pair, and
`OnlineAmtSession.create` refuses an unusable WASM source — absent, blank, or
non-string URL, absent, empty, or non-buffer binary — before it touches any ONNX
Runtime state, so an untyped caller fails on its own call rather than later
inside ONNX Runtime.

This package deliberately does not resolve ONNX Runtime's WASM binary itself.
npm hoists `onnxruntime-web` above an installed dependency, so a path relative to
this package's own directory does not exist after a Git install; only the
consumer's bundler or filesystem knows where the binary ended up.

The deterministic 180-frame fixture under
`evals/fixtures/online_amt_runtime` verifies score parity within `2e-4`, exact
decoded states, exact signal-active results, reset behavior, and faster-than-
audio-cadence sequential execution. Model reproduction and native validation
instructions are in `tools/online_amt/README.md`.

## Browser and offline parity

```bash
npm run eval:browser-parity
```

`evals/browser/runtimeFixture.js` replays that same fixture through the
production session and output decoder. `tools/run-browser-parity.mjs` runs the
one module twice — offline in Node against bytes from disk, and in headless
Chrome against the same files over HTTP — and compares the two. It needs a
Chrome or Chromium binary; `CHROME_PATH` names one that is not on the default
path.

Everything that must not depend on the environment is compared exactly: decoded
states, signal-active results, onset and note-event counts, the frames carrying
active-pitch and target evidence, and a structural hash of the decoded output
that excludes confidences. Each side must also stay within the fixture's own
`2e-4` score bound and must actually decode something. A raw hash of the model
scores is reported but not asserted, so a last-bit inference difference between
the two environments is visible rather than silent, and a real behavioral
divergence still fails.

Both environments currently produce bit-identical inference.

## Browser assumptions

The browser integration targets modern secure-context browsers/webviews with ES
modules, WebAssembly, `Worker`, `AudioContext`, `AudioWorklet`, transferable
`ArrayBuffer`, and `navigator.mediaDevices.getUserMedia`. The audio device must
support a 16 kHz context. Production uses one WASM thread, so cross-origin
isolation and `SharedArrayBuffer` are not required.

The consuming application supplies asset URLs and creates its own module worker.
The package must not assume `document.baseURI`, a Vite source layout, microphone
permission wording, or any sheet-music-viewer path.

```ts
import { BrowserOnlineAmtRecognizer } from "@fschuh/piano-transcription-engine/browser";

const recognizer = new BrowserOnlineAmtRecognizer({
  modelUrl: "/generated-listen-assets/online_amt_streaming.onnx",
  workletUrl: "/generated-listen-assets/online-amt-capture.js",
  createWorker: () => new Worker(
    new URL("./onlineAmtWorker.ts", import.meta.url),
    { type: "module", name: "online-amt-inference" },
  ),
  describeError: (error) => (
    error instanceof DOMException && error.name === "NotAllowedError"
      ? "Microphone permission was denied."
      : undefined
  ),
});
```

The optional `describeError` hook lets the application replace a start failure's
message with its own wording. It is how permission and device phrasing stays out
of this package: returning `undefined` keeps the underlying error message, and
the lifecycle error and thrown error always carry the same text.

The worker entry remains consumer-owned so its bundler can compile it normally.
It receives the recognizer's `initialize` message and creates the
`OnlineAmtSession`, so it is also where the consumer supplies `wasmUrl` — the
recognizer neither knows nor invents where ONNX Runtime's WASM binary lives.
The recognizer requests one input channel with echo cancellation, noise
suppression, and automatic gain control disabled, then captures 512-sample
chunks from a 16 kHz `AudioContext` without persisting or transmitting audio.

## Data boundary

This public repository must not contain real MP3/MIDI recordings, exact
copyrighted score annotations, or traces derived from them. Those inputs live in
the private `piano-transcription-evals` repository and are supplied explicitly to
the eval API. Only original, public-domain, licensed, or non-musical numeric
fixtures belong here.

### Raw recognition evaluation (Round 3)

After capture, score a private cached trace without running inference or a matcher:

```sh
node dist/eval/scoreCli.js --trace /private/trace-directory \
  --midi /private/reference.mid --protocol /private/protocol.json \
  --onset-lag-ms 160 --output /private/recognition.json
```

Choose the fixed onset lag from prior audio/model timing inspection, before
comparing configurations. The example uses the approximately 160 ms delay observed
in the Task 01 audit; it is not a universal model constant. Use `0` to score the
original frame timestamps. The CLI requires this choice explicitly. The API
`evaluateRecognitionRecording` defaults to zero and accepts `onsetEstimateLagMs`.
Estimated onset is chunk-end time minus this lag; decision availability always
remains the original chunk-end time. MIDI alignment is a separate protocol value.
Neither correction removes buffering from reported causal detection delay.

The report compares production `OnlineAmtOutputDecoder` transition events with
three causal attack-probability thresholds (0.2, 0.3, 0.4). Each comparison uses
release threshold 0.15 and minimum per-pitch separation 64 ms. It emits on the
first eligible frame, adds no lookahead, and rearms only after an active frame
falls to the release threshold. Suppressed frames cannot rearm it. Sustained high
attack probability therefore cannot recover another attack. These are diagnostic
readouts, not promoted decoder settings. Replay includes pre-roll and the fixed
capture tail; scoring filters estimated onsets to the same half-open audio
interval and removes excluded regions on both sides. The report separately counts
references and predictions outside the interval and those excluded within it.
These disjoint counts plus the scored counts account for every input event. A
tail decision can match an attack inside the interval, but cannot extend it.

Matching maximizes exact-pitch one-to-one matches within inclusive protocol
windows (normally ±50 ms and ±100 ms), pairing earliest compatible attacks with
stable input-index ties. It does not minimize timing error among equally large
matchings. Reports retain unmatched indices, signed and absolute timing error,
and decision delay. Empty precision/recall denominators are defined as 1; F1 is 1
when both sets are empty and 0 when only one is empty. `meanRecordingMetrics`
averages recordings equally; use it separately for each configuration/window.

`inspectScoreFrame` exposes every pitch's five weighted scores and selected state.
Active-frame probabilities divide by the known wrapper weights `[1,1,1,2,2]`
without renormalization; alternate weights may be supplied to the API. This does
not undo recurrent feedback. Suppressed evidence and `selectedState` are `null`: the
wrapper holds the previous argmax, so it is not a current-frame measurement.
`diagnoseRawAttacks` reports nearby attack/presence peaks and suppressed-frame
counts by default. Add CLI `--raw-frames` (API `includeRawFrames: true`, or the
final `includeFrames` argument to `diagnoseRawAttacks`) to include per-frame
evidence, competing pitches and selected states. Compact reports omit the
`frames` property entirely. Its window centers on reference time plus
the fixed onset lag. Peaks are explicitly optimistic reference-informed evidence,
not detected attacks. Frame inspection also supports unplayed-pitch and verified
no-attack interval analysis; silence is scored with empty references only where
silence has been verified.

For gold chord diagnostics, pass `--gold-moments /private/moments.json`, an array
of `{ "onsetMs": 100, "pitches": [60, 64] }` objects in MIDI time. Moments name
exact reference onsets, in chronological order; rolled attacks should retain
separate onsets. The report lists recovered pitches and complete chords, and
marks consecutive identical pitch sets as repeated chords using the full performed
sequence before interval/exclusion filtering. Removing a moment cannot manufacture
a repeat. The API accepts the same `goldMoments` data. No gold chord claims are generated without these groups.
Zero observed false attacks is a finite-recording result. Corpus baseline runs,
annotation review and performance conclusions belong to Task 03.

Annotation review uses `createAnnotationReviewQueue(report, trace)` or the score
CLI's `--review-output FILE`. Each unresolved entry includes audio replay bounds,
MIDI pitch/name, nearby references and predictions, shared readout IDs, and
weighted/unweighted frame evidence with selected states and competing pitches.
The queue groups exact event identities across readouts and prioritizes shared
disagreements. Nearby timing or pitch substitutions are possibilities, not edits;
shared model evidence is not independent annotation verification.

A **correction sidecar** is a reviewed edit list stored beside a source MIDI file
rather than inside it: the annotation stays byte-identical in version control
while accepted edits live separately, so they can be read, reverted, and
re-applied on their own. Each edit therefore addresses the *original* parsed MIDI
and repeats the value it expects to find there, never an index into an
already-corrected array.

`applyAnnotationCorrections(references, edits)` (CLI: `--corrections FILE`)
applies one sidecar's additions, replacements, and deletions before evaluating
all readouts. The engine reads one recording's edits as a bare JSON array; a
caller keeping several recordings in one file selects that recording's array
itself. Each edit requires `verifiedBy`, `reason`, and `replacement`
(`{midi, onsetMs}` in original MIDI time, or `null` for deletion). An indexed edit
also requires `referenceIndex` in the **original** parsed MIDI and `original:
{midi, onsetMs}` to detect a stale sidecar. Additions omit both fields. Keep the
original MIDI in version control, retain reports before editing, and regenerate
all compared configurations against the same sidecar/protocol. Label-only edits
reuse inference. Protocol exclusions remove both sides consistently.

Gold chord moments may supply `pitchOnsetsMs`, parallel to `pitches`, to preserve
the individual performed onsets of a rolled chord. The moment onset groups the
chord; it does not replace per-pitch attack timing. Gold status is a separate
human annotation decision: record the verifier, passage, and dimensions only
after full passage verification, including attacks absent from both model and
reference. Clearing the queue alone does not promote silver or verify releases.

Review export evidence identifies `eventSource` as `reference` or `prediction`;
`optimisticReferenceInformed` is false for prediction-centered evidence.
`applyAnnotationCorrections` returns uniform `{midi, onsetMs, annotationSource}`
records. Source metadata preserves the original MIDI index, complete original
caller record, and applied sidecar index. Alignment moves only the evaluated
onset, so source fields can be copied into a correction guard without arithmetic.
Original release/channel metadata remains archived under the source, not silently
reinterpreted as corrected release timing. Additions have null original source.
Queue ordering uses shared-readout count descending, then actual event time.

`nearestSamePitchMs` and `nearestOtherPitchMs` give the signed distance from the
entry's event to its closest opposite-side neighbour within the same 250 ms
window the concern flags use, or null when there is none. Positive means the
neighbour is later; equidistant neighbours report the earlier one. The concern
flags say only that a neighbour exists, so these separate a window-boundary
disagreement from a distant coincidence without opening the evidence file.

Correction validation rejects repeated `(midi, onsetMs)` identities in the final
assembled references, including collisions caused by replacements. Review entries
are keyed by that identity, so two references sharing one collapse into a single
queue entry: one disagreement disappears from the queue, the survivor reports
more readouts than were compared, and its provenance names only the first of the
two. Refusing the sidecar is loud where losing a review entry would be silent.
The error names the duplicate identity. Deletions and moves can free an identity
for an addition in the same sidecar, regardless of edit order. Distinct repeated
attacks and simultaneous different pitches remain valid. Because the check reads
the assembled result, it also refuses a duplicate already present in an unedited
annotation, when no sidecar was supplied at all.
