"""
stealth_humanizer.py — local "undetectable AI" humaniser.

Replicates the core method paid humanisers use (StealthGPT / Undetectable AI style),
entirely on this machine:

  1. Rewrite the essay with a local LLM (Ollama) using a prompt tuned for HIGH
     burstiness (wildly uneven sentence length) + HIGH perplexity (specific, less
     predictable vocabulary) while staying collegiate — never dumbed down.
  2. Generate N candidates and score each with a LOCAL proxy — GPT-2 perplexity +
     sentence-length burstiness — which is what detectors actually key on. Keep the
     best. (This is the "internal detector" multi-pass, but offline and instant.)
  3. Targeted second pass: find the remaining most-predictable (low-perplexity)
     sentences and rewrite ONLY those to raise perplexity, accepting a change only
     if the local score improves and the facts/length are preserved.

Research basis: detectors flag low perplexity + low burstiness (predictable, uniform
prose). Raising both — via richer wording and uneven rhythm, not simpler words —
lowers detection while keeping quality. Paraphrasing/rhythm attacks (e.g. DIPPER)
drop detector accuracy sharply with minimal meaning change.

The GPT-2 scorer is loaded lazily so importing this module stays cheap.
"""
import os
import re
import sys
import requests

OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1").rsplit("/v1", 1)[0]
STEALTH_MODEL = os.environ.get("STEALTH_LLM_MODEL", "llama3.1:8b")


# ─────────────────────────────────────────────────────────────────────────────
#  Local detector proxy: GPT-2 perplexity + burstiness
# ─────────────────────────────────────────────────────────────────────────────
class StealthScorer:
    _tok = None
    _model = None
    _device = None
    _ppl_cache: dict = {}      # text -> perplexity; refine passes re-score the same sentences dozens
                               # of times, so caching collapses the dominant cost of the refine stage.

    @classmethod
    def _load(cls):
        if cls._model is None:
            import torch
            from transformers import GPT2LMHeadModel, GPT2TokenizerFast
            # Default the small scoring model to CPU so the GPU stays free for the
            # Ollama LLM (avoids VRAM contention / model eviction). Override with
            # SCORE_DEVICE=cuda if you have headroom.
            cls._device = os.environ.get("SCORE_DEVICE", "cpu")
            if cls._device == "cuda" and not torch.cuda.is_available():
                cls._device = "cpu"
            cls._tok = GPT2TokenizerFast.from_pretrained("gpt2")
            cls._model = GPT2LMHeadModel.from_pretrained("gpt2").to(cls._device).eval()

    @classmethod
    def perplexity(cls, text: str) -> float:
        """Mean GPT-2 perplexity. Higher = less predictable = more human-looking.

        Memoized: the refine stage re-ranks every sentence by perplexity on each pass and
        re-scores the essay after each swap, recomputing identical sentence perplexities many
        times. Caching by exact text makes pass 2+ ranking near-free with zero effect on the
        scores chosen (same values, just not recomputed)."""
        cached = cls._ppl_cache.get(text)
        if cached is not None:
            return cached
        cls._load()
        import torch
        ids = cls._tok(text, return_tensors="pt", truncation=True, max_length=1024
                       ).input_ids.to(cls._device)
        if ids.size(1) < 2:
            return 0.0
        with torch.no_grad():
            loss = cls._model(ids, labels=ids).loss
        val = float(torch.exp(loss))
        if len(cls._ppl_cache) > 4000:      # bound memory across a long/batch run
            cls._ppl_cache.clear()
        cls._ppl_cache[text] = val
        return val

    @staticmethod
    def sentences(text: str):
        return [s for s in re.split(r"(?<=[.!?])\s+", re.sub(r"[ \t]+", " ", text)) if s.strip()]

    @classmethod
    def burstiness(cls, text: str) -> float:
        """Coefficient of variation of sentence lengths. Higher = more human."""
        lengths = [len(s.split()) for s in cls.sentences(text)]
        if len(lengths) < 2:
            return 0.0
        mean = sum(lengths) / len(lengths)
        var = sum((x - mean) ** 2 for x in lengths) / len(lengths)
        return (var ** 0.5) / mean if mean else 0.0

    @classmethod
    def score(cls, text: str) -> float:
        """Combined 'looks human' objective (higher = better).

        If the local RoBERTa detector is available (train/local_detector.py) it is the
        PRIMARY signal — we directly minimise its AI-probability, which tracks ZeroGPT
        without the rate limit. Burstiness (quality-neutral) and a capped perplexity
        reward supplement it. Falls back to burstiness+perplexity only if the detector
        can't load."""
        burst = cls.burstiness(text)
        ppl = cls.perplexity(text)
        # 2026-07-14: the roberta proxy was shown NOT to track real ZeroGPT (local.md A0), but
        # burstiness + GPT-2 perplexity DO (rule pipeline halved real ZeroGPT 100%->55% while
        # raising both). SCORE_MODE=real selects on those detector-agnostic levers ONLY and drops
        # the invalid proxy term; higher perplexity cap so genuinely bursty/high-ppl drafts win.
        if os.environ.get("INKSPLASH_SCORE_MODE", "proxy") == "real":
            bw = float(os.environ.get("INKSPLASH_BURST_W", "3.2"))
            pcap = float(os.environ.get("INKSPLASH_PPL_CAP", "80.0"))
            return bw * burst + min(ppl, pcap) / 22.0
        base = 2.6 * burst + min(ppl, 34.0) / 45.0
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from train.local_detector import LocalDetector
            ai = LocalDetector.ai_prob_chunked(text)      # 0..100, lower is better
            return base + (100.0 - ai) / 12.0             # detector dominates selection
        except Exception:
            return base


