"""Quote freeze/thaw self-check. Run: python3 test/test_quote_freeze.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "humanizer"))
from stealth_humanizer import freeze_quotes, thaw_quotes, _keeps_facts, _keeps_marks  # noqa: E402

src = 'Orwell wrote “All animals are equal — but some are more equal.” Critics said "it is a fable".'
masked, quotes = freeze_quotes(src)
assert masked == "Orwell wrote [[Q1: All animals are equal — but some are more equal.]] Critics said [[Q2: it is a fable]].", masked
assert quotes == ["“All animals are equal — but some are more equal.”", '"it is a fable"']

# A rewrite that moves the markers but keeps them restores both quotes byte-for-byte.
# Edits the model makes INSIDE a marker are discarded: restore is by number only.
rewrite = "Critics called it [[Q2: a fable, it is]]. Orwell, though, wrote [[Q1: All animals are equal]]"
assert thaw_quotes(rewrite, quotes) == 'Critics called it "it is a fable". Orwell, though, wrote ' + quotes[0]
# The model re-wrapped a marker in quotes: unwrap, do not double the quote marks.
assert thaw_quotes('He wrote "[[Q1]]" and [[Q2]].', quotes) == f"He wrote {quotes[0]} and {quotes[1]}."
# Lost, duplicated, or invented markers are refused.
assert thaw_quotes("Orwell wrote [[Q1]].", quotes) is None
assert thaw_quotes("[[Q1]] [[Q1]] [[Q2]]", quotes) is None
assert thaw_quotes("[[Q1]] [[Q2]] [[Q3]]", quotes) is None
# Text with no quotes round-trips untouched.
assert freeze_quotes("plain text") == ("plain text", [])
assert thaw_quotes("plain text", []) == "plain text"
# Every rewrite guard rejects a candidate that dropped a marker.
assert not _keeps_marks(masked, "Orwell wrote something. Critics said [[Q2: it is a fable]].")
assert not _keeps_facts(masked, "Orwell wrote something. Critics said [[Q2: it is a fable]].")
assert _keeps_facts(masked, "Critics said [[Q2: it is a fable]]. Orwell wrote [[Q1: x]]")
print("quote freeze: ok")
