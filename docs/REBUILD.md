# Neuaufbau: Struktur, Übernahme, Löschung

Stand: 2026-10-08. Das Projekt wird von Grund auf neu aufgebaut. Der bisherige Code (Tag `v1.0.0`, 138 Commits, 6231 Zeilen in 33 Modulen) wird als Steinbruch genutzt, nicht als Basis. Es gibt keine Migration vom alten Schema, weil nichts davon in Produktion ist (0 Sessions auf dieser Maschine). Der alte Stand bleibt als Tag `v1.0.0` erreichbar und wird aus `main` entfernt.

## 1. Vergleich der lokalen Modell-Last

| | claude-mem 13.24.1 | agentmemory 0.9.29 | Agent Mem neu |
|---|---|---|---|
| Embedding | `all-MiniLM-L6-v2` (englisch, 384d) über `uvx chroma-mcp` + onnxruntime als Subprozess (`ChromaMcpManager.ts:46`) | `Xenova/all-MiniLM-L6-v2` (englisch) über `@huggingface/transformers`, nur mit `EMBEDDING_PROVIDER=local` (`providers/embedding/local.ts`) | ein multilinguales Modell über fastembed/ONNX, im Prozess, immer an |
| Reranker | keiner | `Xenova/ms-marco-MiniLM-L-6-v2`, nur mit `RERANK_ENABLED` (`state/reranker.ts`) | optional, aus |
| Bild | keines | `Xenova/clip-vit-base-patch32` für Vision-Suche (`providers/embedding/clip.ts`) | keines; der Beobachter beschreibt Bilder |
| Tokenisierung | keine | `jieba`, `tiny-segmenter` für CJK, handgeschriebener Porter-Stemmer, 41 Synonymgruppen | FTS5 Trigram, sprachunabhängig, keine Zusatzpakete |
| Graph | keiner | Datei-Adjazenz-Heuristik, Dijkstra | Ko-Okkurrenz plus Beobachter-Konzepte, PPR in numpy |
| LLM | Haiku-Beobachter über Abo oder Provider-Key | Provider-Key, sonst nichts | Beobachter über Abo-Login pro Harness, kein Key |

Zur Laufzeit lädt Agent Mem genau ein lokales Modell, das Embedding. Das ist weniger als agentmemory (bis zu drei plus zwei Segmenter) und gleich viel wie claude-mem, aber multilingual und ohne Python-Subprozess über `uvx`. Die Liste in `STACK.md` nennt Kandidaten, aus denen per Messung einer gewählt wird.

Was die Paper über beide hinaus erlauben, steht in `DESIGN.md` §9: ergebnis-gelabelte Fälle, Selbstkorrektur des Gelernten, Belegart, Anker-Staleness, Cross-Harness-Transfer, zustandsloser Beobachter mit Spool, Wiederholungsrate als Metrik. Nichts davon braucht ein weiteres lokales Modell.

## 2. Neue Paketstruktur

```
src/agentmem/
  capture/        Hooks → Events → Turns. Standardbibliothek.
    hook.py         Einstieg `agentmem hook <harness> <event>`, Deadline, Spool-Fallback
    normalize/      claude.py, codex.py, copilot.py, opencode.py → Event
    events.py       Event, Turn, Dedupe-Schlüssel
    spool.py        Write-behind, Replay
    privacy.py      Redaction, Excludes, Private-Blöcke
    identity.py     Projekt, Worktree, Git-Anker
    signals.py      Tool-Kategorien, Befehlsschlüssel, Fehlersignaturen, Signal-Erkennung (nur Zünder)
  memory/         Datenmodell und Schreibpfade.
    db.py           Verbindung, Migrationen (ab 001 neu), Backups, Integrität
    schema/001_init.sql
    observations.py Beobachtungen, Revisionen, Supersede, Status
    episodes.py     Episoden öffnen/schließen, Credit Assignment, Fälle
    procedural.py   Fälle, Lektionen, Regeln, Rezepte mit Zählern
    core.py         Core-Block (user, project, rules), Versionen, Caps
    notes.py        Session-Notes
    graph.py        Entitäten, Kanten, Konzepte, Synonymkanten
    accesses.py     shown/used/cited/followed/denied/overridden
  observer/       Memory-Agent im Hintergrund.
    bundle.py       Turn-Bündel aus Spool/DB bauen, kürzen, Ähnliche beilegen
    prompt.py       Beobachter-Identität, Schema, Skip-Regeln
    schema.py       JSON-Schema und Validierung der Ausgabe
    runner.py       Prozess, Slots, Retry, Budget, Fallback roh
    adapters/       claude.py (`claude -p`), codex.py (`codex exec`), copilot.py (SDK/-p)
    jobs.py         observe, resolve, lesson, rule, reflect, evolve, revise, consolidate, summarize
  retrieval/      Suche und Ranking.
    lexical.py      FTS5, Präfix, Key Expansion
    vectors.py      Embedding-Registry, Kalibrierung, Matmul
    graph_search.py PPR mit Spezifität
    fuse.py         RRF über aktive Streams, Agreement-Bonus, Diversität
    score.py        Aktivierung, Wichtigkeit, Nutzung, Trust, R
    timefilter.py   dateparser, since/until, as_of
    abstain.py      Mindestscore, Stütze
  serve/          Was der Session-Agent sieht.
    inject.py       Budgets, Datenrahmen, Chronologie, Chain-of-Note
    briefing.py     Start-Index, Core-Block, offene Episoden, Lektionen
    decision.py     PreToolUse: Deny, Warnung, Fall, Datei-Timeline; Fehler-Hook
    mcp.py          sechs Tools
  learn/          Deterministische Lernschleife.
    activation.py   ACT-R
    feedback.py     Nutzung erkennen, Zähler, Konsequenzen (§4 DESIGN)
    retention.py    Verblassen, Tiers
    scheduler.py    Jobs mit Lease, Budget, Leerlauf
  viewer/         statisch und --live
  eval/           Fixture, LongMemEval, agentmemory-Adapter, Gold-Beleg-Set, Online-Metriken
  cli/            status, doctor, setup, models, view, search, show, rules, lessons, cases, jobs, pause, purge, backup, restore, import, export, eval
plugins/          claude/, codex/, copilot/, opencode/
tests/
docs/             PLAN.md, DESIGN.md, STACK.md, REBUILD.md, evidence/
```

