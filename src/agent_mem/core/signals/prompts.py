"""What a prompt says beyond its request: corrections, preferences, decisions, and text the harness put there. Pure functions, standard library only."""

from __future__ import annotations

import re

from agent_mem.core.signals.tools import SUBCOMMAND_TOOLS

_CORRECTION = re.compile(
    r"(?i)^\s*(nein|no\b|nope|falsch|wrong|stop\b|halt\b|nicht so|not like that|that's not|das ist nicht|"
    r"das stimmt nicht|incorrect|undo|rückgängig|mach das rückgängig)"
    r"|\b(ich hab(e)? (doch )?gesagt|i (already )?(told|said)|hör auf|don't do that|do not do that|"
    r"nicht schon wieder|immer noch falsch|still wrong)\b"
    r"|\bagain\?"
)
# "immer noch", "wie immer", "noch nie", "never mind" are filler, not rules.
_ALWAYS_NEVER = re.compile(
    r"(?i)(?<!noch )(?<!wie )(?<!für )\b(immer\b(?!\s+(noch|wieder|mehr)\b)|nie(mals)?\b|always\b"
    r"|never\b(?!\s+mind\b)|stets\b|grundsätzlich\b)"
)
_INSTEAD = [
    re.compile(
        r"(?i)\b(?:nutze|verwende|benutze|nimm|use)\s+`?([\w.@/+-]+)`?\s+(?:statt|anstatt|anstelle von|instead of|not)\s+`?([\w.@/+-]+)`?"
    ),
    re.compile(r"(?i)`?([\w.@/+-]+)`?\s+(?:statt|anstatt)\s+`?([\w.@/+-]+)`?"),
    # "nicht pip benutzen, sondern uv": the verb may stand between the name and the comma.
    re.compile(
        r"(?i)\b(?:nicht|kein|not|no)\s+`?([\w.@/+-]+)`?(?:\s+(?:benutzen|verwenden|nutzen|nehmen|using))?\s*,\s*"
        r"(?:sondern|but|use)\s+`?([\w.@/+-]+)`?"
    ),
]
_AVOID = re.compile(
    r"(?i)\b(?:never use|don't use|do not use|nie|niemals|kein|keine|nicht)\s+`?([\w.@/+-]{2,40})`?\s+(?:benutzen|verwenden|nutzen|nehmen|use)?"
)
_DECISION = re.compile(
    r"(?i)\b(wir nehmen|wir verwenden|wir nutzen|entschieden|entscheidung|we(?:'ll| will)? use|we decided|decided to|"
    r"let's use|lass uns .{1,40} (nehmen|verwenden|nutzen)|going with|we're going with|from now on|ab jetzt|ab sofort)\b"
)


def is_correction(prompt: str) -> bool:
    return bool(_CORRECTION.search(prompt[:600]))


def _name(token: str) -> str:
    # "nutze uv statt pip." ends a sentence; the rule is about `pip`, not `pip.`.
    return token.lower().rstrip(".,:;!?")


# "nicht so, sondern anders", "nicht hier, sondern im viewer", "X statt der alten": everyday contrast in prose.
# A command rule names a tool, never one of these closed-class words.
_FILLER = frozenset(
    [
        "a",
        "an",
        "the",
        "this",
        "that",
        "these",
        "those",
        "it",
        "its",
        "one",
        "ones",
        "other",
        "some",
        "any",
        "all",
        "here",
        "there",
        "now",
        "later",
        "then",
        "so",
        "not",
        "no",
        "more",
        "again",
        "them",
        "they",
        "we",
        "you",
        "me",
        "us",
        "der",
        "die",
        "das",
        "dem",
        "den",
        "des",
        "ein",
        "eine",
        "einen",
        "einem",
        "einer",
        "eines",
        "dies",
        "diese",
        "dieser",
        "dieses",
        "hier",
        "da",
        "dort",
        "jetzt",
        "später",
        "dann",
        "anders",
        "nicht",
        "kein",
        "keine",
        "mehr",
        "wieder",
        "es",
        "er",
        "sie",
        "wir",
        "ich",
        "du",
        "ihr",
        "uns",
        "mir",
        "dir",
        "ihn",
        "im",
        "in",
        "am",
        "an",
        "auf",
        "mit",
        "für",
        "von",
        "zu",
        "bei",
        "nach",
        "vor",
        "aus",
        "um",
        "immer",
        "nie",
        "lieber",
        "bitte",
        "auch",
        "noch",
        "nur",
        "schon",
        "heute",
        "morgen",
        "alles",
        "alle",
        "etwas",
        "nichts",
        "was",
        "wie",
        "wo",
        "use",
        "nutzen",
        "benutzen",
        "verwenden",
        "nehmen",
    ]
)


# Up to this length a prompt is a typed correction ("pnpm statt npm, bitte"), not a paragraph.
BARE_SWAP_CHARS = 160


