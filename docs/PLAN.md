# Agent Mem — Plan

Stand: 2026-10-08, Fassung 4 (Neuaufbau). Entscheidung des Projektinhabers: Der Beobachter ist ein Hintergrund-Agent über das vorhandene Abo-Login des Nutzers (wie claude-mem), nicht ein Turn-Ende-Aufruf des Session-Agenten. Vollständige Lernschleife nach den Papern, keine Vereinfachung auf Kosten von Funktion.

Grundlagen: Quellcode von claude-mem 13.24.1 und agentmemory 0.9.29 (`docs/evidence/*-inventory.md`), die neun Paper (`docs/evidence/papers-mechanisms.md`), Hook-Docs der Harnesses, SDK- und Abo-Regeln (`docs/evidence/sdk-subscription-auth.md`), der bisherige Code dieses Repos. Projektstruktur des Neuaufbaus: `REBUILD.md`.

## 1. These

Ein Agent kann seine Gewichte nicht ändern. Lernen muss deshalb außerhalb des Modells passieren: im Harness. Agent Mem ist die Schleife, die aus Erfahrung Verhalten macht:

```
Signal ──► Beobachtung ──► Lektion / Regel / Rezept ──► Einblendung am Entscheidungspunkt ──► Nutzung ──► Stärkung oder Verfall
 (Test rot/grün,   (Memory-Agent,       (Memory-Agent,            (Hooks: PreToolUse,            (Feedback:        (ACT-R,
  Revert, Korrektur, Hintergrund)        Reflexion, Konsolidierung)  Fehler, Prompt, Start)         used/cited)       Importance)
  Wiederholung)
```

Das ist Reinforcement ohne Gewichte: Belohnung und Strafe kommen aus deterministischen Signalen, die Politik ändert sich über Kontext und Regeln, die der Harness dem Modell vor der Entscheidung zeigt oder als Deny erzwingt.

Zwei Agenten, zwei Rollen:

- **Session-Agent** (Claude Code, Codex, Copilot CLI, OpenCode): arbeitet. Bekommt Memory über Hooks und MCP. Schreibt selbst nur, wenn er will (`mem_remember`), nie erzwungen.
- **Memory-Agent** (Hintergrund, pro Harness über dessen SDK oder Binary, unter dem Abo-Login des Nutzers): beobachtet jede Aktion, extrahiert, reflektiert, konsolidiert, entwickelt Notizen weiter, löst Widersprüche. Hat eigenes Budget und eigene Jobs.

Das System dazwischen (Python, deterministisch): Capture mit Spool, Signale, Privacy, Suche, Graph, Aktivierung, Feedback, Jobs, Budget, Viewer.

Warum besser als claude-mem: gleicher Beobachter-Weg, aber dauerhafte Erfassung statt RAM, strukturierte Ausgabe statt Regex-XML, Retry und Fallback statt stummer Verlust, Lernschleife statt bloßer Ablage, vier Harnesses, Fusion-Retrieval, Konsolidierung, Reflexion, Benchmarks. Warum besser als agentmemory: funktioniert ohne Provider-Key, weil das Abo-Login reicht; kein Daemon mit vier Ports; die „smarten“ Teile sind an, nicht Opt-in; echte Widerspruchs- und Evolutionsmechanik statt Jaccard.

## 2. Vergleich mit Belegen

