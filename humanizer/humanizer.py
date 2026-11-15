"""
AI Text Humaniser - Adversarial Testing Tool
This tool is intended solely for adversarial evaluation of AI text detectors
to help developers harden their models against circumvention.

v2 — Rewritten to (a) preserve document structure (paragraph breaks, blank
lines, leading indentation / tabs) instead of collapsing everything into one
block, and (b) actively *remove* common signatures of AI-generated prose
(cliche connectives, hedging boilerplate, em-dashes, curly quotes, uncontracted
forms, low burstiness) rather than only adding surface noise.

Pipeline stages (rule-based, no API key required):
    1. normalise_punctuation  — em/en dashes, smart quotes, ellipsis, spacing
    2. strip_ai_phrases       — delete/replace ~60 telltale AI phrases & openers
    3. apply_contractions     — "it is" -> "it's" etc. (AI avoids contractions)
    4. replace_synonyms       — conservative, curated swaps (no WordNet garbage)
    5. add_fillers            — sparse conversational discourse markers
    6. inject_typos           — occasional homophone slips
    7. vary_sentences         — split some long sentences to raise burstiness

Every stage operates line-by-line so newlines, blank lines and indentation
survive verbatim.
"""
import os
import random
import re
import string
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

try:
    import nltk
except Exception:  # nltk is optional for the core transforms
    nltk = None

try:
    import textstat
except Exception:
    textstat = None


@dataclass
class HumaniserConfig:
    humanise_level: float = 0.5  # 0.0 to 1.0
    use_llm: bool = False
    openai_api_key: Optional[str] = None
    typo_probability: float = 0.06
    filler_probability: float = 0.12
    synonym_probability: float = 0.18
    contraction_probability: float = 0.85
    sentence_split_probability: float = 0.25
    candidates: int = 6  # generate N variants, keep the burstiest (best-of-N)
    llm_model: Optional[str] = None  # None -> module default (OpenRouter free Llama)
    seed: Optional[int] = None
    # PROFESSIONAL mode (default): preserve full length + a formal, college-level
    # register and sophisticated vocabulary. Skips the quality-lowering transforms
    # (vocabulary downgrade, colloquial fillers, injected typos, comma splices) and
    # keeps only the quality-neutral ones (AI-cliche removal, em-dash/quote cleanup,
    # sentence-length variation). Set professional=False for the old max-evasion
    # "casual student" path that scores lowest on detectors but reads informal.
    professional: bool = True


# ─────────────────────────────────────────────────────────────────────────────
#  AI-signature data
# ─────────────────────────────────────────────────────────────────────────────

# Sentence-opening connectives that scream "LLM". Each maps to a pool of plainer
# human alternatives ("" means: delete the opener and re-capitalise the sentence).
_AI_OPENERS = {
    r"furthermore": ["Also", "And", "On top of that", "Plus"],
    r"moreover": ["Also", "And", "What's more", "Plus"],
    r"additionally": ["Also", "And", "On top of that"],
    r"in addition": ["Also", "And"],
    r"consequently": ["So", "As a result", "Because of that"],
    r"nevertheless": ["Still", "Even so", "That said"],
    r"nonetheless": ["Still", "Even so"],
    r"subsequently": ["Then", "After that", "Later"],
    r"in conclusion": ["In the end", "All in all", "So"],
    r"in summary": ["All in all", "So", "To sum up"],
    r"to summarise": ["All in all", "So"],
    r"to summarize": ["All in all", "So"],
    r"ultimately": ["In the end", "", "Finally"],
    r"notably": ["", "Interestingly"],
    r"importantly": ["", ""],
    r"firstly": ["First", "For one", "To start"],
    r"secondly": ["Second", "Then"],
    r"thirdly": ["Third", "Then"],
    r"lastly": ["Finally", "Last"],
    r"overall": ["All in all", "On the whole"],
}

# Mid-sentence phrase boilerplate → plainer wording (regex, case-insensitive).
# Order matters: longer phrases first so they win before their substrings.
_AI_PHRASES = [
    (r"\bit is important to note that\b", ""),
    (r"\bit'?s important to note that\b", ""),
    (r"\bit is worth noting that\b", ""),
    (r"\bit is important to (understand|remember|recognise|recognize) that\b", ""),
    (r"\bit should be noted that\b", ""),
    (r"\bneedless to say,?\s*", ""),
    (r"\bit goes without saying that\b", ""),
    (r"\bplays? an? (crucial|vital|pivotal|key|significant|important) role in\b", "matters in"),
    (r"\bplays? an? (crucial|vital|pivotal|key|significant|important) role\b", "matters"),
    (r"\ba testament to\b", "a sign of"),
    (r"\bdelve into\b", "look at"),
    (r"\bdelving into\b", "looking at"),
    (r"\bnavigat(e|ing) the complexities of\b", "dealing with"),
    (r"\bin the realm of\b", "in"),
    (r"\bin the world of\b", "in"),
    (r"\bin today'?s (world|society|era|age)\b", "today"),
    (r"\bin the modern (world|era|age)\b", "today"),
    (r"\bin an? (ever-?changing|fast-?paced) world\b", "these days"),
    (r"\bthe fact that\b", "that"),
    (r"\ba wide (range|array|variety) of\b", "many"),
    (r"\ba (variety|myriad|plethora|multitude) of\b", "many"),
    (r"\bwhen it comes to\b", "with"),
    (r"\bwith regard to\b", "about"),
    (r"\bwith respect to\b", "about"),
    (r"\bin order to\b", "to"),
    (r"\bdue to the fact that\b", "because"),
    (r"\bin light of the fact that\b", "because"),
    (r"\bfor the purpose of\b", "to"),
    (r"\bit is essential to\b", "you need to"),
    (r"\bit is crucial to\b", "you need to"),
    (r"\bserves? as a\b", "is a"),
    (r"\bfoster(s|ing)? a sense of\b", "build"),
    (r"\bharness(es|ing)? the power of\b", "use"),
    (r"\bunlock the potential of\b", "make the most of"),
    (r"\bshed light on\b", "explain"),
    (r"\bat the end of the day\b", "in the end"),
    (r"\bfirst and foremost\b", "first"),
    (r"\ba double-edged sword\b", "a trade-off"),
    (r"\bthe ever-(evolving|growing|changing)\b", "the changing"),
    (r"\bcutting-edge\b", "new"),
    (r"\bstate-of-the-art\b", "advanced"),
    (r"\bseamless(ly)?\b", "smooth"),
    (r"\bmanifold\b", "many"),
    (r"\bmyriad\b", "countless"),
    # Overused intensifiers/hedges: thin them out.
    (r"\bvery\s+", ""),
    (r"\bquite\s+", ""),
    (r"\breally\s+", ""),
    (r"\barguably\s+", ""),
    (r"\bessentially\s+", ""),
    (r"\bsignificantly\s+", ""),
]