Paketname `agentmem`, Befehl `agent-mem` bleibt.

## 3. Übernahme aus dem bisherigen Code

| Bisher | Neu | Was sich ändert |
|---|---|---|
| `hook.py` 224 Z. | `capture/hook.py` | unverändert im Kern; Stop ruft keine Erzwingung |
| `normalize/*` 4 Dateien | `capture/normalize/` | Copilot: `agentStop`, `postToolUse additionalContext` ergänzen |
| `events.py`, `spool.py`, `privacy.py`, `identity.py` | `capture/` | unverändert |
| `signals.py` 380 Z. | `capture/signals.py` | Korrektur-/Präferenz-Regex bleiben als Signal, Schreibpfade entfallen; neue Signale (Bestätigung, Wiederholung, Überlange Suche) |
| `capture.py` 686 Z. | aufgeteilt in `memory/observations.py`, `memory/episodes.py`, `memory/procedural.py` | Rezepte werden Episoden/Fälle; Regel-Schreibpfad geht an den Beobachter; Dead Ends werden Fälle mit `outcome = abandoned` |
| `db.py`, `schema/001_init.sql` | `memory/db.py`, neues `001_init.sql` | Migrationsmechanik bleibt, Schema neu, keine Altmigration |
| `store.py` | `memory/observations.py`, `memory/graph.py` | Memories → Observations |
| `search.py` 451 Z. | `retrieval/lexical.py`, `fuse.py`, `abstain.py` | RRF über aktive Streams, Präfix, Key Expansion |
| `semantic.py` 374 Z. | `retrieval/vectors.py`, `graph_search.py`, `timefilter.py` | Registry statt Custom-Modell-Hardcode, PPR-Spezifität |
| `learn.py` 130 Z. | `learn/activation.py`, `learn/feedback.py` | Zähler und Konsequenzen neu |
| `consolidate.py` 197 Z. | `learn/retention.py`, Beobachter-Job `consolidate` | Titelvergleich entfällt |
| `inject.py` 293 Z. | `serve/inject.py`, `serve/briefing.py`, `serve/decision.py` | Index-Format, Deny, Fälle |
| `mcp_server.py` | `serve/mcp.py` | sechs Tools |
| `indexer.py`, `health.py`, `config.py`, `timeutil.py`, `logutil.py` | `learn/scheduler.py`, `cli/`, `config.py` | Scheduler bekommt Jobs und Budget |
| `importers.py` 417 Z. | `cli/import.py` | claude-mem und agentmemory auf neues Schema, Compaction-Summaries |
| `evaluate.py` | `eval/longmemeval.py` | plus Adapter und Fixture |
| `viewer/` | `viewer/` | Ansichten neu, Gerüst und CSP bleiben |
| `plugins/*` | `plugins/*` | Versionen, Copilot-Events |
| `tests/` 12 Dateien | `tests/` | nach Modulen neu geschnitten, Fixtures übernehmen |

## 4. Gelöscht

`summarize.py`, `federate.py` (natives Harness-Memory wird nicht mehr gelesen; Nutzer entscheidet sich für ein Memory), `views.py` (durch `serve/briefing.py` ersetzt), `commands.py` (in `cli/` aufgeteilt), `memories`-Tabelle, Regel-Auto-Enable per Regex, `rules.auto_enable` ohne Nutzerbestätigung, Reranker-Default, alle Provider- und Key-Optionen, alte Migrationen, `CHANGELOG.md` (beginnt neu bei 0.1.0), `ARCHITECTURE.md` (ersetzt durch `DESIGN.md`).

## 5. Git

- `main` wird auf einen neuen Wurzel-Stand gesetzt, der alte Stand bleibt unter Tag `v1.0.0` und Branch `archive/v1`.
- Version beginnt bei `0.1.0`, Release-Ziel `1.0.0` nach Dogfooding.
- Keine Co-Author-Zeilen, keine Generator-Hinweise.
