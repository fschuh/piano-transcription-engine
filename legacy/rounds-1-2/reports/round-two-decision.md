### Round-two production decision — August 25, 2026

Task 29 made the round's one production decision and froze the approved-profile
list, `benchmark-results/listen-round-two-approved-profiles-task29.json`, as the
third and last link of the round-two artifact chain.

**Result: `round-two-grid-produced-no-eligible-improvement`, reason
`no-ablation-accepted`. `DEFAULT_LISTEN_MATCHER_PROFILE_ID` stays `baseline-v1`,
and the approved-profile list is exactly `[baseline-v1]`.** No threshold, profile,
gate, fixture, or manifest assignment changed. The list's digest is `dbf777ba` over
eligibility manifest `20be9d6d`, over candidate manifest `21655efa`, over Task 26
evidence `bass-axis-unsupported` at `8dfe2f1b`; its file SHA-256 is
`c71624cefb4db1f5ac7b0981ca4e62f3756dbd999d279ff6718c7ae7bc346873`.

```bash
npm --prefix webapp run emit:round-two-approved-profiles
```

The command needs no browser and no dev server, because the round confirmed
nothing and collected no live corpus. It reads the committed chain and resolves it
by rerunning it: Task 24's frozen stop rule is recomputed over both archived
Task 26 repetitions, the committed Task 27 manifest must be what that rerun
re-derives, the committed Task 28 manifest must be what Task 28's own emitter
reproduces from it, and only then is the decision derived. Re-running the command
reproduces the committed file byte for byte and refuses to revise it. Neither
earlier link is edited by this task, and tests hold both sets of committed bytes
against the records their own emitters reproduce.

#### What the round measured, and what refused it

A round that accepted no ablation is not a round that found nothing, so the
decision records what each staged grid selected and which rule refused it. All
three grids selected profiles, and Task 24's stop rule refused every one of them
for `selected-set-has-no-material-repeated-recovery`:

| Ablation | Grid | Selected | Refused by |
| --- | --- | --- | --- |
| `ablation-1-round-one-grid` | 1,000 (159 globally safe) | `o0p550-t0p500-a0p350-x0p990-b1`, `o0p450-t0p575-a0p275-x0p970-b1`, `o0p550-t0p500-a0p200-x0p970-b1` | `selected-set-has-no-material-repeated-recovery` |
| `ablation-2-refined-family` | 1,400 (452 safe) | `o0p450-t0p5375-a0p300-x0p990-b1`, `o0p450-t0p5375-a0p075-x0p970-b1` | `selected-set-has-no-material-repeated-recovery` |
| `ablation-3-bass-axis` | 4,200 (2,294 safe) | `o0p450-t0p500-a0p075-x0p990-b1-B0p550`, `o0p450-t0p5375-a0p075-x0p970-b1` | `selected-set-has-no-material-repeated-recovery` |

Why none was registrable: the stop rule requires every discovery stratum to be
complete and to contain a material recovery, and the round-two authored stratum
contains none for any profile. `baseline-v1` does not reproduce the late-recovery
phenomenon on either newly authored group — it carries no required pitch without a
fresh re-onset there and already advances at source distance 0 on
`round-two/r2-repeated-low-triad-direct-splendid-pp/correct` and distance 1 on
`round-two/r2-repeated-mid-tetrad-tone-salamander-v13/correct` — so no candidate
can show a material gain against it in that stratum. With no ablation accepted,
Task 27 could search no candidate, and Tasks 28 and 29 had nothing to confirm or
promote. The bass-axis pair support recorded the same refusal from its own side:
`o0p450-t0p500-a0p075-x0p990-b1-B0p550` against its twin failed on
`bass-grid-failed-stop-rule` and `repeated-recovery-regression-against-twin`.

Two of the selected profiles do reach `v05` and `v13` at source distance 0 in
discovery, through a 0.075 active-target gate below Task 22's 0.0958 three-run
limiting minimum. That is a discovery measurement of refused profiles, not a
result: none reaches `dynamics-mixed/tone/salamander` at all, none was registered,
and none was confirmed. It is recorded here so the round's evidence is not read as
having found nothing to look at.

#### The repeated-chord result