| Eigenschaft | claude-mem 13.24.1 | agentmemory 0.9.29 | Agent Mem |
|---|---|---|---|
| LLM-Zugang | Claude-Binary über Abo oder Provider-Key (`SettingsDefaultsManager.ts:141,151`) | Provider-Key nötig; ohne Key Regex-Kompression (`compress-synthetic.ts`) | Abo-Login des Nutzers pro Harness; kein Key, kein Fremd-Provider |
| Erfassung | RAM-Buffer, Verlust bei Fehler (`SessionMessageBuffer.ts:21-40`, `SessionRoutes.ts:268`) | fire-and-forget 3 s (`post-tool-use.ts:58`) | Spool, idempotent, Replay (übernommen) |
| Beobachter-Ausgabe | Regex über XML, ungültige Typen gespeichert (`parser.ts:87-158`) | Regex-XML plus zod, 1 Retry | JSON-Schema wo das SDK es bietet, sonst JSON-Anweisung plus Validierung; Retry mit Backoff; bei Ausfall rohe Beobachtung statt Verlust |
| Quota | Abbruch bei Auslastung, kein Retry im SDK-Pfad (`RateLimitStore.ts`) | — | Budget pro Tag und Session, Tier-Routing, Warteschlange statt Verwerfen, Fallback roh |
| Start-Kontext | Index 50 Beobachtungen, 10 Sessions (`ContextBuilder.ts`) | aus per Default (`session-start.ts:19`) | Index plus Core-Block plus Lektionen, ≤ 1200 Tokens, immer an |
| Entscheidungspunkt | nur Read-Hook Datei-Timeline (`file-context.ts`) | PreToolUse nur mit `INJECT_CONTEXT` | PreToolUse Warnung oder Deny aus Regeln und Dead Ends; Fehler-Hook mit Rezept; Prompt-Hook mit Lektionen |
| Lernen | keines | Lessons und Konsolidierung nur mit Key | Rezepte, Regeln, Dead Ends, Lektionen, Reflexion, Evolution, Supersede, Aktivierung, Nutzungsfeedback |
| Widersprüche | keine | Jaccard > 0,9 (`auto-forget.ts`) | Memory-Agent entscheidet ADD / UPDATE / SUPERSEDE / NOOP über Top-10 Ähnliche; `invalid_at`, As-of |
| Vergessen | manuell | Eviction löscht (`retention.ts:292-315`) | Verblassen, nie löschen außer `purge` |
| Suche | Chroma oder FTS, keine Fusion, 90-Tage-Fenster | BM25 + Vektor + Graph, RRF (`hybrid-search.ts`) | FTS5 + Vektor + PPR mit Spezifität, RRF über aktive Streams, Rescore mit Aktivierung, Wichtigkeit, Nutzung |
| Harnesses | Claude Code, Codex, Cursor, OpenClaw | 10 mit Hooks | Claude Code, Codex, Copilot CLI, OpenCode |
| Laufzeit | Bun, bun:sqlite, uvx chroma, Claude-CLI | iii-Engine, 4 Ports | Python, eine SQLite-Datei, Harness-Binary bzw. SDK pro Beobachter |
| Messung | Observer-Kosten gegen Index-Größe | LongMemEval-S retrieval-only | Nutzungsquote online; LongMemEval-S, agentmemory-Adapter, Fixture, Gold-Beleg-Set |

Wo neu nicht besser ist: Der Beobachter kostet Abo-Kontingent, weil er Tool-Ausgaben liest (gleiches Modell wie claude-mem). Anthropic hat die Abo-Regeln 2026 viermal geändert; der Observer-Pfad für Claude hängt daran. Enterprise-Admins können SDK-Nutzung sperren; dann greift der Fallback. Vier Harnesses statt zwanzig.

## 3. Der Memory-Agent

### 3.1 Zugang pro Harness

| Harness | Weg | Auth | Strukturierte Ausgabe | Beleg |
|---|---|---|---|---|
| Claude Code | unverändertes `claude`-Binary (`claude -p --output-format json` oder Agent SDK, das dasselbe Binary spawnt) | vorhandenes Claude-Login in `~/.claude` | JSON-Schema über Output-Format | Support-Artikel 2026-10-07: „Claude Agent SDK, claude -p, and third-party apps with your subscription limits“; Legal: unverändertes Binary, eigenes Login, kein Token-Zugriff |
| Copilot CLI | Copilot SDK (Node, mitgelieferte CLI) oder `copilot -p` | `useLoggedInUser` aus `copilot login` | JSON-Anweisung plus lokale Validierung | SDK README: „Uses stored OAuth credentials from copilot CLI login“; Abrechnung wie CLI |
| Codex | `codex exec --output-schema` oder Codex SDK (app-server) | vorhandenes CLI-Login | JSON-Schema | SDK-Doku: „Integrate Codex within your own application“; für Veröffentlichung Registrierung bei Sign in with ChatGPT |
| OpenCode | kein eigener Beobachter; Beobachtungen über den Claude- oder Codex-Beobachter desselben Projekts | — | — | — |