def _pair(avoid: str, prefer: str | None) -> tuple[str, str | None] | None:
    names = [avoid] if prefer is None else [avoid, prefer]
    if avoid == prefer or any(len(n) < 2 or n in _FILLER or n.isdigit() for n in names):
        return None
    return avoid, prefer


def preference_pairs(text: str) -> list[tuple[str, str | None]]:
    """Extract (avoid, prefer) pairs such as "pnpm statt npm" -> ("npm", "pnpm")."""
    pairs: list[tuple[str, str | None]] = []
    sample = text[:1000]
    for index, pattern in enumerate(_INSTEAD):
        for match in pattern.finditer(sample):
            # Bare "X statt Y" in running prose is any word swap ("Redo anstatt Reuse zu nennen"), not a tool rule.
            if index == 1 and len(sample) > BARE_SWAP_CHARS and "`" not in match.group(0):
                continue
            first, second = _name(match.group(1)), _name(match.group(2))
            prefer, avoid = (second, first) if index == 2 else (first, second)
            pair = _pair(avoid, prefer)
            if pair is not None and pair not in pairs:
                pairs.append(pair)
    if not pairs:
        for match in _AVOID.finditer(sample):
            token = _name(match.group(1))
            # "kein git push" avoids `git push` (a command key), not every git command.
            sub = re.match(r"\s+`?([a-z][\w-]*)", sample[match.end(1) :].lower()) if token in SUBCOMMAND_TOOLS else None
            if sub and sub.group(1) not in _FILLER:
                token = f"{token} {sub.group(1)}"
            pair = _pair(token, None)
            if pair is not None:
                pairs.append(pair)
    return pairs[:5]


_CANONICAL_RULE = re.compile(
    r"(?i)^\s*(?:use|nutze|verwende)\s+`?([\w.@/+-]+?)`?\s+(?:instead of|statt|anstatt)\s+`?([\w.@/+-]+?)`?(?=[\s.,;:!]|$)"
)
# "Never commit, use local commits" is no tool swap: the avoided name needs a verb ("do not use npm") or backticks.
_CANONICAL_AVOID_RULE = re.compile(
    r"(?i)^\s*(?:do not|don't|never|not|no|nicht|nie(?:mals)?)\s+"
    r"(?:(?:use|nutze|verwende|benutze)\s+`?([\w.@/+-]+?)`?|`([\w.@/+-]+?)`)\s*[,;]\s*"
    r"(?:(?:but|sondern)\s+(?:(?:use|nutze|verwende|benutze)\s+)?|"
    r"(?:use|nutze|verwende|benutze)\s+)`?([\w.@/+-]+?)`?(?=[\s.,;:!]|$)"
)


def canonical_rule(text: str) -> tuple[str, str] | None:
    """Return one explicit command substitution as (avoid, prefer)."""
    match = _CANONICAL_RULE.match(text)
    if match:
        pair = _pair(_name(match.group(2)), _name(match.group(1)))
    elif match := _CANONICAL_AVOID_RULE.match(text):
        pair = _pair(_name(match.group(1) or match.group(2)), _name(match.group(3)))
    else:
        return None
    return (pair[0], pair[1]) if pair is not None and pair[1] is not None else None


def mentions_rule(prompt: str) -> bool:
    return bool(_ALWAYS_NEVER.search(prompt[:600]))


def decision_sentences(text: str) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+|\n+", text[:4000])
    return [s.strip()[:300] for s in sentences if _DECISION.search(s)][:3]


_NOTICE = re.compile(r"^\s*<task-notification>.*?<summary>(.*?)</summary>", re.DOTALL)


# Text the harness puts into the prompt slot itself: background-task notices, slash-command wrappers, hook feedback.
_HARNESS_PROMPT = re.compile(
    r"^\s*(?:<task-notification>|<command-(?:name|message)>|<local-command-stdout>|Stop hook feedback:|\[Request interrupted)"
)


# Harness text that continues the running turn instead of asking something new: a finished background task, the
# feedback of a blocking Stop hook, an interruption. A slash command the user typed is a new request.
_CONTINUES_TURN = re.compile(r"^\s*(?:<task-notification>|Stop hook feedback:|\[Request interrupted)")


def continues_turn(prompt: str | None) -> bool:
    return bool(_CONTINUES_TURN.match(prompt or ""))


def from_harness(prompt: str | None) -> bool:
    """True when the user did not type this prompt; it then never teaches rules, corrections or preferences."""
    return bool(_HARNESS_PROMPT.match(prompt or ""))


def request_text(prompt: str | None) -> str:
    """The prompt as a reader sees it: a background-task notice is the harness talking, so show its summary."""
    notice = _NOTICE.match(prompt or "")
    return notice.group(1).strip() if notice else (prompt or "")
