"""
train/prep_data.py — build the SFT dataset for the local humanizer.

Two stages:
  --stage targets  (GPU-FREE, network only): download human-written college/corporate/
      scientific text, clean + quality-filter it, write train/data/targets.jsonl. These
      genuinely-human passages are the *output* (gold) side of every training pair.
  --stage flatten  (GPU: uses Ollama, run unattended): for each target, generate an
      "AI-flattened" version (uniform sentences, generic vocabulary) as the *input*, and
      write train/data/sft.jsonl. Optionally drop targets that read too AI (local detector).

The flatten->reverse scheme structurally preserves meaning: the model is trained to turn a
flattened paraphrase back into the exact human passage, so it can never learn to drop facts.

Usage:
  .venv\\Scripts\\python.exe train\\prep_data.py --stage targets --n 3000
  .venv\\Scripts\\python.exe train\\prep_data.py --stage flatten           # later, when AFK
"""
import argparse, json, os, re, random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "train", "data")

INSTRUCTION = (
    "Rewrite the text so it reads as authentically human-written and would not be flagged by "
    "an AI-text detector, while keeping it polished, collegiate/professional writing. Keep "
    "every fact, name, date, number and the thesis exactly; do not drop or reframe information. "
    "Vary sentence length naturally, use precise (not simplified) vocabulary, and keep perfect "
    "grammar. Output only the rewritten text."
)

# Human-text sources (streamed, no auth). Each: (hf_name, config, split, field, kind).
# Robust list — any that fail to load are skipped and the rest fill the quota.
SOURCES = [
    ("ccdv/arxiv-summarization", None, "train", "abstract", "scientific"),
    ("ccdv/pubmed-summarization", None, "train", "abstract", "scientific"),
    ("ccdv/govreport-summarization", None, "train", "report", "essay"),   # formal/corporate
    ("EdinburghNLP/xsum", None, "train", "document", "essay"),            # professional prose
]


def clean(t: str) -> str:
    t = re.sub(r"\s+", " ", t or "").strip()
    t = re.sub(r"\(CNN\)\s*-?\s*", "", t)            # news boilerplate
    t = re.sub(r"\[\d+\]|\bet al\.\b", "", t)        # citation cruft
    return t.strip()


def good(t: str) -> bool:
    words = t.split()
    if not (70 <= len(words) <= 380):
        return False
    if len(re.findall(r"[.!?]", t)) < 4:              # needs several sentences
        return False
    alpha = sum(c.isalpha() or c.isspace() for c in t) / max(1, len(t))
    if alpha < 0.85:                                  # not tables/citations/numbers
        return False
    try:
        import textstat
        if textstat.flesch_kincaid_grade(t) < 8.0:    # college/professional level
            return False
    except Exception:
        pass
    return True


def stage_targets(n: int):
    from datasets import load_dataset
    os.makedirs(DATA, exist_ok=True)
    per_kind = {"scientific": n // 2, "essay": n - n // 2}
    got = {"scientific": 0, "essay": 0}
    out_path = os.path.join(DATA, "targets.jsonl")
    seen = set()
    with open(out_path, "w", encoding="utf-8") as f:
        for name, cfg, split, field, kind in SOURCES:
            if got[kind] >= per_kind[kind]:
                continue
            try:
                ds = load_dataset(name, cfg, split=split, streaming=True)
            except Exception as e:
                print(f"[prep] skip {name}: {str(e)[:100]}")
                continue
            print(f"[prep] streaming {name} ({field}) for {kind} ...")
            for ex in ds:
                if got[kind] >= per_kind[kind]:
                    break
                t = clean(ex.get(field, ""))
                # cap very long articles to a college-essay-sized excerpt
                if len(t.split()) > 380:
                    t = " ".join(t.split()[:340])
                key = t[:120]
                if key in seen or not good(t):
                    continue
                seen.add(key)
                got[kind] += 1
                f.write(json.dumps({"id": f"{kind}_{got[kind]}", "kind": kind, "text": t}) + "\n")
            print(f"[prep]   {kind}: {got[kind]}/{per_kind[kind]}")
    print(f"[prep] wrote targets -> {out_path}  ({got})")


_FLATTEN_SYS = (
    "Rewrite the passage in a flat, generic, AI-assistant style: uniform medium-length "
    "sentences, smooth predictable phrasing, plain vocabulary, no rhythm variation. Keep the "
    "same meaning, facts and length. Output only the rewritten passage."
)


def stage_flatten(model: str, filter_human: bool, limit: int = 0):
    import requests
    host = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1").rsplit("/v1", 1)[0]
    tgt = os.path.join(DATA, "targets.jsonl")
    out = os.path.join(DATA, "sft.jsonl")
    det = None
    if filter_human:
        import sys; sys.path.insert(0, ROOT)
        from train.local_detector import LocalDetector as det

    def flatten(text):
        payload = {"model": model, "keep_alive": -1, "stream": False,
                   "options": {"temperature": 0.7},
                   "messages": [{"role": "system", "content": _FLATTEN_SYS},
                                {"role": "user", "content": text}]}
        r = requests.post(f"{host}/api/chat", json=payload, timeout=180)
        return (r.json().get("message", {}).get("content") or "").strip()

    items = [json.loads(l) for l in open(tgt, encoding="utf-8") if l.strip()]
    if limit:
        random.shuffle(items)
        items = items[:limit]
    n = 0
    with open(out, "w", encoding="utf-8") as f:
        for it in items:
            if det is not None and det.ai_prob_chunked(it["text"]) > 40:  # keep only human targets
                continue
            ai_in = flatten(it["text"])
            if len(ai_in.split()) < 0.6 * len(it["text"].split()):
                continue
            f.write(json.dumps({"instruction": INSTRUCTION, "input": ai_in,
                                "output": it["text"], "kind": it["kind"]}) + "\n")
            n += 1
            if n % 50 == 0:
                print(f"[prep] flattened {n}/{len(items)}")
    print(f"[prep] wrote {n} SFT pairs -> {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["targets", "flatten"], required=True)
    ap.add_argument("--n", type=int, default=3000)
    ap.add_argument("--model", default="llama3.1:8b")
    ap.add_argument("--filter_human", action="store_true",
                    help="(flatten) drop targets the local detector rates as AI-ish")
    ap.add_argument("--limit", type=int, default=0, help="(flatten) cap number of pairs")
    args = ap.parse_args()
    random.seed(0)
    if args.stage == "targets":
        stage_targets(args.n)
    else:
        stage_flatten(args.model, args.filter_human, args.limit)
