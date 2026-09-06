# Round 1/2 historical outcomes

Archived September 6, 2026. This is reference material, excluded from the installed
package and `npm test`. Commands in the copied reports describe the original
checkout only; they are not active engine workflows.

Task numbers in archived filenames and copied reports refer to the historical
**listen matcher calibration plan**. Tasks labelled **extraction-plan** below
refer to the separate piano transcription engine repository extraction plan.

## Conclusion

Round 1 ended August 22, 2026 with `no-safe-candidate`. All four frozen v2
candidates advanced omitted-bass cases that baseline refused and missed recognition
floors. No candidate reached live validation. The later
[calibration-plan Task 23 re-score](reports/round-one-policy-rescore.md) removed
asymmetric correctness-floor rejections but retained the safety rejections.

Round 2 ended August 25 with `round-two-grid-produced-no-eligible-improvement`,
reason `no-ablation-accepted`. The three staged grids selected three, two, and two
profiles, but all failed `selected-set-has-no-material-repeated-recovery`.
The terminal outcome was `bass-axis-unsupported`. No new profile was registered;
confirmation decoded 0 of 12 held-back traces; no live corpus was collected.
The approved list contains only `baseline-v1`. This is a bounded search outcome,
not evidence that baseline solves every recognition problem.

Read the [Round 1 report](reports/round-one-decision.md),
[Round 2 report](reports/round-two-decision.md), and copied
[plan outcome](plan-outcome.md). Reports are verbatim decision sections and a policy re-score excerpt;
their historical commands and relative paths refer to the original checkout.

## Provenance and retained artifacts

The complete old implementation, fixtures, emitters, and verifier are preserved at
[viewer commit 89afafcdd7fd06db0626feba6a0665ab1c3bf798](https://github.com/fschuh/omr-sheet-music-viewer/tree/89afafcdd7fd06db0626feba6a0665ab1c3bf798).
This is the final source snapshot selected before historical-test deactivation.
Its full verifier is `tools/online_amt/verify_listen_benchmark_evidence.mjs`;
implementation files are under `webapp/src/listen/` and its `benchmarks/` directory.

[provenance.json](provenance.json) records source paths, immutable links, original
SHA-256 values, and the disposition of every measurement artifact. Calibration-plan
Task 27, 28, and 29 final manifests are copied verbatim into `artifacts/`.
Both calibration-plan Task 13
repetitions retain explicitly labelled decision extracts: profiles, failed gates,
eligibility, and recommendation. Full per-event exports and intermediate archives
remain at the source commit because they include score and trace details outside
this extraction's redistribution boundary. Extracts do not replace original
hash-chain inputs. No emitter, verifier, or completed-branch simulator is copied.

The viewer's normal test command no longer runs historical benchmark/policy tests
or the evidence verifier. Historical reproduction uses the pinned source checkout;
it is not a prerequisite for current tests.

## Useful fixtures retained

Extraction-plan Task 06 replaced isolated, sequence, dynamics, repeated-chord, omitted-bass,
false/skipped/duplicate advance cases with original numeric fixtures in
`src/eval/functionalFixtures.ts`. Its latency tests keep lag separate from safety.
The old Course Clear passage, v05 trace, and shared-pitch trace remain source-only;
their copyrighted passage data is not copied into the engine.

Extraction-plan Task 08 adds `spurious-bass-onset-safety`, an original numeric example of the
Round 1 rejection mechanism: a false bass onset between candidate and baseline
gates. This differs from the existing sustained-bass case. Baseline refuses it;
all four v2 profiles advance it. It uses the public evaluation API without an
artifact wrapper and does not claim to reproduce measured audio.

## Reproducing the current default

Run `npm test` in the engine. Profile tests verify the default and fixed policy;
functional tests exercise safety behavior. `baseline-v1` uses onset 0.60,
target-note 0.50, active-target 0.35, unexpected-note 0.97, and a required fresh
bass onset. Fixed policy retains a 32 ms settle interval and note-event refractory
mode. The production registry owns these values; this archive is never read to
select or construct the default.
