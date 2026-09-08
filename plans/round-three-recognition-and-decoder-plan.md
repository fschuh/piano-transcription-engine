# Round 3: Online AMT recognition limits and decoder calibration

> **Status:** In progress. Proposed September 7, 2026; Task 01 completed
> September 8, 2026. Task 02 completed September 8, 2026; Tasks 03 to 07 have not begun.
>
> **Code:** `piano-transcription-engine`.
>
> **Recordings, annotations, traces, and detailed results:** private
> `piano-transcription-evals`.

## Objective and approach

Find how reliably the existing Online AMT model recognizes real piano attacks,
which failures can improve without retraining, and how much useful recognition
the target-independent decoder can extract from its output. Evaluate global
settings first and investigate instrument/setup calibration where the evidence
supports it.

Use an established evaluation protocol with an adaptive experiment loop. Specify
the baseline audit and scoring before experimenting; choose subsequent experiments
from the observed failure mechanisms. The round can finish successfully with a
documented limitation or a better decoder even if no matcher profile is promoted.

Separate these stages throughout the report:

```text
audio -> input processing -> model probabilities and selected states
      -> output-score calibration -> target-independent events
      -> matcher -> ordered score advancement
```

Raw score evidence and decoded-event accuracy are different measurements. A model
may support pitch presence without distinguishing another attack of the same
pitch. Note-event F1 requires an event readout; it is not a decoder-free metric.
Report the best recognition observed under the tested settings and readout family,
not an absolute or mathematically proven model ceiling.

## Starting point and scope

The engine already provides `OnlineAmtSession`, `OnlineAmtOutputDecoder`, MIDI
parsing, recording inventory, functional matcher tests, and browser/offline parity.
The inventory reads MP3 headers; it does not yet decode the recordings or measure
recognition. Reuse those components and add the missing audio and evaluation path.

Round 1 rejected candidates for safety, including hallucinated bass attacks.
Round 2 accepted no ablation under its repeated-recovery stop rule and ran no
confirmation matrix. Neither round demonstrated that every possible global
improvement was exhausted. Their useful lessons are the paired failure mechanisms:
missing repeated-pitch attacks and fresh attacks on pitches that were not played.

Include raw recognition, input/model-wrapper experiments, output calibration, and
causal event decoding. Bring the matcher back only after measuring those layers.
Leave retraining, a broad matcher grid, a calibration wizard, and automatic viewer
rollout outside this round. Earlier unsuccessful retrigger and score-event reset
experiments are evidence to consult, not features to re-enable by default.

Use ordinary tests, configurations, Git revisions, and readable comparisons.
Do not rebuild Round 2 artifact chains, completed-branch simulators, duplicated
decision validators, or defenses against consistent manual artifact falsification.

## Code and data ownership

- Engine: reusable capture, score analysis, event matching, experiment adapters,
  reporting code, and original numeric/synthetic tests. Production modules remain
  independent of eval code.
- Private eval repo: recordings, score annotations, split/setup configuration,
  MIDI corrections, model traces, experiment journals, and per-recording reports.
- Viewer: no Round 3 implementation work. It may adopt a separately verified engine
  revision after the round's decision.

Accept input paths and annotations as caller data. Keep copyrighted sequences out
of engine code and tests. Use the existing private annotation for Course Clear.
Keep evaluation-only tools out of the normal consumer installation path: prefer an
explicit local FFmpeg prerequisite for MP3 decoding; do not add a heavy audio or
browser toolchain to the engine's Git-install preparation hook.

The private eval repo may pin an experimental engine revision while the viewer
continues using its released revision. Record which revision/configuration each
run uses. Matching revisions are required for a claimed production comparison,
not for every research experiment.

## Corpus and annotation policy

### Gold Course Clear speed evaluation

Use the five corrected takes, each with 69 pitch attacks across 27 score moments:
nominal 1000 ms, 500 ms, 400-to-300 ms acceleration, 250 ms, and 200 ms. These
are five performances from one Yamaha GC1 / Surface Pro microphone setup.

Score every take separately. Use actual MIDI timing for attack matching; retain
nominal speed as a label. For local-speed analysis, distinguish written rhythmic
gaps and pauses from tempo changes. Report repeated chords and complete chords
explicitly. Do not count these takes as five independent instruments.

