# claude-mem Dokumentation 13.36.1, vollständig gelesen (2026-10-13)

Quelle: `~/.claude/plugins/marketplaces/thedotmack/docs` (Repo-Stand bd2e084, 2026-10-12), alle 51 Mintlify-Seiten unter `docs/public/` plus die internen Seiten unter `docs/` (ADRs, Server, Native-Bridges, Session-IDs, Merge-Rubrik, Production-Guide). Nicht im Detail gelesen: `i18n/` (README-Übersetzungen), `expense-pricing/` (Preistabellen), `context/cursor-hooks-reference.md` (Cursor-eigene Doku), Kapitel 9–14 der Team-Vision (Produktideen).

## Wo agent-mem schon vorne liegt (laut claude-mems eigener Doku)

- Warteschlange: claude-mem hält die Observer-Queue im Worker-RAM. Die Doku sagt mehrfach „Never restart a healthy worker“, Issue #4068 ist offen, Codex-Batching „braucht nach Crash Transcript-Replay“. agent-mem: `observe_queue` in SQLite mit Lease und Backoff.
- Observer-Isolation: claude-mem braucht `CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR`, damit Observer-Transkripte nicht in `~/.claude/projects` landen. agent-mem nutzt `--no-session-persistence` und `--setting-sources ""`.
- Subagent-Flut: claude-mem hat nach 429-Fluten durch Dynamic Workflows `SKIP_SUBAGENT_OBSERVATIONS` nachgerüstet (Default aus). agent-mem bündelt nur die Endantworten von höchstens drei Subagents pro Turn.
- Relevanz statt Aktualität: claude-mem injiziert beim Start die neuesten 50 Beobachtungen; der eigene Production-Guide nennt das als Problem und empfiehlt das optionale `SEMANTIC_INJECT`. ACT-R-Ranking ist dort opt-in (`REINFORCE_ALPHA=0`). agent-mem rankt und kann schweigen.
- Keine API-Keys: claude-mem bietet als Default CMEM Pro (bezahlt) an, dazu OpenRouter, Gemini, OpenAI-kompatibel.

## Kandidaten zum Übernehmen (nach Nutzen/Aufwand)

1. Native Turn-Identität: `nativePromptId` des Hosts plus SHA-256 des bereinigten Prompts. Gleiche ID mit gleichem Text liefert dieselbe Prompt-Nummer, gleiche ID mit anderem Text gibt 409, gleicher Text mit anderer ID ergibt zwei Turns. agent-mem dedupliziert Ereignisse schon über `harness|session|kind|sha256(ts, tool_use_id, …)` (`hooks/capture.py:48`); ein Hook-Retry mit neuem Zeitstempel ergäbe aber ein zweites Ereignis. Niedrige Priorität.
2. Native-Memory-Ingest ohne Modell: Claude-Code-Auto-Memory (`memory/*.md`, ohne `MEMORY.md`) direkt als Fakten, Frontmatter `type`/`originSessionId` als Metadaten, Content-Hash-Dedup, Symlinks nie folgen, >64 KB überspringen, Änderung ergibt neuen Snapshot, Löschen der Quelle löscht das Archiv nicht.
3. Datei-Historie bei `Read`: Zeitleiste der Beobachtungen zu dieser Datei als Kontext, einmal pro Session pro Datei, nur ab 1,5 KB, nicht wenn die Datei seit der letzten Beobachtung geändert wurde. Spezifitätsranking: geändert +2, ≤3 Dateien +2, 4–8 +1. Kein Deny: claude-mems eigene Eval zeigt bei einer 19-KB-Datei mit Opus +20 % Tokens, erst ab 49 KB −32 %.
4. Index-Format: geschätzte Abrufkosten pro Eintrag (`~155`), Kopfzeile `Current: YYYY-MM-DD HH:MM TZ`, Session-Zusammenfassung nur zeigen, wenn sie nach der letzten Beobachtung entstand.
5. Fehlerklassen beim Observer: `auth_invalid` pausiert (kein Fallback hilft), `quota` mit Cooldown (30 min) und Probe durch genau einen Request, `transient` mit Backoff, `unrecoverable` ohne Retry; „Modell nicht mehr verfügbar“ nie retryen, sondern beim nächsten Start melden.
6. Host ohne SessionStart-stdout (Kimi): Kontext beim ersten UserPromptSubmit mit Marker je Session; PreCompact löscht den Marker; Marker nur bei Erfolg schreiben.
7. Prozess: Merge-Rubrik (nur Root-Cause-Fixes, keine Guards/Fallbacks/Retries/Reaper/Marker-Dateien, Größe proportional zum Fehler) und ADR-Format „Regressionstest scheitert gegen Baseline, besteht mit Änderung“.