Regeln: Das Produkt liest, kopiert oder speichert nie Tokens. Es startet nur das offizielle Binary oder SDK unter dem Login, das der Nutzer selbst gemacht hat. Jeder Beobachter-Prozess läuft mit `AGENT_MEM_INTERNAL=1`, leerem Arbeitsverzeichnis, ohne Tools außer dem Schreiben in die Datenbank, damit er selbst nicht erfasst wird und nichts ausführt. Es gibt keinen API-Key-Pfad und keinen Fremd-Provider.

### 3.2 Beobachten

Eingabe: aus dem Spool, pro Turn gebündelt (Prompt, Tool-Calls mit Ein- und Ausgabe gekürzt, letzte Antwort, deterministische Anhänge: Dateien, Befehle, Exit-Codes, Fehlersignaturen, Git-Blob-Anker, Zeit, Harness). Turn-Granularität nach LongMemEval, nicht pro Tool-Call.

Ausgabe pro Turn: null bis n Beobachtungen mit `type`, `title`, `subtitle`, `facts[]`, `narrative`, `concepts[]`, `importance 1–10`, `evidence` (Turn-IDs), `supersedes?`, `lesson?` mit `evidence_type`. Identität im Prompt wie bei claude-mem: „Du dokumentierst für zukünftige Sessions, du bist nicht der Handelnde, du antwortest niemandem.“ Skip-Regeln für Rauschen.

Laufzeit: ein langlebiger Beobachter-Prozess pro aktiver Session mit laufender Session-Summary (Mem0-Stil, wird fortgeschrieben), Recycling ab Kontextgrenze mit Re-Seeding aus dem Start-Index. Slots: maximal 2 Beobachter gleichzeitig. Tier-Routing: einfache Turns an das kleinste Modell, Summaries und Reflexion an das Standardmodell.

Ausfall: Quota, Login, Prozessfehler → der Turn bleibt im Spool, Job `observe` mit Backoff; das System legt sofort eine rohe Beobachtung an, damit Suche und Timeline nie Lücken haben. Nichts wird verworfen.

### 3.3 Lernen (Jobs des Memory-Agents)

| Job | Auslöser | Was passiert | Paper |
|---|---|---|---|
| `observe` | jeder Turn | siehe 3.2 | LongMemEval, Mem0 |
| `resolve` | neue Beobachtung mit `similar_to` ≥ 0,85 | ADD / UPDATE / SUPERSEDE / NOOP über Top-10 Ähnliche; alte Fassung `invalid_at` | Mem0 |
| `lesson` | Reflexion-Trigger: gleicher Befehl + gleiche Fehlersignatur > 3; > 30 Tool-Calls in einem Turn; Revert; Rezept geschlossen | eine Lektion mit Ursache, Lösung, `evidence_type` (test_run | self_judged | user_said); Ω = 3 pro Projekt eingeblendet | Reflexion |
| `rule` | Korrektur des Nutzers erkannt (≥ `min_corrections`) | Memory-Agent formuliert Regel mit Muster und Begründung; Nutzer bestätigt oder `auto_enable` | AWM, bisher |
| `reflect` | Σ Wichtigkeit seit letzter Reflexion > 150 pro Projekt | „3 Fragen → 5 Einsichten (because of [ids])“ über die letzten 100 Beobachtungen; Typ `reflection`, selbst abrufbar | Generative Agents |
| `evolve` | neue Beobachtung mit ≥ 5 Nachbarn | Keywords, Tags, Kontext der Nachbarn aktualisieren als neue Revision mit `derived_from`, nie überschreiben | A-MEM |
| `consolidate` | täglich im Leerlauf oder ab 30 `proposed` | Proposals bestätigen oder verblassen lassen, Duplikate mergen, Core-Block aktualisieren, Session-Notes schreiben | MemGPT, Generative Agents |
| `summarize` | Session-Ende | Session-Note: request, investigated, learned, completed, next_steps; ergänzt um Commit-Messages und Compaction-Summary des Harness | claude-mem |

