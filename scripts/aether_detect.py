#!/usr/bin/env python3
"""aether_detect.py — Write-mode detector. Reuses the InkSplash scorers rather
than reinventing them: local GPT-2/RoBERTa AI probability (always), a fact-
preservation score vs the source, and optional authoritative ZeroGPT.

Usage:
  aether_detect.py --text OUT.txt [--source SRC.txt] [--zerogpt]
                   [--inksplash-dir DIR] [--ai-max 35] [--fact-min 0.9]
  aether_detect.py --segments SEGS.json [--inksplash-dir DIR]   (sentence scores / choices)

Prints one JSON line: {"aiScore":float, "factScore":float|null,
"zerogpt":float|null, "pass":bool, "detail":str}. Exit 0 on success, 2 on error.
The InkSplash humaniser dir (default: $INKSPLASH_DIR) supplies local_detector,
stealth_humanizer and the optional zerogpt_detect module.
"""
import argparse, importlib, json, os, re, sys


def _read(path):
    if not path:
        return ""
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


_ABBR = ("Mr.", "Mrs.", "Ms.", "Dr.", "St.", "Jr.", "Sr.", "vs.", "Prof.", "Gen.")
_OPENERS = ("“", '"', "‘", "'", "(", "[")


def _facts(text):
    """Numbers and names. A capitalised word counts only mid-sentence: "Yet" opening a
    reworded sentence, or "The" opening a quotation, is not a fact (InkSplash's score
    counted those). "Mr. Jones" still counts Jones.
    ponytail: a name that only ever opens sentences is not counted; add spaCy NER if that matters."""
    nums = set(re.findall(r"\b\d[\d,.]*\b", text))
    names = set()
    for m in re.finditer(r"\b[A-Z][a-zA-Z]+\b", text):
        window = text[max(0, m.start() - 40):m.start()].rstrip(" \t")
        if not window or window.endswith("\n") or window.endswith(_OPENERS):
            continue
        before = window.rstrip("”\"’')]")
        words = before.split()
        if before and before[-1] in ".!?:" and (words[-1] if words else "") not in _ABBR:
            continue
        names.add(m.group())
    return nums | names


def _fact_score(src, out):
    want = _facts(src)
    if not want:
        return 1.0
    have = set(re.findall(r"\b\d[\d,.]*\b|\b[A-Z][a-zA-Z]+\b", out))
    return len(want & have) / len(want)


def _meaning(fs, src, out):
    """MiniLM similarity of the rewrite to its source; None if embeddings are unavailable.
    MiniLM reads ~256 tokens, so paragraphs are compared pairwise when counts match."""
    try:
        fs._emb()
    except Exception:  # noqa: BLE001 - no sentence-transformers: no meaning score
        return None
    sp = [p for p in src.split("\n") if p.strip()]
    op = [p for p in out.split("\n") if p.strip()]
    pairs = list(zip(sp, op)) if len(sp) == len(op) and len(sp) > 1 else [(src, out)]
    return float(min(fs._sem_sim(a, b) for a, b in pairs))


def _segments(det, path):
    """Sentence-level scoring for the sentence humaniser. Input JSON:
    {"segments": [str, ...], "options": {"3": [alt, ...]}}. Segments concatenate back to the text.
    A sentence is scored in context: the window of it plus its neighbours, since the classifier is
    unreliable on one short sentence. Options are chosen greedily in order, each window seeing the
    choices already made, and only replace a sentence when they score lower than it does.
    Output: {"scores": [window score per segment], "choice": {"3": index or -1}}."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    segs = [str(x) for x in data.get("segments", [])]
    window = lambda i, own: "".join(segs[max(0, i - 1):i] + [own] + segs[i + 1:i + 2]).strip()
    scores = [float(det.ai_prob(window(i, s))) if s.strip() else 0.0 for i, s in enumerate(segs)]
    choice = {}
    for key in sorted(data.get("options", {}), key=int):
        i = int(key)
        if not 0 <= i < len(segs):
            continue
        best, best_score = -1, float(det.ai_prob(window(i, segs[i])))
        for k, alt in enumerate(data["options"][key]):
            sc = float(det.ai_prob(window(i, str(alt))))
            if sc < best_score:
                best, best_score = k, sc
        choice[key] = best
        if best >= 0:
            segs[i] = str(data["options"][key][best])
    return {"scores": scores, "choice": choice}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text")
    ap.add_argument("--segments")
    ap.add_argument("--source")
    ap.add_argument("--zerogpt", action="store_true")
    ap.add_argument("--inksplash-dir", default=os.environ.get("INKSPLASH_DIR", ""))
    ap.add_argument("--ai-max", type=float, default=35.0)
    ap.add_argument("--fact-min", type=float, default=0.9)
    ap.add_argument("--meaning-min", type=float, default=0.85)
    args = ap.parse_args()

    root = args.inksplash_dir
    if not root or not os.path.isdir(root):
        print(json.dumps({"error": f"InkSplash dir not found: {root!r}"}))
        return 2
    for p in (root, os.path.join(root, "train")):
        if p not in sys.path:
            sys.path.insert(0, p)

    if args.segments:
        try:
            ld = importlib.import_module("local_detector")
            Det = next(v for v in vars(ld).values()
                       if isinstance(v, type) and hasattr(v, "ai_prob_chunked"))
            print(json.dumps(_segments(Det, args.segments)))
            return 0
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"error": f"sentence scoring failed: {e}"}))
            return 2
    if not args.text:
        print(json.dumps({"error": "--text or --segments is required"}))
        return 2

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

    fact = meaning = None
    if src.strip():
        try:
            fs = importlib.import_module("stealth_humanizer")
            fact = _fact_score(src, out)
        except Exception:  # noqa: BLE001 - fact score is advisory
            fs = None
        if fs is not None:
            meaning = _meaning(fs, src, out)

    zg = None
    if args.zerogpt:
        try:
            zd = importlib.import_module("zerogpt_detect")
            zg = zd.detect(out)
            zg = float(zg) if zg is not None else None
        except Exception:  # noqa: BLE001 - ZeroGPT is flaky/optional
            zg = None

    verdict = (zg if zg is not None else ai)
    passed = verdict <= args.ai_max and (fact is None or fact >= args.fact_min) \
        and (meaning is None or meaning >= args.meaning_min)
    detail = f"local {ai:.1f}%"
    if zg is not None:
        detail += f", ZeroGPT {zg:.1f}%"
    if fact is not None:
        detail += f", facts {fact*100:.0f}%"
    if meaning is not None:
        detail += f", meaning {meaning:.2f}"
    print(json.dumps({"aiScore": ai, "factScore": fact, "meaning": meaning, "zerogpt": zg,
                      "pass": bool(passed), "detail": detail}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