## Laufende Notizen (Seite für Seite)

- Start-Index: Tabelle ID|Zeit|Typ-Icon|Titel|~Tokens, gruppiert nach Datum UND Datei-Pfad; Legende; Hinweis "kritische Typen (gotcha, decision, trade-off) sofort holen"; Token-Kosten pro Eintrag sichtbar
- Summary nur zeigen, wenn nach letzter Observation erzeugt (Staleness-Regel)
- 4 Ebenen: search -> timeline(anchor|query, depth) -> get_observations(ids batch) -> get_tool_uses (Roh-I/O, 64KB cap, truncation marker, content_hash vor Kürzung)
- tool_uses: UNIQUE(content_session_id, tool_use_id) idempotent; observation_id nachträglich verknüpft, nie überschrieben
- FTS-Trigger: UPDATE OF nur indexierte Spalten (sonst wächst Index bei Bookkeeping-Updates)
- Suche: Chroma semantisch zuerst, Keyword füllt leere Kategorien; alle Wörter müssen vorkommen, keine Operatoren; Substring-Fallback wenn keine Ganzwort-Treffer; CJK immer Substring; Prompts via LIKE
- Suchergebnisse unter Tages-Überschriften, Reihenfolge nach Relevanz
- MCP: 4 Tools, important_workflow als Anleitung; Schemas additionalProperties:true; 9->4 Tools reduziert (Token-Kosten der Tool-Definitionen)
- /clear: SessionStart source=clear, Session läuft weiter, prompt_number zählt hoch
- Zukunft (nicht gebaut): adaptive Indexgröße je source (startup/resume/compact)
## Gelesen: hooks-architecture, architecture/hooks
- Setup-Hook (version-check): prüft deklarierte deps, bun install bei Lücken, Marker .install-version, IMMER exit 0, nennt fehlende Module
- SessionStart-Matcher startup|clear|compact; continue/resume injiziert NICHT neu (Prompt-Cache bleibt)
- PostToolUseFailure gleicher Handler, speichert {error,is_interrupt} -> Fehlversuche im Gedächtnis
- Skip-Liste: ListMcpResourcesTool, SlashCommand, Skill, TodoWrite, AskUserQuestion
- Prompt komplett privat -> nichts speichern, auch Tool-Beobachtungen dieses Prompts überspringen
- Dual-Tag: <private> + <claude-mem-context> (Rekursionsschutz), Strip an 3 Stellen (Hook, Hook, Worker); max 100 Tags (ReDoS)
- Stop-Hook: letzte User- + Assistant-Nachricht aus Transcript (system-reminder gefiltert) -> Summary request/investigated/learned/completed/next_steps/notes
- SessionEnd: nur Status completed, Worker beendet Arbeit sauber (kein DELETE)
- Observer: Agent-SDK query() mit disallowedTools (alle), event-driven Message-Generator, Initial-/Continuation-/Observation-/Summary-Prompts, XML-Antwort
- Hook-Latenzen dokumentiert (context p95 120ms, PostToolUse p95 15ms)
- /api/processing = Operator-Retry für pausierte Sessions (Credential refused, Transport)
- Fehlermodi: DB locked -> skip+log; Disk full -> warnen, Memory abschalten
## Gelesen: worker-service, modes, file-read-gate, folder-context
- Queue-Status pending/processing/processed/failed, max 3 Retries, stuck = processing >5 min; manuelle Recovery-Route + CLI (Auto-Recovery beim Start AUS seit v5)
- Teardown loggt pendingCount bevor Puffer verworfen wird
- Modes: Rolle + Typen + Concepts + Sprache, Vererbung via "--" (code--de, code--chill = nur "painful to rediscover"); User-Modes in ~/.claude-mem/modes überleben Updates
- Telegram Wrap-up pro Projekt-Route
- File-Read-Gate (PreToolUse Read, sync): <1.5KB nichts; 1.5-32KB Timeline als Kontext; >=32KB Code + whole-file + unverändert seit letzter Obs + im Projekt + tree-sitter da -> DENY mit Timeline + Wegweiser (smart_outline/unfold, get_observations, Read offset/limit). Fail-open bei 3s Budget. Nur Hauptsession, nicht Subagent.
  - Spezifitätsranking: modified +2, <=3 Dateien +2, 4-8 +1; 1 pro Session, max 15; Timeline-Kontext pro Datei 1x pro Session
  - eigene Eval: 19KB-Datei Opus +20% (schlechter!), 49KB -32..-35% -> Schwelle 32KB empirisch
  - "Current: Datum Zeit TZ" Kopf für Zeitbezug; Titel als Historie markiert, nicht aktueller Inhalt