The eligibility manifest holds no entry, so it carries neither of Task 24's two
labels and the decision copies neither: `repeatedChordResult` is empty, and
`repeatedRecoveryOutcome` and `confirmationReproductionStatus` do not exist for
this round. Nothing here is described as fixing `v05`. The shipped default still
recovers that chord at source distance 2 and 2,220 ms, and never arms it at all in
`v13` or the mixed run.

#### What this round did not recover

Round one's rejected candidates cleared the Task 06 Tone 333 ms false advance that
`baseline-v1` still carries, improved 16 of 21 leaf domains, and cut sequence late
advances from 8 to 2. Round two promoted nothing, so it recovers none of that: a
round that only tightens gates has not advanced the product, and the retained
default keeps every known limitation recorded in the August 22 production-decision
entry above.

The version-2 confirmation fixtures remain unobserved — 12 traces, 0 decoded,
fixture identity `a5695acc`, generation `d1971fa3`, first-observed ledger
`1f9613bd` — and stay available as confirmation evidence for a later round. No
live corpus was collected, and none could have been: the live gates exist to test
a candidate that could otherwise ship, and this round confirmed none.

#### The approved-profile list, and what membership means

Membership is not registry membership. The registry retains every historical and
rejected profile so a regression can be reproduced and a default rolled back;
approval is `baseline-v1` plus every candidate that passed all automated gates
**and** all required live gates. A candidate that cleared the automated matrix and
whose live gates failed or were never collected is not a member; the selected
default must be one; and only members may be offered by any later calibration
path. `assertOfferableListenMatcherProfileId` in
`webapp/src/listenRoundTwoProductionDecision.ts` is the guard those paths call,
and it refuses a registry identifier that is merely retained.

That list is not taken on trust anywhere. The emitter derives it from the
eligibility manifest and the live rows under the membership rule and refuses to
write a list that differs from the constant production would offer; the evidence
verifier recomputes the same membership, the bounded outcome, and the ablation
record from the artifacts themselves; and both refuse a live result naming a
profile the automated matrix never cleared, because live evidence cannot approve a
candidate around the automated gates.

Neither is a live gate outcome, and neither is the live archive itself. A Task 15
session archives the *performance*: each trial carries the authored score it was
played against — target pitches, the deliberately played notes of every attack,
score position, chord size, register, dynamic, articulation, tempo, ambiguity, and
the reason a negative trial exists — together with the target-independent decoded
recognition trace, captured once and replayed by every profile column, with no
audio in the export. Every archived outcome is then reproduced by replaying that
trace through the profile's own thresholds on the same matcher path the automated
domains use, and an outcome the replay does not reproduce is refused. That is what
the archive's digest is for: it authenticates the evidence, and the outcomes are
recomputed from it rather than believed. A trial's `expectedCorrect` is checked
against its class in both directions, so a positive trial cannot be relabelled out
of the correctness gate; an unsafe counter without an advance is an incoherent row;
and a negative trial the incumbent itself advances is archived as the live
incumbent failure it is, since removing one is the live improvement that matters
most.

A completed round names its Task 15 sessions by path, file SHA-256, and record
digest, and every candidate's live status is recomputed from those archived trials
before membership is decided: per setup, per trial, and per counter, with each
failure naming the setup, the trial, the counter, and both values. The archives are bound to the eligibility manifest they were
collected against and may replay only automated-eligible profiles; each setup must
carry all eight required trial classes and the corpus must cover an acoustic and a
digital instrument; safety on the negative classes is absolute at any rate;
repeated-chord recovery is compared under Task 24's frozen boundaries; and latency
is allowed one decoder hop. A stated result the archives do not reproduce is
refused, as is a collected corpus whose archives cannot be read — an approval
nobody can recompute is not an approval. `webapp/src/listenRoundTwoLiveEvidence.ts`
holds that rederivation and the evidence verifier repeats it independently.

