# Agent Mem: Plan

Stand: 2026-10-12. Dies ist der einzige Plan. Er ersetzt alle früheren Dokumente. Offene Punkte sind als Messungen mit vorab festgelegtem Ausgang geführt (§12), damit der Plan sich nicht mehr ändern muss, sondern nur noch ausgeführt wird.

## 1. Ziel

Agent Mem gibt Coding-Agents (Claude Code, Codex, Copilot CLI, OpenCode) ein gemeinsames, dauerhaftes Gedächtnis, das:

1. täglich läuft, ohne die Session zu verlangsamen,
2. ohne API-Key auskommt (Abo-Login der Harnesses, sonst lokales Ollama),
3. Widersprüche erkennt (neue Aussage löst alte ab),
4. messbar mindestens so gut ist wie der bisherige Stand und wie reines mem0,
5. wenig eigenen Code zur Pflege hat.

Nicht-Ziele: Cloud-Sync, Mehrbenutzer, Verschlüsselung der Datenbank, eigener Graph-Server, Daemon, API-Key-Pfad für Fremdprovider.

## 2. Festgeschriebene Entscheidungen

| # | Entscheidung | Begründung (Beleg) |
|---|---|---|
| D1 | `mem0ai` (gepinnt, aktuell 2.2.1, Apache-2.0) übernimmt Extraktion und Dedup. | Läuft ohne Key lokal (Anhang A.1). |
| D2 | Das LLM für mem0 ist ein eigener Provider, der den Harness-Befehl startet (`claude -p`, `codex exec`). Er wird nach `Memory.from_config` per `memory.llm = …` gesetzt. | mem0 prüft Provider-Namen fest und lässt eigene nicht zu (A.2). |
| D3 | Die Beobachtung läuft immer im Hintergrund. Der Hook schreibt nur und kehrt zurück. | Hook-Pfad bleibt stdlib, `add` braucht 3,4 s (A.3). |
| D4 | Kein Daemon. Ein Worker startet vom Hook losgelöst, arbeitet die Warteschlange ab und beendet sich. | Regel R1 (§13), weniger Pflege. |
| D5 | Wahrheit ist SQLite (Events, Turns, `memories`). mem0 plus Qdrant ist Extraktionsmaschine und Index, jederzeit neu aufbaubar. | Begrenzt Abhängigkeit von einem Fremdprojekt. |
| D6 | Jeder von mem0 erzeugte Fakt wird als Zeile in `memories` gespiegelt (`kind='fact'`, `source='agent'`). | Schema hat `invalid_at`, `superseded_by`, `importance`, `dedupe_key` schon (`schema/001_init.sql:78`). Viewer und FTS5-Suche laufen so weiter. |
| D7 | Widersprüche löst eine eigene Schicht über `store.supersede`. mem0 allein tut das nicht. | Gemessen mit drei Modellen (A.1). |
| D8 | Vektor-Store ist Qdrant im Pfad-Modus, jede Operation unter `filelock` (öffnen, arbeiten, schließen). Ersatz ist Chroma. | Qdrant als einziger lokaler Store mit BM25 in mem0, nur ein Prozess gleichzeitig; mit Sperre 30 von 30 Schreibvorgänge, 7 bis 8 ms (A.4). Chroma verträgt Parallelität, hat aber keine Keyword-Suche (A.5). |
| D9 | Kein Neo4j und kein Graphiti vorab. mem0 bringt Entity-Linking mit (spaCy, zweite Collection). | Im Paket kein Graph-Store mehr (A.6). Ein Graph-Spike nur bei klarer Messlücke (§12). |
| D10 | Der Viewer bleibt unverändert. Was er künftig zeigt, wird später entschieden. | Entscheidung des Nutzers. Er liest `memories`, dadurch zeigt er die gespiegelten Fakten automatisch. |
| D11 | Embedder nur aus der fastembed-Liste, ohne eigene Registrierung. Sieger per Messung (§8, Phase 0). | Weniger Eigenpflege. |
| D12 | Provider-Kette für den Worker: Claude (Haiku) → Codex → Copilot → Ollama → rohe Beobachtung. Je Stufe überspringbar, wenn nicht installiert oder Quota erschöpft. | Alle Stufen außer Copilot gemessen (A.7). |

## 3. Architektur und Datenfluss