- Folder-CLAUDE.md (default aus): Tag-Block, Nutzerinhalt erhalten, Root ausgenommen, Submodule erkannt, atomare Writes, --clean
- Worktree: Kontext aus Eltern-Repo + Worktree zusammen
## Gelesen: configuration (58KB)
- CONTEXT_MAIN_AGENT_ONLY=true: Subagent-Obs (agent_id UND agent_type) nicht beim Start eingeblendet; Suche zeigt alles
- SKIP_SUBAGENT_OBSERVATIONS / SKIP_AGENT_TYPES (workflow-subagent) gegen Workflow-Flut (Hunderte Obs, 429)
- SKIP_BASH_PATTERNS Regex; ungültige Regex ignoriert -> Capture nie verloren
- REINFORCE_ALPHA (opt-in ACT-R): ln(1 + age^-0.5 + a*Σ age_k^-0.5), neuestes Viertel immer nach Aktualität
- SEMANTIC_INJECT (opt-in) pro Prompt top-5, Format narrative|index (narrative default: wirkt ohne Toolcall)
- WORK_STATE: work_state_write als kanonische To-do-Liste, offene Listen beim Start
- Observer-Budget: Generationen, retire bei MAX_CONVERSATION_CHARS (400k) bzw. halbes Kontextfenster; Tool-Feld cap 1/10 Fenster max 16k Zeichen; "Prompt is too long" -> neue Generation, gleiche Arbeit retry; zu großes Feld wird vom Modell verdichtet (FIELD_OPTIMIZE), Timeout -> abschneiden
- OBSERVE_BARE_PROMPTS=false: Prompt allein kein Observer-Call, geht mit nächstem Tool/Summary
- Quota Guard (Abo): stop bei 5h-Fenster 95%, 7d 93%..., 5h >=85% innerhalb 15 min vor Reset; Quota Fallback Provider
- Codex-Provider: codex app-server isoliert, Batch 8 Obs / 32k Zeichen, Effort low
- OBSERVER_CLAUDE_CONFIG_DIR: Observer-Transkripte aus ~/.claude/projects heraushalten (sonst importiert Codex sie als User-Chats)
- Near-Dup Dedup (opt-in): Tier0 normierter Titel -> merge + occurrence_count (gleiches Projekt/Host/Agent-Scope); Tier1 IDF-Cosine 0.8 nur Kandidaten zur Prüfung, IDF-Veto seltener Tokens, Cold-start <10 Docs aus
- TOOL_USES_RETENTION_DAYS: nur löschen, wenn verknüpfte Obs existiert (sonst einzige Kopie)
- IDLE_EXIT_SEC opt-in; Hook-Spool hält Obs während Worker weg
- Projektnamen: git root; worktree <repo>/<wt> liest Eltern; Submodul <super>/<path>; gelöschter Worktree wird beim Start in Eltern gefaltet; git-remote slug opt-in; .claude-mem-project Marker außerhalb git (nicht in $HOME/tmp); Named environments via Globs; project merge markiert statt umschreibt
- Kontext-Settings: Obs 50, Sessions 10, Typ-/Konzept-Filter, FULL_COUNT 5 expandiert (narrative|facts), Token-Ökonomie (read cost, work investment, savings), last summary/last message opt
- Kill-switches nur aus Hook-Env (DISABLE_TOOL_HOOKS etc.), Launcher prüft vor Bun-Start
- Sicherheit: Worker ohne Auth, nur Loopback; DNS-Rebinding Host-Check; DELETE nur ohne Origin/eigene Origin; TV-Token Allowlist exakt
## Gelesen: private-tags, auto-redaction, export-import, memory-ingest, manual-recovery, knowledge-agents, quota-fallback
- <private>: nested, mehrfach, an Hook-Kante; Zusammenfassungen nur aus nicht-privaten Obs
- Auto-Redaction opt-in: 11 Muster, Ersatz inline <redacted type='x'/> (Kontext bleibt), Observer-Prompt sagt "nicht Wert erraten"; Custom-Muster vor Built-ins; kaputte Regex übersprungen; >1M Zeichen Feld -> komplett oversize (fail closed); kaputte settings.json -> letzte gute Config weiter (nicht auf aus fallen); Log nur pattern,count
- Export: Query-basiert (hybrid), JSON mit Obs/Sessions/Summaries/Prompts; Import transaktional, Dedup-Schlüssel je Tabelle, Sessions zuerst; bestehende Session behält lokale Metadaten
- memory ingest: Claude-Code-Auto-Memory-MD direkt als Obs, ohne Modell (schon destilliert); MEMORY.md übersprungen; Frontmatter type/originSessionId als Metadaten; content-hash idempotent; Symlinks nie gefolgt, >64KB skip; --dry-run DB-frei; Quelle muss in ~/.claude/projects liegen
- Manual Recovery: stuck processing -> beim Start auf pending zurück, aber NICHT automatisch verarbeitet (gegen Duplikate); failed nach 3
- Knowledge Agents: build (Filter) -> prime (ganzer Korpus in SDK-Session, 1M Kontext, ~2000 Obs) -> query via resume; auto-reprime bei Ablauf
- Quota Fallback: Cooldowns (30 min spent, 90 s rate/5xx/2x leere Antwort), Probe durch EINEN Generator, Auth-Fehler NICHT umschalten (pausieren), Resume-Sweep 1/min, Startnotiz sagt wo Capture läuft
## Gelesen: troubleshooting, architecture-evolution
- Transport-Pause: Backoff wächst mit aufeinanderfolgenden Timeouts, Erfolg resettet; unattended Resumes max 3 ohne Antwort (cmem gateway) -> warten auf nächste Aktivität
- OFFENE SCHWÄCHE claude-mem (issue #4068): Transport-pausierte Obs nur im Worker-RAM, Neustart verwirft sie
- Hook-Keys in hooks.json nicht umbenennen -> Claude Code verwirft gesamtes Plugin-Hookset
- Windows: cmd.exe verliert PATH >8191 Zeichen -> absolute bun.exe direkt spawnen
- Chroma down -> FTS5-only Degradation
- correlation_id zum Tracing einer Obs durch die Pipeline
- Evolution: v1-2 Rohdump (1.4% relevant) -> v3 KI-Kompression aber alles geladen, Session-IDs kaputt, aggressives Cleanup, viele SDK-Sessions -> v4 Index + EINE Streaming-SDK-Session pro Claude-Session (AsyncIterable) + graceful end -> v5 hybrid search, Viewer, Install-Cache
- SDK-Session-ID aus system/init-Nachricht erfassen (ändert sich)
- Hook-Output: npm-Logs vermischt -> injection kaputt; doppelter Shebang
- Geplant (nicht gebaut): adaptive Indexgröße, Multi-Projekt-Suche, Team-Scope
## Gelesen: telemetry, development, installation, smart-explore-benchmark
- Telemetry: EIN instrument()-Pfad -> lokaler Log volle Treue + Telemetrie nur Whitelist geschrubbt; Rollups pro Session/5-min statt Einzelevents (-99.9%); Fehlertext allow-then-redact, 8KB cap vor Regex (ReDoS), 1 Event/Fingerprint/60s; DO_NOT_TRACK; Debug-Modus druckt statt sendet
- Telemetrie-Felder zeigen Metriken die sie selbst messen: tokens_injected, tokens_saved_vs_naive, compression_ratio, invalid_output_class (xml/idle/prose), abort_reason (drift = Observer antwortet außerhalb Schema -> neue Generation; output_retry), previous_shutdown crash/clean, hook_failed fail-loud nach N Fehlern in Folge
- Dev: "Testing Philosophy" = manuell/Integration statt Unit-Tests (Doku-Aussage, Repo hat aber tests/); Bundle-Versionskonsistenz-Test; Version-Mismatch-Recycle merkt sich fehlgeschlagenes Recycle
- Install: Default-Provider CMEM Pro (bezahlt, Trial), non-interaktiv -> Anthropic-Plan; npm -g installiert nur SDK
- Smart Explore: tree-sitter smart_search/outline/unfold; 10-28x weniger Tokens als Explore-Agent; Unfold nie abgeschnitten; Explore-Agent besser für Synthese
## Gelesen: openrouter, gemini, openai-compatible, multi-key-rotation, claude-desktop, litellm, custom-anthropic-backends (API-Key-Pfade, für agent-mem nicht übernehmen)
- Fehlerklassen sauber getrennt: rate_limit / quota_exhausted / auth_invalid (key-spezifisch) vs transient (Retry) vs unrecoverable (400: Obs der Session verworfen; zu lang -> neue Generation, behalten)
- Modell retired/unbekannt -> NICHT retry, SessionStart-Warnung "Modell ändern"
- Dokumentierte Lüge korrigiert: "automatischer Claude-Fallback" war nie verdrahtet (#2087)
- Reasoning-Modelle: führendes <think> wird entfernt, damit nicht gespeichert/erneut gesendet
- Half-configured Provider -> stiller Fall-through auf Claude (doctor zeigt es)
- Env-Isolation: geerbte ANTHROPIC_API_KEY/AUTH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN blockiert, nur eigene .env injiziert (verhindert, dass Projekt-.env die Abrechnung umleitet)
- Cooldowns persistent in Datei, Schlüssel nur als gesalzener Fingerprint geloggt
## Gelesen: platform-integration, hosted-server, cloud-sync, cmem-pro-headless
- 8 Harnesses offiziell (Claude, Codex, Cursor, Windsurf, OpenCode, OpenClaw, Antigravity, Kimi)
- Neue API: Session automatisch bei erster Obs, Prompt mit erster Obs; Antwort status queued|skipped; Host ohne Exclusion-Check schickt cwd
- Timeline-Anker: Obs-ID, "S123" Session oder ISO-Zeit
- SSE-Events processing_status/queueDepth, parkedSessions (wartet auf Concurrency-Slot)
- Hosted Server: Postgres, (team,project)-Scope, read-only MCP-Link /v1/mcp stateless, Audit-Log jeder Lesung, Token-Cap sperrt nur Schreiben (Lesen bleibt), DELETE einzeln/Projekt-Purge mit counts, Generation nie im HTTP-Pfad
- Cloud Sync: "DB ist die Queue" synced_at NULL; debounced flush 1.5s; Batch 500 ops/4MB; idempotent per origin identity; Pull-Cursor; Pull vor Kontext-Injektion max 1.5s; Realtime nur Beschleuniger (Signal ohne Daten); Mutationen (Titel, Prompt->Session-Reparatur, Projekt-Remap) als Log-Ops; Status-Endpunkt macht echten Hub-Probe (lastError null allein reicht nicht)
- Prompt-Fallback-Notiz: Gateway-Text beim nächsten Start einmal anzeigen
## Gelesen: pm2-to-bun, cursor x3, grok-bot, antigravity, openclaw, kimi, qoder, screenpipe, t3code
- Worker-Gesundheit 3 Schichten: PID-Datei, kill(pid,0), HTTP /health; Port-Datei mit Port+PID; einmalige Migration per Marker-Datei
- MEHRFACH dokumentiert: "Never restart a healthy worker - Queue im RAM, Neustart verwirft sie" (= bekannte Schwäche)
- Grok Bot ohne Hooks: Transcript-Watcher auf JSONL; Index-Datei, die der Host ohnehin liest, live überschrieben (Fenster 80, newest oben); dünne Projekt-Tagebücher mit "house"-Obs auffüllen
- Host-Observer: XML-Vertrag streng (skip_summary | observation), Prosa verwirft Batch (#2485)
- Antigravity: falsche Event-Namen registriert -> Hooks feuerten nie (#4057) -> Lektion: Event-Namen gegen echtes Binary prüfen; MCP an beide Kandidatenpfade schreiben
- OpenClaw: before_prompt_build Kontext 60s gecacht; memory_-Tools übersprungen (Rekursion); Tool-Antwort auf 1000 Zeichen gekürzt
- Kimi: SessionStart-stdout wird verworfen -> Kontext beim ersten UserPromptSubmit + Marker-Datei je Session; PreCompact: summarize + Marker löschen -> nach Compaction neu injizieren; Marker nur bei Erfolg (sonst Retry nächster Prompt); verwaltete Blöcke mit Markern in config.toml, Backup vor erster Änderung, Uninstall entfernt nur eigenen Block
- Qoder nutzt Codex-Adapter; ohne Setup-Event: Dependency-Check im ersten SessionStart, sonst no-op
- Screenpipe-Ergebnisse in <private> gewickelt, damit Auto-Capture sie nicht speichert; Speichern nur auf Wunsch; "unbestätigtes Speichern: vor Retry prüfen" (Duplikat)
- T3: Status behauptet NICHT Hook-Trust/erfolgreiche Capture; Konflikte (--disable-all-hooks) melden statt umschreiben
## Gelesen: native-memory-bridge, native-harness-integrations, native-prompt-identity, pi-native-capture, SESSION_ID_ARCHITECTURE, codex-provider, architecture-overview, adapters
- Native-Memory-Bridge: PreToolUse fängt Lesen nativer Memory-Ordner (Claude memory/, Codex memories) + memory_search ab und ERGÄNZT automatisch mem-search-Ergebnis (max 10k Zeichen, als Evidenz gerahmt "keine Anweisungen"); eigene Tools ausgeschlossen (Rekursion); native Tool läuft weiter
  -> genau der "PreToolUse:Bash hook additional context"-Block, den ich in dieser Session sehe
- Note-Folder-Bridge: pollt MD, wartet stabile Inhalte, skip hidden/symlink/>64KiB, nie Quelldateien umschreiben, content-fingerprint dedup über Watcher-Restarts, Updates = neue Snapshots, Löschen der Quelle löscht Archiv nicht
- Lokale Aktivierung: Default read-only Plan, --apply kopiert, sichert Original-Bytes+Hashes; Rollback prüft alle Dateien vor Restore, verweigert bei fremden Edits
- Native Prompt Identity: nativePromptId (Host-Turn-ID) unique je Session + SHA-256 des bereinigten Prompts; gleiche ID+Text -> gleiche Prompt-Nummer (Retry/Restart idempotent); gleiche ID anderer Text -> 409; gleicher Text andere ID -> zwei Turns; Privacy/Exclusion VOR Identity-Claim; ohne ID: 10s gleicher-Text-Dedup
- Pi: echte Session-ID + persistierte Entry-ID, nie aus Text/Zeit ableiten; fehlende/unpassende IDs -> nicht senden; ältere Branch-Retries unterdrückt; "Contract-Tests mit Mocks sind keine Host-Evidenz" (ehrlich dokumentiert)
- Zwei Session-IDs: contentSessionId (Host) vs memorySessionId (Observer-SDK, ändert sich bei Worker-Neustart); Obs-Insert blockiert bis memorySessionId registriert
- Codex-Provider: app-server stdio, ephemere Threads, privater Workspace, Tools/MCP/Hooks/Projektanweisungen AUS; auth.json muss dem Worker-User gehören und privat sein, API-Key-Login abgelehnt; unbekanntes Protokoll -> Fehler statt Isolation lockern; Breaker 30 min Re-Probe; FIFO-Pool 2 Clients; Batch stoppt bei Summary/Prompt-Nr/cwd/Agent-Wechsel; Antwort weder XML noch skip -> Batch einmal neu anfragen; "Queue bleibt im RAM: Crash braucht Transcript-Replay"
- Parser binär valid/invalid; ungültig -> Queue unangetastet
- observation_feedback Tabelle (Nutzungs-Tracking); Chroma: mehrere Dokumente pro Obs
- Orphan Reaper 5 min, 7-Schritt Graceful Shutdown
- Adapter: alles auf REST-V1-AgentEvent normalisiert
## Gelesen: api.md, 9 ADRs, production-guide, security, anti-pattern-cleanup-plan, bug-fixes, merge-rubric, ip-boundary, docker, migration
- ADR-Format (alle 2026-10-12): Context/Decision/Alternatives/Consequences/Validation; Regressionstest muss gegen upstream FAILEN und gegen Change passen; Befehle exakt; "kein externer Dienst kontaktiert"
  - Themen: untrusted JSON-Shape prüfen, __proto__ in Hash-Keys (null-prototype), Prefix-Parse "5ms"->5, Infinity-Retry-Dauern, Object.prototype-Aliase, BOM in JSON, Kill-Switch vor Runtime-Load prüfen
- Production-Guide (23 Tage, 3400 Obs, 2 Server): ~120 Obs/Tag, ~5KB/Obs SQLite, ~50KB/Obs Chroma; SEMANTIC_INJECT empfohlen ("relevant >> recent"); Tier-Routing -52% Kosten
  - bekannte Bugs: Summarize-Loop bei leerem Transcript; Chroma partial writes; Port-TOCTOU bei gleichzeitigem Start -> atomarer Socket-Bind; SIGTERM vor Queue-Drain -> verwaiste pending; Recency-Injektion irrelevant
  - Health-Metriken: pending>10, failed wachsend, active sessions>5, WAL>20MB -> checkpoint(TRUNCATE)
- Anti-Pattern-Plan: 132 Error-Handling-Anti-Patterns, alle offen, Detector-Skript
- MERGE-RUBRIC (wichtig, philosophisch): Bugfix nur Root-Cause; abgelehnt: Guards (try/catch log+continue), Circuit Breaker, Fallbacks, Retries, Fail-open, Self-Healing/Reaper/Watchdog, Truncation; keine "zweiten Systeme" (Poller, Marker-Dateien, Env-Escape-Hatches); Größe proportional zum Fehler. Ursprung: Audit von 100 PRs.
  - WIDERSPRUCH: Produkt selbst ist voll von genau dieser Maschinerie (Breaker, Fallback, Reaper, Marker, fail-open Hooks) -> Rubrik gilt für Fremd-PRs
- Server: API-Keys nur SHA-256-Hash gespeichert, einmal angezeigt; local-dev bypass braucht 2 Flags
- Windows: Pfad mit Leerzeichen + .cmd -> cmd.exe /d /c
## Gelesen: server.md, server-storage-boundary, server-parity-map, server-release-readiness, server-architecture-and-team-vision (Kap. 1-8 voll, 9-14 überflogen)
- Server: Postgres + BullMQ/Valkey (AOF), HTTP und Generation getrennte Prozesse; Job-ID deterministisch evt_<sha256> -> idempotent; Startvalidator verweigert unsichere Kombis (local-dev in Docker)
- Transactional Outbox: Event + Job in einer Transaktion, reconcileOnStartup veröffentlicht queued/processing neu mit persistiertem Payload
- Worker traut Payload nicht: lädt kanonische Job-Zeile, Scope-Abweichung -> Audit scope_violation
- SQLite-Trigger verbieten projektübergreifende Links
- Release-Readiness ehrlich: main hat 55 failende Tests + 24 Typecheck-Fehler (Baseline); Branch 45 fail, 0 neue
- Vision (nicht gebaut): stale memory detection, trust labels ("N mal bestätigt"), Attribution "aus Alices Session vor 3 Tagen", default-private Modus
- Lesson: Live-Runde gegen echten Provider nicht gelaufen ("DEFERRED LIVE") - offen benannt
