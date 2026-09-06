### Production profile decision — August 22, 2026

The one auditable global-default decision the frozen evidence was collected for.

**Result: `no-safe-candidate`. `DEFAULT_LISTEN_MATCHER_PROFILE_ID` stays
`baseline-v1`.** No threshold, candidate value, gate, fixture, or manifest
assignment changed; this entry and the re-verification below are the whole of the
decision.

#### How the selection rule was applied

The rule is gates first, ranking second: only eligible profiles are ranked, and
they are ranked on live safety, live correctness, automated independent
recognition, ordered and complete behavior, latency, and finally distance from
`baseline-v1`. The August 21 frozen confirmation left the eligibility set empty,
so the ranking steps never ran and there was nothing to break a tie between.

The live corpus was not collected. Its own rule makes it conditional on at least
one automated-eligible candidate, because a live session exists to test a profile
that could otherwise ship; with none eligible, playing the corpus would produce
per-instrument numbers for four profiles already rejected on held-back automated
evidence and could not make any of them shippable. The live outcome is therefore
recorded as `no-safe-candidate` rather than as live evidence, and the default is
unchanged.

Nothing here re-reads the confirmation numbers for a new threshold. Choosing
values in response to the measurements that rejected these four would be
post-result retuning of the search that produced them; a different default needs
a new discovery round whose search accounts for isolated omitted-bass evidence.

#### Blockers a future candidate has to clear

| Gate | What blocked it |
| --- | --- |
| `safety-isolated-false-advance` | All four candidates advance one omitted-bass fixture per renderer — `isolated/direct/122` and `isolated/tone/124` — that `baseline-v1` refuses. A dedicated safety fixture that advances fails at any rate. |
| `release-isolated-course-clear` | All four miss the fixed 52/54 Tone Course Clear floor: 50/54 for the `open` pair, 48/54 for the `held` pair. |
| `release-isolated-recognition` | `early-held-v2` and `steady-held-v2` reach only 100/106 under Tone against the fixed 101/106 floor. |

The shared 0.99 unexpected-note gate does not compensate for the more permissive
onset and active-target gates on a target whose bass is simply absent, which is
the single mechanism behind the safety failure in both renderers.

#### Known limitations of the retained default

Retaining `baseline-v1` keeps its measured weaknesses, and they are the reason
this decision is worth revisiting with a new generation rather than closed:

- The Task 06 Tone 333 ms false advance belongs to `baseline-v1`, on
  `sequence/tone/course-clear-27/333ms`: a stalled single-note target completed
  by a later chord's shared pitch. It is the only false advance the sequence and
  dynamics domains record under any profile, and every rejected candidate clears
  it.
- Under Tone the default reaches 100/106 isolated correct advancement and 48/54
  on Course Clear — 94.3%, below the 95% acceptance gate the release floors are
  derived from. Direct meets its floors at 104/106 and 52/54.
- `baseline-v1` is the least sensitive profile measured. It carries 8 sequence
  late advances under Direct where the `early` pair carries none, holds Tone
  held-back ordered dynamics advancement at 146/432 against as much as 280/432,
  and recovers the `v05` repeated chord two attacks late instead of one.

These are recognition losses, not safety losses: the default advances no
dedicated safety fixture in any domain.

#### Rollback and rollforward

The default is one exported constant, `DEFAULT_LISTEN_MATCHER_PROFILE_ID` in
`webapp/src/listenMatcherProfiles.ts`. Every profile ever released stays in the
registry as an immutable entry, so changing the default forward or back is that
one edit and needs no reconstruction of threshold values from this history.
Production, replay, and every benchmark read the profile through
`matcherOptionsForListenMatcherProfile`, so that constant is the only place the
shipped behavior is chosen.

#### Re-verification of the shipped default

Measured on the development Windows machine at commit `65da882` — the commit the
August 21 confirmation code landed at — with Chrome 152.0.7977.55 on Windows 11
(10.0.26200), Node v22.12.0, and the unchanged `online_amt_streaming.onnx`
(SHA-256 `a77be8262d3742ce4d9e7d29146d8b17f5755650a7d2aee952bf5bf5ed190ac4`,
re-hashed locally). The commit carrying this entry changes documentation and one
registry comment only; no measured code, value, gate, or fixture differs between
them.

| Check | Result |
| --- | --- |
| Unit suite | 472 tests, 472 pass, plus the two-test dynamics pretest |
| Production build | passes |
| Canonical paired isolated smoke | both renderers `matched-recorded-baseline`, advanced at 196 ms, structure hashes `83fbd243` and `5c164339` |
| Complete sequence validation | 156 traces, both renderers, six speeds; trace reuse and baseline parity verified; all ten profile rows reproduce the August 19 tables exactly |
| Dynamics and articulation matrix | 52 traces, both renderers; trace reuse and baseline parity verified; all corpus, confirmation, equal-piano, and `v05` gate rows reproduce the August 19 tables exactly |
| Committed regressions under the default | replayed from rendered audio and in the unit suite; `baseline-v1` satisfies both pinned cases |

`baseline-v1` reproduced its recorded sequence row under Direct — 291 independent
and 283 ordered of 456, 199 prefix, 33/60 complete, 8 late, 58 carry-over blocked,
192 / 214.67 ms — and under Tone — 292 / 310, 219 prefix, 38/60 complete, 0 late,
62 carry-over, 200 / 228 ms — with all four dedicated safety counters at zero at
every speed under both renderers. The dynamics matrix reproduced Direct 639 / 702
independent and 224 ordered, Tone 609 / 675 and 239, the untouched `confirmation`
rows at 391 / 432 and 77 under Direct and 392 / 432 and 146 under Tone, and the
Direct equal-piano constant-layer aggregate at 90.86% / 45.49% / 12.50%.

Both committed regressions reproduce from rendered audio in this environment.
`listen-dynamics-case-tone salamander v05` reports 25/27 independent, 23/27
ordered, 0/0/0 safety, decoded-structure hash `b043076d`, and `baseline-v1`
satisfying the pinned late advance of target 23 at 25,440 ms from the attack two
positions later. `listen-sequence-case-tone course-clear-27 333.33` reports 23/27
independent, 8/27 ordered, 1/0/0 safety, decoded-structure hash `ab28401f`, and
`baseline-v1` satisfying the pinned false advance at 4,768 ms. In both runs the
more sensitive profiles deviate from the pinned outcomes — recovering `v05` a
repetition earlier, and no longer classifying the 333 ms advance as false — and
each deviation is reported as one, never as a pass.

This machine is a different browser build and operating system from the Linux
host that recorded the frozen archives, which is where the Task 04 identity rule
earns its keep: every decoded-structure hash and every discrete musical outcome
reproduced, while the rendered audio diagnostics did not agree to their last bits
— Tone `v05` renders `peak` 0.3653072416782379 here against the archived
0.36530718207359314. The Task 10 and Task 11 whole-file evidence digests include
those diagnostics and so are not expected to match across platforms;
`node tools/online_amt/verify_listen_benchmark_evidence.mjs` still verifies all
three frozen archives against their recorded file hashes and digests.

Ordinary listen mode uses and reports the retained identifier: the application
builds its matcher from `resolveEffectiveListenMatcherProfile`, which without a
debug override resolves to `DEFAULT_LISTEN_MATCHER_PROFILE_ID`, and the
Diagnostics panel prints the effective profile, appending `(debug override)`
whenever the session picker has replaced it.
