from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import torch

from streaming_step import (
    CANONICAL_STATE_WEIGHTS,
    INPUT_NAMES,
    OUTPUT_NAMES,
    OnlineAmtStreamingStep,
)


def state_weights(value: str) -> tuple[float, ...]:
    """Parses the five per-state weights an export applies to its own scores."""
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 5:
        raise argparse.ArgumentTypeError(
            f"Expected five comma-separated weights, received {value!r}",
        )
    try:
        weights = tuple(float(part) for part in parts)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"{value!r} is not five numbers") from error
    if any(weight <= 0 for weight in weights):
        raise argparse.ArgumentTypeError(f"Weights must be positive, received {value!r}")
    return weights


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export online_amt as one stateful 512-sample ONNX step.",
    )
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--state-weights",
        type=state_weights,
        default=CANONICAL_STATE_WEIGHTS,
        help=(
            "Per-state weighting applied before the argmax, as off,offset,"
            "sustain,onset,reOnset. Defaults to the canonical 1,1,1,2,2."
        ),
    )
    return parser.parse_args()


def build_streaming_step(
    source_root: Path,
    checkpoint: Path,
    weights: tuple[float, ...] = CANONICAL_STATE_WEIGHTS,
) -> OnlineAmtStreamingStep:
    source_root = source_root.resolve()
    if str(source_root) not in sys.path:
        sys.path.insert(0, str(source_root))
    from transcribe import OnlineTranscriber, load_model

    model = load_model(checkpoint.resolve())
    reference = OnlineTranscriber(model, return_roll=False)
    initial_state = (
        reference.audio_buffer,
        reference.mel_buffer,
        reference.acoustic_layer_outputs[0],
        reference.acoustic_layer_outputs[1],
        reference.hidden[0],
        reference.hidden[1],
        reference.prev_output,
        torch.zeros((1,), dtype=torch.int64, device=reference.device),
    )
    return OnlineAmtStreamingStep(model, initial_state, weights).eval()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_revision(source_root: Path) -> str | None:
    """The upstream revision the graph was built from, when it can be measured."""
    try:
        completed = subprocess.run(
            ["git", "-C", str(source_root.resolve()), "rev-parse", "HEAD"],
            capture_output=True,
            check=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return completed.stdout.strip() or None


def write_sidecar(args: argparse.Namespace) -> Path:
    """Records what this export is, beside the file it wrote.

    A re-weighted export is a different model, and every trace captured from it
    has to be read by the weighting it applied. Naming that weighting on the
    capture command line would make it an assertion; writing it beside the
    artifact makes it a property of the artifact, which is what a later run can
    actually check.
    """
    sidecar = args.output.with_name(f"{args.output.name}.export.json")
    sidecar.write_text(
        json.dumps(
            {
                "exportedAt": datetime.now(timezone.utc).isoformat(),
                "model": args.output.name,
                "sha256": digest(args.output),
                "byteLength": args.output.stat().st_size,
                "stateWeights": list(args.state_weights),
                "canonicalStateWeights": list(CANONICAL_STATE_WEIGHTS),
                "checkpointSha256": digest(args.checkpoint),
                "sourceRevision": source_revision(args.source_root),
                "opsetVersion": 18,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return sidecar


def main() -> None:
    args = parse_args()
    step = build_streaming_step(args.source_root, args.checkpoint, args.state_weights)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    example_inputs = step.initial_inputs()
    with torch.inference_mode():
        torch.onnx.export(
            step,
            example_inputs,
            args.output,
            input_names=list(INPUT_NAMES),
            output_names=list(OUTPUT_NAMES),
            opset_version=18,
            dynamo=True,
            external_data=False,
            optimize=True,
            verify=True,
        )
    sidecar = write_sidecar(args)
    weights = ", ".join(str(weight) for weight in args.state_weights)
    print(f"Exported {args.output} ({args.output.stat().st_size / 1_000_000:.1f} MB)")
    print(f"State weighting {weights}; recorded in {sidecar}")


if __name__ == "__main__":
    main()
