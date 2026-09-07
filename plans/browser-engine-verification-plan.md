# Browser engine verification plan

> **Status:** Proposed, September 7, 2026.
>
> **Owner repository:** `piano-transcription-engine`.
>
> **Prompted by:** the Windows defects found by the extraction's manual listen
> smoke, and by the observation that this package is now a web library whose
> consumers choose the browser engine.

## Decision summary

Verify two axes separately, because they fail for unrelated reasons and cost
very different amounts to run.

The **platform** axis is about installing and building: path separators, line
endings, and whether `prepare` succeeds. Every defect the extraction actually hit
was on this axis, and `npm ci` alone would have caught each one. It is cheap, so
it gates every push.

The **browser engine** axis is about what the engine computes: whether ONNX
Runtime's WASM inference and this package's decoder produce the same decisions on
a different JavaScript engine. It changes rarely and costs more to run, so it
runs on a schedule and on demand, not as a merge gate.

Prioritise WebKit over Firefox. The sheet-music viewer ships as a Tauri
application, and Tauri does not bundle an engine — it uses the platform webview:
WebView2 (Chromium) on Windows, WKWebView (WebKit) on macOS, and WebKitGTK
(WebKit) on Linux. Two of the three runtimes this project ships on are WebKit,
and neither has ever executed this package. Nothing this project ships runs
Gecko, so Firefox is worth adding only if the package gains outside consumers.

Keep browser automation out of `package.json`. npm installs this package's
devDependencies transiently in order to run `prepare` when a consumer installs it
from Git, so anything added there is downloaded during every consumer install
even though it does not survive into their tree. The engine's dependency
footprint — one runtime dependency, two devDependencies — is part of what makes
it safe to pin as a bare Git dependency. CI installs what it needs itself.

## Goals

- Make the portability claim in `README.md` true, or narrow it to what has been
  measured.
- Catch a platform or engine defect before a person running the application does.
- Localise a failure to a layer without further investigation, using the parity
  check's existing separation of model output from decoded output.
- Leave consumer install cost unchanged.

## Non-goals

- Do not test the packaged Tauri application. Its webviews are the real runtimes,
  and the manual listen-mode smoke owns that; a browser is a proxy for them.
- Do not gate merges on the scheduled engine matrix. A flaky browser job that
  blocks merges gets ignored, which is worse than not having it.
- Do not add per-engine numeric tolerances. A threshold that moves to accommodate
  whatever a run produced is not a check.
- Do not add CI to the private recording repository. Its value is the corpus, its
  inventory is fast to run locally, and putting private recordings through hosted
  runners is a decision that needs its own justification.
- Do not replace the Chrome DevTools driver. It works, it has no dependencies,
  and Chrome remains the reference engine.

## What runs where

| Trigger | Platform | Engine | Checks |
| --- | --- | --- | --- |
| Every push and pull request | Linux | — | `npm ci`, `typecheck`, `npm test` |
| Every push and pull request | Windows | — | `npm ci`, `typecheck`, `npm test` |
| Every push and pull request | Linux | Chrome | `eval:browser-parity` |
| Scheduled and on demand | Linux | WebKit | `eval:browser-parity` |
| Scheduled and on demand | Windows | Chrome | `eval:browser-parity` |
| Scheduled and on demand | macOS | WebKit | `eval:browser-parity` |
| Scheduled and on demand | — | — | Cross-job comparison of the recorded results |

Windows earns a push-gated slot because every defect found so far lived there and
because `npm ci` is the check that finds them. macOS earns a scheduled slot
because ARM64 is a different architecture and therefore the most likely source of
a genuine numeric difference; it is also the most expensive runner on private
repositories, at a ten-times minute multiplier against Linux's one and Windows's
two. This repository is public, so hosted runners are free for it today.

## Why the cross-job comparison matters

`eval:browser-parity` compares Node against a browser **on one machine**. Running
it on three platforms produces three independent within-machine results and still
does not say whether Windows agrees with Linux. The check already prints the
identifiers needed to answer that — `recognitionStructureHash`, `statesHash`,
`signalActiveHash` — so a job that collects them from every matrix leg and
compares them turns a set of local checks into one portability statement.

Those three must be identical everywhere. `scoresHash` must not be compared: raw
WASM float output is allowed to differ between engines, and if any ONNX Runtime
code path uses relaxed SIMD its results are implementation-defined by
specification. Each leg's own `2e-4` bound against the recorded fixture is what
constrains the numbers.

## Implementation tasks

### Task 01 — Assert the frozen asset digests

Add a test that the canonical model, its licence notice, and the capture worklet
match the SHA-256 digests and sizes frozen in the extraction baseline.

