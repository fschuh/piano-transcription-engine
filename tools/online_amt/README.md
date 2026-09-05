# online_amt ONNX export and validation

These tools reproduce and validate the fixed-shape streaming ONNX model shipped
by `@fschuh/piano-transcription-engine`. They require a separate checkout of
[`jdasam/online_amt`](https://github.com/jdasam/online_amt) at revision
`f353035175cc3436ebdc411530a9e73c966d2077`, its `model-180000.pt` checkpoint,
and a Python environment containing its PyTorch dependencies plus NumPy and
ONNX Runtime.

From this repository root:

```text
python tools/online_amt/export_streaming_onnx.py \
  --source-root ../online_amt \
  --checkpoint ../online_amt/model-180000.pt \
  --output assets/models/online_amt_streaming.onnx

python tools/online_amt/validate_streaming_onnx.py \
  --source-root ../online_amt \
  --checkpoint ../online_amt/model-180000.pt \
  --onnx assets/models/online_amt_streaming.onnx \
  --browser-fixture-dir evals/fixtures/online_amt_runtime
```

The graph consumes one 512-sample mono float32 chunk at 16 kHz and makes all
eight recurrent tensors explicit. `reset=true` selects the initial
mel/CNN/LSTM state embedded in the graph. Validation compares the streaming
step with both the upstream PyTorch transcriber and native ONNX Runtime, then
regenerates the public-safe 180-frame fixture when
`--browser-fixture-dir` is supplied.

The fixture audio is deterministic silence plus a synthesized, exponentially
decaying 440 Hz harmonic signal. It contains no recording or copyrighted score
material. Regenerating the fixture or canonical model is a reviewed model
change; normal builds and tests only read them.

The exported model is derived from `jdasam/online_amt` under the MIT license.
Its required notice is at `assets/models/online_amt.LICENSE.txt`; model hashes
and runtime results are recorded in the repository README and
`RUNTIME_BENCHMARK.md`.