### Silver repertoire evaluation

Use the seventeen distinct MP3/MIDI pairs. Each loose pair without setup metadata
gets its own unknown-source setup ID; that is a bookkeeping convention, not proof
of seventeen physically different instruments. Report every recording and an
equally weighted mean of recording scores. Pooled note counts may be supplemental.

Silver MIDI may contain extra notes, missing notes, wrong pitches, and timing
errors. Treat it as a reference transcription, not unquestionable ground truth.
Use local one-to-one onset/pitch matching so one disagreement does not misalign
the rest of a passage. Avoid whole-recording perfection as the silver score.

Do not silently forgive mismatches because the model disagrees with the MIDI.
Ordinary F1 already gives each isolated mismatch a small effect: 100 correctly
recognized attacks against 101 reference attacks, one of them nonexistent, scores
about 99.5%. A reference missing one attack similarly produces one unmatched
prediction. Keep both the score and those discrepancies visible.

### Review, correction, and promotion to gold

Produce a private review queue with time, MIDI pitch/name, predicted pitch/name,
nearby attacks, and model evidence. Classify entries neutrally:

- Unmatched reference attack: possible extra annotation or recognition miss.
- Unmatched predicted attack: possible missing annotation or hallucination.
- Nearby same-pitch event: possible annotation or detection timing error.
- Nearby different-pitch event: possible pitch substitution on either side.

Prioritize consequential disagreements and ones shared by several configurations.
Shared-model agreement is not independent proof. The user resolves them by
listening and inspecting the audio/score, with a replayable interval available
without requiring a custom annotation editor.

Preserve original annotations through Git history or a small correction sidecar.
Record corrections and unresolved regions explicitly. If an uncertain region is
excluded, exclude both reference and predicted events there for every configuration
and report the excluded duration/count; do not remove only the side that hurts a
score. When annotations change, rescore the baseline and compared configurations
against the same revised reference. Inference need not rerun for label-only edits.

Gold promotion requires the user to verify the entire passage's played pitches
and attacks, including notes both transcribers may have missed. Merely clearing
the disagreement queue is insufficient. Track `gold-onsets` separately from
release/sustain accuracy: perfect attack annotations do not establish perfect
offsets. Promotion changes annotation quality, not a recording's development or
confirmation assignment.

## Fixed evaluation protocol

Before tuning, write a small private configuration specifying the recording split,
musical scoring intervals, alignment offsets, timing windows, and experiment
budget. No generated manifest or digest chain is required.

### Input, clocks, and noise

- Decode to mono 16 kHz float PCM with one documented conversion path. Retain
  original level for baseline; do not silently normalize recordings.
- Validate sample-zero alignment against several real attacks. Account for MP3
  encoder delay/padding as handled by the decoder. Derive any alignment correction
  from audio/annotation inspection, not by optimizing each candidate's F1.
- Feed 512-sample chunks in order, keeping recurrent state through the take and
  resetting between recordings. Process faster than wall-clock time without
  changing sample rate or time-stretching the performance.
- Record score timestamps and the audio time at which a causal decision becomes
  available. Include any buffering/lookahead in detection delay; execution time
  is a separate performance measurement.
- Define a short, fixed tail flush for the runner and label its added samples.
  Do not invent reference attacks or extend a candidate's scoring window.
- Preserve pre-roll. Estimate noise from verified pre-attack audio, leaving an
  attack guard interval. Use the available stable segment; report its length and
  uncertainty rather than requiring one second or a new recording.
- Record level, peak/clipping, and approximate noise separately from correctness.
  A long interval before the first MIDI note may contain unannotated music or
  speech, so it is not automatically a noise-calibration region.
- Apply the same scoring interval to every configuration. Evaluate verified
  silence separately for false detections; do not count unannotated music as
  negative evidence.

### Raw evidence and event measurements

Capture all 88 pitches' five state scores, selected states, signal-active flags,
and timestamps before TypeScript event decoding or matcher filtering.

The current wrapper weights onset/re-onset scores by two. Recover the unweighted
probabilities on active frames by dividing by the known weights, and retain both
representations. These are probabilities under the current recurrent trajectory;
undoing weights does not undo earlier feedback decisions. On inactive frames the
export zeros scores: label evidence as suppressed/unavailable rather than proving
that the network found no pitch. Investigate gating only when relevant.