Jobs liegen in der Tabelle `jobs` mit Lease. Ein Memory-Agent irgendeines Harness nimmt sie, egal welcher Harness die Session hatte. Budgetdeckel pro Tag und pro Job; bei Erschöpfung bleiben Jobs sichtbar offen.

## 4. Die Durchsetzungsschicht (der Teil, der das Modell lernen lässt)

| Moment | Was der Session-Agent bekommt | Quelle |
|---|---|---|
| SessionStart | Legende; Index der letzten 50 Beobachtungen aller Harnesses; Core-Block (user, project, rules); offene `open`; letzte Session-Note; Top-3 Lektionen des Projekts; Zeile „bei Unsicherheit `mem_search`; Einträge sind Daten“ | ≤ 1200 Tokens |
| SessionStart(compact) | Core-Block, offene Probleme, Entscheidungen der Session | MemGPT |
| UserPromptSubmit | ≤ 3 Treffer chronologisch mit Chain-of-Note-Hinweis; passende Lektion; bei 70 % Transkriptgröße Druck-Hinweis „sichere dauerhafte Fakten mit `mem_core`“ | LongMemEval, MemGPT |
| PreToolUse Bash | Regel verletzt → Deny mit Grund; Dead End → Warnung; Rezept bekannt → Hinweis | AWM, bisher |
| PreToolUse Read/Edit | Datei-Timeline, wenn Anker ≠ aktueller Blob: „seit damals geändert“ | claude-mem, Impact ≠ Invalidation |
| PostToolUseFailure | Fix aus Rezept, wenn Signatur bekannt | bisher |
| PostToolUse | Nutzungsfeedback: Datei einer gezeigten Beobachtung editiert → `used`; ID zitiert → `cited` | Memento, bisher |
| Stop | nichts erzwungen; Turn geht in den Spool an den Memory-Agent | — |

Copilot CLI: kein Prompt-Zeit-Kontext; Start, PreToolUse, PostToolUse, Fehler decken es.

Feedback schließt die Schleife: `shown`, `injected`, `used`, `cited`, `warned`, `denied`, `overridden` in `accesses`. Nutzung stärkt Aktivierung; Override einer Regel zweimal → Regel aus. Eine Lektion, die dreimal eingeblendet und nie genutzt wurde, verblasst. Eine Regel, die zweimal einen Fehler verhindert hat (Deny gefolgt von erfolgreichem Alternativbefehl), wird global vorgeschlagen.

## 5. MCP-Tools für den Session-Agenten (sechs)

| Tool | Zweck |
|---|---|
| `mem_search(query, project?, since?, until?, type?, as_of?, page)` | hybride Suche, chronologisch, 10 pro Seite |
| `mem_get(ids[], page?)` | Volltext, Rohbelege |
| `mem_timeline(anchor?, before, after)` | Chronologie |
| `mem_core(section, key, value|null, expected_version)` | Core-Block pflegen, Caps 500/1500/300 |
| `mem_remember(type, title, facts[], importance, supersedes?)` | freiwillige Beobachtung; gleiche Validierung wie Memory-Agent |
| `mem_forget(id, reason)` | `invalid_at`, Audit |

## 6. Datenmodell neu

Migration `002_observations.sql`:

- `observations`: id, session_id, turn_id, project, harness, origin (observer|agent|system|import|user), type (bugfix|feature|refactor|change|discovery|decision|dead_end|recipe|lesson|reflection|open|note|preference|correction|security_note), title, subtitle, facts JSON, narrative, concepts JSON, importance, evidence_type, status (raw|proposed|confirmed), version, derived_from, supersedes, superseded_by, valid_from, invalid_at, evidence JSON, files_read, files_modified, commands, exit_codes, error_sigs, created_at.
- `observation_versions`, `session_notes`, `core`, `jobs` (kind, payload, project, claimed_by, lease_until, attempts, next_at, done_at, result), `budget` (harness, day, tokens_used, cap).
- `entities` mit kind `concept`; `edges` mit `edge_kind`, `tvalid`, `tvalid_end`; `accesses` mit Arten `observed`, `refined`, `denied`, `overridden`.
- Bestehend: `turns`, `events`, `vectors`, `search_keys`, `recipes`, `rules`, `anchors`, `health`, `meta`, `spool`.