This is a prerequisite, not an extra. The line-ending hazard closed on
September 7 would not be caught by any CI job: a hosted runner checks out with
`core.autocrlf` disabled and never sees the conversion. It is caught by asserting
the digests, on the machine where the condition is real. The test also makes
`.gitattributes` an enforced invariant rather than a hoped-for one.

Acceptance:

- `npm test` fails when a tracked identity-bearing asset's bytes change.
- The test names the file, its expected size and digest, and what it observed.
- Verified to fail against a CRLF copy of the worklet and to pass against the
  repository's own.

### Task 02 — Record parity results as data

Add a `--json <path>` option to `tools/run-browser-parity.mjs` that writes both
environments' results and the verdict, alongside the existing table.

Acceptance:

- The file records the engine, the platform, both result objects, and the pass or
  fail decision.
- The human-readable output is unchanged when the option is absent.
- The exit code is unchanged in both modes.

### Task 03 — Select the browser engine

Add `--engine chrome|webkit|firefox`, defaulting to `chrome`. Chrome keeps the
existing dependency-free DevTools driver. WebKit and Firefox load their driver
through a dynamic import so the automation library stays optional and absent from
`package.json`; a missing library must fail with a message naming what to install.

Acceptance:

- `npm run eval:browser-parity` behaves exactly as it does today.
- `--engine webkit` runs the same fixture through the same module and reports the
  same fields.
- With no automation library installed, `--engine webkit` explains what is
  missing instead of failing obscurely.
- `npm ci` in this repository installs no browser automation.

### Task 04 — Gate every push on the platform axis

Add a workflow running Linux and Windows: `npm ci`, `npm run typecheck`,
`npm test`, and on Linux `npm run eval:browser-parity`.

Install the browser explicitly rather than relying on a runner image shipping
one, and pass its path through `CHROME_PATH`. Which browsers hosted images
preinstall has changed over time and should not be assumed.

Acceptance:

- Both legs pass on the current head.
- A deliberate reintroduction of the Windows path-separator defect fails the
  Windows leg and not the Linux one.
- The workflow does not check out or require the private recording corpus.

### Task 05 — Cover the shipping engines on a schedule

Add a scheduled and manually dispatchable workflow running the engine matrix
above, each leg writing its JSON result as an artifact, and a final job comparing
the three environment-independent hashes across every leg.

Acceptance:

- Every leg reports its own verdict, and the comparison job fails if any of the
  three hashes disagrees between legs.
- `scoresHash` differences are reported and do not fail the run.
- A failing leg names the platform and engine in its job title.

### Task 06 — Settle the portability claim

Run the matrix, then either confirm `README.md`'s browser assumptions section
against what passed, or narrow it to the engines actually verified. Record the
outcome and the hashes in `EXTRACTION.md` next to the existing standing checks.

Acceptance:

- The README claims no more than has been measured.
- A reader can tell which engines were verified, on which platforms, and when.
- If an engine failed, the record says whether the cause was ONNX Runtime's WASM
  numerics or this package's decoder, using the failing hash to place it.

## What a failure would mean

The parity check's fields sit on the boundary between the ONNX graph and this
package's own code, so a failure identifies its layer before anything is
debugged. `states` and `signalActive` come out of the graph; onsets, note events,
active pitches, target evidence, and timing come out of `onlineAmtOutput.ts`.

| Failing field | Layer | Likely remedy |
| --- | --- | --- |
| `scoresHash` only, bound held | WASM float noise | None; this already passes |
| `2e-4` bound violated | ONNX Runtime numerics | Constrain the runtime in `OnlineAmtSession.create`, as it already pins threads, optimization, and execution mode; re-export the model if one operator is responsible |
| `statesHash` | The graph's own state selection | The same numeric remedy, landing on a near-tie |
| `recognitionStructureHash`, states identical | This package's decoder | A real defect: locale-dependent formatting, iteration-order assumptions, or timing arithmetic. Fix it and add a Node regression test |
| The run does not start | A missing platform capability | Feature-detect and fail clearly, or narrow the documented claim |

Some outcomes are not fixable here. A genuine engine defect leaves the choice of
avoiding the code path, reporting it upstream, and documenting the engine as
unsupported until it is fixed.

## Risks

The likeliest WebKit outcome is that `scoresHash` differs, every discrete field
matches, and the run passes. That is still worth having: it replaces an
assumption of portability with a measurement on the engine two of three shipping
platforms use.

Playwright's WebKit is a build of WebKit, not Safari and not WKWebView. It is a
much closer proxy than Chrome and it is not the real thing; only the packaged
application on each platform is.

The repository carries a 69 MB model, so checkout dominates every job. The checks
themselves take about five seconds each.