For each reference attack, report nearby attack evidence, pitch-presence evidence,
timing, selected-state behavior, and competing pitches. Compare against unplayed
pitches and no-attack regions, with particular attention to sustained notes and
repeated attacks. Label any reference-informed maximum/peak measurement as an
optimistic diagnostic; a deployable readout cannot use the reference to select it.

For events, match exact MIDI pitch and onset time using maximum one-to-one matching.
Use a primary +/-50 ms window and a supplemental +/-100 ms timing-sensitivity
result, fixed across configurations. Test matching against small known cases,
including close repeats and ties. If initial annotation inspection shows these
windows inappropriate, revise them before tuning and explain why.

Report precision, recall, F1, unmatched references, unmatched predictions, matched
timing error, and causal detection delay. Keep release/sustain scoring optional
until annotations support it. Do not let timing-offset correction hide latency.

Gold adds complete-chord attack recognition, repeated-chord recovery by attack,
and zero-observed-false-attack results. Silver reports reference similarity and
the review queue. Zero observed errors is a finite-corpus observation, not a
universal safety claim.

Plot/report precision-recall tradeoffs from a small family of score readouts as
well as the shipped decoder result. A lower threshold that raises recall while
adding hallucinations is a tradeoff, not automatically an improvement. Raw
pitch-presence completeness must not be reported as fresh-attack completeness.

### Development and confirmation

Assign twelve silver recordings to development and five to confirmation before
tuning, balancing length, density, register, and recording conditions using
metadata/annotation inspection. Keep related known sources together. Save the
actual IDs in private configuration; engine code does not embed the corpus.

Use development results to choose experiments. Baseline runs on confirmation are
permitted, but do not use their failure details to direct tuning. Run selected
finalists on confirmation after selection; do not repeatedly retune on it.

Use leave-one-take-out comparisons for modest Course Clear setup calibration:
fit on four takes and evaluate the fifth, reporting all five held-out results.
Because the same passage informs repeated research cycles, treat this as
exploratory setup evidence rather than a fresh independent final test.

Global settings must be fitted on development data. A silver configuration fitted
to its entire recording may illustrate calibration headroom, but is not evidence
that instrument calibration generalizes. A single recording per unknown setup
cannot provide independent same-instrument takes.

Keep manual annotation cleanup and promotion in the development loop. If final
confirmation exposes a clear reference defect, document the correction and
rescore the already selected baseline/finalists without retuning. Further tuning
after that inspection needs new confirmation evidence or an explicit exploratory
conclusion.

## Adaptive experiment loop

Allow an initial six hypothesis cycles, normally three to five configurations per
cycle. Baseline plumbing and annotation corrections are not hypothesis cycles.
Choose one family at a time; combine useful changes only after their individual
effects are understood. A combination experiment counts as a cycle.

For each cycle, write one short journal entry:

1. Observed failure mechanism and affected development recordings.
2. Hypothesis and expected measurable change.
3. Configurations and why their range is useful.
4. Results against the original baseline and current best, per recording.
5. Keep, reject, or investigate further, with the next hypothesis and reason.

The agent may choose and run experiments within this scope and budget without
asking approval each time. Stop after six cycles, or after three consecutive
cycles yield neither useful improvement nor a new actionable explanation. Stop
earlier when the objectives have been answered. Report what remains before a
budget expansion or substantially different technique is adopted.

Candidate experiment families, ordered by initial simplicity rather than a
mandatory sequence:

| Family | When justified | Recompute model inference? |
| --- | --- | --- |
| Fixed input gain | Weak attacks correlate with recording level | Yes |
| DC/rumble filtering | The audio shows relevant unwanted low-frequency energy | Yes |
| Silence threshold/patience | Gating suppresses useful audio or state behavior | Yes |
| Onset/re-onset state weights | Useful attack probability loses state selection | Yes, if used in feedback |
| Output score bias/scaling | Score interpretation differs systematically by state/setup | No, if downstream only |
| Causal event extraction | Scores/states contain attacks missed or duplicated by decoding | No |

