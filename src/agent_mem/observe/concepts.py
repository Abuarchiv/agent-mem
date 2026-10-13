"""The spaCy model mem0 uses for entity linking and lemmatisation (``observe.entity_model``), downloaded into
agent-mem's model directory so a reinstall of the tool keeps it.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from agent_mem.core.config import Config

# spaCy's packaged models, downloaded into agent-mem's model directory so a reinstall of the tool keeps them.
SPACY_VERSION = "3.8.0"
SPACY_URL = "https://github.com/explosion/spacy-models/releases/download/{name}-{v}/{name}-{v}-py3-none-any.whl"
SPACY_SHA256 = {
    "de_core_news_sm": "fec69fec52b1780f2d269d5af7582a5e28028738bd3190532459aeb473bfa3e7",
    "en_core_web_sm": "1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85",
}


def model_path(config: Config) -> Path | None:
    """The downloaded model for ``observe.entity_model``, or None."""
    name = config.observe.entity_model
    path = config.model_dir / "spacy" / name / f"{name}-{SPACY_VERSION}"
    return path if (path / "config.cfg").is_file() else None


def _fetch(url: str, path: Path) -> None:
    """With a timeout: urlretrieve has none and waits for good on a stalled connection."""
    with urllib.request.urlopen(url, timeout=60) as response, open(path, "wb") as out:
        shutil.copyfileobj(response, out)


def download_model(config: Config) -> Path:
    """Fetch the wheel of ``observe.entity_model`` from spaCy's releases and unpack the model directory.
    Known models are checked against a pinned SHA-256."""
    name = config.observe.entity_model
    if not re.fullmatch(r"[a-z]{2,3}_[a-z_]+_(sm|md|lg|trf)", name):
        raise ValueError(f"{name!r} is not a spaCy model name such as de_core_news_sm")
    target = config.model_dir / "spacy" / name
    with tempfile.TemporaryDirectory() as tmp:
        wheel = Path(tmp) / "model.whl"
        _fetch(SPACY_URL.format(name=name, v=SPACY_VERSION), wheel)
        expected = SPACY_SHA256.get(name)
        if expected and hashlib.sha256(wheel.read_bytes()).hexdigest() != expected:
            raise ValueError(f"{name}: download does not match the pinned checksum")
        prefix = f"{name}/{name}-{SPACY_VERSION}/"
        with zipfile.ZipFile(wheel) as archive:
            for member in archive.namelist():
                if member.startswith(prefix) and ".." not in member:
                    archive.extract(member, target.parent)
    path = model_path(config)
    if path is None:
        raise ValueError(f"{name}: the download holds no model directory")
    return path