Index-Dokument pro Turn: Prompt + letzte Antwort + Titel + Fakten + Konzepte (Key Expansion). Beobachtungen zusätzlich einzeln.

## 7. Retrieval und Graph

FTS5 trigram mit Präfix; Vektor (fastembed, Modell-Registry mit kalibrierter Schwelle; Kandidaten embeddinggemma-300m, Qwen3-Embedding-0.6B-Q, jina-embeddings-v3); PPR Dämpfung 0,5, Spezifität 1/|P_i|, Synonymkanten cos > 0,8 zwischen Konzepten; RRF k = 60 über aktive Streams mit Agreement-Bonus; Session-Diversität 3. Rescore = RRF × Aktivierung × Wichtigkeit × Nutzung × Trust × Projekt-Boost × R_MemoryBank. Abstention: Vektortreffer nur mit lexikalischer oder Graph-Stütze. Reranker optional. Follow-up-Rate als Diagnose. Embedding sofort nach Schreiben.

## 8. Viewer

`agent-mem view`, `agent-mem view --live` (127.0.0.1, zufälliger Port, SSE, nur solange offen). Ansichten aus `agent-memory-system/ui`: Timeline, Beobachtung mit Belegen und Diff, Replay, Graph, Core, As-of, Lernen (Rezepte, Regeln, Lektionen, Reflexionen, Nutzungsquote), Jobs und Budget, Gesundheit (Capture, Spool, Beobachter-Status pro Harness, Quota), Privacy, Setup.

## 9. Privacy, Trust, Isolation

Alles durch `privacy.clean_text` vor dem Beobachter und vor dem Speichern. Beobachter-Prozess ohne Tools, ohne Projektzugriff, `AGENT_MEM_INTERNAL=1`, eigenes leeres Arbeitsverzeichnis. `tool_external` nie injiziert, nie Regel. Präferenzen und Regeln nur aus Nutzer-Prompts. Belegpflicht. Einblendungen als Daten gerahmt. Keine Token-Zugriffe, kein eigener Login-Flow. DB unverschlüsselt, 0o700, `purge` konsistent.

## 10. Budget und Ausfall

- Standard: Beobachter an, Tagesbudget pro Harness konfigurierbar, Default 2 % des typischen Tageskontingents, sichtbar in `status`.
- Quota erreicht oder Login fehlt: Jobs warten, rohe Beobachtungen decken Suche und Timeline, Hinweis im Start-Kontext („Beobachter pausiert seit …“).
- Enterprise ohne SDK-Freigabe: dauerhaft roher Modus; der Turn-Ende-Pfad (`observe.mode = session`) bleibt als abschaltbare Option im Code, Default aus.

## 11. Messung

Online in `status`: Beobachter-Quote (Turns mit Beobachtung vom Agenten), Latenz Turn → Beobachtung, Nutzungsquote eingeblendeter Einträge (Ziel > 30 %), Deny-Treffer und Overrides, Lektionen genutzt, Follow-up-Rate, Budgetverbrauch. Offline: 25-Fall-Fixture, LongMemEval-S, agentmemory `coding-agent-life-v1` über Adapter, Gold-Beleg-Set. Alle Zahlen im README, auch die schlechteren.

## 12. Was aus dem bisherigen Code übernommen wird und was nicht

| bisher | neu |
|---|---|
| Regex schreibt Memories | Regex liefert Signale; Memory-Agent schreibt |
| `summarize.py` mit `claude -p`, aus | Memory-Agent pro Harness über Binary/SDK, an |
| Titelvergleich | `resolve`-Job mit Supersede und `invalid_at` |
| `mem_remember` einziges Schreibtool | bleibt freiwillig; Hauptpfad ist der Beobachter |
| Memories ohne Status, Wichtigkeit, Belege | raw → proposed → confirmed, importance, evidence, Revisionen |
| Briefing als Prosa | Index, Core-Block, Lektionen |
| Keine Reflexion, Evolution, Lektionen | Jobs reflect, evolve, lesson, rule, consolidate |
| Graph ohne Konzepte | Konzept- und Synonymknoten, PPR mit Spezifität |
| Viewer statisch | plus `--live`, Replay, As-of, Jobs, Budget |