```
Harness-Hook ──► capture.apply ──► SQLite (events, turns, spool)         [Hook-Pfad, stdlib, <100 ms]
      │                                   │
      │  Hook startet losgelöst, falls kein Worker den Lock hält
      ▼
agent-mem observe  (Worker, Prozess lebt nur solange Arbeit da ist)
      │  1. nimmt Turn aus observe_queue, baut Bündel, privacy.clean_text
      │  2. memory.add(bündel) ── mem0 ── LLM-Provider (Kette D12) ── Qdrant (unter filelock)
      │  3. pro neuem Fakt: store.add_memory (Spiegel, dedupe=mem0:<uuid>)
      │  4. Widerspruchsprüfung: ähnliche Fakten → LLM-Urteil → store.supersede
      ▼
SQLite memories (Fakten gültig/ungültig)
      │
      ├──► Hook: SessionStart / UserPromptSubmit lesen per FTS5 (+Vektor, falls Sieger §12) ≤ 3 Treffer, als Daten gerahmt
      ├──► MCP-Server: mem_search, mem_get, … (Retrieval-Sieger aus §12)
      └──► Viewer (unverändert)
```

Garantien:
- Der Hook ruft nie ein Modell und importiert weder mem0 noch qdrant noch fastembed (Regel R2, §13).
- Kein Turn geht verloren: Er bleibt in `observe_queue`, bis `add` gelingt oder die Rohstufe ihn gesichert hat.
- Ein Ausfall von mem0, Qdrant oder jedem Provider verändert nur die Qualität der Fakten, nie die Erfassung.

## 4. Komponenten

### 4.1 Capture (bleibt)
`hook.py`, `capture.py`, `normalize/*`, `events.py`, `spool.py`, `privacy.py`, `identity.py`, `signals.py`: unverändert übernommen. Neu ist nur der Aufruf `spawn_worker()` am Ende des Stop-Hooks (§4.3).

### 4.2 Warteschlange (neu, Migration `002_observe.sql`)
Tabelle `observe_queue(turn_id PRIMARY KEY, state CHECK IN ('pending','running','done','raw','failed'), attempts, next_try, provider, last_error, updated_at)`. Ein Eintrag wird beim Abschluss eines Turns angelegt (in `capture.apply`, selbe Transaktion). `state='running'` hat ein Lease (Zeitstempel); abgelaufene Leases gelten wieder als `pending`. Migrationstest nach Regel R6 (§13).

### 4.3 Worker `agent-mem observe`
1. Start durch den Hook: `subprocess.Popen([...,'observe','--drain'], start_new_session=True, stdin/stdout/stderr=DEVNULL)`. Vorher nicht-blockierender Versuch auf `observe.lock`. Hält ein Worker den Lock, tut der Hook nichts.
2. Schleife: nächsten `pending` Turn mit `next_try <= jetzt` leasen, bearbeiten, Ergebnis schreiben. Leere Warteschlange → Lock freigeben, Prozess beendet sich.
3. Bündelung: Liegen mehrere Turns derselben Session an, geht ein `add` mit allen (Reihenfolge erhalten). Ein `add` pro Bündel, nie pro Tool-Call.
4. Limits: höchstens 1 Worker, Tageslimit für Aufrufe in `config` (Standard 300). Bei Erreichen: nächste Stufe der Kette (§4.4), zuletzt roh.
5. Fehler: Backoff 1 min, 5 min, 30 min, 6 h, danach `failed` (bleibt im Viewer sichtbar, Neuversuch per `agent-mem observe --retry-failed`).
6. Jeder Aufruf setzt `MEM0_TELEMETRY=False` und `MEM0_DIR=<Datenverzeichnis>/mem0` (Rechte 0o700).

### 4.4 LLM-Provider (Memory-Agent, Zugang pro Harness)

Gemeinsame Regeln: Der Prozess liest, kopiert oder speichert nie Tokens. Er startet nur das offizielle Binary unter dem Login des Nutzers. Jeder Aufruf: leeres temporäres Arbeitsverzeichnis, `AGENT_MEM_INTERNAL=1`, Prompt über stdin, Zeitlimit 120 s. Die Antwort wird auf gültiges JSON geprüft (Codefences entfernen, einmal wiederholen, sonst Fehler).