Begin a gain experiment, if selected, with five modest levels around unity, such
as -6, -3, 0, +3, +6 dB. Report any clipping/over-range samples and compare the
actual transformed audio. Runtime gain selection must be feasible causally;
whole-recording peak normalization is only an offline diagnostic.

Changing state weights inside `streaming_step.py` changes the selected state fed
back on subsequent frames and requires rerunning/re-exporting the wrapper with
the same pretrained weights. A downstream score transform does not simulate this.
Do not edit the production model asset in place for an experiment.

Global monotonic score scaling may only change threshold interpretation; it does
not create separation within an unchanged score ordering. Claim a calibration
benefit only when event quality, latency, or usable cross-setup thresholds improve.
Use few setup parameters; avoid per-pitch fits or a separate setting for every
chord. Any settings chosen from labeled takes must be evaluated on other takes.

EQ, compression, denoising, and richer readouts are conditional hypotheses, not
required implementations. No score-target conditioning, MIDI-guided state resets,
future-label access, or retraining is allowed in a deployable candidate.

## Implementation tasks and deliverables

### Task 01 — Establish the private protocol and audio runner

- Extend the existing eval API and private scripts with explicit audio input and
  output paths; retain the current inventory command.
- Select and document the split, timing rules, noise intervals, and baseline
  configuration. Check a small sample of annotation alignment.
- Implement MP3-to-PCM conversion and sequential model capture using the existing
  session. Cache raw traces privately and reuse them for downstream experiments.

Done when one gold take and one development silver recording run end to end,
preserving timestamps/state and producing inspectable raw scores. Test conversion
timing and runner edge cases with original synthetic audio. No recognition
performance claim is needed at this stage.

**Complete, September 8, 2026.** All twenty-two recordings the protocol names run
end to end and their raw traces are cached, past the one gold take and one silver
recording this asked for. The protocol is adopted as private caller data; the
private `reports/round-three/task-01-protocol.md` records what was measured to
choose each of its values and is the place to change them.

Three results bear on the tasks that follow:

- The model's causal detection delay is about 160 ms and barely moves across the
  five gold speeds. A fixed window applied to raw frame times would therefore
  match almost nothing, so Task 02 has to state the onset time its readout
  estimates and report detection delay separately, without folding the delay into
  the protocol's annotation alignment offset.
- One silver recording's reference onsets sit about 34 ms early, and four more
  recordings have alignment this model-free check could not establish. All are
  handed to the Task 03 review queue rather than corrected on an unverified
  measurement.
- The conversion path had been feeding the stereo gold takes 3 dB above both the
  mono silver recordings and what the live capture worklet would produce. It now
  averages channels as the worklet does, so the gold takes' recorded levels, and
  the apparent over-range samples in the two fastest ones, are superseded.

### Task 02 — Implement raw diagnostics and event scoring

- Add weighted/unweighted score inspection and suppressed-frame reporting.
- Implement local event matching, the two timing windows, per-recording metrics,
  precision-recall comparisons, and gold chord/repetition diagnostics.
- Include the shipped decoder and one small causal attack-score readout for
  comparison. State its event separation and latency behavior explicitly.

Done when tests demonstrate that an extra/missing MIDI attack changes only its
local match, subsequent events still match, and one prediction cannot satisfy two
attacks. Test false attacks, repeats, timing boundaries, silence, and empty event
sets. Compare raw evidence and decoder output without matcher involvement.

**Complete, September 8, 2026.** The engine eval API now provides weighted and
unweighted frame inspection, suppressed-evidence labels, reference-informed raw
attack diagnostics, maximum one-to-one event scoring, and gold complete/repeated
chord diagnostics. `piano-transcription-score` compares shipped decoder events
with three causal hysteresis thresholds from cached traces and caller MIDI and
protocol files. It records exclusions, both timing windows, and separate onset
error and decision delay. A fixed onset-lag estimate is an explicit CLI input,
separate from annotation alignment; the original availability clock is retained.
Synthetic tests cover local annotation errors, one-to-one repeats and ties,
false attacks, timing boundaries, silence/empty sets, causal replay, suppression,
chords, exclusions, pre-roll, tail handling and latency. Build and the full test
suite pass. No corpus performance claim is made; baseline reporting remains
Task 03. See the README's raw recognition evaluation section for usage and exact
readout/matching conventions.

