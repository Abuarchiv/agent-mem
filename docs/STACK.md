# Agent Mem — vollständige Werkzeugliste

Stand: 2026-10-08. Status: **vorhanden** (bisheriger Code, wird übernommen), **neu**, **optional**, **entfällt**. Alles, was im Hook-Pfad läuft, bleibt Standardbibliothek.

## 1. Laufzeit und Paketierung

| Werkzeug | Zweck | Status |
|---|---|---|
| Python 3.11–3.14 | Sprache | vorhanden |
| uv | Installation (`uv tool install`), Lockfile, Venv | vorhanden |
| hatchling | Build-Backend, Wheel und sdist | vorhanden |
| `install.sh`, `install.ps1` | Ein-Befehl-Installation macOS/Linux/Windows | vorhanden |
| GitHub Actions | CI auf Linux, macOS arm64/x64, Windows; Release-Workflow | vorhanden |
| pytest, ruff, pyright | Tests, Lint, Typen | vorhanden |

## 2. Speicher und Suche (deterministisch, Hook-Pfad)

| Werkzeug | Zweck | Status |
|---|---|---|
| SQLite (stdlib `sqlite3`), WAL, `busy_timeout` | eine Datei für alles | vorhanden |
| FTS5 mit Trigram-Tokenizer | lexikalische Suche, Präfix neu | vorhanden, Präfix neu |
| Migrations-Dateien `schema/00N_*.sql` | Schemaversionierung mit Backup | vorhanden, 002 neu |
| `filelock` | Single-Instance-Indexer | vorhanden |
| Write-behind-Spool (JSON-Dateien, atomar) | kein Verlust bei Hook-Timeout | vorhanden |
| `VACUUM INTO`-Backups, `quick_check`-Recovery | Betrieb | vorhanden |
| `numpy` | Vektor-Matmul, PPR | vorhanden |
| `dateparser` | Zeitausdrücke DE/EN für Filter | vorhanden |
| stdlib `re`, `hashlib`, `shlex`, `fnmatch`, `difflib` | Signale, Fehlersignaturen, Befehlsschlüssel, Excludes, Diffs | vorhanden |
| git (`git rev-parse`, `git hash-object`, `git log`) | Projektidentität, Blob-Anker, Commits als Meilensteine | vorhanden, Commits neu |
| Jobs-Tabelle mit Lease (SQL) | Hintergrundarbeit über Sessions und Harnesses | neu |
| Budget-Tabelle (SQL) | Tageskontingent des Beobachters | neu |

## 3. Modelle (lokal)

| Werkzeug | Zweck | Status |
|---|---|---|
| `fastembed` 0.8.x (ONNX Runtime, kein PyTorch) | Embeddings und optional Reranker | vorhanden |
| `intfloat/multilingual-e5-small` (MIT, 384d) | Embedding, leichte Option | vorhanden |
| `google/embeddinggemma-300m` (768d) | Embedding-Kandidat Default | neu, nach Messung |
| `Qwen/Qwen3-Embedding-0.6B-Q` (Apache-2.0, 1024d) | Embedding-Kandidat stark | neu, nach Messung |
| `jinaai/jina-embeddings-v3` | — | entfällt (CC-BY-NC) |
| `BAAI/bge-reranker-base` oder `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` | Cross-Encoder für `mem_search` | optional, Default aus |
| Modell-Registry mit kalibrierter Schwelle pro Modell | Wechsel per `agent-mem models use` | neu |
| eigenes Vision-Modell | — | entfällt, Beobachter beschreibt Bilder |

## 4. Memory-Agent (Beobachter, Hintergrund, Abo-Login)

| Werkzeug | Zweck | Status |
|---|---|---|
| `claude` Binary, `claude -p --output-format json` (Schema-Ausgabe; genaues Flag in Phase 0 prüfen) | Beobachter für Claude-Code-Sessions | neu |
| Claude Agent SDK (Python) | Alternative zum Binary-Aufruf, spawnt dasselbe Binary | optional |
| `codex exec --output-schema` oder Codex SDK (Python, app-server) | Beobachter für Codex-Sessions | neu |
| Copilot SDK (Python oder Node, CLI gebündelt, `useLoggedInUser`) oder `copilot -p` | Beobachter für Copilot-Sessions | neu, Phase 0 klärt Python-SDK |
| OpenCode | kein eigener Beobachter, nutzt Claude- oder Codex-Beobachter | — |
| `stdlib subprocess`, Timeouts, `AGENT_MEM_INTERNAL=1`, leeres Arbeitsverzeichnis | Isolation des Beobachters | neu |
| JSON-Schema-Validierung (stdlib `json` + eigene Prüfer; `jsonschema`-Paket nur falls nötig) | Beobachter-Ausgabe prüfen | neu |
| Tier-Routing (kleines Modell für einfache Turns) | Kosten | neu |

