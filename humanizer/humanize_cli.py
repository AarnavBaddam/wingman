"""
humanize_cli.py — thin CLI bridge between the TypeWriter daemon and the
rule-based humaniser in humanizer.py.

Usage:
    python humanize_cli.py <input.txt> <output.txt> [level]

Reads UTF-8 text from <input.txt>, runs the local (no-API-key) rule-based
humanisation pipeline, and writes the result to <output.txt>. Prints a short
status line to stderr; the daemon reads the *file*, not stdout.

Exit codes:
    0  success
    2  bad arguments
    3  input file missing / empty
    4  pipeline error (missing spaCy model, etc.)
    5  the rewrite altered a quotation; the original text was written instead
"""
import sys
import os

# Make sure we can import humanizer.py sitting next to this script regardless
# of the current working directory the daemon launched us from.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _ensure_nltk():
    """Make sure the NLTK corpora the rule-based transforms need are present.

    Newer NLTK splits these into *_tab / *_eng resources; humanizer.py's own
    lazy fallback only grabs the legacy names. We check each with data.find()
    first and only hit the downloader for genuinely missing resources, so warm
    runs cost a few file-exists checks rather than a network round-trip."""
    import nltk
    resources = {
        "punkt": "tokenizers/punkt",
        "punkt_tab": "tokenizers/punkt_tab",
        "wordnet": "corpora/wordnet",
        "omw-1.4": "corpora/omw-1.4",
        "averaged_perceptron_tagger": "taggers/averaged_perceptron_tagger",
        "averaged_perceptron_tagger_eng": "taggers/averaged_perceptron_tagger_eng",
    }
    for pkg, path in resources.items():
        try:
            nltk.data.find(path)
        except LookupError:
            try:
                nltk.download(pkg, quiet=True)
            except Exception:
                pass


def _preserve_indentation(src: str, out: str) -> str:
    """Re-apply the source's paragraph indentation to the humanised output.

    The LLM/stealth rewrite emits clean paragraphs without the original leading tabs/
    spaces, so a tab-indented essay comes back flush-left. This detects the indent used at
    the start of the source's paragraphs and, if most paragraphs were indented, prepends the
    same indent to each output paragraph's first line."""
    import re
    from collections import Counter

    def para_indents(text):
        out_i, prev_blank = [], True
        for ln in text.split("\n"):
            if ln.strip() == "":
                prev_blank = True
                continue
            if prev_blank:
                m = re.match(r"^([ \t]+)", ln)
                out_i.append(m.group(1) if m else "")
            prev_blank = False
        return out_i

    src_i = para_indents(src)
    if not src_i:
        return out
    indented = [i for i in src_i if i]
    if len(indented) / len(src_i) < 0.5:      # source paragraphs aren't consistently indented
        return out
    indent = Counter(indented).most_common(1)[0][0]

    res, prev_blank = [], True
    for ln in out.split("\n"):
        if ln.strip() == "":
            res.append(ln); prev_blank = True; continue
        if prev_blank and not re.match(r"^[ \t]", ln):
            ln = indent + ln
        res.append(ln); prev_blank = False
    return "\n".join(res)


