# Piano transcription engine

`@fschuh/piano-transcription-engine` owns the reusable online-AMT recognition,
exact-chord matching, browser recognition, and evaluation code used by the sheet
music viewer. It is installed directly from Git at an exact commit and is not
published to npm (`private: true`).

Task 02 establishes the installable package boundary. The production and browser
entry points are intentionally empty until Tasks 03-05 move their implementations;
the evaluation entry currently exposes only non-decoding file inventory, which
Task 07 will extend with corpus validation.

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
`evals/fixtures` directory. It lists MP3/MIDI paths only and never decodes or
modifies them.

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

## Browser assumptions

The browser integration targets modern secure-context browsers/webviews with ES
modules, WebAssembly, `Worker`, `AudioContext`, `AudioWorklet`, transferable
`ArrayBuffer`, and `navigator.mediaDevices.getUserMedia`. The audio device must
support a 16 kHz context. Production uses one WASM thread, so cross-origin
isolation and `SharedArrayBuffer` are not required.

The consuming application supplies asset URLs and creates its own module worker.
The package must not assume `document.baseURI`, a Vite source layout, microphone
permission wording, or any sheet-music-viewer path.

## Data boundary

This public repository must not contain real MP3/MIDI recordings, exact
copyrighted score annotations, or traces derived from them. Those inputs live in
the private `piano-transcription-evals` repository and are supplied explicitly to
the eval API. Only original, public-domain, licensed, or non-musical numeric
fixtures belong here.