| Stufe | Befehl | Status |
|---|---|---|
| 1 Claude Code | `claude -p --restricted --setting-sources "" --tools "" --strict-mcp-config --no-session-persistence --model haiku` | gemessen, läuft (A.3). `--bare` ist verboten: bricht das Login. Ohne `--setting-sources ""` laufen fremde Plugin-Hooks mit. |
| 2 Codex | `codex exec --ephemeral --ignore-user-config -s read-only -C <leer> --skip-git-repo-check --output-schema <datei> -o <aus>` | gemessen, läuft. Ein Trivialaufruf verbrauchte 24.569 Tokens: teuer, deshalb Stufe 2. |
| 3 Copilot CLI | `copilot -p` oder Copilot SDK mit `useLoggedInUser` | nicht installiert. Phase 3 installiert und prüft. Fällt die Prüfung durch, entfällt die Stufe ohne Planänderung. |
| 4 Ollama | mem0-Provider `ollama` (Standard `qwen3.5:4b-mlx`, größer: `qwen3.6:35b-mlx`) | gemessen, läuft (A.1). Langsamer, Qualität schwankt. |
| 5 roh | `store.add_memory(kind='summary', …)` aus Prompt und Antwort, ohne Modell | vorhanden. |

OpenCode hat keinen eigenen Beobachter. Seine Turns arbeitet derselbe Worker über die Kette ab, wie die aller Harnesses. Die Kette ist global, nicht pro Harness: Jeder Worker bearbeitet jeden Turn, egal aus welchem Harness er kam.

### 4.5 mem0-Konfiguration
```
llm:          (Platzhalter ollama, danach memory.llm = ProviderKette)
embedder:     fastembed, Modell = Sieger Phase 0
vector_store: qdrant, path=<Datenverzeichnis>/qdrant, on_disk
version-pin:  mem0ai==2.2.1 (Upgrade nur mit grünem Adapter-Test)
extras:       mem0ai[nlp] (spaCy für Entity-Linking)
```
Alles läuft über ein Modul `observe/mem0_adapter.py` mit zwei Funktionen: `extract(bundle, namespace) -> list[Fact]` und `search(query, namespace, k)`. Nur dieses Modul importiert mem0. Es ist die Austauschstelle, falls mem0 die Messung (§8) nicht besteht.

Namespaces: `user_id = "<nutzer>|p:<projekt_id>"` für Projektfakten und `"<nutzer>|global"` für Präferenzen. Suche liest beide und führt sie zusammen. (Kein Metadaten-Filter nötig, bewusst einfach.)

Plattform: Auf Intel-Macs gibt es kein ONNX Runtime und damit kein fastembed. Dort ist der Embedder `ollama` mit `nomic-embed-text`. Die Konfiguration wählt automatisch.

### 4.6 Spiegel und Widerspruchsschicht
Nach jedem `add` liefert mem0 Ereignisse (`ADD`, `UPDATE`, `DELETE`, `NONE`) mit Id und Text. Der Worker:
1. `ADD`/`UPDATE`: `store.add_memory(kind='fact', source='agent', trust='observer', importance=0.5, turn_id, origin=harness, dedupe='mem0:<uuid>:<revision>')`. Titel = erste Zeile des Fakts, Body = Fakt.
2. `DELETE`: `invalid_at` setzen (nie löschen).
3. Für jeden neuen Fakt: `search(neuer Fakt, k=5)` im selben Namespace, ohne ihn selbst. Treffer mit Score ≥ `contradiction.min_score` (Standard 0,6, in Phase 0 kalibriert) gehen mit dem neuen Fakt in einen einzigen LLM-Aufruf: Antwort als JSON-Liste `[{id, verdict: KEEP|SUPERSEDE}]`. Bei `SUPERSEDE`: `store.supersede(alt, neu)`.
4. Gültigkeit überall mit `invalid_at IS NULL` filtern (steht in den Suchen schon).

Pro Turn also höchstens zwei Modellaufrufe: mem0-Extraktion (die Zahl interner mem0-Aufrufe misst Phase 0) und das Widerspruchsurteil (nur bei Kandidaten).

