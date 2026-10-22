#!/usr/bin/env python3
"""aether_detect.py — Write-mode detector. Reuses the InkSplash scorers rather
than reinventing them: local GPT-2/RoBERTa AI probability (always), a fact-
preservation score vs the source, and optional authoritative ZeroGPT.

Usage:
  aether_detect.py --text OUT.txt [--source SRC.txt] [--zerogpt]
                   [--inksplash-dir DIR] [--ai-max 35] [--fact-min 0.9]

Prints one JSON line: {"aiScore":float, "factScore":float|null,
"zerogpt":float|null, "pass":bool, "detail":str}. Exit 0 on success, 2 on error.
The InkSplash humaniser dir (default: $INKSPLASH_DIR) supplies local_detector,
stealth_humanizer and the optional zerogpt_detect module.
"""
import argparse, importlib, json, os, sys


def _read(path):
    if not path:
        return ""
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--source")
    ap.add_argument("--zerogpt", action="store_true")
    ap.add_argument("--inksplash-dir", default=os.environ.get("INKSPLASH_DIR", ""))
    ap.add_argument("--ai-max", type=float, default=35.0)
    ap.add_argument("--fact-min", type=float, default=0.9)
    args = ap.parse_args()

    root = args.inksplash_dir
    if not root or not os.path.isdir(root):
        print(json.dumps({"error": f"InkSplash dir not found: {root!r}"}))
        return 2
    for p in (root, os.path.join(root, "train")):
        if p not in sys.path:
            sys.path.insert(0, p)

    out = _read(args.text)
    src = _read(args.source)
    if not out.strip():
        print(json.dumps({"error": "empty text"}))
        return 2

    try:
        ld = importlib.import_module("local_detector")
        Det = next(v for v in vars(ld).values()
                   if isinstance(v, type) and hasattr(v, "ai_prob_chunked"))
        ai = float(Det.ai_prob_chunked(out))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"local detector failed: {e}"}))
        return 2

    fact = None
    if src.strip():
        try:
            fs = importlib.import_module("stealth_humanizer")
            fact = float(fs._fact_score(src, out))
        except Exception:  # noqa: BLE001 - fact score is advisory
            fact = None

    zg = None
    if args.zerogpt:
        try:
            zd = importlib.import_module("zerogpt_detect")
            zg = zd.detect(out)
            zg = float(zg) if zg is not None else None
        except Exception:  # noqa: BLE001 - ZeroGPT is flaky/optional
            zg = None

    verdict = (zg if zg is not None else ai)
    passed = verdict <= args.ai_max and (fact is None or fact >= args.fact_min)
    detail = f"local {ai:.1f}%"
    if zg is not None:
        detail += f", ZeroGPT {zg:.1f}%"
    if fact is not None:
        detail += f", facts {fact*100:.0f}%"
    print(json.dumps({"aiScore": ai, "factScore": fact, "zerogpt": zg,
                      "pass": bool(passed), "detail": detail}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