## 13. Phasen

| Phase | Inhalt | Tage |
|---|---|---|
| 0 Spikes | `claude -p --output-format json` mit Schema unter Abo-Login aus Python; `copilot` SDK/`-p` mit `useLoggedInUser`; `codex exec --output-schema`; je ein Beobachtungs-Prompt auf einem echten Turn; Isolation (keine Tools, kein Capture) prüfen | 2 |
| 1 Kern | Schema 002, Migration, Key-Expansion-Index, Jobs und Budget, sechs MCP-Tools, Start-Index | 4 |
| 2 Beobachter Claude | Spool-gespeiste Turn-Bündel, Beobachter-Prompt und Schema, langlebiger Prozess mit Recycling, Slots, Tier-Routing, Retry, Fallback roh, Budget | 5 |
| 3 Durchsetzung | PreToolUse Deny/Warnung, Datei-Timeline mit Ankern, Fehler-Rezepte, Prompt-Lektionen, Druck-Hinweis, Feedback-Arten, Override-Logik | 3 |
| 4 Lernjobs | resolve, lesson, rule, reflect, evolve, consolidate, summarize; Trigger und Schwellen; Revisionen | 5 |
| 5 Retrieval und Graph | Registry, Kalibrierung, PPR-Spezifität, Konzeptknoten, RRF über aktive Streams, Abstention, Paginierung, As-of | 3,5 |
| 6 Beobachter Copilot und Codex | Copilot SDK, `codex exec`; gleiche Pipeline, harness-spezifische Ausgabe-Validierung | 4 |
| 7 Benchmarks | LongMemEval-S, agentmemory-Adapter, Fixture, Gold-Beleg-Set | 2 |
| 8 Viewer | `--live`, zwölf Ansichten, Replay, Diff, As-of, Jobs, Budget | 5 |
| 9 Migration und Import | claude-mem-DB, agentmemory, Transkripte; alte Lernlogik raus; Tests, Ruff, Pyright | 2 |
| 10 Dogfooding | zwei Wochen parallel Claude Code, Codex, Copilot; Quoten und Budget beobachten | 10 Kalendertage |
| 11 Release | README mit Vergleich und Zahlen, CHANGELOG, Plugins, CI, Tag 2.0.0 | 1 |

Etwa 36 Arbeitstage plus zwei Wochen Nutzung.

## 14. Feste Entscheidungen

Beobachter läuft unter dem Login des Nutzers über offizielles Binary oder SDK; nie Token-Zugriff, nie eigener Login-Flow. Eine SQLite-Datei, kein Daemon außer den kurzlebigen Beobachter-Prozessen pro Session, kein Port außer Viewer solange offen. Sechs MCP-Tools. Nichts gelöscht außer `purge`. Jede Beobachtung hat Belege. Kein Verlust bei Ausfall: Spool und rohe Beobachtung. Schlechtere Stellen stehen im README.

## 15. Risiken

| Risiko | Antwort |
|---|---|
| Anthropic ändert Abo-Regeln erneut | Pfad ist das unveränderte Binary unter eigenem Login, wie vom Support-Artikel genannt; bei Sperre Fallback roh; Turn-Ende-Modus bleibt im Code |
| Enterprise sperrt SDK/CLI-Automation | roher Modus; dokumentiert |
| Beobachter verbraucht Kontingent der Arbeit | Tagesbudget, Tier-Routing, Turn-Bündelung statt pro Tool-Call, Skip-Regeln |
| Beobachter-Prozess stört die Session (Rate Limits) | Slots 2, Backoff, Priorität für die Session |
| Beobachter halluziniert | Schema-Validierung, Belegpflicht auf Turn-IDs, deterministische Anhänge, Quarantäne bis Nutzung |
| Drei SDK-Lebenszyklen | eine Pipeline, drei dünne Adapter mit gemeinsamer Validierung; Spikes vorab |
| Modellwechsel verschiebt Schwellen | `calibrate` auf Fixture |
