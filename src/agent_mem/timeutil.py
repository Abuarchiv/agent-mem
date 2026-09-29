"""UTC time helpers. All stored timestamps are ISO 8601 UTC strings."""

from __future__ import annotations

from datetime import UTC, datetime


def now() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime | None = None) -> str:
    return (value or now()).astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def from_any(value: object) -> str:
    """Accept epoch seconds/milliseconds or ISO strings from hosts; fall back to now."""
    if isinstance(value, int | float) and value > 0:
        seconds = value / 1000 if value > 10_000_000_000 else value
        try:
            return iso(datetime.fromtimestamp(seconds, UTC))
        except (OverflowError, OSError, ValueError):
            return iso()
    if isinstance(value, str):
        parsed = parse(value)
        if parsed is not None:
            return iso(parsed)
    return iso()


def hours_between(earlier: str, later: datetime | None = None) -> float:
    start = parse(earlier)
    if start is None:
        return 0.0
    return max(((later or now()) - start).total_seconds() / 3600.0, 0.0)


def day(value: str) -> str:
    return value[:10]
