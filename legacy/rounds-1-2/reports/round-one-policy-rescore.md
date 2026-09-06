### Round-two validation policy — August 23, 2026

Task 23 freezes validation policy version 1 in
`webapp/src/listenProfileValidationPolicy.ts`. This is a versioned policy change,
not a correction to the Task 13 evidence. The two Task 13 JSON files and their
historical gate definitions remain byte-for-byte unchanged and continue to verify
under the round-one contract they actually ran.

The policy has four independent parts:

- Safety gates remain mandatory and fail closed. A complete run with any required
  gate unapplied rejects every affected profile; filtering only
  `applied && !passed` can no longer turn missing coverage into eligibility.
- Correctness eligibility is paired non-regression against `baseline-v1` on the
  identical frozen corpus. The incumbent traverses the same gate implementation
  and reports a reference row; it is not exempt from a rule it supplies the
  baseline for.
- The former isolated count floors are frozen as rates: 98% Direct overall, 95%
  Tone overall, and 95% Course Clear for both renderers. A manifest binds each rate
  to its census by ceiling. These are product targets, not eligibility gates, and
  every profile reports its distance from them.
- Eligibility alone cannot promote a profile. Promotion requires at least one
  predeclared material improvement: a one-percentage-point rate gain, one 32 ms
  decoder-hop latency reduction, or removal of one unsafe event, while still
  passing every safety and correctness gate. A profile at parity everywhere stays
  eligible for comparison but is not promotable. Rate and latency comparisons
  admit only frozen `1e-12` rate and `1e-9` ms representation epsilons, so the
  same count-derived one-point gain cannot fall on opposite sides of the boundary
  because of binary subtraction.

The Task 13 archive contract explicitly expects no `policyVersion` field because
those files predate this policy; a policy-versioned file is rejected instead of
being relabelled as historical evidence. Re-scoring both frozen Task 13 archives
through the committed archive reader gives the same adjacent result without
rendering audio or running inference. The re-score applies the complete policy
materiality set — isolated rates and latency, sequence rates and latency, dynamics
suite rates, and unsafe-event reduction. The
incumbent's Tone product debt is one overall correct advance (100/106 versus the
derived target 101) and four Course Clear advances (48/54 versus 52). All four
`v2` candidates meet paired isolated correctness and the materiality boundary.
The open pair's old `release-isolated-course-clear` rejection disappears, and the
held pair's old `release-isolated-recognition` and
`release-isolated-course-clear` rejections disappear. All four remain ineligible
for exactly one surviving reason: `safety-isolated-false-advance`, covering
`isolated/direct/122` and `isolated/tone/124`. Thus Task 23 changes no production
decision, threshold, registry entry, or default; it removes only the asymmetric
correctness rejections before the round-two corpus is built.
