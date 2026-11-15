"""
train/local_detector.py — fast, local, rate-limit-free AI-text detector.

Wraps a RoBERTa classifier so training/eval can score "how AI does this read?" thousands
of times with no network and no ZeroGPT rate limit. Used as the fast inner-loop signal for
candidate selection and preference labelling; ZeroGPT stays the *authoritative* O3 metric,
checked periodically to keep the local proxy honest.

Primary model: Hello-SimpleAI/chatgpt-detector-roberta — a modern ChatGPT-era detector that
tracks ZeroGPT well here (validated: genuine-AI essay 95.9% vs hand-written ~2%). The classic
openai-community/roberta-base-openai-detector was tested and REJECTED: it only recognizes
GPT-2-era text and rated our 100%-ZeroGPT essay 0% AI. Override with DETECTOR_MODEL env var.

ai_prob(text) -> float in [0,100]  (higher = more likely AI-generated)
"""
import os
import re

MODEL = os.environ.get("DETECTOR_MODEL", "Hello-SimpleAI/chatgpt-detector-roberta")


class LocalDetector:
    _tok = None
    _model = None
    _fake_idx = 1
    _device = None

    @classmethod
    def _load(cls):
        if cls._model is None:
            import torch
            from transformers import AutoTokenizer, AutoModelForSequenceClassification
            # CPU by default so the GPU stays free for the Ollama LLM (SCORE_DEVICE=cuda to override).
            cls._device = os.environ.get("SCORE_DEVICE", "cpu")
            if cls._device == "cuda" and not torch.cuda.is_available():
                cls._device = "cpu"
            cls._tok = AutoTokenizer.from_pretrained(MODEL)
            cls._model = AutoModelForSequenceClassification.from_pretrained(MODEL).to(cls._device).eval()
            # find which label index means "AI/fake"
            id2label = {int(k): str(v).lower() for k, v in cls._model.config.id2label.items()}
            for i, lab in id2label.items():
                if "fake" in lab or "ai" in lab or "machine" in lab or "gpt" in lab:
                    cls._fake_idx = i
                    break

    @classmethod
    def ai_prob(cls, text: str) -> float:
        """Whole-text AI probability (0-100)."""
        cls._load()
        import torch
        enc = cls._tok(text, return_tensors="pt", truncation=True, max_length=512).to(cls._device)
        with torch.no_grad():
            probs = torch.softmax(cls._model(**enc).logits, dim=-1)[0]
        return float(probs[cls._fake_idx]) * 100.0

    @classmethod
    def ai_prob_chunked(cls, text: str, max_words: int = 300) -> float:
        """Average AI probability over ~paragraph-sized chunks — more stable on long
        essays than a single 512-token truncation, and closer to how detectors sweep."""
        words = text.split()
        if len(words) <= max_words:
            return cls.ai_prob(text)
        chunks, cur = [], []
        for para in re.split(r"\n\s*\n", text):
            if not para.strip():
                continue
            if len((" ".join(cur) + " " + para).split()) > max_words and cur:
                chunks.append(" ".join(cur)); cur = [para]
            else:
                cur.append(para)
        if cur:
            chunks.append(" ".join(cur))
        scores = [cls.ai_prob(c) for c in chunks if c.strip()]
        return sum(scores) / max(1, len(scores))


if __name__ == "__main__":
    import sys
    txt = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else "test"
    print(f"AI prob: {LocalDetector.ai_prob_chunked(txt):.1f}%")
