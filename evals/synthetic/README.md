# Public functional fixtures

The active functional suite is defined in
`src/eval/functionalFixtures.ts`. Its eight project-authored numeric traces cover
isolated recognition, continuous sequencing, dynamics, repeated chords,
omitted-bass safety, false advances, skipped advances, and duplicate advances.

These fixtures are intentionally short, target-independent recognizer outputs.
They are not melodies, transcriptions, copied benchmark artifacts, or derivatives
of the private MP3/MIDI corpus. Each trace records only synthetic MIDI pitches,
confidence values, note events, and monotonic timing.

Tests import the public `@fschuh/piano-transcription-engine/eval` API and replay
the traces through the production matcher exported by the engine package. The
suite reports exact advances, false/skipped/duplicate advances, processing time,
and attack-to-advance latency. Comparisons name the classifications that got
worse for each individual case rather than reducing a run to a corpus total or a
pass/fail boolean. Deliberately degraded configurations prove the safety and
correctness gates remain capable of failing.