### Task 03 — Produce the baseline report and annotation review queue

- Run all five gold takes and the development silver set through the unchanged
  model and decoder. Keep confirmation outcomes separate if captured now.
- Report failure mechanisms, speed dependence, reference similarity, noise/level,
  and the recognition/false-detection tradeoff.
- Generate timestamped annotation disagreements, support manual correction, and
  rescore configurations consistently after edits. Record promotion to gold only
  after full user verification of the claimed annotation dimensions.

Done when the baseline report identifies which knobs have plausible value and
which cases appear limited by absent or ambiguous evidence. This is the first
review milestone and determines the experiment order; do not build all possible
knobs in advance.

### Task 04 — Run the bounded adaptive experiments

- Execute up to six documented hypothesis cycles under the rules above.
- Retain the original baseline, the best global configuration, and at most one
  materially distinct setup-calibration approach for detailed follow-up.
- Report unchanged/negative findings as well as improvements. Review important
  silver disagreements before attributing small gains to recognition changes.

Done when the budget/stop condition is reached or a clear outcome is supported.
Deliver an experiment table and a concise explanation of remaining limits. A
per-recording oracle fit must remain labeled as exploratory.

### Task 05 — Evaluate selected recognition finalists

- Record the selected settings before running the five silver confirmation files.
- Compare baseline and finalists on the same annotations and timing rules, and
  report each gold speed and Course Clear calibration fold.
- Require a useful gain without unexplained severe per-recording regressions,
  additional gold false attacks, or an unacceptable latency cost to call a
  candidate broadly better. Report tradeoffs when neither setting dominates.

Done when findings distinguish global improvement, setup-specific potential,
overfitting, annotation uncertainty, and no useful improvement. A close silver
comparison remains inconclusive until the changed events are reviewed; do not
invent a universal annotation-error margin.

### Task 06 — Check promising changes through the matcher and audio safety cases

- Replay promising decoded outputs through `baseline-v1` with unchanged matcher
  settings. Use score data only at this stage for target matching/navigation.
- Report independent matches, ordered/complete progress, delay, and
  false/skipped/duplicate advances per case. Classify gains by their source layer.
- Run the existing numeric functional suite and a compact original audio suite
  with omitted bass, extra notes, held pitches, repeated attacks, and silence.
  Numeric traces alone cannot reveal hallucinations introduced by input/model
  changes. Private historical cases may supplement these diagnostics.

Done when a recognition improvement's practical effect and remaining safety
limitations are known. Skip new matcher tuning unless the report specifically
shows useful decoded evidence being rejected; a broad profile search belongs to
a later decision.

### Task 07 — Close the round and record the next decision

- Produce a private final report with baseline results, experiments, annotation
  changes, confirmation results, and unresolved cases.
- Add a public summary containing reusable findings and aggregate measurements,
  with no private audio, MIDI, score sequence, or per-recording trace.
- Recommend one outcome: global recognition change, setup-calibration follow-up,
  targeted decoder/matcher work, or no useful improvement under tested methods.
- If recommending production adoption, run affected engine tests/build and browser
  parity, document causal processing cost and asset/config changes, and provide
  an explicit engine revision for a separate viewer adoption step.

Done when every observed improvement has a named layer and an evidence limit.
No candidate, unfinished annotation cleanup, or lack of a production promotion is
not by itself a reason to extend the round.

## Minimal outputs and completion criteria

Keep the implementation usable through private commands for capture, score,
compare, and annotation-review export, backed by the engine's shared eval code.
Command names may evolve; one configuration and readable generated reports are
sufficient. No custom annotation application or autonomous agent framework is
required to execute the loop.

At completion we should be able to answer:

- How well does the current model expose pitch and fresh-attack evidence on each
  gold speed and across the silver repertoire?
- What does the current decoder lose or invent relative to that evidence?
- Which tested knobs improve recognition at a comparable false-detection rate
  and delay, globally or for a known setup?
- Which apparent failures are reference-annotation problems, and which remain
  unresolved?
- Do promising recognition changes help score following, and what is the next
  smallest experiment or product change justified by the results?

The empirical recognition envelope is specific to the tested recordings, timing
rules, causal readouts, and configurations. It guides where to spend effort; it
does not establish that Online AMT can never recognize a currently missed note.