The promoted default is likewise rederived rather than named. The plan's ordered
rule is applied to the same archives in
`webapp/src/listenRoundTwoDefaultSelection.ts`: fewer live safety failures, then
higher live correct advancement, then higher automated independent recognition,
then ordered and complete progress, then lower latency, then smaller distance from
`baseline-v1`, with every step compared by dominance across setups and renderers so
a digital gain never pays for an acoustic loss and a Tone gain never pays for a
Direct one. Every step is compared per renderer *and* per instrument, and ordered advances and
complete passages are two measures rather than a sum, so a gain on one piano never
pays for a loss on another and an ordered gain never conceals a complete-passage
loss. Both confirmation repetitions must rank alike, the winner must beat every
other approved candidate, and it is promoted only on a material improvement under
Task 23's frozen recipe — `listenPromotionMaterialImprovements`, the same function
the confirmation matrix uses, applied to the archived domain results rather than
paraphrased into a new aggregate, so the axes a promotion may be earned on are
exactly the ones that policy authorizes. The evidence verifier recomputes that
assessment independently and refuses a promotion whose archives hold no material
axis, a refusal the archives contradict, or a stated assessment that is not the
policy's. A round whose rule does
not separate its candidates, or whose winner is not materially better, records
`approved-without-material-improvement`: those profiles stay approved and offerable
by calibration while production stays where it is. None of this round's evidence
reached that branch — it approved no candidate — but the rules are enforced and
tested rather than described, because the branch is what a later round will take.

#### The residual, routed to a new plan

The round does not resolve the recorded missing re-onset, so it emits
`plans/listen-decoder-model-evidence-requirement.md` as this task's own output,
referenced by the SHA-256 of its bytes
(`195737b2e85fe02e039d9a9bee25173987e960d802c3689576412cadc7b56aaa`) so it cannot be
emptied after the decision cites it. It carries both decoder defects Task 22
recorded — onset evidence on a bass pitch that was never sounded (0.5267 on
`isolated/direct/122`, 0.5094 on `isolated/tone/124`, both inside the
`[0.50, 0.60)` corridor and both admitted through the ordinary fresh-onset path)
and no D5/74 re-onset across the first two physically repeated chords of
`[62, 74, 82]`, with sustained evidence 0.1935, 0.1627, and 0.0958 — and states
the acceptance question: whether decoder or model evidence can expose the first
real repeated attack for a still-ringing required pitch while refusing an
unsounded bass, reaching source distance 0 without adding false, skipped, or
duplicate advances on the paired corpus. The second defect is the same retrigger
limitation the August 14 score-rise experiment could not correct safely, not an
unclassified threshold symptom.

Task 21 is deliberately not named as the next step: it is reachable only through
Task 17, Task 17 requires an approved alternative profile, and this round approved
none, so that prerequisite cannot be met. Model work is a non-goal in the
calibration plan, which is why the requirement is a separate document rather than
another task in it.

#### Verification

Measured on the development Linux machine at the commit carrying this entry, with
Node v24.13.0. This branch runs the full unit suite and the production build only.
The isolated, sequence, and dynamics matrices are deliberately not run: there is no
selected profile for them to validate, and replaying them over a corpus this round
preserved would spend the evidence the not-run branch exists to keep.

| Check | Result |
| --- | --- |
| Unit suite | passes, including the Task 29, live-evidence, and selection-rule tests |
| Production build | passes |
| Frozen evidence verifier | all ten artifacts verify, including the three-link chain and the requirement digest |
| Default identifier | `DEFAULT_LISTEN_MATCHER_PROFILE_ID` is `baseline-v1`, and `resolveEffectiveListenMatcherProfile()` resolves it |
| Approved list | exactly `[baseline-v1]`, chained to eligibility manifest `20be9d6d` |
| Live corpus | none collected, and no Task 29 file other than the list itself exists |
| Confirmation partition | 12 traces, 0 decoded, ledger `1f9613bd` unchanged |

Ordinary listen mode runs and reports the retained identifier: the application
builds its matcher from `resolveEffectiveListenMatcherProfile`, which without a
debug override resolves to `DEFAULT_LISTEN_MATCHER_PROFILE_ID`, and the
Diagnostics panel prints the effective profile, appending `(debug override)`
whenever the session picker has replaced it.

Rollback is unchanged and still one edit: `DEFAULT_LISTEN_MATCHER_PROFILE_ID` in
`webapp/src/listenMatcherProfiles.ts`. Every released profile stays in the
registry, so moving the default forward or back needs no reconstruction of
threshold values from this history.

See the [piano dynamics benchmark](PIANO_DYNAMICS_BENCHMARK.md) for the
velocity-layer methodology, asset smoke checks, and measured 40-run matrix.