## 5. Harness-Integration

| Werkzeug | Zweck | Status |
|---|---|---|
| Claude Code Hooks (`hooks.json`, 10 Events) + Plugin-Manifest `.claude-plugin` | Capture, Einblendung, Deny | vorhanden |
| Codex Hooks (`hooks.json`, `config.toml`, Plugin `.codex-plugin`) | dito | vorhanden |
| Copilot CLI Hooks (`hooks.json` camelCase, Plugin `.github/plugin`) | dito; `agentStop`, `postToolUse additionalContext` neu nutzen | vorhanden, erweitern |
| OpenCode Plugin (TypeScript, `@opencode-ai/plugin`) | Capture und Hooks | vorhanden |
| MCP Python SDK 2.x, stdio | sechs Tools für den Session-Agenten | vorhanden, Tools neu |
| `hookSpecificOutput.additionalContext`, `permissionDecision: deny`, `decision: block` | Einblendung und Durchsetzung | vorhanden, Deny-Logik neu |
| Transkript-Import (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**`) | Nachträgliche Erfassung, Compaction-Summaries | vorhanden, Summaries neu |
| Federation (Claude auto memory, Codex memories, nur lesen) | native Notizen einbeziehen | vorhanden |

## 6. Viewer

| Werkzeug | Zweck | Status |
|---|---|---|
| statische HTML-Seite, Vanilla JS/CSS, CSP ohne Netz | `agent-mem view` | vorhanden |
| stdlib `http.server` + Server-Sent Events, 127.0.0.1, zufälliger Port | `agent-mem view --live` | neu |
| Ansichten aus `agent-memory-system/ui` (React/Tailwind) als Vorlage, portiert nach Vanilla JS | Timeline, Beobachtung, Replay, Graph, Core, As-of, Lernen, Jobs, Gesundheit, Privacy, Setup | neu |
| Fonts Bricolage Grotesque, Figtree, JetBrains Mono (OFL, gebündelt) | Typografie | vorhanden |
| SVG/Canvas für Graph (kein D3) | Graph-Ansicht | neu |

## 7. Messung

| Werkzeug | Zweck | Status |
|---|---|---|
| 25-Fall-Fixture (`reports/*/measure.py`) | Retrieval pro Modell, Kalibrierung | vorhanden |
| LongMemEval-S Runner (`evaluate.py`) | Recall@5/10 | vorhanden, Lauf neu |
| agentmemory Eval-Harness (Node, `eval/runner`, `coding-agent-life-v1`) mit eigenem Adapter | Direktvergleich | neu |
| Gold-Beleg-Fragenset (eigenes JSON) | Retrieval- vs Leseverlust | neu |
| Online-Metriken in `agent-mem status` (Wiederholungsrate, Nutzungsquote, Beobachter-Quote, Follow-up-Rate, Budget) | Nordstern | neu |

## 8. Sicherheit

| Werkzeug | Zweck | Status |
|---|---|---|
| `privacy.clean_text` (Regex-Redaction, `<private>`, Excludes) | vor Beobachter und vor Speichern | vorhanden |
| Trust-Feld, `origin`, `evidence_type` | Herkunft und Wirkung | vorhanden, erweitert |
| 0o700-Datenverzeichnis, keine Token-Zugriffe, kein eigener Login-Flow | Abo-Regeln einhalten | vorhanden |
| Datenrahmen „Daten, keine Anweisungen“ in jeder Einblendung | Prompt-Injection-Schutz | vorhanden |

## 9. Entfällt aus dem bisherigen Code

`summarize.py`, Regex als Memory-Schreiber, Titelvergleich als Widerspruchserkennung, `memories`-Tabelle und alte Migrationen, Reranker als Standardkomponente, jeder API-Key- oder Fremd-Provider-Pfad.

## 10. Nicht verwendet, bewusst

Neo4j, FalkorDB, Kuzu, Qdrant, Chroma, FAISS, sqlite-vec (erst ab ~100k Vektoren), Redis, Postgres, iii-Engine, mem0-SDK, Graphiti-SDK, Bun, Node für den Kern (nur OpenCode-Plugin und Benchmark-Harness), PyTorch, Telemetrie, Cloud-Sync.