# Uncontracted forms AI over-uses. Applied probabilistically.
_CONTRACTIONS = [
    (r"\b(I|you|we|they) are\b", r"\1're", {"I": "I'm"}),  # special-cased below
    (r"\bit is\b", "it's"),
    (r"\bthat is\b", "that's"),
    (r"\bthere is\b", "there's"),
    (r"\bhere is\b", "here's"),
    (r"\bwhat is\b", "what's"),
    (r"\bwho is\b", "who's"),
    (r"\bhe is\b", "he's"),
    (r"\bshe is\b", "she's"),
    (r"\bdo not\b", "don't"),
    (r"\bdoes not\b", "doesn't"),
    (r"\bdid not\b", "didn't"),
    (r"\bis not\b", "isn't"),
    (r"\bare not\b", "aren't"),
    (r"\bwas not\b", "wasn't"),
    (r"\bwere not\b", "weren't"),
    (r"\bhave not\b", "haven't"),
    (r"\bhas not\b", "hasn't"),
    (r"\bhad not\b", "hadn't"),
    (r"\bwill not\b", "won't"),
    (r"\bwould not\b", "wouldn't"),
    (r"\bcould not\b", "couldn't"),
    (r"\bshould not\b", "shouldn't"),
    (r"\bcannot\b", "can't"),
    (r"\bcan not\b", "can't"),
    (r"\bwe will\b", "we'll"),
    (r"\byou will\b", "you'll"),
    (r"\bthey will\b", "they'll"),
    (r"\bwe have\b", "we've"),
    (r"\byou have\b", "you've"),
    (r"\bthey have\b", "they've"),
]

# Conservative, hand-picked synonym swaps. Unlike WordNet these are always
# register-appropriate, so we never get "scale -> scurf" style garbage.
_SAFE_SYNONYMS = {
    "utilise": ["use"], "utilize": ["use"], "utilised": ["used"], "utilized": ["used"],
    "commence": ["start", "begin"], "commenced": ["started", "began"],
    "terminate": ["end", "stop"], "demonstrate": ["show"], "demonstrates": ["shows"],
    "facilitate": ["help", "ease"], "facilitates": ["helps"],
    "numerous": ["many", "lots of"], "additional": ["extra", "more"],
    "obtain": ["get"], "obtained": ["got"], "acquire": ["get"], "acquired": ["got"],
    "sufficient": ["enough"], "approximately": ["about", "around", "roughly"],
    "subsequently": ["later", "then"], "previously": ["before", "earlier"],
    "currently": ["now"], "however": ["but", "though"],
    "therefore": ["so"], "individuals": ["people"], "individual": ["person"],
    "purchase": ["buy"], "purchased": ["bought"], "assist": ["help"],
    "attempt": ["try"], "attempted": ["tried"], "require": ["need"],
    "requires": ["needs"], "required": ["needed"],
    "regarding": ["about"], "endeavour": ["try"],
    "comprehend": ["understand"], "ascertain": ["find out"],
    # ── broadened for perplexity (essay-register safe) ──
    "devastating": ["ruinous", "shattering", "brutal"],
    "conflict": ["war", "fighting"], "immense": ["huge", "vast", "enormous"],
    "struggle": ["fight", "ordeal"], "reshaping": ["remaking", "reworking"],
    "unresolved": ["unsettled", "lingering"], "punitive": ["harsh", "punishing"],
    "collapse": ["breakdown", "crash"], "fertile": ["ripe", "ready"],
    "resentment": ["bitterness", "anger"], "aggressive": ["forceful", "belligerent"],
    "expansionism": ["expansion"], "rapidly": ["quickly", "fast"],
    "declared": ["announced"], "invaded": ["attacked", "stormed into"],
    "brutal": ["savage", "vicious"], "largest": ["biggest"],
    "bloodiest": ["deadliest"], "unprecedented": ["never-before-seen", "staggering"],
    "decisive": ["crucial", "telling"], "halted": ["stopped", "checked"],
    "reversed": ["turned back", "undid"], "accelerated": ["sped up", "quickened"],
    "surrendered": ["gave up", "capitulated"], "profound": ["deep", "far-reaching"],
    "lasting": ["enduring", "long-lived"], "exposed": ["laid bare", "revealed"],
    "cruelty": ["barbarity", "savagery"], "systematically": ["methodically"],
    "murdered": ["killed", "slaughtered"], "consequences": ["fallout", "aftermath", "results"],
    "origins": ["roots", "beginnings"], "tensions": ["frictions", "strains"],
    "mobilized": ["marshalled", "rallied"], "mobilization": ["mustering"],
    "transforming": ["turning", "changing"], "innovation": ["invention"],
    "fundamentally": ["basically", "at its core"], "nature": ["character", "shape"],
    "understand": ["grasp", "get a handle on"], "important": ["key", "big"],
    "significant": ["major", "big"], "essential": ["vital", "key"],
    "various": ["several", "assorted"], "modern": ["present-day"],
    "began": ["started", "kicked off"], "created": ["bred", "spawned", "made"],
    "spread": ["fanned out", "swept"], "brought": ["dragged", "pulled"],
    "stands": ["ranks", "sits"], "opened": ["kicked off", "started"],
}

