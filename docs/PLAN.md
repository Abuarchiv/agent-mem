# Agent Mem: Plan

Stand: 2026-10-12. Dies ist der einzige Plan. Er ersetzt alle früheren Dokumente. Offene Punkte sind als Messungen mit vorab festgelegtem Ausgang geführt (§12), damit der Plan sich nicht mehr ändern muss, sondern nur noch ausgeführt wird.

## 1. Ziel

Agent Mem gibt Coding-Agents (Claude Code, Codex, Copilot CLI, OpenCode) ein gemeinsames, dauerhaftes Gedächtnis, das:

1. täglich läuft, ohne die Session zu verlangsamen,
2. ohne API-Key auskommt (Abo-Login der Harnesses, sonst lokales Ollama),
3. Widersprüche erkennt (neue Aussage löst alte ab),
4. messbar mindestens so gut ist wie der bisherige Stand und wie reines mem0,
5. wenig eigenen Code zur Pflege hat,
6. von Dritten in unter fünf Minuten installierbar ist und ohne Nacharbeit läuft (§14).

Nicht-Ziele: Cloud-Sync, Mehrbenutzer, Verschlüsselung der Datenbank, eigener Graph-Server, Daemon, API-Key-Pfad für Fremdprovider.

## 2. Festgeschriebene Entscheidungen

