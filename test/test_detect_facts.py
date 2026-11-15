"""Detector fact-score self-check. Run: python3 test/test_detect_facts.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from aether_detect import _facts, _fact_score  # noqa: E402

text = 'Yet Orwell wrote in 1945. His farm had Napoleon. He said, “The pigs won.” This hurt Mr. Jones.'
assert sorted(_facts(text)) == ["1945", "Jones", "Mr", "Napoleon", "Orwell"], sorted(_facts(text))
# Rewording sentence openers does not cost facts; dropping a number or a name does.
assert _fact_score(text, "Orwell wrote in 1945, and Napoleon held the farm. So the pigs won. Mr. Jones was hurt.") == 1.0
assert _fact_score(text, "Orwell wrote. Napoleon held the farm. Mr. Jones was hurt.") == 0.8
print("detect facts: ok")