### 4.7 Injection (Hook, stdlib)
`inject.py` bleibt unverändert: Es liest bereits `memories` mit `kind IN (…, 'fact')` und `invalid_at IS NULL` (`inject.py:175-177`), gewichtet nach Aktivierung und `importance`. Gespiegelte Fakten erscheinen dadurch ohne Codeänderung. Inhalt und Form der Injektion (Legende, Index, höchstens 3 Treffer) bleiben wie in der Datei.
- Copilot CLI hat keinen Kontext zur Prompt-Zeit: nur SessionStart und PreToolUse.
- Ob der Hook nur FTS5 nutzt oder zusätzlich die vorhandene Vektorsuche (`semantic.py`), entscheidet die Messung in Phase 2 (§12, E3).

### 4.8 MCP-Server (bleibt, Quelle wechselt)
`mcp_server.py` behält seine fünf Tools (`mem_search`, `mem_timeline`, `mem_get`, `mem_remember`, `mem_forget`). `mem_search` nutzt den Retrieval-Sieger aus Phase 2. Läuft nur im Session-Prozess, öffnet Qdrant nur kurz unter dem Lock (Timeout 2 s, danach Antwort aus SQLite).

### 4.9 Viewer (bleibt, unberührt)
`viewer/` und `views.py` ändern sich nicht. Sie importieren `consolidate`, `learn`, `search`, `store`, `health`. Diese Module und das Schema bleiben deshalb bestehen. Dass der Viewer nun auch gespiegelte Fakten zeigt, ist ein Nebeneffekt von D6.

### 4.10 Graph
Nur der mem0-Entity-Store (spaCy). Phase 0 prüft, dass er gefüllt wird. Kein eigener Graph-Code.

## 5. Datenmodell
- Neu: `observe_queue` (§4.2). Keine weitere Migration.
- `memories`: unverändert. Fakten erscheinen als `kind='fact'`. Die mem0-Id steckt im Dedupe-Schlüssel.
- mem0-Daten (`<Datenverzeichnis>/mem0/history.db`, `<Datenverzeichnis>/qdrant`) sind ableitbar. `agent-mem reindex` baut Qdrant aus `memories` neu auf (nur Embedding, kein Modellaufruf).
- Backups (`VACUUM INTO`) sichern SQLite. Qdrant und mem0 werden nicht gesichert.

## 6. Privacy und Sicherheit
1. `privacy.clean_text` läuft auf dem Bündel vor `memory.add` und auf jedem Fakt vor `store.add_memory` (letzteres erzwingt `add_memory` selbst).
2. Quellen mit `tool_external` (Web, fremde MCP-Tools) erzeugen nie Regeln oder Präferenzen und werden nie automatisch injiziert (Regel R5, §13).
3. Der Beobachter-Prozess ist isoliert: leeres Verzeichnis, keine Tools, keine MCP-Server, keine Settings, `AGENT_MEM_INTERNAL=1`, damit er sich nicht selbst erfasst.
4. mem0-Telemetrie aus, per Test abgesichert (Test startet den Adapter und prüft die Umgebungsvariable).
5. Einträge werden beim Anzeigen als Daten gerahmt, nie als Anweisung.
6. Ausgabe von Ollama bleibt lokal. Es gibt keinen Netzwerkzugriff außer dem einmaligen Modell-Download.
7. Datenverzeichnis 0o700, Dateien 0o600. Verschlüsselung der Datenbank ist ausdrücklich nicht abgedeckt.
8. Die frühere Regel „keine generativen Modellaufrufe" entfällt. Ausnahme ist allein der Worker `observe`. „Kein Daemon" bleibt: Der Worker beendet sich selbst (§13, R1).

## 7. Fehlerfälle

| Fall | Verhalten |
|---|---|
| Worker stürbe mitten im Turn | Lease läuft ab, Turn wird neu versucht. mem0-Dedup verhindert Doppelfakten, der Spiegel dedupt zusätzlich über `dedupe`. |
| Quota/Login der Stufe 1 | Stufe 2…4 in Reihenfolge. Fehlerart wird in `last_error` gespeichert. |
| Alle Stufen fehlen | Rohstufe (`kind='summary'`), Turn `state='raw'`, später per `--reprocess-raw` mit Modell nachholbar. |
| Qdrant-Sperre nicht erhältlich (Timeout) | Worker wartet mit Backoff, MCP antwortet aus SQLite, Hook merkt nichts. |
| Qdrant beschädigt | `agent-mem reindex`. |
| mem0-Upgrade bricht Adapter | Adapter-Test schlägt in CI fehl, Pin bleibt. |
| Ungültiges JSON vom Modell | einmal wiederholen, dann Fehler und Backoff. |
| Mehrere Sessions parallel | Ein Worker, alle Turns über die Queue, kein Konflikt. |
| Kein Netz | Stufen 1 bis 3 scheitern, Ollama und Rohstufe laufen. |

