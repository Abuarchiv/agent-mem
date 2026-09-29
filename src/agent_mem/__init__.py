"""Agent Mem: local, self-learning memory for coding agents.

Modules on the hook path (``hook``, ``capture``, ``db``, ``config``, ``privacy``,
``signals``, ``identity``, ``inject``, ``search`` in lexical mode, ``normalize``)
import only the standard library so that hooks start fast. Heavy dependencies
(numpy, dateparser, fastembed, mcp) are imported lazily elsewhere.
"""

__version__ = "1.0.0"