# ─────────────────────────────────────────────────────────────────────────────
#  LLM helpers (Ollama)
# ─────────────────────────────────────────────────────────────────────────────
_PREAMBLE_RE = re.compile(
    r"^\s*(here('?s| is)|sure|certainly|below is|the following|i(?:'ve| have) rewritten|"
    r"here you go)\b[^\n]*:?\s*\n+", re.IGNORECASE)


def _clean(text: str) -> str:
    """Strip a leaked LLM preamble line and normalise AI-tell punctuation."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)   # Qwen3 thinking guard
    text = _PREAMBLE_RE.sub("", text.strip())
    # em/en dashes -> comma (the single biggest punctuation tell); smart quotes/ellipsis
    text = re.sub(r"\s*[—–]\s*", ", ", text)
    text = re.sub(r",\s*,", ",", text)
    text = (text.replace("‘", "'").replace("’", "'")
                .replace("“", '"').replace("”", '"').replace("…", "...")
                .replace("�", ""))
    return text.strip()


# Quotations are frozen behind [[Qn: words]] markers for the whole rewrite and restored
# byte-for-byte by number afterwards (user rule 2026-10-23: the humaniser never edits a
# quote). The words stay visible so the model does not guess and paraphrase a hidden
# quote; anything it changes inside a marker is thrown away on restore.
# ponytail: single-quoted spans are not frozen; they collide with apostrophes.
_QUOTE_RE = re.compile(r'“[^”\n]*”|"[^"\n]*"')
_MARK_RE = re.compile(r"\[\[Q(\d+)(?::[^\[\]]*)?\]\]")
_MARK_RULE = (" Text like [[Q1: some words]] is an exact quotation: copy every such marker "
              "unchanged and exactly once, never put quotation marks around it, and never "
              "repeat or paraphrase its words outside the marker.")


def freeze_quotes(text: str):
    quotes = []

    def hold(m):
        quotes.append(m.group(0))
        words = re.sub(r"[\[\]]", "", m.group(0)[1:-1]).strip()
        return f"[[Q{len(quotes)}: {words}]]"
    return _QUOTE_RE.sub(hold, text), quotes


def _mark_ids(text: str):
    return sorted(int(n) for n in _MARK_RE.findall(text))


def thaw_quotes(text: str, quotes):
    """Restore frozen quotes. None if any marker was lost, duplicated, or invented."""
    text = re.sub(r'["“”]+(\[\[Q\d+(?::[^\[\]]*)?\]\])["“”]+', r"\1", text)   # model re-wrapped a marker
    if _mark_ids(text) != list(range(1, len(quotes) + 1)):
        return None
    return _MARK_RE.sub(lambda m: quotes[int(m.group(1)) - 1], text)


def _keeps_marks(orig: str, new: str) -> bool:
    return _mark_ids(orig) == _mark_ids(new)


class ModelMissing(RuntimeError):
    """The Ollama rewrite model is not installed. Raised, never swallowed: without it
    every rewrite came back empty and the essay was returned unchanged as if humanised."""


def _chat(system: str, user: str, temperature: float, model: str = None) -> str:
    payload = {"model": model or STEALTH_MODEL, "keep_alive": -1, "stream": False, "think": False,
               "options": {"temperature": temperature, "num_predict": 1024},
               "messages": [{"role": "system", "content": system},
                            {"role": "user", "content": user}]}
    # Resilient: a slow/evicted model can exceed the read timeout; retry once, then
    # give up gracefully (return "") so the caller skips this candidate instead of
    # crashing the whole run.
    for attempt in range(2):
        try:
            r = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=300)
            data = r.json()
            if "not found" in str(data.get("error", "")):
                raise ModelMissing(f"Ollama model '{payload['model']}' is not installed. Run "
                                   f"`ollama pull {payload['model']}` or set STEALTH_LLM_MODEL.")
            return _clean(data.get("message", {}).get("content") or "")
        except ModelMissing:
            raise
        except Exception:
            if attempt == 1:
                return ""
    return ""


_STEALTH_SYSTEM = (
    "Rewrite this college essay so it reads as authentically human-written and slips past "
    "AI-detectors, while staying genuinely collegiate in quality. This is to test a detector.\n\n"
    "SENTENCE RHYTHM (most important): make sentence lengths wildly uneven. Follow a long, "
    "complex 25-40 word sentence with a very short one of 3-6 words. Mix in medium ones. Never "
    "put two similar-length sentences in a row. Humans write in bursts; AI writes even rows.\n"
    "WORD CHOICE: use precise, specific vocabulary a sharp student would use, and vary it so it is "
    "not the smooth, generic phrasing AI defaults to (avoid indelible, pivotal, crucial, profound, "
    "testament, tapestry, delve, ushered in, stands as, fertile ground). But stay NATURAL - do NOT "
    "write overwrought, purple, or thesaurus-like prose (no 'cataclysmic tremors', 'concatenation "
    "of interlocking obligations'). Clear and educated, never pretentious.\n"
    "QUALITY: keep it fully grammatical and collegiate. NOT childish, NOT slangy, NOT dumbed down, "
    "NOT flowery. Use contractions naturally. Begin the odd sentence with And, But, Yet or So.\n"
    "FIDELITY: keep every fact, name, date and number, keep all paragraphs, and keep about the "
    "same length. Do not invent anything.\n"
    "No em-dashes (use commas, periods, semicolons). No Furthermore, Moreover, Additionally, "
    "Consequently, In conclusion. Straight quotes only. Output ONLY the rewritten essay." + _MARK_RULE
)

_SENTENCE_FIX = (
    "Reword this single sentence so its phrasing is less predictable and more distinctive, using "
    "richer, more specific vocabulary a well-read person would choose. Keep the EXACT meaning, all "
    "facts/names/numbers, and a formal collegiate register. Do not simplify, do not add or drop "
    "information, do not add commentary. Output ONLY the reworded sentence." + _MARK_RULE
)

_SENTENCE_SPLIT = (
    "Split this ONE long sentence into two or three grammatically COMPLETE sentences of very "
    "different lengths (make at least one short, 3-7 words). Every sentence must have a subject and "
    "a verb - no fragments. Keep the exact meaning, all facts, names and numbers, and a formal "
    "collegiate tone. Output ONLY the rewritten sentences, nothing else." + _MARK_RULE
)

# spaCy is used to *guarantee* grammar: a split is accepted only if every resulting
# sentence has a subject and a finite verb (i.e. no fragments). Loaded lazily.
_NLP = None


def _nlp():
    global _NLP
    if _NLP is None:
        import spacy
        _NLP = spacy.load("en_core_web_sm")
    return _NLP


def _is_sentence(s: str) -> bool:
    doc = _nlp()(s)
    has_subj = any(t.dep_ in ("nsubj", "nsubjpass", "expl") for t in doc)
    has_verb = any(t.pos_ in ("VERB", "AUX") for t in doc)
    return has_subj and has_verb


def _fragments(text: str) -> int:
    return sum(0 if _is_sentence(s) else 1 for s in StealthScorer.sentences(text))


def _burst_split(text: str, min_words: int = 17) -> str:
    """Raise burstiness by asking the LLM to split each long sentence into shorter,
    length-varied, grammatically complete sentences — the single biggest detector
    lever. Each rewrite is accepted only if spaCy finds NO fragments and every number
    in the original survives, so grammar and facts are preserved."""
    min_words = int(os.environ.get("INKSPLASH_BURST_MINWORDS", min_words))
    out = []
    for para in text.split("\n"):
        if not para.strip():
            out.append(para)
            continue
        pieces = []
        for s in StealthScorer.sentences(para):
            if len(s.split()) >= min_words:
                r = _chat(_SENTENCE_SPLIT, s, temperature=0.7).strip().strip('"')
                nums_ok = all(n in r for n in re.findall(r"\b\d[\d,]*\b", s))
                _sem_min = float(os.environ.get("INKSPLASH_SEM_MIN", "0"))
                sem_ok = _sem_min <= 0 or _sem_sim(s, r) >= _sem_min
                if r and nums_ok and sem_ok and _keeps_marks(s, r) and _fragments(r) == 0 and len(r) >= 0.7 * len(s):
                    pieces.append(r)
                    continue
            pieces.append(s)
        out.append(" ".join(pieces))
    return "\n".join(out)


# ─────────────────────────────────────────────────────────────────────────────
#  Fact-preservation guard
# ─────────────────────────────────────────────────────────────────────────────
def _facts(text: str):
    """Numbers, years and Capitalised proper nouns that must survive a rewrite."""
    nums = set(re.findall(r"\b\d[\d,]*\b", text))
    props = set(re.findall(r"\b[A-Z][a-zA-Z]+\b", text))
    return nums, props


def _keeps_facts(orig: str, new: str) -> bool:
    if not _keeps_marks(orig, new):             # a lost/duplicated quote marker is a hard fail
        return False
    onums, oprops = _facts(orig)
    nnums, nprops = _facts(new)
    if not onums <= nnums:                      # every number must still be present
        return False
    missing = oprops - nprops
    return len(missing) <= max(1, len(oprops) // 6)   # allow tiny proper-noun drift


# ─────────────────────────────────────────────────────────────────────────────
#  Main entry
# ─────────────────────────────────────────────────────────────────────────────
def _fact_score(src: str, out: str) -> float:
    """Fraction of numbers + named-ish tokens in src preserved in out (0..1)."""
    def f(t):
        return (set(re.findall(r"\b\d[\d,\.]*\b", t)),
                set(w for w in re.findall(r"\b[A-Z][a-zA-Z]+\b", t)))
    sn, sp = f(src); on, op = f(out)
    tot = len(sn) + len(sp)
    return ((len(sn & on) + len(sp & op)) / tot) if tot else 1.0


# ─────────────────────────────────────────────────────────────────────────────
#  Fidelity guards (2026-07-14): the rule pipeline had NO semantic/thesis guard and NO
#  fact-restoration, so the aggressive perplexity rewording that beats REAL ZeroGPT was
#  drifting facts (O1) and the thesis (O2). These add both, cheaply (MiniLM on CPU).
# ─────────────────────────────────────────────────────────────────────────────
_EMB = None


def _emb():
    global _EMB
    if _EMB is None:
        from sentence_transformers import SentenceTransformer
        _EMB = SentenceTransformer("all-MiniLM-L6-v2", device="cpu")
    return _EMB


def _sem_sim(a: str, b: str) -> float:
    """MiniLM cosine similarity; 1.0 if embeddings unavailable (guard becomes a no-op)."""
    try:
        import numpy as np
        va, vb = _emb().encode([a, b], normalize_embeddings=True)
        return float(np.dot(va, vb))
    except Exception as e:
        global _SEM_WARNED
        if not _SEM_WARNED:
            _SEM_WARNED = True
            sys.stderr.write(f"[stealth] meaning guard OFF, embeddings unavailable: {e}\n")
        return 1.0


_SEM_WARNED = False


def _restore_facts(src: str, best: str, model: str = None) -> str:
    """Weave back exact numbers + named entities present in the source but missing from the
    rewrite. Accept a pass only if it strictly raises fact retention (never worsens style/O3
    because it changes nothing else). Ported from direct_humanise so the rule pipeline also
    protects O1 on fact-dense science (blackholes dropped to 0.71 without this)."""
    facts = set(re.findall(r"\b\d[\d,\.]*\b", src)) | set(re.findall(r"\b[A-Z]{2,}\b", src))
    try:
        for e in _nlp()(src).ents:
            toks = re.findall(r"[A-Za-z]+", e.text)
            if e.label_ in ("PERSON", "ORG", "GPE", "LOC", "EVENT", "FAC", "PRODUCT") \
                    and toks and all(t[0].isupper() or t.isupper() for t in toks):
                facts.add(e.text)
    except Exception:
        pass
    for _pass in range(2):
        missing = [x for x in facts if x and x not in best]
        if not missing or len(missing) > 18:
            break
        fix_sys = ("Revise the passage so it includes these exact terms from the original, which "
                   "are currently missing: " + "; ".join(sorted(missing)) + ". Weave each in "
                   "naturally, change nothing else, keep the same style and length. Output only "
                   "the revised passage." + _MARK_RULE)
        fixed = _chat(fix_sys, best, temperature=0.4, model=model)
        if fixed and 0.75 <= len(fixed) / max(1, len(src)) <= 1.4 and _keeps_marks(best, fixed) \
                and _fact_score(src, fixed) > _fact_score(src, best):
            best = fixed
        else:
            break
    return best


def direct_humanise(text: str, model: str = None, instruction: str = None,
                    candidates: int = 8) -> str:
    """Humanise with a FINE-TUNED model using its OWN training prompt, and pick the best of
    N drafts by the local detector — the paid-service 'internal detector multi-pass', but
    with the correct prompt so the model doesn't over-generate. Single-pass output has huge
    variance (one draw of the WWI essay measured 28%, another 98%); scoring N drafts with
    train/local_detector and keeping the lowest-AI one that preserves facts + length makes it
    consistent. Selection minimises  detector_AI% + fact-drop penalty, with a small length
    guard; early-exits once a draft is clearly human (<12%)."""
    # Candidate count is env-tunable: more drafts reduce best-of-N variance (the chance that
    # NO draft in the pool is simultaneously low-detector + thesis-preserving + vocab-rich),
    # at a proportional cost in generation time. Default keeps the caller's value.
    try:
        candidates = int(os.environ.get("INKSPLASH_CANDIDATES", candidates))
    except Exception:
        pass
    if instruction is None:
        try:
            from train.prep_data import INSTRUCTION as instruction
        except Exception:
            instruction = ("Rewrite the text so it reads as authentically human-written and "
                           "would not be flagged by an AI detector, while keeping it polished. "
                           "Keep every fact, name, date, number and the thesis exactly; do not "
                           "drop or reframe information. Output only the rewritten text.")
    m = model or STEALTH_MODEL
    n = int(len(text.split()) * 1.4) + 48        # cap generation near source length
    try:
        import os as _os, sys as _sys
        _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
        from train.local_detector import LocalDetector
        detect = LocalDetector.ai_prob_chunked
    except Exception:
        detect = None

    def _difficult_rate(t):
        try:
            import textstat
            w = len(re.findall(r"[A-Za-z']+", t)) or 1
            return textstat.difficult_words(t) / w * 100.0
        except Exception:
            return 0.0

    def _mean_word_len(t):
        w = re.findall(r"[A-Za-z']+", t)
        return sum(len(x) for x in w) / max(1, len(w))
    # Vocabulary-selection weights (env-tunable; defaults preserve the original behaviour so the
    # live SFT model is unchanged). Boosting these lets best-of-N recover O4 on DPO-tuned models
    # whose thesis is already protected at the training level.
    _VW = float(os.environ.get("INKSPLASH_VOCAB_W", "2.5"))
    _MW = float(os.environ.get("INKSPLASH_MWL_W", "0.0"))
    _VX = float(os.environ.get("INKSPLASH_VOCAB_EXIT", "1.5"))
    # O3 is a HARD constraint, not just a cost term: never SELECT a draft whose detector
    # score is near/over the 30% target when a compliant draft exists. The vocab weighting
    # (INKSPLASH_VOCAB_W) can otherwise let a vocab-rich but more-detectable draft win the
    # combined cost (this is exactly what pushed wwi_essay to 31% on a DPO2 eval run). We
    # keep a margin below 30 so worst-case variance still lands under target.
    _AICAP = float(os.environ.get("INKSPLASH_AI_CAP", "25.0"))
    # Thesis-aware selection (env-gated, default OFF so the live SFT path is byte-for-byte unchanged).
    # The best-of-N cost is otherwise blind to O2 — with a low-detector but thesis-mangling draft in
    # the pool, nothing stops selection from picking it (the ~1/3-of-runs O2 miss). When enabled we
    # add (1 - thesis_similarity)*W using eval.py's EXACT metric, so we optimise the same signal O2 is
    # scored on. Kept as a moderate term (not a hard gate) to avoid the documented O2<->O4 whack-a-mole.
    _TW = float(os.environ.get("INKSPLASH_THESIS_W", "0"))
    _thsim = None
    if _TW > 0:
        try:
            from train.eval import thesis_similarity as _thsim
        except Exception:
            _thsim = None
    src_diff = _difficult_rate(text)

    best, best_cost, best_ai = None, 1e9, 100.0          # global fallback (min combined cost)
    best_ok, best_ok_cost = None, 1e9                    # min cost AMONG O3-compliant, fact-keeping drafts
    for i in range(max(1, candidates)):
        temp = 0.6 + 0.16 * i                     # spread drafts across temperatures
        payload = {"model": m, "keep_alive": -1, "stream": False, "think": False,
                   "options": {"temperature": temp, "num_predict": n},
                   "messages": [{"role": "system", "content": instruction},
                                {"role": "user", "content": text}]}
        try:
            r = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=180)
            out = _clean(r.json().get("message", {}).get("content") or "")
        except Exception:
            continue
        if not out or not (0.7 <= len(out) / max(1, len(text)) <= 1.4):
            continue
        fact = _fact_score(text, out)
        ai = detect(out) if detect else (0.0 if _keeps_facts(text, out) else 50.0)
        vocab_drop = max(0.0, src_diff - _difficult_rate(out))   # simplified vocabulary = penalty
        mwl_drop = max(0.0, _mean_word_len(text) - _mean_word_len(out))
        th_drop = (1.0 - _thsim(text, out)) if _thsim else 0.0    # thesis loss (O2), 0 when disabled
        # Objective-weighted: minimise detection, keep facts, don't dumb down vocabulary.
        # NB: the thesis term is deliberately NOT in this global fallback cost — a 2026-07-14 eval
        # showed that putting it here lets the fallback pick a high-detector draft for its thesis
        # (O3 regressed to 35%). It belongs ONLY in the tier-1 (O3-compliant) pool below, as a
        # tie-breaker that can never override the detector cap.
        cost = ai + (1.0 - fact) * 120.0 + vocab_drop * _VW + mwl_drop * _MW
        if cost < best_cost:
            best, best_cost, best_ai = out, cost, ai
        # Tier-1 pool: only drafts that clear the O3 cap AND keep facts compete on vocab+thesis cost.
        if ai <= _AICAP and fact >= 0.85:
            ok_cost = (1.0 - fact) * 120.0 + vocab_drop * _VW + mwl_drop * _MW + ai * 0.15 + th_drop * _TW
            if ok_cost < best_ok_cost:
                best_ok, best_ok_cost = out, ok_cost
        if ai < 12.0 and fact >= 0.95 and vocab_drop <= _VX:    # human, faithful, vocab kept
            break
    # Prefer the best O3-compliant, fact-keeping draft; fall back to global min-cost only if none.
    if best_ok is not None:
        best, best_ai = best_ok, best_ai
    if best is None:
        return text

    # ── Fact-restoration (targets O1 on fact-dense scientific text) ───────────
    # Find exact numbers AND named entities (proper nouns / acronyms, via spaCy) present in
    # the source but missing from the chosen draft, and ask the model to weave them back.
    # Keep the revision only if it raises fact retention AND stays undetectable (<30%).
    facts = set(re.findall(r"\b\d[\d,\.]*\b", text)) | set(re.findall(r"\b[A-Z]{2,}\b", text))
    try:
        import spacy
        _nlp = globals().setdefault("_SPACY", spacy.load("en_core_web_sm"))
        for e in _nlp(text).ents:
            toks = re.findall(r"[A-Za-z]+", e.text)
            if e.label_ in ("PERSON", "ORG", "GPE", "LOC", "EVENT", "FAC", "PRODUCT") \
                    and toks and all(t[0].isupper() or t.isupper() for t in toks):
                facts.add(e.text)
    except Exception:
        pass
    # Loop the restoration up to 2 passes so VERY fact-dense science (e.g. ~15 named facts) can
    # recover in stages — a single pass with a >10-term list tended to leave residue, which is
    # what left O1 at ~0.93 on some blackholes/photosynthesis draws. Each pass re-computes the
    # still-missing terms and is accepted only if it strictly raises fact retention AND keeps the
    # detector under the O3 cap, so O1 can never be bought at the expense of O3.
    _o3cap = float(os.environ.get("INKSPLASH_AI_CAP", "25.0"))
    for _pass in range(2):
        missing = [x for x in facts if x and x not in best]
        if not missing or len(missing) > 18:
            break
        fix_sys = ("Revise the passage so it includes these exact terms from the original, which "
                   "are currently missing: " + "; ".join(sorted(missing)) + ". Weave each in "
                   "naturally, change nothing else, keep the same style and length. Output only "
                   "the revised passage." + _MARK_RULE)
        try:
            r = requests.post(f"{OLLAMA_URL}/api/chat", timeout=180, json={
                "model": m, "keep_alive": -1, "stream": False, "think": False,
                "options": {"temperature": 0.4, "num_predict": n},
                "messages": [{"role": "system", "content": fix_sys},
                             {"role": "user", "content": best}]})
            fixed = _clean(r.json().get("message", {}).get("content") or "")
        except Exception:
            fixed = ""
        if fixed and 0.75 <= len(fixed) / max(1, len(text)) <= 1.4 and _keeps_marks(best, fixed) \
                and _fact_score(text, fixed) > _fact_score(text, best) \
                and (detect is None or detect(fixed) < _o3cap):
            best = fixed
        else:
            break   # no accepted improvement → further passes won't help
    return best


def stealth_humanise(text: str, candidates: int = 6, refine_sentences: int = 4,
                     verbose: bool = False) -> str:
    """Return the most human-looking rewrite of `text` per the local proxy."""
    temps = [0.85, 0.9, 0.8, 0.95, 0.88, 1.0, 0.82, 0.92]
    # Early-exit thresholds: once a fact-keeping draft saturates the perplexity cap (the dominant
    # real-ZeroGPT lever) AND has strongly human sentence-length variance, extra drafts can't beat
    # it on the axes detectors key on — so we stop generating. This cuts the candidate stage (often
    # the single biggest cost) with NO detection penalty, since the kept draft already maxes both
    # levers. Tunable; set INKSPLASH_EXIT_BURST very high to disable.
    _exit_pcap = float(os.environ.get("INKSPLASH_PPL_CAP", "80.0"))
    _exit_burst = float(os.environ.get("INKSPLASH_EXIT_BURST", "0.55"))
    # Plateau early-exit is OFF by default: trimming the candidate pool weakens best-of-N and can
    # let a worse (more detectable) draft win on a bad draw — a 2026-07-16 deployed run stopped early
    # and scored 69% real ZeroGPT. The user's hard rule is "cut runtime WITHOUT raising the AI score",
    # so by default we keep the FULL candidate pool (identical selection to pre-optimization) and take
    # the runtime win purely from the safe perplexity memoization. Opt in for speed via env.
    _min_cands = int(os.environ.get("INKSPLASH_MIN_CANDS", "5"))       # explore at least this many
    _patience = int(os.environ.get("INKSPLASH_CAND_PATIENCE", "999"))  # 999 => plateau exit disabled
    best, best_rank = None, -1e9
    produced = since_improve = 0
    for i in range(max(1, candidates)):
        cand = _chat(_STEALTH_SYSTEM, text, temperature=temps[i % len(temps)])
        # FIDELITY GUARDS (protect O1/O2): reject candidates that compressed too far,
        # ballooned (a rambling/hallucinating small model), or dropped facts.
        if not cand or not (0.75 * len(text) <= len(cand) <= 1.30 * len(text)):
            continue
        if not _keeps_marks(text, cand):
            continue
        # Meaning guard. ponytail: MiniLM reads only the first ~256 tokens of each text;
        # compare per paragraph if long essays drift late.
        _doc_min = float(os.environ.get("INKSPLASH_DOC_SEM_MIN", "0"))
        if _doc_min > 0 and _sem_sim(text, cand) < _doc_min:
            continue
        sc = StealthScorer.score(cand)
        len_ratio = min(len(cand) / len(text), 1.10)
        keeps = _keeps_facts(text, cand)
        rank = sc + 0.8 * len_ratio + (5.0 if keeps else 0.0)   # fact-preservation dominates
        cand_burst = StealthScorer.burstiness(cand)
        if verbose:
            sys.stderr.write(f"[stealth] cand {i}: rank={rank:.2f} score={sc:.2f} "
                             f"keeps_facts={keeps} burst={cand_burst:.2f} "
                             f"len={len(cand)} ({len_ratio:.0%})\n")
        produced += 1
        if rank > best_rank:
            best, best_rank = cand, rank
            since_improve = 0
        else:
            since_improve += 1
        # (a) Saturation exit: this draft already maxes both detector levers -> stop (no penalty).
        # perplexity(cand) is memoized from score() above, so this check is ~free.
        if keeps and cand_burst >= _exit_burst and StealthScorer.perplexity(cand) >= _exit_pcap:
            if verbose:
                sys.stderr.write(f"[stealth] saturation early-exit at cand {i}\n")
            break
        # (b) Diminishing-returns exit: we keep the SAME best draft, so the AI score is unchanged;
        # we just stop paying for more drafts once the best has plateaued for `patience` in a row.
        if produced >= _min_cands and since_improve >= _patience:
            if verbose:
                sys.stderr.write(f"[stealth] plateau early-exit at cand {i} "
                                 f"({since_improve} without improvement)\n")
            break
    if best is None:
        # Every candidate violated the guards — return the source unchanged rather than
        # ship a fact-dropping rewrite (O1/O2 outrank O3 when they conflict).
        return text

    # ── Burstiness pass: grammatical sentence splitting (biggest lever) ───────
    burst = _burst_split(best)
    if StealthScorer.score(burst) >= StealthScorer.score(best):
        best = burst

    # ── Targeted second pass: rewrite the most-predictable sentences ──────────
    # Perplexity is the dominant real-ZeroGPT lever (2026-07-14: ppl 120->17%, ppl 45->37%),
    # so rewrite the top-K lowest-perplexity (most AI-like) sentences each pass and KEEP every
    # improving rewrite (not just the first) to drive average perplexity up further on the
    # harder long/scientific essays. INKSPLASH_REFINE_TOPK tunes how many per pass.
    topk = int(os.environ.get("INKSPLASH_REFINE_TOPK", "3"))
    for _ in range(max(0, refine_sentences)):
        sents = StealthScorer.sentences(best)
        if len(sents) < 4:
            break
        # rank by perplexity ascending; the lowest-perplexity sentence is most AI-like
        ranked = sorted(sents, key=lambda s: StealthScorer.perplexity(s))
        improved = False
        for target in ranked[:topk]:
            if len(target.split()) < 6:
                continue
            reworded = _chat(_SENTENCE_FIX, target, temperature=1.0)
            reworded = reworded.strip().strip('"')
            _sem_min = float(os.environ.get("INKSPLASH_SEM_MIN", "0"))
            if not reworded or reworded == target or not _keeps_facts(target, reworded) \
                    or (_sem_min > 0 and _sem_sim(target, reworded) < _sem_min):
                continue
            trial = best.replace(target, reworded, 1)
            if StealthScorer.score(trial) > StealthScorer.score(best):
                best = trial
                improved = True
        if not improved:
            break
    # ── Fact-restoration (O1): weave back any numbers/entities the rewrite dropped ──
    best = _restore_facts(text, best)
    return best


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("infile"); ap.add_argument("outfile")
    ap.add_argument("-n", "--candidates", type=int, default=6)
    ap.add_argument("-r", "--refine", type=int, default=4)
    args = ap.parse_args()
    src = open(args.infile, encoding="utf-8").read()
    out = stealth_humanise(src, candidates=args.candidates, refine_sentences=args.refine, verbose=True)
    open(args.outfile, "w", encoding="utf-8").write(out)
    sys.stderr.write(f"[stealth] in {len(src)} -> out {len(out)} chars, "
                     f"final score={StealthScorer.score(out):.2f}\n")