## 8. Messung

Datensätze: (a) Fixture mit 25 Fällen (davon 5 Abstention, 10 Widerspruchspaare getrennt in (d)), in Phase 0 neu gebaut aus deutschen und englischen Coding-Szenarien und unter `tests/fixtures/` abgelegt; die frühere Fixture ist im Repo nicht auffindbar, (b) LongMemEval-S über das vorhandene `evaluate.py` (Session-Recall@k je Fragetyp), (c) 30 reale Fakten aus Dogfooding, von mir auf Müll geprüft, (d) 10 Widerspruchspaare (Korrektur wie „pytest → nox").

Referenzwerte: Frühere Zahlen (hit@1 0,75 / 0,80 / 0,85) stammen aus einer Notiz ohne auffindbaren Beleg und gelten nicht als Schwelle. Maßstab ist der Bestand, den Phase 0 auf dem neuen Fixture und auf LongMemEval-S frisch misst.

| Metrik | Messpunkt | Schwelle |
|---|---|---|
| Fixture hit@1 | Phase 2, neuer Stand | ≥ Bestand (Phase 0) − 0,02 |
| Fixture Abstention | Phase 2 | ≥ Bestand (Phase 0) |
| LongMemEval-S Recall@5 | Phase 0 (Bestand, reines mem0) und Phase 2 (neu) | neu ≥ Bestand − 0,02 |
| Hook-Laufzeit p95 | Phase 1, mit und ohne Worker | < 100 ms |
| `add` Median | Phase 0 | < 10 s |
| Modellaufrufe pro Turn | Phase 1 | ≤ 3 |
| Müllquote Fakten | Phase 1, 30 Stichproben | ≤ 30 % |
| Widerspruchstest | Phase 1, 10 Paare (Korrektur wie „pytest → nox") | ≥ 8 von 10 gelöst |

Nicht gemessen und nicht behauptet: End-to-End-Antwortgenauigkeit mit Judge-Modell. Sie braucht ein weiteres Modell und liegt außerhalb dieses Plans.

## 9. Phasen

| Phase | Arbeit | Abnahme | Dauer |
|---|---|---|---|
| 0 Messen | Fixture bauen (25 Fälle plus 10 Widerspruchspaare). Reines mem0 (Ollama und Claude) und Bestand auf Fixture und LongMemEval-S messen. Embedder-Kandidaten messen (§12, E2). Anzahl interner mem0-LLM-Aufrufe zählen. spaCy-Entity-Store prüfen. Copilot installieren und `copilot -p` prüfen. Hook-Laufzeit des Bestands messen. Score-Schwelle für §4.6 kalibrieren. | Fixture liegt unter `tests/fixtures/`, Zahlen im Anhang B. Alle Stoppregeln aus §12 sind ausgewertet. | 3 Tage |
| 1 Worker | Migration `002`, Queue, `spawn_worker`, Worker, Provider (Stufe 1, 4, 5), `mem0_adapter`, Spiegel, Widerspruchsschicht, Datenschutztests, neue `AGENTS.md` aus §13 schreiben. Nur Claude Code. | Echte Session erzeugt Fakten, nächste Session bekommt sie, Korrektur löst den alten Fakt ab. Tabelle §8 Phase-1-Zeilen erfüllt. Alle Tests, `ruff`, `pyright` grün. | 5 Tage |
| 2 Retrieval | Hook-Suche gegen MCP-Suche gegen mem0-Suche auf Fixture und LongMemEval-S vergleichen (§12, E3). Sieger festlegen. Injection und MCP auf Sieger. | Schwellen aus §8 erfüllt, Bericht im Anhang B. | 3 Tage |
| 3 Harnesses | Stufe 2 (Codex) und Stufe 3 (Copilot, falls geprüft) in die Kette, Plugins für Codex und Copilot, OpenCode über die Kette. | Je Harness eine echte Session: Capture, Recall in neuer Session, Compaction, Deinstallation. | 3 Tage |
| 4 Aufräumen | Code des Retrieval-Verlierers löschen (§12, E3). `README`, `ARCHITECTURE`, `SECURITY` (Bedrohungsmodell aus §6) und `CHANGELOG` an diesen Plan angleichen. Release-Check auf Linux, macOS (arm64, x64), Windows. | CI grün, Zeilenzahl gesunken. | 2 Tage |
| 5 Dogfooding | 2 Wochen echte Nutzung. Wöchentliche Auswertung der Müllquote, Ausfallrate, Latenz, Anteil der eingeblendeten Fakten, die später genutzt wurden (vorhandene Tabelle `accesses`). | Keine Datenverluste, keine Hook-Verlangsamung, Ausfallrate Worker < 5 %. | 14 Tage |

Insgesamt 16 Arbeitstage plus 2 Wochen Dogfooding. Es wird nichts gepusht, deployt oder veröffentlicht; Commits bleiben lokal, bis der Nutzer es ausdrücklich erlaubt.

## 10. Code: behalten, ändern, löschen

| Modul | Schicksal |
|---|---|
| `hook`, `capture`, `normalize/*`, `events`, `spool`, `privacy`, `identity`, `signals`, `timeutil`, `logutil`, `config`, `db` | behalten. `capture` legt Queue-Eintrag an, `config` erhält Worker-Optionen. |
| `store`, `search`, `inject`, `learn`, `consolidate`, `health`, `views`, `viewer/*`, `mcp_server`, `cli`, `commands` | behalten (Viewer-Abhängigkeiten). `inject` und `search` lesen Fakten. |
| `summarize` | behalten (opt-in, getestet). Ob Fakten ihn ersetzen, entscheidet der Dogfooding-Bericht, nicht dieser Plan. |
| `evaluate` | behalten und für die Messung nutzen. |
| `semantic`, `indexer` | Schicksal laut E3 (§12). |
| `federate`, `importers` | unverändert, kein Teil dieses Plans. |
| neu | `observe/` mit `worker.py`, `queue.py`, `providers.py`, `mem0_adapter.py`, `contradiction.py`. Insgesamt Ziel unter 600 Zeilen. |
| neue Abhängigkeiten | `mem0ai[nlp]`, `qdrant-client` (kommt mit mem0), als Extra `observer`; Kern bleibt wie bisher installierbar. |

## 11. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| mem0 entwickelt sich schnell oder bricht Schnittstellen | Pin, einziger Importpunkt `mem0_adapter`, Adapter-Test in CI. |
| `memory.llm` zu überschreiben ist ein interner Eingriff | Test, der bei Upgrade bricht. Austauschstelle laut §12 E1. |
| Abo-Policies der Anbieter ändern sich | Kette D12 mit Ollama und Rohstufe, nichts hängt an einer Stufe. |
| Qualität der Fakten schwankt je Modell | Müllquote messen (§8), Stichproben in Dogfooding, Wechsel auf größeres Ollama-Modell möglich. |
| Codex ist teuer (24,5k Tokens pro Trivialaufruf) | nur Stufe 2, Tageslimit. |
| Latenz der Hintergrundverarbeitung stört nicht, aber Fakten sind verzögert verfügbar | Erwartete Verzögerung wenige Sekunden bis Minuten, akzeptiert. |
| Doppelte Daten (SQLite und Qdrant) laufen auseinander | SQLite ist Wahrheit, `reindex` baut neu. |
| Intel-Mac ohne ONNX | Ollama-Embedder als Automatik. |
| Fakten in fremder Sprache oder zu langem Text | Phase 1 prüft Sprache und Länge der Ausgabe an Stichproben, mem0-Prompt über `custom_fact_extraction_prompt` anpassbar. |

## 12. Vorab entschiedene Verzweigungen

Jede offene Frage hat einen Messpunkt und einen festgelegten Ausgang. Kein Ausgang verlangt eine Planänderung.

| Nr. | Frage | Messung | Wenn ja / wenn nein |
|---|---|---|---|
| E1 | Besteht reines mem0 (mit Widerspruchsschicht) die Schwellen aus §8? | Phase 0 und 1 | Ja: weiter. Nein: `mem0_adapter.extract` wird durch einen eigenen Beobachter ersetzt (`claude -p --json-schema` mit festem Schema, Ausgabe direkt in `store.add_memory`). Rest des Plans unverändert. |
| E2 | Welcher Embedder? | Kandidaten aus der fastembed-Liste (`multilingual-e5-small`, `embeddinggemma-300m`, `Qwen3-Embedding-0.6B-Q`), gemessen auf Fixture und LongMemEval-S mit Latenz | Höchster Recall@5; bei Abstand unter 0,01 der kleinere. Schwellenwerte je Modell neu kalibrieren. |
| E3 | Wer liefert Retrieval: Hook-FTS5 (+ vorhandene Vektoren) oder mem0/Qdrant-Hybrid? | Phase 2, beide auf denselben Daten | Sieger bedient Hook und MCP. Verliert mem0-Suche: Qdrant dient nur noch dem Dedup. Verliert die SQLite-Suche: `semantic.py` bleibt, Hook ruft bei Bedarf `agent-mem query` (Budget 400 ms). Das Verlierer-Modul wird in Phase 4 gelöscht. |
| E4 | Ist ein echter Graph nötig? | LongMemEval-Kategorien multi-session und temporal-reasoning im Vergleich zu den übrigen | Rückstand über 0,10 gegenüber den übrigen Kategorien: separater Spike mit Graphiti auf FalkorDB (nicht Neo4j), mit eigener Messung. Sonst nichts. |
| E5 | Funktioniert Copilot als Stufe? | Phase 3 | Ja: Stufe 3. Nein: Stufe entfällt, Copilot-Sessions werden von Stufe 1, 2 oder 4 bearbeitet. |
| E6 | Reicht der Qdrant-Lock in der Praxis? | Phase 1 mit 3 parallelen Sessions | Ja: bleibt. Nein (Wartezeit über 2 s im p95): Chroma als Store, Keyword über SQLite-FTS5. |
| E7 | Mehr als 3 Modellaufrufe pro Turn? | Phase 1 | Ja: Widerspruchsurteil nur bei Score ≥ 0,75 und Bündelung auf 3 Turns. |

## 13. Verbindliche Regeln (für die neue `AGENTS.md`)

Diese Regeln stammen aus der früheren `AGENTS.md`, die im Arbeitsbaum durch „neue!" ersetzt wurde. Sie gelten weiter, mit einer Änderung (R1). Phase 1 schreibt sie in die neue `AGENTS.md`.

- **R1 Grenze.** Kein Daemon, kein HTTP-Server, keine offenen Ports. Der Viewer schreibt eine statische, offline lauffähige Seite (keine Netzwerkzugriffe). Generative Modellaufrufe macht allein der Worker `observe` (und das bestehende, optionale `summarize`), immer mit `AGENT_MEM_INTERNAL=1`, damit die Kindsession nicht erfasst wird. Online geht Agent Mem nur für Modell-Downloads.
- **R2 Hook-Pfad.** Die Module `hook`, `capture`, `db`, `config`, `privacy`, `signals`, `identity`, `inject`, `search`, `learn`, `store`, `spool`, `normalize/*`, `events`, `timeutil`, `logutil` importieren nur die Standardbibliothek. mem0, qdrant, fastembed, numpy, dateparser und mcp werden nur lazy außerhalb des Hook-Pfads importiert. Hooks dürfen den Agent nie blockieren oder zum Absturz bringen: Deadline, Spool bei Fehler, stille Ausgabe bei Fehler.
- **R3 Schreibwege.** Events werden nur über `capture.apply` geschrieben (Live-Hooks, Spool-Replay, Importe), idempotent über Dedupe-Schlüssel. Erinnerungen nur über `store.add_memory`, das Titel und Text bereinigt.
- **R4 Privacy.** Alles Gespeicherte läuft durch `privacy.clean_text`. Rohe Host-Payloads werden nie gespeichert. Laufzeitdaten, Zugangsdaten, Logs, Backups und Modell-Caches liegen außerhalb von Git.
- **R5 Vertrauen.** Host-Eingaben und abgerufener Text sind nicht vertrauenswürdig; injizierter Kontext wird als Daten gerahmt. Externe Inhalte (`tool_external`) werden nie automatisch injiziert und nie zu Regeln oder Präferenzen. Regeln und Präferenzen stammen nur aus den Prompts des Nutzers. Pakete bleiben innerhalb von `config.Budgets`.
- **R6 Schema.** Jede Schemaänderung ist eine neue nummerierte Datei in `src/agent_mem/schema/` mit Migrationstest.
- **R7 Plugins.** Manifeste in `plugins/` tragen die Paketversion (Test prüft das).
- **R8 Viewer.** `viewer/` wird nur vom CLI geladen, escaped jeden gespeicherten String; `purge` löscht geschriebene Seiten.
- **R9 Entwicklung.** `uv sync --all-extras`, `uv run pytest`, `uv run ruff check src tests && uv run ruff format --check src tests && uv run pyright`. `uv.lock` gehört ins Repository, damit Pins reproduzierbar sind. Vor einem Release: CI grün auf Linux, macOS (arm64, x64) und Windows, dazu je Harness eine echte Session von Hand (Capture, Recall in neuer Session, Compaction, Deinstallation).
- **R10 Git.** Nur lokale Commits, kein Push, keine Releases, solange der Nutzer es nicht ausdrücklich erlaubt. Keine KI-Hinweise in Commits, PRs, Tags oder Dateien.

## Anhang A: Gemessene Fakten (alle auf dieser Maschine, 2026-10-11/12)

Skripte liegen unter `docs/evidence/spikes/`.

- **A.1 mem0 ohne Key, Widerspruch** (`mem0_ollama_contradiction.py`): mem0ai 2.2.1, Ollama `qwen3.5:4b-mlx` und `qwen3.6:35b-mlx`, Embedder `nomic-embed-text`, FAISS. Nachrichten „Wir nutzen pytest" und „Korrektur: nox statt pytest" ergaben bei beiden Modellen zwei ADDs; der alte Fakt blieb gültig. Einzelprobe, saubere Läufe mit isoliertem `MEM0_DIR`.
- **A.2 Provider-Validierung**: Ein eigener Provider-Name in der Config scheitert („Unsupported LLM provider"). Setzen von `memory.llm` nach `from_config` funktioniert.
- **A.3 mem0 über `claude -p`** (`mem0_claude_cli.py`): Haiku unter Abo-Login, gleiche zwei Nachrichten, zwei ADDs, `add` 3,4 s, `search` unter 0,1 s. `--bare` ergibt „Not logged in". Ohne `--setting-sources ""` laufen die Hooks von claude-mem im Beobachter mit und verfälschen die Ausgabe.
- **A.4 Qdrant mit Sperre** (`qdrant_lock_two_processes.py`): Zwei Prozesse, je 15 Operationen mit `filelock` und `close()`, 30 von 30 Punkten, Median 7 bis 8 ms pro Öffnen und Schreiben. Ohne Sperre scheitert der zweite Zugriff: „already accessed by another instance".
- **A.5 Chroma** (`chroma_two_processes.py`): Zwei parallele Schreiber, 40 von 40 Einträgen ohne Sperre. mem0 hat für Chroma keine Keyword-Suche.
- **A.6 Graph in mem0**: Im installierten Paket kein `graph_store`, kein Neo4j, Kuzu oder Memgraph. Entitäten (PROPER, QUOTED, TOPIC, IDENTIFIER) kommen aus spaCy und liegen in einer zweiten Collection (`entity_store`). Keyword-Suche (BM25) bietet unter den lokalen Stores nur Qdrant.
- **A.7 Codex**: `codex exec --ephemeral --ignore-user-config -s read-only … --output-schema … -o …` lieferte `{"a":"ok"}` unter dem CLI-Login, 24.569 Tokens für einen Trivialaufruf. Copilot CLI ist nicht installiert (`which copilot` leer).
- **A.8 Lizenzen**: mem0ai Apache-2.0, qdrant-client Apache-2.0, filelock MIT. fastembed und spaCy nicht geprüft; Phase 0 trägt das nach.
- **A.9 Schema**: `memories` hat `invalid_at`, `superseded_by`, `valid_from`, `importance`, `dedupe_key`, `kind IN (… 'fact' …)`; `store.supersede` und `store.add_memory(dedupe=…)` existieren.

## Anhang B: Messberichte
Wird in Phase 0 und 2 gefüllt. Format je Lauf: Datum, Commit, Modell, Datensatz, Zahlen. Kein Eintrag wird nachträglich geändert; neue Läufe kommen darunter.
