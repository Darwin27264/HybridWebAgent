#!/usr/bin/env python3
"""
Ofln-Scout ONNX Dynamic INT8 Quantization Script

Quantizes the FP32 ModernBERT model bundle (`laya.onnx`, ~1.7 GB) down to
an INT8 bundle (`laya_int8.onnx`, ~403 MB) using ONNX Runtime dynamic quantization.
This achieves an estimated ~2.4x CPU inference speedup and ~4x memory reduction.

Usage:
    python scripts/quantize-int8.py
    python scripts/quantize-int8.py --input path/to/laya.onnx --output path/to/laya_int8.onnx
    python scripts/quantize-int8.py --cache-dir ~/.cache/receptron-laya
    python scripts/quantize-int8.py --help
"""

import sys
import os
import time
import argparse
import logging
import warnings
from pathlib import Path

# Clean log formatting and filter external warnings
logging.getLogger("root").setLevel(logging.ERROR)
warnings.filterwarnings("ignore")

# Dependency Verification with friendly diagnostics
try:
    import onnx
    import onnxruntime
    from onnxruntime.quantization import quantize_dynamic, QuantType
except ImportError as e:
    missing_pkg = getattr(e, 'name', 'onnxruntime / onnx')
    sys.stderr.write(
        f"\n[ERROR] Missing required Python dependency: {missing_pkg}\n\n"
        "To run the dynamic quantization script, please install the required packages:\n"
        "    pip install onnx onnxruntime\n\n"
        f"Original error: {e}\n\n"
    )
    sys.exit(1)


def format_bytes(bytes_num: int) -> str:
    """Format bytes into human-readable string (KB, MB, GB)."""
    if bytes_num <= 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB"]
    idx = 0
    val = float(bytes_num)
    while val >= 1024.0 and idx < len(units) - 1:
        val /= 1024.0
        idx += 1
    return f"{val:.2f} {units[idx]}"


def resolve_default_paths(cache_dir_arg: str | None = None) -> tuple[Path | None, Path | None]:
    """
    Search for standard cached Laya model files across common locations:
    1. process.env.LAYA_MODEL_DIR
    2. cache_dir_arg / receptron--laya-onnx / main
    3. ~/.cache/receptron-laya / receptron--laya-onnx / main
    4. ./onnx
    5. ~/.cache/laya
    """
    candidates = []

    env_model_dir = os.environ.get("LAYA_MODEL_DIR")
    if env_model_dir:
        candidates.append(Path(env_model_dir))

    if cache_dir_arg:
        c_path = Path(cache_dir_arg).expanduser().resolve()
        candidates.append(c_path / "receptron--laya-onnx" / "main")
        candidates.append(c_path)

    env_cache_dir = os.environ.get("LAYA_CACHE_DIR")
    if env_cache_dir:
        ec_path = Path(env_cache_dir).expanduser().resolve()
        candidates.append(ec_path / "receptron--laya-onnx" / "main")
        candidates.append(ec_path)

    # Standard default cache
    home_cache = Path.home() / ".cache" / "receptron-laya" / "receptron--laya-onnx" / "main"
    candidates.append(home_cache)
    candidates.append(Path.home() / ".cache" / "laya")
    candidates.append(Path.cwd() / "onnx")

    for candidate in candidates:
        candidate_onnx = candidate / "laya.onnx"
        if candidate_onnx.exists():
            return candidate_onnx, candidate / "laya_int8.onnx"

    return None, None


def parse_args():
    parser = argparse.ArgumentParser(
        description="Quantize FP32 Laya ModernBERT ONNX model to dynamic INT8 (~403 MB) for CPU speedup.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--input", "-i",
        type=str,
        default=None,
        help="Path to the source FP32 ONNX model (default: auto-detected from cache)",
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        default=None,
        help="Path to the output INT8 ONNX model (default: <input_dir>/laya_int8.onnx)",
    )
    parser.add_argument(
        "--cache-dir", "-c",
        type=str,
        default=None,
        help="Base directory containing cached model weights",
    )
    parser.add_argument(
        "--external-data",
        action="store_true",
        default=False,
        help="Save quantized tensor weights in a separate .data external file",
    )
    parser.add_argument(
        "--force", "-f",
        action="store_true",
        default=False,
        help="Overwrite existing output model if it already exists",
    )
    return parser.parse_args()