# Words we must never touch (they carry meaning / are proper-ish).
_SYNONYM_BLACKLIST = {
    "history", "war", "world", "second", "first", "state", "united", "power",
    "front", "age", "scale", "order", "party", "force", "forces",
}

_FILLERS = [
    "honestly", "to be honest", "in a way", "if you think about it",
    "for what it's worth", "at least in my view", "as far as I can tell",
]


# ─────────────────────────────────────────────────────────────────────────────
#  Optional analysis (spaCy loaded lazily; only used by callers that ask)
# ─────────────────────────────────────────────────────────────────────────────
class TextAnalyser:
    def __init__(self, nlp=None):
        self._nlp = nlp

    @property
    def nlp(self):
        if self._nlp is None:
            import spacy
            try:
                self._nlp = spacy.load("en_core_web_sm")
            except OSError as e:
                raise OSError(
                    "spaCy model not found. Run: python -m spacy download en_core_web_sm"
                ) from e
        return self._nlp

    def analyse(self, text: str) -> dict:
        doc = self.nlp(text)
        sentences = list(doc.sents)
        stats = {
            "sentence_count": len(sentences),
            "avg_sentence_length": sum(len(s) for s in sentences) / max(1, len(sentences)),
        }
        if textstat is not None:
            stats["flesch_reading_ease"] = textstat.flesch_reading_ease(text)
            stats["word_count"] = textstat.lexicon_count(text, removepunct=True)
        return stats


