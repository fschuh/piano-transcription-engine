# Piano transcription engine

`@fschuh/piano-transcription-engine` owns the reusable online-AMT recognition,
exact-chord matching, browser recognition, and evaluation code used by the sheet
music viewer. It is installed directly from Git at an exact commit and is not
published to npm (`private: true`).

The production entry point exposes the platform-neutral recognition contracts,
online-AMT output decoder, exact-chord matcher, matcher diagnostics, immutable
profile registry, and 16 kHz/512-sample protocol constants. The browser entry
point exposes the injected `BrowserOnlineAmtRecognizer`; the evaluation entry
exposes the public-safe functional trace replayer and recording-file inventory,
which Task 07 will extend with private-corpus validation.

## Commands

```text
npm ci
npm run typecheck
npm test
npm run build
npm run eval:inventory -- [recordings-directory]
npm pack --dry-run
```

With no recordings directory, `eval:inventory` inspects the public-safe
`evals/fixtures` directory. The command is also installed as the
`piano-transcription-eval` binary, which is how the private corpus repository
invokes it:

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

`PUBLIC_FUNCTIONAL_EVALUATION_FIXTURES` contains eight original numeric traces
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
sequential execution. Browser callers pass `modelUrl`; offline callers may pass
`modelData` and `wasmBinary` so inference needs no HTTP server or filesystem
dependency in production code.

The deterministic 180-frame fixture under
`evals/fixtures/online_amt_runtime` verifies score parity within `2e-4`, exact
decoded states, exact signal-active results, reset behavior, and faster-than-
audio-cadence sequential execution. Model reproduction and native validation
instructions are in `tools/online_amt/README.md`.

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
});
```

The worker entry remains consumer-owned so its bundler can compile it normally.
The recognizer requests one input channel with echo cancellation, noise
suppression, and automatic gain control disabled, then captures 512-sample
chunks from a 16 kHz `AudioContext` without persisting or transmitting audio.

## Data boundary

This public repository must not contain real MP3/MIDI recordings, exact
copyrighted score annotations, or traces derived from them. Those inputs live in
the private `piano-transcription-evals` repository and are supplied explicitly to
the eval API. Only original, public-domain, licensed, or non-musical numeric
fixtures belong here.
