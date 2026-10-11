# Plan: Extern zuerst, wenig eigener Code

Stand: 2026-10-12. Ersetzt die Reihenfolge und den Umfang von `PLAN.md`, `REBUILD.md` und `STACK.md`. Der Memory-Agent (`PLAN.md` §3.1) bleibt als Zugang pro Harness, siehe unten.

## 1. Leitregel
Eigener Code nur dort, wo es kein fertiges Open-Source-Teil gibt. Alles andere wird eingekauft, gepinnt und nicht gepflegt.

Eigen bleibt nur, was kein Fremdprojekt liefert: Hook-Capture pro Harness, Injection mit Deadline, Privacy-Filter, die dünne Anbindung des Memory-Agents und die Widerspruchsschicht.

## 2. Stack: extern gegen eigen

| Aufgabe | Lösung | Eigener Code |
|---|---|---|
| Extraktion, Dedup, Speichern, Suche | `mem0ai` (pinnen, aktuell 2.2.1) | Konfiguration |
| LLM für mem0 | Memory-Agent aus §3 (Abo-Login) | je Harness ca. 30 Zeilen |
| Embedder | mem0-Provider `fastembed` (vorhanden) | keiner |
| Vektor-Store | mem0-Provider `qdrant` im Pfad-Modus (eingebettet, kein Server) | keiner |
| MCP-Server | offizielles `mcp`-SDK (FastMCP), 4 Tools über mem0 | ca. 60 Zeilen |
| Hook-Capture, Spool, Privacy, Identität | vorhanden (`capture`, `normalize`, `spool`, `privacy`, `identity`) | wird behalten |
| Widerspruch (`invalid_at`) | eigene Schicht über mem0 `update`/`delete` | klein, siehe §4 |
| Benchmarks | offizielle LongMemEval- und LoCoMo-Repos | nur Adapter |
| Viewer | bleibt unverändert, Nutzung wird später entschieden | keiner neu |

Zu Phase 0 gehört die Prüfung, ob Qdrant im Pfad-Modus Hybridsuche (Keyword) in mem0 liefert. FAISS kann das nicht, mem0 warnt dort selbst. Die mem0-eigenen MCP-Server (Cloud mit Key, OpenMemory mit Docker) habe ich nicht neu geprüft und gehe nach altem Wissen davon aus, dass sie nicht passen. Deshalb der schmale eigene Wrapper.

## 3. Der Memory-Agent

### 3.1 Zugang pro Harness
Die Tabelle aus `PLAN.md` §3.1 gilt unverändert (Claude: `claude -p`, Codex: `codex exec --output-schema`, Copilot: SDK oder `copilot -p`, OpenCode über Claude/Codex). Neu ist, wie er an mem0 hängt:

```python
class ClaudeCliLLM(LLMBase):   # mem0.llms.base
    def generate_response(self, messages, response_format=None, tools=None, **kw):
        ...  # subprocess: claude -p ..., Prompt über stdin, Text zurück
memory = Memory.from_config(cfg); memory.llm = ClaudeCliLLM(...)
```