# ─────────────────────────────────────────────────────────────────────────────
#  Core transforms
# ─────────────────────────────────────────────────────────────────────────────
class Transformations:
    def __init__(self, nlp=None):
        self.nlp = nlp
        self.homophones = {
            "their": "there", "there": "their",
            "your": "you're", "you're": "your",
            "its": "it's", "it's": "its",
            "then": "than", "than": "then",
        }

    # ── sentence splitting that never eats newlines ──────────────────────────
    @staticmethod
    def _sent_tokenize(text: str):
        if nltk is not None:
            try:
                return nltk.sent_tokenize(text)
            except LookupError:
                try:
                    nltk.download("punkt", quiet=True)
                    nltk.download("punkt_tab", quiet=True)
                    return nltk.sent_tokenize(text)
                except Exception:
                    pass
            except Exception:
                pass
        # Regex fallback: split after ., ! or ? followed by whitespace.
        return re.split(r"(?<=[.!?])\s+", text)

    # ── whole-text punctuation normalisation (structure preserving) ──────────
    @staticmethod
    def normalise_punctuation(text: str) -> str:
        # Smart quotes → straight
        text = text.replace("‘", "'").replace("’", "'")
        text = text.replace("“", '"').replace("”", '"')
        # Ellipsis char → three dots
        text = text.replace("…", "...")
        # Em-dash / en-dash: the single biggest punctuation tell of LLM prose.
        #   "word — word"  -> "word, word"   (spaced dash acts as a comma)
        #   "word—word"     -> "word, word"
        text = re.sub(r"\s*[—–]\s*", ", ", text)
        # Collapse the ", ," that can result if a dash sat next to a comma.
        text = re.sub(r",\s*,", ",", text)
        # Non-breaking spaces → normal
        text = text.replace(" ", " ")
        return text

    # ── remove AI opener + phrase boilerplate ────────────────────────────────
    def strip_ai_phrases(self, line: str, level: float) -> str:
        # Openers first (only at the start of the line/sentence chunk).
        for pat, repl_pool in _AI_OPENERS.items():
            m = re.match(rf"^(\s*)({pat})(,?\s+)(.*)$", line, flags=re.IGNORECASE)
            if m and random.random() < 0.9 * level + 0.1:
                lead, _, _, rest = m.groups()
                repl = random.choice(repl_pool)
                if repl:
                    # Short coordinating conjunctions read better without a comma
                    # ("And the war..." not "And, the war...").
                    sep = " " if repl in {"And", "But", "So", "Or", "Plus", "Then"} else ", "
                    line = f"{lead}{repl}{sep}{rest}"
                else:
                    # Deleted the opener → capitalise the new first word.
                    rest = rest[:1].upper() + rest[1:] if rest else rest
                    line = f"{lead}{rest}"

        for pat, repl in _AI_PHRASES:
            if random.random() < 0.85 * level + 0.15:
                line = re.sub(pat, repl, line, flags=re.IGNORECASE)

        # Clean up artefacts from deletions.
        line = re.sub(r"\s{2,}", " ", line)
        line = re.sub(r"\s+([.,!?;:])", r"\1", line)
        line = re.sub(r"^\s*,\s*", "", line)
        # Re-capitalise sentence starts we may have lowered.
        line = re.sub(r"([.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), line)
        line = line[:1].upper() + line[1:] if line[:1].isalpha() else line
        return line

    # ── delete AI connectives at ANY sentence start (formal/professional mode) ──
    _FORMAL_CONNECTIVES = (
        r"furthermore|moreover|additionally|in addition|consequently|ultimately|"
        r"in conclusion|in summary|to summarise|to summarize|notably|importantly|"
        r"lastly|firstly|secondly|thirdly|overall|first and foremost|as such|"
        r"that being said|needless to say"
    )

    def strip_formal_connectives(self, line: str) -> str:
        """Delete AI-signalling connectives (Furthermore, Moreover, Consequently,
        Ultimately, In conclusion, ...) wherever they OPEN a sentence — at the start
        of the line or after a . ! ? — and re-capitalise the following word. Unlike
        strip_ai_phrases' opener handling (line-start only, with informal And/But
        replacements), this removes them outright, keeping an academic register and
        catching the ones that sit mid-paragraph."""
        rx = re.compile(rf"(^|[.!?]\s+)(?:{self._FORMAL_CONNECTIVES})[,;]?\s+(\w)",
                        re.IGNORECASE)
        return rx.sub(lambda m: m.group(1) + m.group(2).upper(), line)

    # ── contractions ─────────────────────────────────────────────────────────
    def apply_contractions(self, line: str, prob: float) -> str:
        def repl_are(m):
            subj = m.group(1)
            if subj == "I":
                return "I'm"
            return f"{subj}'re"

        for entry in _CONTRACTIONS:
            if random.random() >= prob:
                continue
            if len(entry) == 3 and isinstance(entry[2], dict):
                pat, _repl, _ = entry
                line = re.sub(pat, repl_are, line, flags=re.IGNORECASE)
            else:
                pat, repl = entry[0], entry[1]
                line = re.sub(pat, repl, line, flags=re.IGNORECASE)
        return line

    # ── curated synonym swaps ────────────────────────────────────────────────
    def replace_synonyms(self, line: str, prob: float) -> str:
        used = set()  # avoid picking the same replacement twice in one line

        def swap(m):
            word = m.group(0)
            low = word.lower()
            if low in _SYNONYM_BLACKLIST or low not in _SAFE_SYNONYMS:
                return word
            if random.random() >= prob:
                return word
            options = [o for o in _SAFE_SYNONYMS[low] if o not in used] or _SAFE_SYNONYMS[low]
            choice = random.choice(options)
            used.add(choice)
            if word[:1].isupper():
                choice = choice[:1].upper() + choice[1:]
            return choice

        return re.sub(r"[A-Za-z]+", swap, line)

    # ── sparse fillers at sentence starts ────────────────────────────────────
    def add_fillers(self, line: str, prob: float) -> str:
        sentences = self._sent_tokenize(line)
        if len(sentences) <= 1 and random.random() >= prob:
            return line
        out = []
        for s in sentences:
            s = s.strip()
            # Don't stack a filler on a sentence that already opens with a
            # conjunction ("And it..." -> "Honestly, and it...") — reads wrong.
            starts_conj = bool(re.match(r"^(And|But|So|Yet|Still|Or|Nor)\b", s))
            if s and not starts_conj and random.random() < prob:
                f = random.choice(_FILLERS)
                s = f"{f.capitalize()}, {s[:1].lower()}{s[1:]}"
            out.append(s)
        return " ".join(out)

    # ── occasional homophone slip ────────────────────────────────────────────
    def inject_typos(self, line: str, prob: float) -> str:
        words = line.split()
        for i, word in enumerate(words):
            clean = word.strip(string.punctuation)
            key = clean.lower()
            if clean and random.random() < prob and key in self.homophones:
                replacement = self.homophones[key]
                if clean[:1].isupper():
                    replacement = replacement[:1].upper() + replacement[1:]
                words[i] = word.replace(clean, replacement, 1)
        return " ".join(words)

    # ── raise burstiness by splitting long sentences (aggressive) ────────────
    _SPLIT_JOINTS = re.compile(
        r",\s+(and|or|but|yet|so|as|because|since|though|although|while|which|where)\s+",
        re.IGNORECASE,
    )
    # Words that reliably start an independent clause. Splitting ", and <subject>"
    # is safe; ", and <noun/adj/adverb>" is a noun list ("causes, course, and
    # consequences") and must NOT be split.
    _SUBJECT_STARTERS = {
        "the", "a", "an", "it", "they", "he", "she", "we", "i", "this", "that",
        "these", "those", "there", "his", "her", "its", "their", "our", "my",
        "you", "germany", "britain", "france", "japan", "italy", "soviet",
    }

    def _valid_joints(self, s: str):
        joints = []
        for m in self._SPLIT_JOINTS.finditer(s):
            conj = m.group(1).lower()
            if conj in {"and", "or"}:
                tail = s[m.end():]
                first = re.match(r"[A-Za-z']+", tail)
                if not first or first.group(0).lower() not in self._SUBJECT_STARTERS:
                    continue  # noun list, skip
            joints.append(m)
        return joints

    def _split_once(self, s: str, prob: float, formal: bool = False):
        """Return [head, tail] if s was split at a valid clause joint, else None.
        formal=True never prepends a coordinating conjunction (And/But/So) to the
        tail — it just starts a new capitalised sentence, keeping academic register."""
        if len(s.split()) < 16 or random.random() >= prob:
            return None
        joints = self._valid_joints(s)
        if not joints:
            return None
        pick = random.choice(joints)
        head = s[:pick.start()].rstrip(" ,")
        conj = pick.group(1).lower()
        tail = s[pick.end():].strip()
        if not (head and tail and len(head.split()) >= 5 and len(tail.split()) >= 5):
            return None
        head = head[0].upper() + head[1:]
        if not head.endswith((".", "!", "?")):
            head += "."
        if not formal and conj in {"and", "but", "so", "yet"} and random.random() < 0.5:
            tail = f"{conj.capitalize()} {tail}"
        else:
            tail = tail[0].upper() + tail[1:]
        return [head, tail]

    def vary_sentences(self, line: str, prob: float, formal: bool = False) -> str:
        # Recursively split long sentences so the length distribution becomes
        # genuinely bursty (a long sentence may break into 2-3 shorter ones).
        sentences = self._sent_tokenize(line)
        out = []
        for s in sentences:
            stack = [s]
            pieces = []
            guard = 0
            while stack and guard < 8:
                guard += 1
                cur = stack.pop(0)
                res = self._split_once(cur, prob, formal=formal)
                if res:
                    pieces.append(res[0])
                    stack.insert(0, res[1])   # keep splitting the tail
                else:
                    pieces.append(cur)
            out.extend(pieces)
        return " ".join(out)

    # ── start some sentences with a conjunction (human cadence, +burstiness) ──
    _CONJ_STARTS = ["And", "But", "So", "Yet", "Still"]

    def add_conjunction_starts(self, line: str, prob: float) -> str:
        sentences = self._sent_tokenize(line)
        out = []
        for i, s in enumerate(sentences):
            s = s.strip()
            # Skip the first sentence and anything already opening with a conj.
            if (i > 0 and s and s[0].isupper() and random.random() < prob
                    and not re.match(r"^(And|But|So|Yet|Still|Or|Nor)\b", s)):
                lead = random.choice(self._CONJ_STARTS)
                s = f"{lead} {s[0].lower()}{s[1:]}"
            out.append(s)
        return " ".join(out)

    # Function words that are safe to lowercase after a comma splice (i.e. not
    # proper nouns — merging "..., germany's" would wrongly de-capitalise it).
    _SPLICE_SAFE_STARTS = {
        "the", "this", "that", "these", "those", "it", "they", "he", "she",
        "we", "you", "a", "an", "in", "on", "by", "for", "with", "at", "from",
        "there", "their", "his", "her", "its", "such", "many", "most", "some",
    }

    # ── occasional comma splice between two short sentences (human error) ─────
    def comma_splice(self, line: str, prob: float) -> str:
        sentences = self._sent_tokenize(line)
        if len(sentences) < 2:
            return line
        out = []
        i = 0
        while i < len(sentences):
            s = sentences[i].strip()
            if (i + 1 < len(sentences) and random.random() < prob
                    and 4 <= len(s.split()) <= 12
                    and s.endswith(".")):
                nxt = sentences[i + 1].strip()
                first = re.match(r"[A-Za-z']+", nxt)
                if first and first.group(0).lower() in self._SPLICE_SAFE_STARTS:
                    merged = s[:-1] + ", " + nxt[0].lower() + nxt[1:]
                    out.append(merged)
                    i += 2
                    continue
            out.append(s)
            i += 1
        return " ".join(out)


# ─────────────────────────────────────────────────────────────────────────────
#  LLM backend selection
#
#  DEFAULT = LOCAL Ollama. A local model is the only backend that *always works*:
#  no network, no API keys, no rate limits, no upstream 429s. On this machine
#  (RTX 5050) llama3.2:3b rewrites the full essay in ~6-9 s. This was chosen after
#  benchmarking: every OpenRouter *:free* model intermittently 429s ("Provider
#  returned error"), so the cloud path can never be relied on to "always work".
#
#  Set HUMANIZE_LLM_PROVIDER=openrouter to use the remote OpenAI-compatible path
#  instead (needs a working key + a paid/uncongested model to be reliable).
# ─────────────────────────────────────────────────────────────────────────────
LLM_PROVIDER = os.environ.get("HUMANIZE_LLM_PROVIDER", "ollama").strip().lower()

if LLM_PROVIDER == "openrouter":
    LLM_BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    # No hardcoded key: supply OPENROUTER_API_KEY via the environment. (Config C's
    # rule engine does not use this path.)
    LLM_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
    # gemma-4-26b-a4b:free was the fastest/most-reliable free model in benchmarks
    # (4B-active MoE, full-length output, ~6-13 s) — but still a congested free
    # endpoint with no uptime guarantee. Prefer the local default above.
    LLM_MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemma-4-26b-a4b-it:free")
    LLM_FALLBACK_MODELS = [
        m.strip() for m in os.environ.get(
            "OPENROUTER_FALLBACK_MODELS",
            "google/gemma-4-26b-a4b-it:free,"
            "nvidia/nemotron-3-super-120b-a12b:free,"
            "openai/gpt-oss-120b:free",
        ).split(",") if m.strip()
    ]
    LLM_TIMEOUT = float(os.environ.get("HUMANIZE_LLM_TIMEOUT", "45"))
else:  # "ollama" (default) — local, always-on
    LLM_PROVIDER = "ollama"
    LLM_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
    LLM_API_KEY = "ollama"  # Ollama ignores the key; any non-empty string works.
    LLM_MODEL = os.environ.get("HUMANIZE_LLM_MODEL", "humanizer-local")
    LLM_FALLBACK_MODELS = []  # local doesn't rate-limit; no chain to walk.
    LLM_TIMEOUT = float(os.environ.get("HUMANIZE_LLM_TIMEOUT", "30"))


class LLMHumaniser:
    def __init__(self, api_key: str = None, base_url: str = None, model: str = None):
        self.provider = LLM_PROVIDER
        self.model = model or LLM_MODEL
        self.base_url = base_url or LLM_BASE_URL
        self.api_key = api_key or LLM_API_KEY
        # Build the model try-order: the chosen primary first, then any distinct
        # fallbacks. On a 429/404 for one model we advance to the next.
        self.models = [self.model] + [m for m in LLM_FALLBACK_MODELS if m != self.model]
        self._client = None  # lazily built OpenAI SDK client (remote provider only)
        # Note: for local Ollama we call the REST API with stdlib urllib and never
        # import the (slow, ~0.7 s) openai SDK — that shaves fixed startup off every
        # per-save invocation. We also deliberately do NOT warm the model here:
        # OLLAMA_KEEP_ALIVE=-1 (set on this machine) plus keep_alive=-1 on every
        # request keeps it pinned in VRAM permanently, so a per-call warm-up would
        # just add a fixed ~2.5 s round-trip for nothing. The one-time cold load
        # after a reboot is handled by the daemon's startup preload.

    def _openai_client(self):
        """Lazily construct the OpenAI SDK client (only needed for the remote
        OpenRouter path). max_retries=0: we run our own short retry loop so a
        throttled model fails fast instead of the SDK doing long internal backoff."""
        if self._client is None:
            from openai import OpenAI
            self._client = OpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                max_retries=0,
                timeout=LLM_TIMEOUT,
                default_headers={"HTTP-Referer": "https://localhost/typewriter",
                                 "X-Title": "TypeWriter Humaniser"},
            )
        return self._client

    def _ollama_chat(self, model: str, system: str, user: str, temperature: float) -> str:
        """Call Ollama's native /api/chat via stdlib urllib (no openai SDK).
        keep_alive=-1 pins the model so back-to-back essays stay warm."""
        import urllib.request
        import json as _json
        host = self.base_url.rsplit("/v1", 1)[0]
        payload = _json.dumps({
            "model": model,
            "keep_alive": -1,
            "stream": False,
            "options": {"temperature": temperature},
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
        }).encode()
        req = urllib.request.Request(f"{host}/api/chat", data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as r:
            data = _json.load(r)
        return (data.get("message", {}).get("content") or "").strip()

    def humanise(self, text: str, level: float, professional: bool = True) -> str:
        if professional:
            # Preserve length + a formal, college-level register and vocabulary.
            # Beat detectors through sentence-rhythm variation and less-predictable
            # (but still formal) phrasing — NOT by dumbing the essay down.
            system_prompt = (
                "Rewrite the following college essay so it does not read as AI-generated, while "
                "keeping it a polished, formal essay a strong student would submit.\n\n"
                "LENGTH: match the length of the original closely (within about 10 percent). Do "
                "not shorten or summarize it, and do NOT pad it with invented sentences, facts, "
                "statistics or claims to make it longer. Keep every fact, name, date, number, "
                "example and paragraph exactly as given. Keep the blank line between paragraphs.\n"
                "REGISTER: formal, academic, third person. No contractions, no slang, no filler, "
                "no first-person asides, no jokey or conversational tone. Keep sophisticated, "
                "precise vocabulary — never simplify or dumb it down.\n"
                "SENTENCE RHYTHM (this is how you avoid detection): vary sentence length hard. "
                "Place several short, direct sentences (5-9 words) between longer, subordinated "
                "ones. Never let sentences settle into a uniform length or a predictable "
                "subject-verb-object march. Vary how sentences open.\n"
                "WORD CHOICE (this also avoids detection): avoid the polished words AI overuses - "
                "indelible, calamitous, profound, cataclysmic, pivotal, crucial, testament, "
                "tapestry, underscore, delve, realm, fertile ground, ushered in, stands as, "
                "left an indelible mark, marked a turning point. Prefer concrete, specific, "
                "less predictable formal wording. Do not write purple or ornate prose.\n"
                "AVOID AI TELLS: no em-dashes (use commas, semicolons or periods); do not use "
                "Furthermore, Moreover, Additionally, Consequently, In conclusion, In summary; "
                "avoid 'it is important to note', 'plays a crucial role', 'navigate the "
                "complexities'. Use only straight quotes ' and \". No ellipses.\n\n"
                "Do NOT invent anything. Do NOT add a title, preamble or commentary. "
                "Output ONLY the rewritten essay."
            )
            # Lower, steadier temperature keeps a formal essay coherent.
            temperature = min(0.9, 0.6 + level * 0.3)
            return self._run(text, system_prompt, temperature)

        system_prompt = (
            "You are rewriting a student's history essay in that student's own voice so it "
            "reads as genuinely hand-written. Keep every fact, name, number and date exactly, "
            "and keep the same paragraph breaks (blank line between paragraphs).\n\n"
            "Write like a real person thinking on the page, not like polished AI prose:\n"
            "- Burstiness: vary sentence length hard. Some sentences 3-6 words. Some long and "
            "winding with several clauses. Never a run of same-length sentences.\n"
            "- Perplexity: choose specific, slightly unexpected words a person would actually "
            "use; avoid the smooth predictable phrasing LLMs default to. Don't thesaurus-stuff.\n"
            "- Use contractions everywhere natural (it's, didn't, wasn't, they'd).\n"
            "- Start the odd sentence with And, But, So, Yet.\n"
            "- Let a little human texture in: an aside, a plain judgement ('this was a disaster'), "
            "a slightly loose connective. Not every sentence needs to be tidy.\n"
            "- Keep it a SERIOUS history essay in a real student's voice. Do NOT make it jokey, "
            "slangy or sarcastic ('boom!', 'super', 'messed up', 'oh no') — that reads as fake.\n\n"
            "BANNED (these scream AI): em-dashes (use commas or full stops); the words "
            "Furthermore, Moreover, Additionally, Consequently, Ultimately, In conclusion, "
            "In summary; the phrases 'it is important to note', 'plays a crucial/vital role', "
            "'delve', 'tapestry', 'stands as', 'testament to', 'navigate the complexities'. "
            "Use only straight quotes ' and \", never curly ones. No ellipses.\n\n"
            "Do NOT invent anything. Do NOT add a title, preamble, or commentary. "
            "Output ONLY the rewritten essay."
        )
        temperature = min(1.15, 0.85 + level * 0.3)
        return self._run(text, system_prompt, temperature)

    def _run(self, text: str, system_prompt: str, temperature: float) -> str:
        last_err = None
        # Walk the model list; give the primary a couple of quick retries (it may
        # be momentarily throttled), then move on to the next model on failure.
        for model in self.models:
            retries = 3 if model == self.models[0] else 1
            for attempt in range(retries):
                try:
                    if self.provider == "ollama":
                        out = self._ollama_chat(model, system_prompt, text, temperature)
                    else:
                        resp = self._openai_client().chat.completions.create(
                            model=model,
                            messages=[
                                {"role": "system", "content": system_prompt},
                                {"role": "user", "content": text},
                            ],
                            temperature=temperature,
                        )
                        out = (resp.choices[0].message.content or "").strip()
                    # Ollama/local models can emit U+FFFD for a mangled char; drop it.
                    out = out.replace("�", "")
                    if out:
                        if model != self.models[0]:
                            sys.stderr.write(f"[humanizer] LLM using fallback model {model}\n")
                        self.last_model_used = model
                        return out
                    last_err = RuntimeError("empty LLM response")
                except Exception as e:  # noqa: BLE001
                    last_err = e
                    msg = str(e)
                    # Local backend: no rate limits to wait out. If it errored
                    # (server down / model missing), fail fast — the pipeline drops
                    # to the instant rule-based path rather than stalling.
                    if self.provider == "ollama":
                        break
                    # 404 = model not available for this account: don't waste
                    # retries, jump straight to the next fallback model.
                    if "404" in msg or "not available" in msg or "unavailable" in msg:
                        break
                    wait = self._retry_after(e, default=6 + 3 * attempt)
                    time.sleep(min(wait, 15))
        raise RuntimeError(f"LLM humanise failed on all models: {last_err}")

    @staticmethod
    def _retry_after(err, default: float) -> float:
        try:
            body = getattr(err, "body", None) or {}
            meta = (body.get("error", {}) or {}).get("metadata", {}) or {}
            ra = meta.get("retry_after_seconds")
            if ra:
                return float(ra) + 1.0
        except Exception:
            pass
        m = re.search(r"retry_after_seconds'?:?\s*([0-9.]+)", str(err))
        return (float(m.group(1)) + 1.0) if m else float(default)


# ─────────────────────────────────────────────────────────────────────────────
#  Pipeline
# ─────────────────────────────────────────────────────────────────────────────
class HumaniserPipeline:
    def __init__(self, config: HumaniserConfig):
        self.config = config
        if config.seed is not None:
            random.seed(config.seed)
        self.analyser = TextAnalyser()
        self.transforms = Transformations()
        # LLM is used whenever use_llm is on; the key/model default to the
        # module-level OpenRouter config, so no key needs to be passed in.
        self.llm = (
            LLMHumaniser(config.openai_api_key, model=config.llm_model)
            if config.use_llm else None
        )

    @staticmethod
    def _split_leading_ws(line: str):
        """Return (leading_whitespace, rest) so indentation/tabs are preserved."""
        m = re.match(r"^([ \t]*)(.*)$", line)
        return m.group(1), m.group(2)

    @staticmethod
    def _burstiness(text: str) -> float:
        """Coefficient of variation of sentence lengths. AI prose is uniform
        (low CV); human prose mixes short and long sentences (high CV)."""
        sents = [s for s in re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", text)) if s.strip()]
        lengths = [len(s.split()) for s in sents]
        if len(lengths) < 2:
            return 0.0
        mean = sum(lengths) / len(lengths)
        if mean == 0:
            return 0.0
        var = sum((x - mean) ** 2 for x in lengths) / len(lengths)
        return (var ** 0.5) / mean

    # Residual AI tells the rule layer sometimes leaves in; each occurrence is a
    # penalty in the composite score so best-of-N avoids the worst candidates.
    _TELL_RE = re.compile(
        r"\b(furthermore|moreover|additionally|consequently|ultimately|"
        r"in conclusion|in summary|it is important|plays? a (crucial|vital|key) role|"
        r"delve|tapestry|stands as a|a testament to|navigat\w+ the complexit)",
        re.IGNORECASE,
    )
    _CONTRACTION_RE = re.compile(r"\b\w+'(s|re|ve|ll|d|t|m)\b", re.IGNORECASE)

    @classmethod
    def _human_score(cls, text: str) -> float:
        """Network-free composite proxy for 'reads as human' (higher = better),
        used to pick the best-of-N candidate without querying a detector. Blends
        the signals detectors actually key on:
          + burstiness         (sentence-length variation)
          + short-sentence mix (presence of punchy < 7-word sentences)
          + lexical variety    (type-token ratio — unpredictable word choice)
          + contraction density(AI under-uses contractions)
          - AI-tell hits       (residual cliche phrases/connectives)
          - runaway mean length (walls of text read as AI/'formal')
        Weights tuned so the ranking tracks ZeroGPT on this essay class."""
        norm = re.sub(r"\s+", " ", text).strip()
        sents = [s for s in re.split(r"(?<=[.!?])\s+", norm) if s.strip()]
        if len(sents) < 2:
            return 0.0
        lengths = [len(s.split()) for s in sents]
        mean = sum(lengths) / len(lengths)
        var = sum((x - mean) ** 2 for x in lengths) / len(lengths)
        burst = (var ** 0.5) / mean if mean else 0.0

        short_frac = sum(1 for L in lengths if L <= 6) / len(lengths)
        long_frac = sum(1 for L in lengths if L >= 25) / len(lengths)

        words = re.findall(r"[A-Za-z']+", norm.lower())
        ttr = len(set(words)) / len(words) if words else 0.0
        contractions = len(cls._CONTRACTION_RE.findall(norm))
        contr_density = contractions / (len(words) / 100.0) if words else 0.0  # per 100 words
        tells = len(cls._TELL_RE.findall(norm))

        # Mean-length comfort band: 12-20 words is natural; penalise drift above.
        mean_pen = max(0.0, mean - 22.0) * 0.03

        score = (
            1.6 * burst
            + 1.2 * short_frac
            + 1.0 * ttr
            + 0.15 * min(contr_density, 6.0)   # cap so it can't dominate
            - 0.30 * tells
            - 0.8 * long_frac
            - mean_pen
        )
        return score

    def _process_once(self, text: str) -> str:
        level = self.config.humanise_level
        cfg = self.config
        out_lines = []
        for raw_line in text.split("\n"):
            lead, body = self._split_leading_ws(raw_line)
            if body.strip() == "":
                out_lines.append(raw_line)  # blank / whitespace-only line: verbatim
                continue

            s = body
            # Always safe / quality-positive: strip AI-cliche openers & boilerplate.
            s = self.transforms.strip_ai_phrases(s, level)

            if cfg.professional:
                # Quality-preserving path: the rule layer only *cleans up* (AI-cliche
                # removal above + em-dash / smart-quote normalisation done in
                # _rule_based). It deliberately does NO sentence splitting (that can
                # sever a compound subject from its verb and leave a fragment), NO
                # vocabulary downgrade, NO contractions, NO fillers, NO typos, NO
                # comma splices. Burstiness/register come from the LLM prompt, which
                # keeps grammar intact. This also means human-written input is left
                # almost verbatim rather than being rewritten into something worse.
                # One extra safe pass: delete AI connectives (Furthermore, Ultimately,
                # In conclusion, ...) that the model left mid-paragraph.
                s = self.transforms.strip_formal_connectives(s)
            else:
                # Max-evasion "casual" path (lowest detector score, informal voice).
                # Contractions: near-total at high level (AI's uncontracted forms are
                # one of the strongest tells).
                s = self.transforms.apply_contractions(s, min(1.0, 0.6 + cfg.contraction_probability * level))
                s = self.transforms.replace_synonyms(s, min(0.92, cfg.synonym_probability + 0.7 * level))
                # Burstiness: split long sentences, then vary openings, then the odd
                # comma splice. Order matters — split first so openings vary more.
                s = self.transforms.vary_sentences(s, min(0.95, 0.75 + cfg.sentence_split_probability * level))
                s = self.transforms.add_conjunction_starts(s, 0.26 * level)
                s = self.transforms.comma_splice(s, 0.16 * level)
                s = self.transforms.add_fillers(s, cfg.filler_probability * level * 0.7)
                s = self.transforms.inject_typos(s, cfg.typo_probability * level)

            out_lines.append(lead + s)
        return "\n".join(out_lines)

    def _score_candidate(self, text: str, source: Optional[str]) -> float:
        """Rank a candidate for best-of-N selection. Casual mode uses the composite
        human-score (rewards short sentences + contractions). Professional mode
        instead rewards burstiness and lexical variety, penalises AI tells, and
        strongly penalises any candidate that came out shorter than the source —
        so selection never favours a compressed or dumbed-down variant."""
        if not self.config.professional:
            return self._human_score(text)
        norm = re.sub(r"\s+", " ", text).strip()
        sents = [s for s in re.split(r"(?<=[.!?])\s+", norm) if s.strip()]
        if len(sents) < 2:
            return 0.0
        lengths = [len(s.split()) for s in sents]
        mean = sum(lengths) / len(lengths)
        var = sum((x - mean) ** 2 for x in lengths) / len(lengths)
        burst = (var ** 0.5) / mean if mean else 0.0
        words = re.findall(r"[A-Za-z']+", norm.lower())
        ttr = len(set(words)) / len(words) if words else 0.0
        tells = len(self._TELL_RE.findall(norm))
        len_ratio = (len(text) / len(source)) if source else 1.0
        len_pen = max(0.0, 0.95 - len_ratio) * 4.0   # heavy penalty if shorter than source
        return 1.6 * burst + 1.0 * ttr - 0.4 * tells - len_pen

    def _rule_based(self, text: str, source: Optional[str] = None) -> str:
        # Structure-preserving punctuation normalisation, then best-of-N by the
        # local composite score (see _score_candidate), which ranks candidates far
        # closer to the detector / to "reads well" than raw burstiness alone.
        text = self.transforms.normalise_punctuation(text)
        source = source if source is not None else text
        n = max(1, self.config.candidates)
        best_text, best_score = None, -1e9
        for _ in range(n):
            cand = self._process_once(text)
            score = self._score_candidate(cand, source)
            if score > best_score:
                best_text, best_score = cand, score
        return best_text

    def process(self, text: str) -> str:
        level = self.config.humanise_level
        cfg = self.config

        if self.llm:
            try:
                # HYBRID: LLM rewrite, THEN layer the rule-based features on top.
                llm_out = self.llm.humanise(text, level, professional=cfg.professional)
                # Length guard: essays must not shrink. If the model compressed the
                # source, retry once and keep the longer result.
                if cfg.professional and len(llm_out) < 0.9 * len(text):
                    try:
                        retry = self.llm.humanise(text, level, professional=True)
                        if len(retry) > len(llm_out):
                            llm_out = retry
                    except Exception:  # noqa: BLE001
                        pass
                sys.stderr.write("[humanizer] LLM ok; layering rule-based features (hybrid)\n")
                return self._rule_based(llm_out, source=text)
            except Exception as e:  # noqa: BLE001 - fall back if the LLM is down/rate-limited
                sys.stderr.write(f"[humanizer] LLM unavailable, using rule-based only: {e}\n")
                return self._rule_based(text, source=text)

        return self._rule_based(text, source=text)


# ─────────────────────────────────────────────────────────────────────────────
#  CLI (kept compatible with the previous --input/--output interface)
# ─────────────────────────────────────────────────────────────────────────────
def main():
    import argparse
    parser = argparse.ArgumentParser(description="AI Text Humaniser v2")
    parser.add_argument("--input", type=str)
    parser.add_argument("--output", type=str)
    parser.add_argument("--level", type=float, default=0.8)
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    config = HumaniserConfig(humanise_level=args.level, use_llm=False, seed=args.seed)
    pipeline = HumaniserPipeline(config)

    if args.input and args.output:
        with open(args.input, "r", encoding="utf-8") as f:
            text = f.read()
        if not text.strip():
            print("Input file is empty.")
            return
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(pipeline.process(text))
        print(f"Humanised text saved to {args.output}")
    else:
        sample = (
            "The Second World War was a devastating conflict. Furthermore, it is important "
            "to note that it reshaped the world — politically, socially, and economically. "
            "It is worth noting that the war played a crucial role in the modern era."
        )
        print("--- Original ---\n" + sample)
        print("\n--- Humanised ---\n" + pipeline.process(sample))


if __name__ == "__main__":
    main()