def quantize_model(input_path: Path, output_path: Path, use_external_data: bool = False, force: bool = False) -> bool:
    """Execute ONNX Runtime dynamic INT8 quantization."""
    if not input_path.exists():
        sys.stderr.write(f"\n[ERROR] Source FP32 model not found: {input_path}\n")
        sys.stderr.write("Please run 'node scripts/prewarm-laya.mjs' first to download the model bundle.\n\n")
        return False

    if output_path.exists() and not force:
        print(f"\n[Notice] Output model already exists at: {output_path}")
        print("Use --force to overwrite. Skipping quantization.")
        return True

    print("=" * 68)
    print("       Ofln-Scout — ModernBERT ONNX INT8 Dynamic Quantizer")
    print("=" * 68)
    print(f"Input FP32 Model  : {input_path}")
    print(f"Output INT8 Model : {output_path}")
    print(f"Weight Type       : QuantType.QInt8")
    print(f"External Data     : {use_external_data}")

    # Calculate input total size (model + companion .data)
    input_size = input_path.stat().st_size
    companion_data = input_path.with_name(input_path.name + ".data")
    total_input_size = input_size
    if companion_data.exists():
        total_input_size += companion_data.stat().st_size
        print(f"Companion Data    : {companion_data} ({format_bytes(companion_data.stat().st_size)})")

    print(f"Total Input Size  : {format_bytes(total_input_size)}")
    print("\n[Quantization] Running onnxruntime.quantization.quantize_dynamic...")

    t0 = time.perf_counter()
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        quantize_dynamic(
            model_input=str(input_path),
            model_output=str(output_path),
            weight_type=QuantType.QInt8,
            use_external_data_format=use_external_data,
        )
    except Exception as err:
        sys.stderr.write(f"\n[ERROR] Quantization failed: {err}\n")
        return False

    duration = time.perf_counter() - t0

    # Calculate output total size
    out_size = output_path.stat().st_size
    out_data = output_path.with_name(output_path.name + ".data")
    total_out_size = out_size
    if out_data.exists():
        total_out_size += out_data.stat().st_size

    ratio = (1.0 - (total_out_size / total_input_size)) * 100.0 if total_input_size > 0 else 0

    print(f"✔ Quantization completed in {duration:.2f} seconds.")
    print("\n" + "-" * 68)
    print(f"Input Size        : {format_bytes(total_input_size)}")
    print(f"Quantized Size    : {format_bytes(total_out_size)} (target: ~403 MB)")
    print(f"Size Reduction    : {ratio:.1f}% reduction")
    print(f"CPU Speedup Est.  : ~2.4x non-autoregressive forward pass speedup")
    print("-" * 68)
    print("\n✔ SUCCESS: INT8 model generated successfully.")
    print(f"  To use the INT8 model in daemon, point LAYA_MODEL_DIR to: {output_path.parent}\n")
    return True


def main():
    args = parse_args()

    input_file = None
    output_file = None

    if args.input:
        input_file = Path(args.input).expanduser().resolve()
    if args.output:
        output_file = Path(args.output).expanduser().resolve()

    if not input_file or not output_file:
        auto_in, auto_out = resolve_default_paths(args.cache_dir)
        if not input_file:
            input_file = auto_in
        if not output_file:
            output_file = auto_out

    if not input_file:
        sys.stderr.write(
            "\n[ERROR] Could not automatically locate the source FP32 model 'laya.onnx'.\n"
            "Please specify the input model path with --input <path> or run:\n"
            "    node scripts/prewarm-laya.mjs\n"
            "to populate the cache.\n\n"
        )
        sys.exit(1)

    if not output_file:
        output_file = input_file.with_name("laya_int8.onnx")

    success = quantize_model(
        input_path=input_file,
        output_path=output_file,
        use_external_data=args.external_data,
        force=args.force,
    )

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