Verifiziert am 2026-10-12 (Spike, `scratchpad/mem0b/spike_cli.py`): mem0 lief mit `claude -p --model haiku` unter dem Abo-Login, ohne Key, ohne Daemon. Zwei Korrekturen am Entwurf in `evidence/observer-cli-flags.md`:
- `--bare` bricht das Login („Not logged in"). Es darf nicht verwendet werden.
- Funktionierende Isolation: `claude -p --restricted --setting-sources "" --tools "" --strict-mcp-config --no-session-persistence --model haiku`, Arbeitsverzeichnis leer, `AGENT_MEM_INTERNAL=1`. Ohne `--setting-sources ""` laufen fremde Plugin-Hooks (z. B. claude-mem) im Beobachter mit.
- mem0 validiert Provider-Namen fest. Der Provider wird deshalb nach `from_config` per `memory.llm = …` gesetzt, nicht per Config.

Codex und Copilot bekommen dieselbe Klasse mit anderem Subprozess, Phase 0 prüft sie einzeln.

### 3.2 Beobachten
Turn-Bündel aus dem Spool (Prompt, gekürzte Tool-Calls, Antwort, deterministische Anhänge) gehen als `messages` an `memory.add(..., user_id, metadata={project, harness, session, turn})`. mem0 extrahiert und dedupliziert selbst. Der eigene Prompt/Schema-Code aus `PLAN.md` §3.2 entfällt, solange mem0s Extraktion die Messung besteht. Ausfall wie bisher: Turn bleibt im Spool, Retry mit Backoff, rohe Beobachtung als Fallback.

### 3.3 Lernen
Von den Jobs in `PLAN.md` §3.3 bleiben zunächst zwei: `observe` (mem0 `add`) und `resolve` (§4). `lesson`, `rule`, `reflect`, `evolve`, `consolidate` werden erst gebaut, wenn Messungen zeigen, dass sie fehlen.

## 4. Widerspruchsschicht
mem0 2.2.1 fügt bei Korrekturen nur hinzu (getestet mit `qwen3.5:4b`, `qwen3.6:35b` und `claude haiku`: jeweils zwei ADDs, der alte Fakt bleibt gültig). Nach jedem `add` sucht ein Schritt die Top-5 ähnlichen Fakten, gibt sie mit dem neuen Fakt an den Memory-Agent und bekommt je Paar `KEEP` oder `SUPERSEDE` zurück. Bei `SUPERSEDE` wird der alte Fakt per `metadata.invalid_at` markiert (mem0 `update`), nicht gelöscht. Die Suche filtert standardmäßig auf Fakten ohne `invalid_at`.

## 5. Injection und MCP
- SessionStart und UserPromptSubmit: `memory.search` mit Filter auf Projekt und `invalid_at` leer, höchstens 3 Treffer, als Daten gerahmt, Deadline wie bisher. Hook-Pfad bleibt Standardbibliothek, mem0 wird nur im Memory-Agent-Prozess importiert (Import ist schwer).
- MCP-Tools: `mem_search`, `mem_get`, `mem_remember`, `mem_forget`.
- Durchsetzung (Deny, Rezepte, Dead Ends) ist nicht Teil der ersten Lieferung. Der Viewer bleibt, siehe §10.

## 6. Phasen
| Phase | Inhalt | Fertig, wenn |
|---|---|---|
| 0 (3 Tage) | **Go/No-go:** reines mem0 (Ollama und `claude -p`) auf dem 25-Fälle-Fixture messen; Zugriffsmodell aus §9.1 testen; Qdrant-Hybridsuche prüfen; Codex- und Copilot-Subprozess prüfen; mem0 pinnen | Zahlen liegen vor und die Schwellen aus §9.3 sind erfüllt, sonst Stopp |
| 1 (4 Tage) | Spool → Memory-Agent → mem0 → Injection für Claude Code; Widerspruchsschicht | echte Session erzeugt Fakten, nächste Session bekommt sie, Korrektur löst alten Fakt ab |
| 2 (2 Tage) | Messung: LongMemEval-S gegen reines mem0 und gegen diesen Stack, dazu Fixture erneut | Zahlen im Plan-Anhang |
| 3 (3 Tage) | Codex und Copilot anbinden, OpenCode über Claude/Codex | je Harness eine echte Session |
| 4 | Löschen nur ohne Viewer-Abhängigkeit: `semantic`, `summarize`, `importers`, `evaluate`, Vektor-Indexer. `search`, `store`, `consolidate`, `learn`, `health` und das DB-Schema bleiben, solange der Viewer sie importiert (`views.py`, `viewer/__init__.py`). Ihre Abschaffung folgt der Viewer-Entscheidung aus §10.1 | Tests grün, Viewer rendert |

Insgesamt etwa 11 Arbeitstage statt 36 plus Dogfooding. Danach 2 Wochen Dogfooding, dann Entscheidung über `lesson`/`rule`/Graph anhand der Messung.

## 7. Risiken
- mem0 ist ein Fremdprojekt mit schneller Versionsfolge. Gegenmittel: Pin, ein Adapter-Modul (`memory.py`), Test gegen genau diese Version.
- `memory.llm` zu überschreiben ist ein interner Eingriff. Gegenmittel: Test, der beim Upgrade bricht.
- Latenz pro `add` über `claude -p` liegt im Sekundenbereich. Gegenmittel: läuft im Hintergrund, nie im Hook.
- Quota des Abos. Gegenmittel: Raw-Fallback und Tageslimit.
- mem0-Telemetrie: `MEM0_TELEMETRY=False` im Memory-Agent-Prozess, per Test abgesichert.
- Der Spike ist eine Einzelprobe (zwei Sätze). Die Qualität beweist erst Phase 2.

## 8. Graph-Memory (Entscheidung 2026-10-12): kein Neo4j
- mem0 2.2.1 hat den Neo4j-Graph-Store nicht mehr. Im installierten Paket gibt es kein `graph_store`, kein Neo4j, Kuzu oder Memgraph. Stattdessen extrahiert es Entitäten mit spaCy (PROPER, QUOTED, TOPIC, IDENTIFIER) und legt sie in einer zweiten Collection im Vektor-Store ab (`entity_store`), um Treffer zu verknüpfen und höher zu gewichten. Das ist der eingebaute Graph-Ersatz und kostet keinen Server.
- Neo4j wäre ein dauerhaft laufender JVM-Server (Daemon, Port, Backup, Updates) für einen Nutzer mit voraussichtlich unter 100.000 Fakten. Das widerspricht dem Ziel, weniger zu pflegen.
- Phase 0 ergänzt: `pip install mem0ai[nlp]` (spaCy) aktivieren und prüfen, dass der Entity-Store gefüllt wird.
- Phase 2 misst Multi-Hop-Fragen (LongMemEval, Kategorien multi-session und temporal-reasoning). Nur wenn diese Kategorie klar zurückbleibt, wird ein echter Graph geprüft: Graphiti mit FalkorDB (Neo4j nur, wenn FalkorDB nicht reicht). Das ist dann ein eigener Spike mit Messung, kein Vorab-Einbau.

## 9. Nachbesserungen (2026-10-12, aus Messungen)

### 9.1 Zugriffsmodell: Qdrant erlaubt nur einen Prozess
Gemessen: Ein zweiter Prozess auf demselben Qdrant-Pfad bricht ab („Storage folder … already accessed by another instance"). Parallele Sessions und Harnesses würden kollidieren. Lösung:
- Genau ein Schreiber: der Memory-Agent, serialisiert über `filelock` (schon Abhängigkeit). Jede Operation öffnet den Store, arbeitet und schließt ihn wieder, immer unter dem Lock.
- Der Hook importiert mem0 nie. Er liest einen Snapshot (`injection/<projekt>.json` mit den obersten Fakten), den der Memory-Agent nach jedem `add` neu schreibt. So bleibt der Hook schnell und lockfrei.
- MCP-Suche öffnet den Store kurz unter demselben Lock mit Timeout und antwortet bei Zeitüberschreitung aus dem Snapshot.
- Phase 0 testet das mit zwei parallelen Prozessen. Fällt der Test durch, ist Chroma (`PersistentClient`) der Ersatz-Store, nicht ein Qdrant-Server.

### 9.2 Eigene Wahrheit: Event-Log, mem0 ist ein Index
Der append-only Spool/Event-Log bleibt die Quelle. Der mem0-Bestand ist daraus neu aufbaubar (`agent-mem reindex`). Das macht mem0-Versionswechsel, Modellwechsel und Provider-Ausfall unkritisch und begrenzt die Abhängigkeit von einem Fremdprojekt.

### 9.3 Messung zuerst, mit Stoppregeln
Phase 0 misst, bevor gebaut wird. Maßstab ist der Bestand aus der früheren Messung (25-Fälle-Fixture, hit@1 hybrid 0,80, Abstention 3/5 richtig). Stopp oder Plan ändern, wenn mem0 plus Widerspruchsschicht darunter liegt, bei Abstention schlechter ist oder `add` im Median über 10 s braucht. Gemessen wurde bisher: 3,4 s pro `add` mit Haiku über `claude -p`, `search` unter 0,1 s (Einzelmessung).

### 9.4 Provider-Kette statt Einzelpfad
Reihenfolge je Harness: Abo-Login des Harness → lokales Ollama (läuft, getestet mit `qwen3.5:4b` und `qwen3.6:35b`) → rohe Beobachtung im Spool. Quota-Fehler wechseln auf die nächste Stufe, nichts geht verloren.

### 9.5 Privacy vor mem0
`privacy.clean_text` läuft auf dem Bündel vor `memory.add` und noch einmal auf jedem extrahierten Fakt vor dem Speichern. Quellen mit `tool_external` erzeugen nie Regeln oder Präferenzen (Regel aus `AGENTS.md`). Jeder Fakt trägt `project`, `harness`, `session`, `turn` als Metadaten, Suche filtert auf `project`.

### 9.6 Takt
Ein `add` pro Turn, nicht pro Tool-Call. Mehr als ein Turn in der Warteschlange wird zu einem Bündel zusammengefasst. Tageslimit für Aufrufe, danach Stufe 2 oder 3 aus §9.4.

## 10. Viewer und Hintergrund-Beobachtung (Entscheidung 2026-10-12)

### 10.1 Viewer bleibt
`viewer/` und `views.py` werden nicht gelöscht und nicht angefasst. Sie lesen weiter aus der SQLite-Datenbank, die das Hook-Capture schreibt (Sessions, Turns, Events, Spool, §9.2). Was der Viewer aus mem0-Fakten zeigen soll (Fakten-Liste, Zeitachse, Entitäten), wird später entschieden. Bis dahin zeigt er den Event-Log. Löschen in Phase 4 betrifft ihn nicht: Er importiert `consolidate`, `learn`, `search`, `store` und `health` und liest die Tabelle `memories`. Diese Module und das Schema bleiben deshalb vorerst.

### 10.2 Beobachtung läuft im Hintergrund, nie im Hook
Das war schon Absicht und wird hier festgeschrieben:
1. Der Hook schreibt nur das Event in Spool/SQLite und kehrt sofort zurück (Millisekunden, Standardbibliothek, keine LLM-Aufrufe).
2. Danach startet der Hook losgelöst (`start_new_session`, Ausgabe nach `/dev/null`) den Befehl `agent-mem observe`, falls kein Worker den Lock hält. Es gibt keinen Daemon: Der Worker arbeitet die Warteschlange ab (`claude -p` → mem0 → Snapshot, §9.1) und beendet sich, wenn sie leer ist.
3. Läuft schon ein Worker, tut der Hook nichts weiter. Der Worker nimmt neue Turns beim nächsten Durchlauf mit.
4. Fehler, Quota oder Absturz des Workers lassen den Turn im Spool (§9.4). Die Session merkt davon nichts.
5. Die Session verlangsamt sich nur durch das, was der Hook liest: den Snapshot. Der Abruf der Fakten kostet damit Dateizugriffe, keine Modellaufrufe.

Prüfen in Phase 1: Hook-Laufzeit mit und ohne Worker messen. Sie soll beide Male unter 100 ms liegen.