def _strip_ai_dashes(text: str) -> str:
    """Guaranteed final sweep: em-dashes are the single biggest AI tell, so remove every
    dash used as a dash — em/en/horizontal dashes, double hyphens, and spaced hyphens between
    words — replacing them with a comma. Hyphenated words ('well-known') are left intact."""
    import re
    text = re.sub(r"\s*[—–―]\s*", ", ", text)          # — – ― -> comma
    text = re.sub(r"(?<=\w)\s*--+\s*(?=\w)", ", ", text)              # -- as a dash
    text = re.sub(r"(?<=[A-Za-z]) - (?=[A-Za-z])", ", ", text)        # spaced hyphen dash
    text = re.sub(r",\s*,", ",", text)                                # collapse ", ,"
    text = re.sub(r"\s+([,.!?;:])", r"\1", text)                      # tidy space before punct
    return text


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: humanize_cli.py <input.txt> <output.txt> [level]", file=sys.stderr)
        return 2

    in_path, out_path = sys.argv[1], sys.argv[2]
    try:
        level = float(sys.argv[3]) if len(sys.argv) > 3 else 0.8
    except ValueError:
        level = 0.8
    level = max(0.0, min(1.0, level))

    if not os.path.exists(in_path):
        print(f"input not found: {in_path}", file=sys.stderr)
        return 3

    with open(in_path, "r", encoding="utf-8") as f:
        text = f.read()

    if not text.strip():
        print("input is empty", file=sys.stderr)
        return 3

    _ensure_nltk()

    # Freeze quotations for every engine below; restored byte-for-byte at the end.
    from stealth_humanizer import freeze_quotes, thaw_quotes
    original = text
    text, quotes = freeze_quotes(text)

    def finish(humanised: str, label: str) -> int:
        humanised = _strip_ai_dashes(humanised)
        humanised = _preserve_indentation(original, humanised)
        restored = thaw_quotes(humanised, quotes)
        if restored is None:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(original)
            print("quotes-changed: the rewrite lost or altered a quotation; original kept", file=sys.stderr)
            return 5
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(restored)
        print(f"ok ({label}): {len(original)} -> {len(restored)} chars", file=sys.stderr)
        return 0

    # STEALTH mode: use the fine-tuned local model (humanizer-local) via best-of-N direct
    # invocation (train/*, stealth_humanizer.direct_humanise). This is the trained-model path;
    # it passes O1 (facts) + O3 (undetectable) far better than the rule/LLM pipeline. Falls
    # through to the rule/LLM pipeline if the model or Ollama isn't available.
    if os.environ.get("HUMANIZE_MODE", "").strip().lower() == "stealth":
        try:
            # Vendored into Aether: stealth_humanizer, humanizer and train/ all sit
            # beside this file. Only the script's own directory goes on sys.path — do
            # NOT inject a parent directory (untrusted module search path).
            _here = os.path.dirname(os.path.abspath(__file__))
            if _here not in sys.path:
                sys.path.insert(0, _here)
            # PROMOTED 2026-07-14 as "Config C": the fine-tuned model path (direct_humanise) was proven
            # USELESS against real ZeroGPT (100%, = raw). The rule pipeline (stealth_humanise:
            # burstiness+perplexity) is the ONLY path that moves real ZeroGPT (~20% on the testset).
            # It is the default stealth engine now. Config C is aggressive and SLOW (minutes/essay);
            # HumanizerBridge's kill timeout was raised to 600s to accommodate it. Override any default
            # via env (e.g. HUMANIZE_STEALTH_ENGINE=model to revert to the old fine-tuned path).
            os.environ.setdefault("STEALTH_LLM_MODEL", "llama3.1:8b")
            os.environ.setdefault("INKSPLASH_SCORE_MODE", "real")
            os.environ.setdefault("INKSPLASH_BURST_MINWORDS", "14")
            os.environ.setdefault("INKSPLASH_BURST_W", "3.0")
            os.environ.setdefault("INKSPLASH_PPL_CAP", "120")
            os.environ.setdefault("INKSPLASH_REFINE_TOPK", "6")
            os.environ.setdefault("INKSPLASH_CANDIDATES", "12")
            os.environ.setdefault("INKSPLASH_REFINE", "12")
            # Meaning guards (MiniLM cosine): drop rewrites that drift from the source.
            os.environ.setdefault("INKSPLASH_SEM_MIN", "0.80")
            os.environ.setdefault("INKSPLASH_DOC_SEM_MIN", "0.85")
            engine = os.environ.get("HUMANIZE_STEALTH_ENGINE", "rule").strip().lower()
            model = os.environ.get("HUMANIZE_LLM_MODEL", "humanizer-local")
            if engine == "rule":
                from stealth_humanizer import stealth_humanise
                cand = int(os.environ.get("INKSPLASH_CANDIDATES", "12"))
                refine = int(os.environ.get("INKSPLASH_REFINE", "12"))
                humanised = stealth_humanise(text, candidates=cand, refine_sentences=refine)
                model = f"rule/{os.environ.get('STEALTH_LLM_MODEL', 'llama3.1:8b')}"
            else:
                from stealth_humanizer import direct_humanise
                humanised = direct_humanise(text, model=model)
            if humanised and humanised.strip():
                return finish(humanised, f"stealth/{model}")
            print("stealth produced empty output; falling back to pipeline", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            if type(e).__name__ == "ModelMissing":     # say so; never "humanise" by returning the input
                print(f"humanise error: {e}", file=sys.stderr)
                return 4
            print(f"stealth humanise unavailable, falling back: {e}", file=sys.stderr)

    try:
        from humanizer import HumaniserConfig, HumaniserPipeline
        # LLM (OpenRouter) is on by default; it auto-falls back to the rule-based
        # pipeline if the model is unavailable/rate-limited. Set HUMANIZE_USE_LLM=0
        # to force the rule-based path.
        use_llm = os.environ.get("HUMANIZE_USE_LLM", "1") != "0"
        # PROFESSIONAL mode (default): preserve length + formal college-level register
        # and vocabulary. Set HUMANIZE_PROFESSIONAL=0 for the old max-evasion casual
        # path (lowest detector score, but reads informal and can shorten the text).
        professional = os.environ.get("HUMANIZE_PROFESSIONAL", "1") != "0"
        config = HumaniserConfig(humanise_level=level, use_llm=use_llm,
                                 candidates=10, professional=professional)
        pipeline = HumaniserPipeline(config)
        humanised = pipeline.process(text)
    except Exception as e:  # noqa: BLE001 - surface any pipeline failure to the daemon
        print(f"humanise error: {e}", file=sys.stderr)
        return 4

    return finish(humanised, f"level={level}")


if __name__ == "__main__":
    sys.exit(main())
