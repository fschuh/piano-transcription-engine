# Extraction report

> **Status:** Complete, September 7, 2026. Every automated check below passed on
> September 6, and the manual listen-mode smoke ran on a real piano on Windows on
> September 7. Round 3 planning is unblocked.

The production listen engine, its canonical online-AMT model, and the reusable
evaluation code moved out of `sheet-music-viewer` into this repository between
September 2 and September 6, 2026. This is the record of what that produced and
of what has to keep passing.

## What each repository owns now

`piano-transcription-engine` owns every recognition, decoding, matching,
profile, inventory, and functional-safety implementation, the canonical model
and capture worklet, and the model tools. It is installed as one private package
and is never published to npm.

`sheet-music-viewer` keeps listen-mode orchestration, score navigation, settings
and persistence, feedback rendering, the MIDI input adapter, and the thin worker
entry. It supplies what this package deliberately does not resolve for its
consumer: the asset URLs, the ONNX Runtime WASM binary, and the wording of
microphone permission and device failures. It has no engine implementation of
its own.

Private `piano-transcription-evals` owns the gold and silver recordings, their
annotations, and the Round 1/2 fixtures derived from a copyrighted score. It
calls this package's evaluation API and implements no decoder, matcher, or
scoring of its own.

## Identification

| | |
| --- | --- |
| Engine commit | `1cb9baa8f3153388416d7d580bfcd9b8bac2a165` |
| Adopted by viewer commit | `5ced96c8919c8c4773da276b66459f0e7413235f` |
| Adopted by eval commit | `73c481f2a67d34993f5934e8e206683c12badaea` |
| Pre-extraction baseline | viewer commit `89afafcdd7fd06db0626feba6a0665ab1c3bf798` |
| Production model | `online_amt_streaming.onnx`, 71,955,821 bytes, SHA-256 `a77be826…90ac4`, exported from `jdasam/online_amt` at `f353035175cc3436ebdc411530a9e73c966d2077` |
| Production default profile | `baseline-v1` in registry version 2 |
| Runtime | `onnxruntime-web` 1.27.0 exactly, one WASM thread, sequential execution |

Both consumers pin that one full commit SHA. Neither follows a branch or a tag.
`1cb9baa` is the revision both consumers install and the revision the commands
below pass at. Documentation commits follow it, so this repository's head and
that revision do not produce byte-identical package tarballs — the packaged
README differs. What is identical is everything that runs: the compiled code, the
type declarations, and the assets. That is why a documentation commit does not
move the pin, and why any commit that changes the bytes a consumer installs
does — `src/`, `assets/`, the tooling `prepare` runs, and the checkout
attributes, since npm installs this package by cloning it and a platform that
rewrote line endings would hand the consumer different files. Each such commit is
qualified by re-running the commands below.

## What was archived rather than ported

The Round 1/2 search, candidate, eligibility, and production-decision machinery
did not come across. `legacy/rounds-1-2/` holds the final decision reports, the
measured plan outcome, the verbatim Task 27/28/29 manifests, and provenance
naming the viewer commit that still contains the full implementation. The
hash-chain and mutation tests that defended generated evidence, the staged
fixtures for a branch that never ran, and the large evidence verifier were left
in that history rather than maintained here.

One Round 1 result was worth keeping as behavior instead of as an artifact: a
spurious-bass-onset fixture that `baseline-v1` refuses and the four frozen v2
profiles advance. It runs in the active functional suite through the public
evaluation API.

The active suite replaced the historical benchmark matrices with nine
project-authored synthetic traces in `src/eval/functionalFixtures.ts`. Score-bearing
measurement detail stayed on the private side of the redistribution boundary: the
frozen benchmark reports and result JSON remain in `sheet-music-viewer` under
`tools/online_amt/` and `benchmark-results/`, each carrying a dated note that the
code it describes was removed.

## What must pass before a later engine revision is adopted

In this repository:

```bash
npm ci
npm run typecheck
npm test
npm run eval:browser-parity
```

`npm test` includes the two canonical parity fixtures: the 180-frame runtime
fixture, which holds score parity within `2e-4` with exact decoded states and
signal-active results and runs faster than its audio cadence, and the Task 01
engine-core fixture, whose decoder frames and `baseline-v1` matcher updates must
reproduce exactly. `npm run eval:browser-parity` requires a Chrome or Chromium
binary.

In the private eval repository, against its own recordings:

```bash
npm ci
npm run eval:inventory
```

In the viewer, after moving its one pinned revision:

```bash
npm ci
npm test
npm run build
```

Then the manual listen-mode smoke — start, target changes, advancement, pause,
resume, stop, and microphone denial — on real input. No automated check replaces
it, and it is still required before the production matcher profile changes.

Run an install and a build on Windows as well when a change touches how tooling
handles paths. Neither repository checks Windows automatically, and the
extraction's only platform defect was exactly that: this verifier compared
Windows path separators against a POSIX literal, so the canonical-model check
failed inside `prepare` and the viewer could not install its dependency there
while every check on Linux passed.