| \# | Entscheidung | Begründung (Beleg) |
| --- | --- | --- |
| D1 | `mem0ai` (gepinnt, aktuell 2.2.1, Apache-2.0) übernimmt Extraktion und Dedup. | Läuft ohne Key lokal (Anhang A.1). |
| D2 | Das LLM für mem0 ist ein eigener Provider, der den Harness-Befehl startet (`claude -p`, `codex exec`). Er wird nach `Memory.from_config` per `memory.llm = …` gesetzt. | mem0 prüft Provider-Namen fest und lässt eigene nicht zu (A.2). |
| D3 | Die Beobachtung läuft immer im Hintergrund. Der Hook schreibt nur und kehrt zurück. | Hook-Pfad bleibt stdlib, `add` braucht 3,4 s (A.3). |
| D4 | Kein Daemon. Ein Worker startet vom Hook losgelöst, arbeitet die Warteschlange ab und beendet sich. | Regel R1 (§13), weniger Pflege. |
| D5 | Wahrheit ist SQLite (Events, Turns, `memories`). mem0 plus Qdrant ist Extraktionsmaschine und Index, jederzeit neu aufbaubar. | Begrenzt Abhängigkeit von einem Fremdprojekt. |
| D6 | Jeder von mem0 erzeugte Fakt wird als Zeile in `memories` gespiegelt (`kind='fact'`, `source='agent'`). | Schema hat `invalid_at`, `superseded_by`, `importance`, `dedupe_key` schon (`schema/001_init.sql:78`). Viewer und FTS5-Suche laufen so weiter. |
| D7 | Widersprüche löst eine eigene Schicht über `store.supersede`. mem0 allein tut das nicht. | Gemessen mit drei Modellen (A.1). |
| D8 | Vektor-Store ist Qdrant im Pfad-Modus. Der Worker öffnet ihn **einmal pro Lauf** unter `filelock`, arbeitet die ganze Warteschlange ab und schließt. Nicht pro Operation. Ersatz ist Chroma. | Qdrant als einziger lokaler Store mit BM25 in mem0, nur ein Prozess gleichzeitig (A.4). Öffnen lädt die ganze Collection in den Speicher: 34 ms bei 1.000, 161 ms bei 5.000, 689 ms bei 20.000 Vektoren (A.11). Pro Operation öffnen wäre bei realen Mengen zu teuer. Chroma verträgt Parallelität, hat aber keine Keyword-Suche (A.5). |
| D9 | Kein Neo4j und kein Graphiti vorab. mem0 bringt Entity-Linking mit (spaCy, zweite Collection). | Im Paket kein Graph-Store mehr (A.6). Ein Graph-Spike nur bei klarer Messlücke (§12). |
| D10 | Der Viewer bleibt unverändert. Was er künftig zeigt, wird später entschieden. | Entscheidung des Nutzers. Er liest `memories`, dadurch zeigt er die gespiegelten Fakten automatisch. |
| D11 | Embedder nur aus der fastembed-Liste, ohne eigene Registrierung. Sieger per Messung (§8, Phase 0). | Weniger Eigenpflege. |
| D12 | Provider-Kette für den Worker: Claude (Haiku) → Codex → Copilot → Ollama → rohe Beobachtung. Je Stufe überspringbar, wenn nicht installiert oder Quota erschöpft. **Standard ist anbietertreu:** Ein Turn geht nur an den Anbieter, der ihn schon gesehen hat (Claude-Turn → Claude, Codex-Turn → Codex, Copilot-Turn → Copilot), dann Ollama, dann roh. OpenCode-Turns gehen an Ollama und roh. `observe.cross_vendor = true` schaltet die volle Kette frei. | Alle Stufen außer Copilot gemessen (A.7). Ohne Anbietertreue würde Code aus einer Claude-Session bei Quota-Ende an OpenAI gehen und umgekehrt; das entscheidet der Nutzer, nicht die Kette. |
| D13 | Alle Fakten liegen in einem Namespace je Projekt (\`user_id = " | p:&lt;projekt_id&gt;"`). Kein `run_id\`, kein globaler Namespace in dieser Fassung. |

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

1. Start durch den Hook: `subprocess.Popen([sys.executable, '-m', 'agent_mem', 'observe', '--drain'], stdin/stdout/stderr=DEVNULL)` mit `start_new_session=True` (POSIX) bzw. `creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` (Windows). Kein `uv run` im Hook-Pfad. Vorher nicht-blockierender Versuch auf `observe.lock`. Hält ein Worker den Lock, tut der Hook nichts.
2. Schleife: nächsten `pending` Turn mit `next_try <= jetzt` leasen, bearbeiten, Ergebnis schreiben. Leere Warteschlange → bis zu `observe.idle_seconds` (Standard 90) auf neue Einträge warten, dann Lock freigeben und beenden. Grund: Jeder Start lädt mem0, Qdrant, fastembed und spaCy neu (mehrere Sekunden CPU); ein Turn alle 30 s würde sonst dauernd neu starten. Begrenzte Lebenszeit, also kein Daemon (R1).
3. Der Worker setzt sich selbst auf niedrige Priorität (`os.nice(10)`, Windows `BELOW_NORMAL_PRIORITY_CLASS`). „Nicht verlangsamen" (D3) heißt auch CPU und Akku, nicht nur Hook-Latenz.
4. Bündelung: Liegen mehrere Turns derselben Session an, geht ein `add` mit allen (Reihenfolge erhalten). Ein `add` pro Bündel, nie pro Tool-Call. Inhalt eines Bündels: Nutzer-Prompts vollständig, Assistenten-Text vollständig, Tool-Aufrufe als Name plus Argumente, Tool-Ausgaben auf `observe.tool_output_chars` (Standard 800) gekürzt, Ereignisse mit `trust='tool_external'` nur als Name ohne Inhalt. Gesamtgrenze `observe.bundle_tokens` (Standard 6.000, Phase 0 misst, ob 4.000 reicht). Überschreitet ein Bündel die Grenze, wird es am Turn-Ende geteilt.
5. Limits: höchstens 1 Worker, Tageslimit für Aufrufe in `config` (Standard 300). Bei Erreichen: nächste Stufe der Kette (§4.4), zuletzt roh. Jeder Aufruf schreibt Stufe, Dauer und (wo das Binary sie nennt) Tokenzahl in eine Tabelle `observe_calls`, damit Phase 5 den Verbrauch des Abos beziffern kann. Stufe 1 teilt sich das 5-Stunden-Fenster des Abos mit der laufenden Session.
6. Fehler: Backoff 1 min, 5 min, 30 min, 6 h, danach `failed`. Erkennt der Provider eine Quota- oder Login-Meldung (Muster auf stderr, in Phase 1 je Binary erhoben), wird die Stufe für 60 min gesperrt statt den Turn zu bestrafen. `agent-mem observe --status` zeigt Warteschlange, Fehler und Verbrauch; `--retry-failed` versucht `failed` erneut. Der Viewer kennt die Warteschlange nicht.
7. Jeder Aufruf setzt `MEM0_TELEMETRY=False` und `MEM0_DIR=<Datenverzeichnis>/mem0` (Rechte 0o700).

### 4.4 LLM-Provider (Memory-Agent, Zugang pro Harness)

Gemeinsame Regeln: Der Prozess liest, kopiert oder speichert nie Tokens. Er startet nur das offizielle Binary unter dem Login des Nutzers. Jeder Aufruf: leeres temporäres Arbeitsverzeichnis, `AGENT_MEM_INTERNAL=1`, Prompt über stdin, Zeitlimit 120 s. Die Antwort wird auf gültiges JSON geprüft (Codefences entfernen, einmal wiederholen, sonst Fehler).

| Stufe | Befehl | Status |
| --- | --- | --- |
| 1 Claude Code | `claude -p --restricted --setting-sources "" --tools "" --strict-mcp-config --no-session-persistence --model haiku` | gemessen, läuft (A.3). `--bare` ist verboten: bricht das Login. Ohne `--setting-sources ""` laufen fremde Plugin-Hooks mit. |
| 2 Codex | `codex exec --ephemeral --ignore-user-config -s read-only -C <leer> --skip-git-repo-check --output-schema <datei> -o <aus>` | gemessen, läuft. Ein Trivialaufruf verbrauchte 24.569 Tokens: teuer, deshalb Stufe 2. |
| 3 Copilot CLI | `copilot -p` oder Copilot SDK mit `useLoggedInUser` | nicht installiert. Phase 3 installiert und prüft. Fällt die Prüfung durch, entfällt die Stufe ohne Planänderung. |
| 4 Ollama | mem0-Provider `ollama` (Standard `qwen3.5:4b-mlx`, größer: `qwen3.6:35b-mlx`) | gemessen, läuft (A.1). Langsamer, Qualität schwankt. |
| 5 roh | `store.add_memory(kind='summary', …)` aus Prompt und Antwort, ohne Modell | vorhanden. |

OpenCode hat keinen eigenen Beobachter. Seine Turns arbeitet derselbe Worker ab, standardmäßig nur mit Ollama und roh (D13). Ein Worker bearbeitet Turns aller Harnesses; welche Stufen er für einen Turn nutzen darf, bestimmt der Herkunfts-Harness (D12, Anbietertreue).

Tests: Die Stufen 1 bis 4 laufen nicht in CI (kein Login, kein Ollama). Es gibt eine Stufe `fake` (liest Antworten aus einer Fixture-Datei), mit der Worker, Spiegel und Widerspruchsschicht in CI getestet werden. Tests gegen echte Binaries tragen den pytest-Marker `local` und laufen nur von Hand (R9).

### 4.5 mem0-Konfiguration

```
llm:          (Platzhalter ollama, danach memory.llm = ProviderKette)
embedder:     fastembed, Modell = Sieger Phase 0
vector_store: qdrant, path=<Datenverzeichnis>/qdrant, on_disk
version-pin:  mem0ai==2.2.1 (Upgrade nur mit grünem Adapter-Test)
extras:       mem0ai[nlp] (spaCy für Entity-Linking)
```

Alles läuft über ein Modul `observe/mem0_adapter.py` mit vier Funktionen: `extract(bundle, namespace) -> list[Fact]`, `search(query, namespace, k)`, `forget(mem0_id)` und `reindex(facts)`. Nur dieses Modul importiert mem0. Es ist die Austauschstelle, falls mem0 die Messung (§8) nicht besteht.

Namespace: nur `user_id = "<nutzer>|p:<projekt_id>"` (D13). Kein `run_id`. Jeder `add` bekommt `metadata={"turn_id": …, "session_id": …, "harness": …}`, damit Fakten auf Turns rückführbar sind und die LongMemEval-Messung (§8) Sessions zählen kann.

Extraktions-Prompt: Der Standard-Prompt von mem0 ist auf Assistenten-Chats zugeschnitten (Vorlieben, Personen, Termine). Für Coding-Turns mit Tool-Ausgaben liefert er voraussichtlich Kleinkram. Phase 0 misst Standard gegen einen eigenen `custom_fact_extraction_prompt` (Konventionen, Entscheidungen, Sackgassen, Befehle, Präferenzen; Sprache des Nutzers; ein Satz pro Fakt) auf der Fixture. Der Sieger steht in §12, E8.

Plattform: Auf Intel-Macs gibt es kein ONNX Runtime und damit kein fastembed. (WEG Lassen weil keine verwendet intel

### 4.6 Spiegel und Widerspruchsschicht

mem0 2.2.1 arbeitet nur hinzufügend: `add` liefert ausschließlich `ADD`-Einträge mit Id und Text (A.10, `main.py:1030-1075`). Es gibt kein `UPDATE`, `DELETE` oder `NONE`, und Dedup ist nur ein MD5-Vergleich des exakten Texts. Nahe Duplikate („Wir nutzen nox", „Tests laufen mit nox") häufen sich deshalb an. Der Worker:

1. Pro `ADD`: `store.add_memory(kind='fact', source='agent', trust='observer', importance=0.5, turn_id, origin=harness, dedupe='mem0:<uuid>')`. Titel = erste Zeile des Fakts, Body = Fakt.
2. Für alle neuen Fakten des Bündels zusammen: je Fakt `search(fakt, k=3)` im Namespace, ohne die Fakten des Bündels selbst. Treffer mit Score ≥ `observe.contradiction_min_score` (Standard 0,4, kalibriert in B.8 und B.16) werden gesammelt, höchstens 15 Paare pro Bündel. Alle Paare gehen in **einen** LLM-Aufruf: Antwort als JSON-Liste `[{new_id, old_id, verdict: KEEP|SUPERSEDE|DUPLICATE}]`.
   - `SUPERSEDE`: `store.supersede(alt, neu)`; mem0-Eintrag des alten Fakts per `forget` entfernen, sonst sieht die nächste Extraktion ihn weiter als Vorwissen.
   - `DUPLICATE`: neuer Fakt bekommt `invalid_at`, alter bleibt; mem0-Eintrag des neuen Fakts entfernen.
   - `KEEP`: nichts.
3. `mem_forget` und `purge` rufen `forget(mem0_id)` für jede betroffene Zeile, damit Qdrant, Entity-Store und `history.db` den Fakt verlieren. SQLite behält die Zeile mit `invalid_at` (nie löschen).
4. Gültigkeit überall mit `invalid_at IS NULL` filtern (steht in den Suchen schon).

Pro Bündel also höchstens zwei Modellaufrufe: die mem0-Extraktion (genau ein Aufruf pro `add`, A.10) und ein gemeinsames Urteil über alle Paare. Ohne Kandidaten entfällt der zweite. Ergebnisse der mem0-Suche werden gegen `memories.invalid_at` nachgefiltert (Überhol-Faktor 3), denn das Ablaufdatum von mem0 (`expiration_date`) ist nur tagesgenau.

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

- Neu: `observe_queue` und `observe_calls` (§4.2, §4.3), beide in Migration `002_observe.sql`. Keine weitere Migration.
- `memories`: unverändert. Fakten erscheinen als `kind='fact'`. Die mem0-Id steckt im Dedupe-Schlüssel.
- mem0-Daten sind ableitbar: `<Datenverzeichnis>/qdrant` (zwei Collections: Fakten und `entity_store`) und `<Datenverzeichnis>/mem0/history.db`. Letztere enthält neben der Änderungshistorie auch die an `add` übergebenen Nachrichten (`storage.py:257`, `save_messages`), also eine zweite Kopie des bereinigten Bündels. Sie unterliegt denselben Rechten und demselben `purge` wie SQLite.
- `agent-mem reindex` leert Qdrant und `history.db` und fügt alle gültigen Fakten per `add(..., infer=False)` wieder ein. Das embeddet und füllt Payload und Entity-Store über mem0s eigenen Pfad, ohne Modellaufruf. Ein eigener Payload-Nachbau entfällt.
- Backups (`VACUUM INTO`) sichern SQLite. Qdrant und mem0 werden nicht gesichert.

## 6. Privacy und Sicherheit

1. `privacy.clean_text` läuft auf dem Bündel vor `memory.add` und auf jedem Fakt vor `store.add_memory` (letzteres erzwingt `add_memory` selbst).
2. Quellen mit `tool_external` (Web, fremde MCP-Tools) erzeugen nie Regeln oder Präferenzen und werden nie automatisch injiziert (Regel R5, §13). Ihr Inhalt kommt nicht ins Bündel (§4.3, Punkt 4): Fremdtext könnte den Beobachter anweisen, erfundene Fakten zu liefern, die später in Sessions eingeblendet werden. Der Beobachter-Prompt rahmt das Bündel als Daten.
3. Der Beobachter-Prozess ist isoliert: leeres Verzeichnis, keine Tools, keine MCP-Server, keine Settings, `AGENT_MEM_INTERNAL=1`, damit er sich nicht selbst erfasst. 3a. Datenfluss zwischen Anbietern nur mit Zustimmung: Standard ist Anbietertreue (D12). Ein Turn verlässt nie den Anbieter, der ihn in der Session schon gesehen hat, außer zu Ollama (lokal).
4. mem0-Telemetrie aus, per Test abgesichert (Test startet den Adapter und prüft die Umgebungsvariable).
5. Einträge werden beim Anzeigen als Daten gerahmt, nie als Anweisung.
6. Ausgabe von Ollama bleibt lokal. Es gibt keinen Netzwerkzugriff außer dem einmaligen Modell-Download.
7. Datenverzeichnis 0o700, Dateien 0o600. Verschlüsselung der Datenbank ist ausdrücklich nicht abgedeckt.
8. Die frühere Regel „keine generativen Modellaufrufe" entfällt. Ausnahme ist allein der Worker `observe`. „Kein Daemon" bleibt: Der Worker beendet sich selbst (§13, R1).

## 7. Fehlerfälle

| Fall | Verhalten |
| --- | --- |
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

Datensätze: (a) Fixture mit 25 Fällen (davon 5 Abstention, 10 Widerspruchspaare getrennt in (d)), in Phase 0 neu gebaut aus deutschen und englischen Coding-Szenarien und unter `tests/fixtures/` abgelegt; die frühere Fixture ist im Repo nicht auffindbar, (b) LongMemEval-S über `evaluate.py` (Session-Recall@k je Fragetyp), (c) 30 reale Fakten aus Dogfooding, von mir auf Müll geprüft, (d) 10 Widerspruchspaare (Korrektur wie „pytest → nox").

LongMemEval-S, Umfang: `evaluate.py` baut je Frage eine frische Datenbank und nimmt alle Haystack-Sessions auf (`evaluate.py:55-75`). Mit mem0 kostet jede Session einen Modellaufruf; der volle Datensatz (rund 500 Fragen mit je etwa 50 Sessions) wären über 25.000 Aufrufe. Das ist in Phase 0 nicht machbar und würde das Abo leeren. Deshalb: feste Teilmenge von 40 Fragen, geschichtet nach Fragetyp, Seed fest, Liste der `question_id` in Anhang B. Extraktion für die Messung mit Ollama (kostenlos, über Nacht im Hintergrund), Embedder wie im Betrieb. Alle Vergleiche (Bestand, reines mem0, neuer Stand) laufen auf derselben Teilmenge. Der Datensatz liegt nicht im Repo und wird in Phase 0 geladen. `evaluate.py` bekommt dafür `--backend {sqlite,mem0}`; der mem0-Pfad zählt Treffer über `metadata.session_id` (§4.5).

Referenzwerte: Frühere Zahlen (hit@1 0,75 / 0,80 / 0,85) stammen aus einer Notiz ohne auffindbaren Beleg und gelten nicht als Schwelle. Maßstab ist der Bestand, den Phase 0 auf dem neuen Fixture und auf LongMemEval-S frisch misst.

| Metrik | Messpunkt | Schwelle |
| --- | --- | --- |
| Fixture hit@1 | Phase 2, neuer Stand | ≥ Bestand (Phase 0) − 0,02 |
| Fixture Abstention | Phase 2 | ≥ Bestand (Phase 0) |
| LongMemEval-S Recall@5 | Phase 0 (Bestand, reines mem0) und Phase 2 (neu) | neu ≥ Bestand − 0,02 |
| Hook-Laufzeit p95 | Phase 1, mit und ohne Worker | &lt; 100 ms |
| `add` Median | Phase 0 | &lt; 10 s |
| Modellaufrufe pro Turn | Phase 1 | ≤ 3 |
| Müllquote Fakten | Phase 1, 30 Stichproben | ≤ 30 % |
| Widerspruchstest | Phase 1, 10 Paare (Korrektur wie „pytest → nox") | ≥ 8 von 10 gelöst |

Nicht gemessen und nicht behauptet: End-to-End-Antwortgenauigkeit mit Judge-Modell. Sie braucht ein weiteres Modell und liegt außerhalb dieses Plans.

## 9. Phasen

| Phase | Arbeit | Abnahme | Dauer |
| --- | --- | --- | --- |
| 0 Messen | Fixture bauen (25 Fälle plus 10 Widerspruchspaare). LongMemEval-S laden, Teilmenge festlegen, `evaluate.py --backend mem0` schreiben. Reines mem0 (Ollama und Claude) und Bestand auf Fixture und Teilmenge messen. Extraktions-Prompt Standard gegen eigenen vergleichen (E8). Embedder-Kandidaten messen (E2). spaCy-Entity-Store prüfen. Copilot installieren und `copilot -p` prüfen. Hook-Laufzeit des Bestands messen. Score-Schwelle für §4.6 kalibrieren. Bündelgröße an 20 echten Turns messen (§4.3, Punkt 4). Lizenzen fastembed und spaCy nachtragen (A.8). | Fixture liegt unter `tests/fixtures/`, Zahlen im Anhang B. Alle Stoppregeln aus §12 sind ausgewertet. | 5 Tage (davon 2 Nächte Ollama-Läufe im Hintergrund) |
| 1 Worker | Migration `002` (`observe_queue`, `observe_calls`), Bündelbau, `spawn_worker` (POSIX und Windows), Worker mit Leerlauf und Priorität, Provider (Stufe 1, 4, 5 und `fake`), Quota-Erkennung je Binary, `mem0_adapter` (vier Funktionen), Spiegel, Widerspruchsschicht mit drei Urteilen, `forget` in `mem_forget` und `purge`, `reindex`, `observe --status`, Datenschutztests, neue `AGENTS.md` aus §13 schreiben. Nur Claude Code. | Echte Session erzeugt Fakten, nächste Session bekommt sie, Korrektur löst den alten Fakt ab, Duplikat wird erkannt, `mem_forget` entfernt den Fakt auch aus Qdrant. Tabelle §8 Phase-1-Zeilen erfüllt. Alle Tests, `ruff`, `pyright` grün; CI ohne Marker `local`. | 6 Tage |
| 2 Retrieval | Hook-Suche gegen MCP-Suche gegen mem0-Suche auf Fixture und LongMemEval-S vergleichen (§12, E3). Sieger festlegen. Injection und MCP auf Sieger. | Schwellen aus §8 erfüllt, Bericht im Anhang B. | 3 Tage |
| 3 Harnesses | Stufe 2 (Codex) und Stufe 3 (Copilot, falls geprüft) in die Kette, Plugins für Codex und Copilot, OpenCode über die Kette. | Je Harness eine echte Session: Capture, Recall in neuer Session, Compaction, Deinstallation. | 3 Tage |
| 4 Aufräumen und Installation | Code des Retrieval-Verlierers löschen (§12, E3). I1 bis I12 aus §14: `setup` mit absoluten Pfaden, Erkennung und Modell-Download, `doctor`-Erweiterung, `uninstall`, Extras-Schnitt, `plugin.json` korrigieren, PyPI-Release-Workflow, Marketplace-Eintrag, Issue-Vorlage. `README`, `ARCHITECTURE`, `SECURITY`, `CHANGELOG`, `CONTRIBUTING` schreiben. | CI grün, Zeilenzahl im Kern gesunken. Frische Installation nach README auf drei OS unter fünf Minuten bis zum ersten Fakt (I9). | 5 Tage |
| 5 Dogfooding | 2 Wochen echte Nutzung. Wöchentliche Auswertung der Müllquote, Ausfallrate, Latenz, Anteil der eingeblendeten Fakten, die später genutzt wurden (vorhandene Tabelle `accesses`). | Keine Datenverluste, keine Hook-Verlangsamung, Ausfallrate Worker &lt; 5 %. | 14 Tage |

Insgesamt 22 Arbeitstage plus 2 Wochen Dogfooding. Es wird nichts gepusht, deployt oder veröffentlicht; Commits bleiben lokal, bis der Nutzer es ausdrücklich erlaubt.

## 10. Code: behalten, ändern, löschen

| Modul | Schicksal |
| --- | --- |
| `hook`, `capture`, `normalize/*`, `events`, `spool`, `privacy`, `identity`, `signals`, `timeutil`, `logutil`, `config`, `db` | behalten. `capture` legt Queue-Eintrag an, `config` erhält Worker-Optionen. |
| `store`, `search`, `inject`, `learn`, `consolidate`, `health`, `views`, `viewer/*`, `mcp_server`, `cli`, `commands` | behalten (Viewer-Abhängigkeiten). `inject` und `search` lesen Fakten. |
| `summarize` | behalten (opt-in, getestet). Ob Fakten ihn ersetzen, entscheidet der Dogfooding-Bericht, nicht dieser Plan. |
| `evaluate` | behalten, erhält `--backend {sqlite,mem0}` und Teilmengen-Option (§8). |
| `semantic`, `indexer` | Schicksal laut E3 (§12). |
| `federate`, `importers` | unverändert, kein Teil dieses Plans. |
| neu | `observe/` mit `worker.py`, `queue.py`, `bundle.py`, `providers.py`, `mem0_adapter.py`, `contradiction.py`. Insgesamt Ziel unter 800 Zeilen. |
| neue Abhängigkeiten | `mem0ai[nlp]`, `qdrant-client` (kommt mit mem0), als Extra `observer`; Kern bleibt wie bisher installierbar. |

## 11. Risiken

| Risiko | Gegenmaßnahme |
| --- | --- |
| mem0 entwickelt sich schnell oder bricht Schnittstellen | Pin, einziger Importpunkt `mem0_adapter`, Adapter-Test in CI. |
| `memory.llm` zu überschreiben ist ein interner Eingriff | Test, der bei Upgrade bricht. Austauschstelle laut §12 E1. |
| Abo-Policies der Anbieter ändern sich | Kette D12 mit Ollama und Rohstufe, nichts hängt an einer Stufe. |
| Qualität der Fakten schwankt je Modell | Müllquote messen (§8), Stichproben in Dogfooding, Wechsel auf größeres Ollama-Modell möglich. |
| Codex ist teuer (24,5k Tokens pro Trivialaufruf) | nur Stufe 2, Tageslimit. |
| Latenz der Hintergrundverarbeitung stört nicht, aber Fakten sind verzögert verfügbar | Erwartete Verzögerung wenige Sekunden bis Minuten, akzeptiert. |
| Doppelte Daten (SQLite und Qdrant) laufen auseinander | SQLite ist Wahrheit, `reindex` baut neu. |
| Intel-Mac ohne ONNX | Ollama-Embedder als Automatik. |
| Fakten in fremder Sprache oder zu langem Text | Phase 1 prüft Sprache und Länge der Ausgabe an Stichproben, mem0-Prompt über `custom_instructions` anpassbar (B.7). |

## 12. Vorab entschiedene Verzweigungen

Jede offene Frage hat einen Messpunkt und einen festgelegten Ausgang. Kein Ausgang verlangt eine Planänderung.

| Nr. | Frage | Messung | Wenn ja / wenn nein |
| --- | --- | --- | --- |
| E1 | Besteht reines mem0 (mit Widerspruchsschicht) die Schwellen aus §8? | Phase 0 und 1 | Ja: weiter. Nein: `mem0_adapter.extract` wird durch einen eigenen Beobachter ersetzt (`claude -p --json-schema` mit festem Schema, Ausgabe direkt in `store.add_memory`). Rest des Plans unverändert. |
| E2 | Welcher Embedder? | Kandidaten aus der fastembed-Liste (`multilingual-e5-small`, `embeddinggemma-300m`, `Qwen3-Embedding-0.6B-Q`), gemessen auf Fixture und LongMemEval-S mit Latenz | Höchster Recall@5; bei Abstand unter 0,01 der kleinere. Schwellenwerte je Modell neu kalibrieren. |
| E3 | Wer liefert Retrieval: Hook-FTS5 (+ vorhandene Vektoren) oder mem0/Qdrant-Hybrid? | Phase 2, beide auf denselben Daten | Sieger bedient Hook und MCP. Verliert mem0-Suche: Qdrant dient nur noch dem Dedup. Verliert die SQLite-Suche: `semantic.py` bleibt, Hook ruft bei Bedarf `agent-mem query` (Budget 400 ms). Das Verlierer-Modul wird in Phase 4 gelöscht. |
| E4 | Ist ein echter Graph nötig? | LongMemEval-Kategorien multi-session und temporal-reasoning im Vergleich zu den übrigen | Rückstand über 0,10 gegenüber den übrigen Kategorien: separater Spike mit Graphiti auf FalkorDB (nicht Neo4j), mit eigener Messung. Sonst nichts. |
| E5 | Funktioniert Copilot als Stufe? | Phase 3 | Ja: Stufe 3. Nein: Stufe entfällt, Copilot-Sessions werden von Stufe 1, 2 oder 4 bearbeitet. |
| E6 | Reicht Qdrant im Pfad-Modus in der Praxis? | Phase 1 mit 3 parallelen Sessions **und** einer Collection mit 20.000 Fakten (synthetisch, wie A.11) | Ja (Worker-Start unter 2 s, MCP-Antwort unter 2 s im p95): bleibt. Nein: Chroma als Store, Keyword über SQLite-FTS5. |
| E7 | Mehr als 3 Modellaufrufe pro Bündel? | Phase 1 | Ja: Widerspruchsurteil nur bei Score ≥ 0,75 und Bündelung auf 3 Turns. |
| E8 | Standard-Prompt von mem0 oder eigener Coding-Prompt? | Phase 0, Fixture (a) und 20 echte Turns, Müllquote und hit@1 | Eigener Prompt gewinnt bei Müllquote um ≥ 10 Punkte oder hit@1 um ≥ 0,05: eigener Prompt. Sonst Standard. |
| E9 | Tokenverbrauch der Stufe 1 pro Tag tragbar? | Phase 5, `observe_calls` | Über 20 % des 5-Stunden-Fensters im Mittel: `bundle_tokens` auf 4.000, Bündelung auf 3 Turns, danach Ollama als Standardstufe für Claude-Turns. |

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

## 14. Installation und Betrieb für Dritte

Ziel: Jemand ohne Kontakt zu uns installiert Agent Mem in unter fünf Minuten, und es läuft ohne Nacharbeit. Maßstab sind claude-mem (Plugin aus dem Marketplace, Kontext mit Token-Ersparnis, Viewer, Arbeitsstand) und agentmemory (lokale Modelle, kein Server). Beide haben etwas, das wir noch nicht haben: eine Installation, die nicht erklärt werden muss.

Bestand (2026-10-12): `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md` sind leer. `plugins/claude/.claude-plugin/plugin.json` sagt noch „No LLM calls". Die Hooks rufen `agent-mem hook claude` über `PATH`; in IDE- oder GUI-gestarteten Sessions ist `PATH` oft unvollständig. Die Observer-Abhängigkeiten (mem0, qdrant, fastembed, spaCy) wiegen rund 400 MB plus Modelle. CI läuft schon auf Ubuntu, macOS arm64, macOS Intel und Windows.

| \# | Entscheidung | Begründung |
| --- | --- | --- |
| I1 | Ein Installationsweg: `uv tool install agent-mem` oder `pipx install agent-mem`, dann `agent-mem setup <harness>`. Veröffentlichung auf PyPI über `release.yml`, Claude-Code-Marketplace-Eintrag (`/plugin marketplace add …`) zeigt auf dasselbe Paket. | Ein Weg lässt sich testen und erklären. |
| I2 | `setup` schreibt den **absoluten Pfad** des `agent-mem`-Binarys in die Hook-Dateien, nie den bloßen Namen. | Hooks aus IDE oder GUI finden sonst das Binary nicht. Häufigster Installationsfehler bei claude-mem-artigen Werkzeugen. |
| I3 | Drei Stufen: Kern (nur stdlib, Capture, FTS5, Injection, Viewer, MCP), `[semantic]` (fastembed), `[observer]` (mem0, qdrant, spaCy). Der Kern läuft ohne die anderen vollständig, mit Rohstufe statt Fakten. | Wer nur 10 MB will, bekommt ein funktionierendes Gedächtnis. Wer Fakten will, zahlt die 400 MB bewusst. |
| I4 | `setup` erkennt Harnesses und Provider (`claude`, `codex`, `copilot`, `ollama` im `PATH`, Login-Zustand per Trivialaufruf), lädt die Modelle mit Fortschrittsanzeige und zeigt zuletzt eine Tabelle: was läuft, was fehlt, was es im Abo kostet. Es fragt nie nach einem API-Key. | Erster Eindruck entscheidet. Keine Überraschung beim ersten Turn. |
| I5 | `doctor` prüft zusätzlich: Observer-Extra vorhanden, Warteschlange und letzter Worker-Lauf, Provider erreichbar, Qdrant-Größe gegen A.11, Hook-Pfade zeigen auf ein existierendes Binary, Hook-Laufzeit. `doctor --json` ist der Anhang für Fehlerberichte. | Fehler müssen sich selbst erklären; wir können nicht bei jedem Rechner zuschauen. |
| I6 | `agent-mem uninstall <harness>` entfernt Hooks und MCP-Einträge und lässt die Daten liegen; `purge` löscht Daten. Beides ohne Rückfrage außer bei `purge`. | Sauberes Entfernen gehört zur Installation. |
| I7 | Versionierung semver. Jede Schema- oder Embedder-Änderung ist ein Minor mit Migration (R6) bzw. automatischem `reindex` beim ersten Start. `mem0ai` gepinnt; Upgrade nur mit grünem Adapter-Test (D1). `CHANGELOG.md` je Release. | Upgrades dürfen keine Daten brechen. |
| I8 | Dokumentation vor Release 2.0: `README.md` (Installation in drei Zeilen, was es tut, was es kostet, was es speichert, was es nie tut), `ARCHITECTURE.md` (aus §3 bis §5), `SECURITY.md` (Bedrohungsmodell aus §6, Meldeweg), `CHANGELOG.md`, `CONTRIBUTING.md` (R9, Tests mit `fake`-Provider). Alles in Englisch. | Open Source ohne README wird nicht installiert. |
| I9 | Abnahme „frische Maschine": Vor jedem Release eine Installation nach README auf einem frischen Benutzerkonto je OS (macOS, Linux, Windows), ohne Vorwissen, Zeit gemessen, bis die erste Session Fakten liefert. Ziel unter fünf Minuten plus Modell-Download. | Nur so sehen wir, was Dritte sehen. |
| I10 | Keine Telemetrie, kein Netzwerk außer Modell-Downloads. Steht im README an erster Stelle. mem0-Telemetrie ist per Test ausgeschaltet (§6, Punkt 4). | Unterscheidungsmerkmal gegenüber claude-mem (OpenRouter) und mem0 (PostHog). |
| I11 | Unterstützungsmatrix im README: Python ≥ 3.11; Ubuntu, macOS arm64, macOS Intel (ohne fastembed, Embedder über Ollama), Windows; Harness-Versionen, mit denen getestet wurde. | Erwartungen klären, bevor jemand installiert. |
| I12 | Fehlerberichte: GitHub-Issue-Vorlage verlangt `agent-mem doctor --json` und die letzten 50 Zeilen des Logs (Pfad aus `agent-mem paths`). Logs enthalten nie Prompt-Inhalte (R4). | Reproduzierbare Berichte statt Rätselraten. |

Was Agent Mem gegenüber claude-mem und agentmemory können muss, damit „besser" messbar ist:

| Merkmal | claude-mem | agentmemory | Agent Mem (Ziel) |
| --- | --- | --- | --- |
| Harnesses | Claude Code | Browser/TS | Claude Code, Codex, Copilot CLI, OpenCode |
| Modellaufrufe | OpenRouter oder Claude, API-Key oder Abo | keine (lokale Embeddings) | Abo-Login oder Ollama, nie Key |
| Daemon | Bun-Worker-Prozess | kein | kein (Worker mit Leerlauf, R1) |
| Widersprüche | nicht | nicht | ja (§4.6), gemessen (§8) |
| Datenhoheit | SQLite + Chroma | lokal | SQLite als Wahrheit, alles ableitbar |
| Installation | Marketplace, ein Befehl | npm | I1 bis I4 |
| Sichtbarkeit | Viewer-UI, Token-Ersparnis | — | Viewer (D10), `status`, `observe --status` |

Phase 4 (§9) übernimmt I1 bis I12 und I9 als Abnahme. Phase 4 wird dafür von 2 auf 5 Tage verlängert; gesamt 22 Arbeitstage.

## Anhang A: Gemessene Fakten (alle auf dieser Maschine, 2026-10-11/12)

Skripte liegen unter `docs/evidence/spikes/`.

- **A.1 mem0 ohne Key, Widerspruch** (`mem0_ollama_contradiction.py`): mem0ai 2.2.1, Ollama `qwen3.5:4b-mlx` und `qwen3.6:35b-mlx`, Embedder `nomic-embed-text`, FAISS. Nachrichten „Wir nutzen pytest" und „Korrektur: nox statt pytest" ergaben bei beiden Modellen zwei ADDs; der alte Fakt blieb gültig. Einzelprobe, saubere Läufe mit isoliertem `MEM0_DIR`.
- **A.2 Provider-Validierung**: Ein eigener Provider-Name in der Config scheitert („Unsupported LLM provider"). Setzen von `memory.llm` nach `from_config` funktioniert.
- **A.3 mem0 über** `claude -p` (`mem0_claude_cli.py`): Haiku unter Abo-Login, gleiche zwei Nachrichten, zwei ADDs, `add` 3,4 s, `search` unter 0,1 s. `--bare` ergibt „Not logged in". Ohne `--setting-sources ""` laufen die Hooks von claude-mem im Beobachter mit und verfälschen die Ausgabe.
- **A.4 Qdrant mit Sperre** (`qdrant_lock_two_processes.py`): Zwei Prozesse, je 15 Operationen mit `filelock` und `close()`, 30 von 30 Punkten, Median 7 bis 8 ms pro Öffnen und Schreiben. Ohne Sperre scheitert der zweite Zugriff: „already accessed by another instance".
- **A.5 Chroma** (`chroma_two_processes.py`): Zwei parallele Schreiber, 40 von 40 Einträgen ohne Sperre. mem0 hat für Chroma keine Keyword-Suche.
- **A.6 Graph in mem0**: Im installierten Paket kein `graph_store`, kein Neo4j, Kuzu oder Memgraph. Entitäten (PROPER, QUOTED, TOPIC, IDENTIFIER) kommen aus spaCy und liegen in einer zweiten Collection (`entity_store`). Keyword-Suche (BM25) bietet unter den lokalen Stores nur Qdrant.
- **A.7 Codex**: `codex exec --ephemeral --ignore-user-config -s read-only … --output-schema … -o …` lieferte `{"a":"ok"}` unter dem CLI-Login, 24.569 Tokens für einen Trivialaufruf. Copilot CLI ist nicht installiert (`which copilot` leer).
- **A.8 Lizenzen** (geprüft 2026-10-12 aus den Paketmetadaten): mem0ai 2.2.1 Apache-2.0, qdrant-client 1.19.1 Apache-2.0, fastembed 0.9.0 Apache-2.0, spaCy 3.8.16 MIT, onnxruntime 1.31.0 MIT, ollama 0.6.3 MIT, filelock MIT. mem0 zieht außerdem openai (Apache-2.0), posthog (MIT) und sqlalchemy (MIT) als Pflichtabhängigkeiten. Alles permissiv.
- **A.10 Was mem0 2.2.1 bei** `add` **und** `search` **tut** (Quelltext `mem0/memory/main.py`, Zeilen 881 bis 1075 und 1642 bis 1735):
  - `add`: (1) letzte 10 Nachrichten der Session laden; (2) die neuen Nachrichten einbetten und die 10 ähnlichsten vorhandenen Fakten im Vektor-Store suchen; (3) **ein** LLM-Aufruf mit diesen Fakten, den neuen und den letzten Nachrichten, Antwort `{"memory": [{"text": …}]}`, nur Hinzufügen (kein Update, kein Löschen); (4) alle neuen Fakten in einem Stapel einbetten; (5) Duplikate per MD5-Hash verwerfen; (6) Fakten samt Vektor, `data`, `text_lemmatized`, `hash`, `created_at` in den Vektor-Store schreiben; (7) Entitäten per spaCy (ohne LLM) ziehen, einbetten und in der Entity-Collection verknüpfen.
  - `search`: Anfrage einbetten, semantische Suche (Überhol-Faktor, mindestens 60), BM25 über lemmatisierte Anfrage (falls der Store Keyword-Suche kann), Entitäts-Boost, dann `score_and_rank` mit Schwelle 0,1.
  - Embeddings werden also an vier Stellen gebraucht: Anfrage bei `add` (Vorwissen für das LLM), neue Fakten (Speicher), Entitäten (Verknüpfung), Anfrage bei `search`.
- **A.9 Schema**: `memories` hat `invalid_at`, `superseded_by`, `valid_from`, `importance`, `dedupe_key`, `kind IN (… 'fact' …)`; `store.supersede` und `store.add_memory(dedupe=…)` existieren.
- **A.11 Qdrant-Pfadmodus, Öffnungszeit nach Größe** (2026-10-12, `qdrant_scale.py`, 384 Dimensionen, Zufallsvektoren, Öffnen + eine Suche + Schließen, Median aus 5): 1.000 Vektoren 34 ms und 4 MB; 5.000 Vektoren 161 ms und 21 MB; 20.000 Vektoren 689 ms und 84 MB. Der Pfadmodus lädt die Collection beim Öffnen vollständig; die Zeit wächst linear. A.4 (7 bis 8 ms) galt für eine fast leere Collection. Bei rund 500 Fakten pro Tag sind 20.000 nach etwa sechs Wochen erreicht.
- **A.12 mem0 2.2.1, weitere Quelltextbefunde** (`memory/main.py`, `memory/storage.py`): `add` liefert nur `ADD`-Einträge (Zeilen 1030 bis 1075), es gibt keinen Update- oder Löschpfad in der Extraktion. `run_id` filtert auch die Ähnlichkeitssuche beim `add` (Zeilen 386 bis 388). `save_messages` speichert die übergebenen Nachrichten in `history.db` (`storage.py:257`). `add(..., infer=False)` embeddet ohne Modellaufruf (Zeile 770). Entity-Ids dürfen keine Leerzeichen enthalten; `|` ist erlaubt. Embedder-Liste in `embeddings/configs.py:16-28` enthält `fastembed` und `ollama`.

## Anhang B: Messberichte

Wird in Phase 0 und 2 gefüllt. Format je Lauf: Datum, Commit, Modell, Datensatz, Zahlen. Kein Eintrag wird nachträglich geändert; neue Läufe kommen darunter. Rohberichte liegen unter `docs/evidence/runs/`.

- **B.1 Hook-Laufzeit Bestand** (2026-10-12, Commit a1a478c, `agent-mem hook claude`, Stop-Ereignis, 20 Turns, frisches Datenverzeichnis, inklusive Prozessstart): Median 67 ms, p95 93 ms, Maximum 154 ms. Schwelle §8 (&lt; 100 ms p95) ist im Bestand erfüllt; Phase 1 misst erneut mit `spawn_worker`.
- **B.2 Fixture, Bestand (sqlite)** (2026-10-12, Commit db14e40, `agent-mem eval --fixture tests/fixtures/memory_cases.json --backend sqlite`, Embedder multilingual-e5-small): hit@1 1,00 (20/20), Abstention 0,40 (2/5), Widerspruchspaare 0/10. Der Bestand findet die Turns, kann aber nicht ablehnen und löst keinen Widerspruch; damit ist die Fixture für hit@1 zu leicht und für Abstention und Widersprüche der eigentliche Maßstab.
- **B.3 Bündelgröße an echten Turns** (2026-10-12, 103 Turns aus den sechs jüngsten Claude-Code-Transkripten dieser Maschine, Schätzung 4 Zeichen pro Token, Median 3 Tool-Aufrufe je Turn): vollständig Median 1.588, p75 7.833, p95 29.080, Maximum 112.198 Tokens. Mit Tool-Ausgaben auf 800 Zeichen und Argumenten auf 2.000 Zeichen gekürzt: Median 810, p75 3.336, p95 9.136, Maximum 22.241. Nur Nutzer plus Assistent: Median 130, p95 4.359. Folge: Die Standardwerte aus §4.3 (800 Zeichen, 6.000 Tokens) treffen; die 6.000er-Grenze teilt etwa jeden achten Turn, 4.000 etwa jeden fünften.
- **B.4 Copilot CLI als Stufe 3 (E5)** (2026-10-12): `@github/copilot` 1.0.95 per `npm install -g` installiert; `copilot -p "…" -s` antwortet unter dem bestehenden GitHub-Login ohne weitere Anmeldung. Befund für den Provider: Mit `-p` wird stdin ignoriert und ein Prompt von 30.000 Zeichen auf der Kommandozeile liefert eine leere Antwort; ohne `-p` liest `copilot -s` den Prompt von stdin und liefert gültiges JSON. Memory und Tools sind im Prompt-Modus standardmäßig aus. `--model` akzeptiert nur Modelle der eigenen Liste (`claude-haiku-4.5` nicht verfügbar), Standardmodell wird genutzt. **E5: Ja, Stufe 3 bleibt.** Provider `CopilotCliLLM` ist eingebaut.
- **B.5 mem0-Telemetrie und Heimatverzeichnis** (2026-10-12): mem0 liest `MEM0_TELEMETRY` und `MEM0_DIR` beim Import und kopiert die Werte in Modulvariablen (`memory/telemetry.py:14`, `memory/setup.py:11`, `configs/base.py:13`, `memory/main.py:51`). Mit Telemetrie an legt `Memory.__init__` einen zweiten Qdrant-Store `<MEM0_DIR>/migrations_qdrant` an (`main.py:516-541`); zwei Prozesse kollidierten dort („already accessed by another instance"), obwohl beide ein eigenes Datenverzeichnis hatten. Behoben: Das Paket `agent_mem.observe` setzt beide Variablen vor dem ersten mem0-Import, der Adapter überschreibt zusätzlich die Modulvariablen; Test `tests/test_observe.py` sichert das ab und prüft, dass der Hook-Pfad weder mem0 noch qdrant noch fastembed importiert.
- **B.6 Entity-Store** (2026-10-12): Collection `agent_mem_entities` wird gefüllt nur im Pfad `infer=True` (`main.py:1103`, `extract_entities_batch` nach der Extraktion). `add(..., infer=False)` legt keine Entitäten an. Folge für §5: `reindex` baut den Entity-Store nicht mit auf; Phase 1 ruft dafür `_link_entities_for_memory` je Fakt (interne API, durch Adapter-Test abgesichert) oder verzichtet auf den Entity-Boost nach einem Reindex. spaCy-Modell ist `en_core_web_sm` (englisch); mem0 lädt es sonst zur Laufzeit per pip in die aktive Umgebung nach, deshalb steht es in der dev-Gruppe und gehört in `setup` (I4).
- **B.8 Schwelle für Widerspruchskandidaten (§4.6)** (2026-10-12, Commit 96b2301, mem0-Suche mit e5-small, `add(infer=False)`): Index aus den 10 „vorher"-Aussagen der Widerspruchspaare plus 20 unverwandten Aussagen; Anfrage ist jeweils die „nachher"-Aussage. Score des zugehörigen alten Fakts: 0,96 / 0,958 / 0,95 / 0,935 / 0,934 / 0,932 / 0,931 / 0,926 / 0,721 / 0,662 (10 von 10 unter den Top-5). Höchste Scores unverwandter Treffer: 0,931 / 0,914 / 0,912 / 0,901 / 0,882 … Die Scores trennen nicht; mem0s Hybrid-Score ist nach oben gestaucht. Folge: `contradiction.min_score = 0,6` behält alle echten Paare (Recall 10/10) und liefert pro Fakt bis zu drei unverwandte Kandidaten, die das gemeinsame Urteil (ein Aufruf pro Bündel) aussortiert. Die E7-Rückfallschwelle 0,75 würde 2 von 10 echten Paaren verlieren; E7 wird deshalb auf „Bündelung auf 3 Turns" ohne Schwellenanhebung geändert.
- **B.9 Fixture, reines mem0 mit Claude Haiku** (2026-10-12, Commit cb520d0, `--backend mem0 --llm claude --llm-model haiku`, Embedder e5-small über den Adapter, 69 `add`-Aufrufe je Lauf):
  - Standard-Prompt: hit@1 0,95 (19/20; c04 verfehlt, der Fakt zur Lösung ist nicht Top-1), Abstention 0,00 (0/5), Widerspruchspaare 1/10 nach Top-3-Metrik (in 9 Fällen steht der veraltete Fakt weiter in den Top-3, bestätigt D7). `add` Median 5,4 s, p95 9,2 s. Fakten durchgehend englisch, Stil „User asked …", mit erfundenen Datumsangaben („on October 11, 2026") aus mem0s Prompt.
  - Coding-Prompt (`observe/coding_instructions.md` als `custom_instructions`): hit@1 0,90 (18/20; c01 und c14 verfehlt), Abstention 0,00, Widerspruchspaare 0/10. `add` Median 6,5 s, p95 10,2 s. Fakten in der Sprache der Eingabe, kürzer, ohne Datumsangaben.
  - Abstention: mem0 liefert immer Treffer; die Scores unverwandter Treffer (0,76 bis 0,80) liegen über dem kleinsten Score eines richtigen Treffers (0,43). Eine Score-Schwelle kann in mem0 nicht ablehnen. Abstention muss aus der SQLite-Seite (E3) oder aus einem Urteil kommen.
  - E8-Stand: hit@1 liegt beim Coding-Prompt 0,05 unter dem Standard; die Entscheidung fällt mit der Müllquote an 20 echten Turns (B.10).
- **B.10 Müllquote an 20 echten Turns (E8)** (2026-10-12, Commit 00714ee, `docs/evidence/spikes/garbage_rate_real_turns.py`, 20 jüngste Turns aus den Claude-Code-Transkripten dieser Maschine, Bündel aus Nutzer- und Assistententext plus Tool-Namen und -Argumenten ohne Tool-Ausgaben, Grenze 24.000 Zeichen, Haiku, ein Namespace, Reihenfolge erhalten; Rohdaten privat unter `~/.cache/agent-mem/eval/real_turns_*.json`, nicht im Repo). Müll nach §8: Routinehandlung ohne Dauerwert, Allgemeinwissen, Duplikat eines früheren Fakts im Lauf, erfunden, oder reine Erzählung („User asked …", „The assistant recommended …"); Zählung von Hand durch mich je Turn.
  - Standard-Prompt: 146 Fakten (7,3 je Turn), davon rund 40 Müll (27 %). `add` Median 10,4 s, p95 23,4 s. Alles englisch, viele Duplikate über Turns hinweg (Turn 3 und 4 wiederholen Turn 1 und 2), erfundene Datumsangaben, Stil „On 2026-10-11 the assistant …".
  - Coding-Prompt: 198 Fakten (9,9 je Turn), davon rund 27 Müll (14 %). `add` Median 18,3 s, p95 30,0 s. Sprache der Eingabe, konkrete Bezeichner (Pfade, Flags, Commits), weniger Erzählung; dafür mehr Fakten je Turn und drei Fakten aus dem Text eines Stop-Hooks, der als Nutzer-Prompt im Transkript stand.
  - **E8: Coding-Prompt gewinnt** (13 Punkte weniger Müll, Schwelle 10; hit@1 auf der Fixture 0,05 schlechter, das ist ein Fall von 20 und innerhalb des Rauschens). Phase 1 ergänzt den Prompt um eine Obergrenze je Bündel (etwa 8 Fakten) und der Bündelbau lässt Hook-Rückmeldungen und System-Hinweise weg, die im Transkript als Nutzer-Nachricht erscheinen.
- **B.11 LongMemEval-S, Teilmenge 40, Bestand (sqlite)** (2026-10-12, Commit 00714ee, `agent-mem eval longmemeval_s.json --subset tests/fixtures/longmemeval_subset.json --backend sqlite`, Embedder e5-small, Standard-Schwelle 0,78, Laufzeit 16,7 min): Recall@5 gesamt 0,925 (37/40); knowledge-update 1,00 (6), multi-session 0,90 (10), single-session-assistant 1,00 (5), single-session-preference 0,67 (3), single-session-user 1,00 (6), temporal-reasoning 0,90 (10). Recall@10 identisch, weil der Bestand nach Session-Dedup selten mehr als 5 Sessions liefert. Das ist der Maßstab für §8 („neu ≥ Bestand − 0,02", also ≥ 0,905) und für E4 (multi-session und temporal liegen 0,10 unter den Einzel-Session-Kategorien; ein Rückstand von genau 0,10 löst den Graph-Spike nicht aus, da E4 „über 0,10" verlangt; Phase 2 misst erneut).
- **B.12 E2 auf der Fixture** (2026-10-12, Commit 96b2301 bis 00714ee, `--backend sqlite --embedder …`): Mit Standard-Schwelle 0,78 liefern MiniLM-L12-v2, embeddinggemma-300m und Qwen3-Embedding-0.6B-Q exakt die Werte des rein lexikalischen Laufs (hit@1 0,85, Abstention 1,00, 1/10), weil ihre Kosinus-Werte unter der für e5 kalibrierten Schwelle liegen und kein Vektor zählt. Mit Schwelle 0 liefern alle vier Modelle hit@1 1,00, Abstention 0,00, 1/10. Die Fixture unterscheidet Embedder nicht; E2 wird auf der LongMemEval-Teilmenge mit Schwelle 0 entschieden (B.13). embeddinggemma kommt über den Spiegel `onnx-community` ohne Anmeldung, steht aber unter den Gemma-Nutzungsbedingungen (kein OSI-Lizenztext); für ein Open-Source-Paket bleibt es nur Kandidat, wenn es klar vorne liegt.
- **B.13 Entity-Store im Extraktionspfad** (2026-10-12, Commit 234542d, Fall c20 der Fixture, Haiku): Nach einem `add` mit `infer=True` enthält `agent_mem_entities` 5 Einträge: „payments module" (TOPIC), „platform team" (TOPIC), „Slack" (PROPER), „# ledger dev Slack channel" (TOPIC), „Ledger" (PROPER). Der Entity-Store wird also gefüllt (Abnahme aus §9, Phase 0, erfüllt); Lücke bleibt nur der Reindex-Pfad (B.6).
- **B.14 Fixture, reines mem0 mit Ollama qwen3.5:4b-mlx** (2026-10-12, Commit 234542d, Standard-Prompt, Embedder e5-small, 69 `add`-Aufrufe, parallel lief die E2-Embedding-Messung auf der CPU): hit@1 0,85 (17/20; c04, c12, c14 verfehlt; c12 ohne Treffer), Abstention 0,00, Widerspruchspaare 0/10. `add` Median 21,2 s, p95 35,7 s. Gegenüber Haiku (B.9) 0,10 schlechter und viermal langsamer; für den Nachtlauf auf LongMemEval ausreichend, für den Betrieb nur Rückfallstufe (D12).
- **B.15 Hook-Laufzeit mit `spawn_observer` (Phase 1)** (2026-10-12, Worker-Code in `observe/`, 20 Stop-Ereignisse, frisches Datenverzeichnis, `observe.providers = []`, damit der gestartete Worker ohne Modell roh ablegt; Maschine unter Last durch E2-Embedding und den Ollama-Nachtlauf, load average 22): mit Spawn Median 180 ms, p95 213 ms, Maximum 236 ms; ohne Spawn (`AGENT_MEM_NO_SPAWN=1`) bei gleicher Last Median 172 ms, p95 200 ms, Maximum 215 ms. Der Spawn kostet also rund 8 bis 13 ms; die Abweichung zu B.1 (67 ms) ist Maschinenlast. Der Worker verarbeitete die 20 Turns in 4 Bündeln (Rohstufe), Lock und Marker funktionierten. Die Schwelle aus §8 (p95 unter 100 ms) wird in Phase 1 auf einer unbelasteten Maschine erneut gemessen, sobald die Nachtläufe durch sind.
- **B.16 Schwelle für Widerspruchskandidaten, zweite Kalibrierung** (2026-10-12, Worker-Code): B.8 hatte die „nachher"-Aussage als Anfrage benutzt, ohne sie in den Index zu legen. Im Betrieb liegt der neue Fakt beim Suchen schon im Index (mem0 fügt erst ein, dann prüfen wir). Mit 30 Fakten im Index bleiben die Scores hoch (echte Paare 0,66 bis 0,96, 9 von 10 in den Top-3; unverwandte bis 0,93). Mit nur **zwei** Fakten im Index fällt der Score des echten Paars auf 0,46, weil mem0 relativ zur Treffermenge normiert; ein frisches Projekt würde seine ersten Widersprüche damit verpassen. Folge: `observe.contradiction_min_score` Standard 0,4 statt 0,6; die Kandidatenzahl bleibt durch Top-3 je Fakt und 15 Paare je Bündel begrenzt, das gemeinsame Urteil sortiert unverwandte Paare aus. §4.6 ist entsprechend geändert.
- **B.17 Worker Ende-zu-Ende mit Stufe 1 (Phase 1, Abnahme „Korrektur löst den alten Fakt ab")** (2026-10-12, Worker-Code mit Coding-Prompt, `observe.providers = ["claude"]`, Haiku, frisches Datenverzeichnis, zwei Sessions über echte Hook-Aufrufe): Turn 1 „Tests laufen mit pytest über uv run pytest" ergab den Fakt „Projekt verwendet pytest als Test-Runner; Tests werden direkt über `uv run pytest` gestartet." Turn 2 (Korrektur nox) ergab „Tests laufen mit nox über `nox -s tests`. Der frühere direkte Aufruf mit `uv run pytest` gilt nicht mehr …"; das Urteil lautete SUPERSEDE, der alte Fakt bekam `invalid_at` und `superseded_by = 2` und wurde aus mem0 entfernt (Suche „Tests" liefert nur noch den neuen). Drei Modellaufrufe insgesamt: extract 11,2 s, extract 6,2 s, judge 3,7 s. Gefundener Fehler dabei: Dasselbe alte Fakt kann in einem Bündel mehreren neuen Fakten unterliegen; der zweite `forget` warf „Memory not found" und riss den Lauf ab. Behoben: `forget` toleriert fehlende Ids, `apply` merkt sich entfernte Ids, und ein Fehler beim Anwenden der Urteile verliert nie das Bündel (Fakten sind zu dem Zeitpunkt schon gespiegelt).
- **B.18 Phase-1-Abnahme „nächste Session bekommt die Fakten"** (2026-10-12, Stufe 1 Haiku, echte Hook-Aufrufe `SessionStart`, `UserPromptSubmit`, `Stop` in Session s1 mit zwei Turns, dann Worker, dann Session s2): Der Worker erzeugte aus einem Bündel drei Fakten („Die API läuft auf Fly.io mit der App kassen-api in der Region fra.", „Die fly.toml setzt app = kassen-api, primary_region = fra und den internen Port 8080.", „Die Keycloak-Anmeldung (OIDC) verwendet den Realm intern und den Client web-app."). Der `SessionStart`-Hook der Session s2 lieferte alle drei als `[M1…M3 · fact]` im `additionalContext`, als Daten gerahmt, ohne Codeänderung an `inject.py` (D6, §4.7 bestätigt). Der folgende `UserPromptSubmit` zur Realm-Frage blendete nichts erneut ein, weil dieselben Einträge in dieser Session schon gezeigt wurden (vorhandene Dedup über `accesses`). Phase-1-Abnahme damit erfüllt bis auf die Hook-Laufzeit auf unbelasteter Maschine (B.15).
- **B.19 E2 auf LongMemEval-40, Zwischenstand** (2026-10-12, Commit 282b5e1, `--backend sqlite --vector-floor 0`, Maschine unter Last durch den Ollama-Nachtlauf): multilingual-e5-small (384 Dim., 118 MB, MIT, eigene Registrierung nötig) Recall@5 0,900, Laufzeit 11,8 min; paraphrase-multilingual-MiniLM-L12-v2 (384 Dim., 220 MB, Apache-2.0, in der fastembed-Liste) 0,925, 6,4 min; embeddinggemma-300m (768 Dim., 1,24 GB, Gemma-Bedingungen) 0,925, 118 min; Qwen3-Embedding-0.6B-Q (1024 Dim., 1,12 GB, Apache-2.0) lief nach über zwei Stunden noch, Ergebnis folgt als B.20. Je Fragetyp liegen MiniLM und Gemma gleich (knowledge-update 1,00, multi-session 0,90, temporal 0,90, preference 0,67); e5 verliert bei knowledge-update (0,83). Nach der E2-Regel (höchster Recall@5, bei Abstand unter 0,01 das kleinere Modell, Latenz zählt) steht **MiniLM-L12-v2** vorn: gleicher Recall wie Gemma bei einem Fünftel der Größe, einem Achtzehntel der Laufzeit und ohne eigene Registrierung (D11 erfüllt). Umstellung in Phase 2 zusammen mit E3: Standardmodell in `config.semantic.model`, Schwelle `min_vector_score` neu kalibrieren (0,78 ist e5-spezifisch, B.12), `query:`/`passage:`-Präfixe nur noch für e5-Modelle, Reindex beim ersten Start nach dem Upgrade (I7).
- **B.7 Adapter-Rauchtest** (2026-10-12, Commit db14e40, Fall c01 der Fixture, Ollama `qwen3.5:4b-mlx`, Embedder e5-small über den eigenen Adapter): `add` 50,2 s (erster Aufruf mit Modellstart) und 29,3 s; `search` 0,02 s; 5 Fakten, alle englisch trotz deutscher Eingabe, Stil „User is setting up …". Der Standard-Prompt von mem0 heißt in 2.2.1 `custom_instructions` (ergänzt den Prompt, ersetzt ihn nicht); der in §11 genannte Name `custom_fact_extraction_prompt` existiert nicht mehr. Die Zeit von 30 s pro `add` mit dem 4b-Modell bedeutet für die LongMemEval-Teilmenge (40 Fragen, rund 2.000 Sessions) etwa 17 Stunden; der Lauf wird deshalb auf zwei Nächte verteilt oder auf 20 Fragen gekürzt, Entscheidung nach dem Fixture-Lauf.