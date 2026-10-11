# claude-mem 13.24.1 — Feature-Inventar (Quellcode-Lesung 2026-10-08)

Quelle: `Projekt inspo/claude-mem`, `src/` 338 TS-Dateien, ~80k Zeilen inkl. Plugin.

## 1. Capture

Hooks in `plugin/hooks/hooks.json` (je ein ~1,5 KB Bash-Einzeiler, der das Plugin-Cache-Verzeichnis sucht und `node bun-runner.js worker-service.cjs hook claude-code <event>` startet):

| Hook | Matcher | Handler | Sendet an Worker |
|---|---|---|---|
| Setup | `*` | `scripts/version-check.js` | — |
| SessionStart | `startup\|clear\|compact` | worker `start`, dann `context` | GET `/api/context/inject?projects=…&platformSource=…` (`src/cli/handlers/context.ts:61`) |
| UserPromptSubmit | — | `session-init` | POST `/api/sessions/init {contentSessionId, project, prompt, platformSource}` (`session-init.ts:113-121`); optional POST `/api/context/semantic` (`:154`) |
| PostToolUse | `*`, async | `observation` | POST `/api/sessions/observations {contentSessionId, tool_name, tool_input, tool_response, cwd, agentId, agentType}` (`observation.ts:18-30`) |
| PreToolUse | `Read`, async | `file-context` | GET `/api/observations/by-file?path=…&projects=…&limit=40` (`file-context.ts:238`) |
| Stop | async | `summarize` | POST `/api/sessions/summarize {last_assistant_message, observedModel, observedBilling}` (`summarize.ts:150-159`); letzte Assistant-Antwort aus Transkript-JSONL (`:99`) |

Dispatcher `src/cli/hook-command.ts:103-175`: Plattform-Adapter (claude-code, codex, cursor, …), stderr-Buffering, Worker nicht erreichbar → exit 0, „fail loud“ nach `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD=3` Fehlern in Folge.

Rohdaten werden **nicht** dauerhaft gespeichert: In-RAM `SessionMessageBuffer` (`src/services/worker/SessionMessageBuffer.ts:21-40`), Dedupe auf `tool_use_id`; Kommentar: Transkript-JSONL ist die einzige dauerhafte Quelle, Worker-Absturz verliert den Buffer. Legacy-Tabelle `pending_messages` existiert (`SessionStore.ts:1364`). Prompts in `user_prompts` (+FTS, `SessionStore.ts:1261-1281`) nach `stripMemoryTags`; vollständig `<private>` → übersprungen (`SessionRoutes.ts:616-630`). `CLAUDE_MEM_SKIP_TOOLS` (`ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion`) wird verworfen (`SettingsDefaultsManager.ts:146`). Projekt-Ausschluss über `CLAUDE_MEM_EXCLUDED_PROJECTS`.

## 2. Observer / Worker

Architektur: eine langlebige Claude-Agent-SDK-`query()`-Konversation pro beobachteter Session, gespeist durch einen Async-Generator (`ClaudeProvider.ts:544-680`). Erste Nachricht `buildInitPrompt` (oder `buildContinuationPrompt` ab Prompt 2), dann eine Nachricht pro Tool-Use (`buildObservationPrompt`), bei Stop `buildSummaryPrompt`. Kein Batching; das Modell darf auf einen Prompt mehrere `<observation>`-Blöcke oder `<skip_summary reason="noise"/>` antworten.

Prompts (`src/sdk/prompts.ts`, Text in `plugin/modes/code.json`):
- Identität: „You are a Claude-Mem, a specialized observer tool for creating searchable memory FOR FUTURE SESSIONS… Record what was LEARNED/BUILT/FIXED… not what you (the observer) are doing.“ Plus „SILENT BY DESIGN / NO CONTACT“.
- Recording-Fokus mit Beispielen; Skip-Regeln (Status-Checks, Installs, leere Listings, Wiederholung).
- Observation-Prompt: `<observed_from_primary_session><what_happened>tool</what_happened><occurred_at/><working_directory/><parameters>…</parameters><outcome>…</outcome>` (`prompts.ts:178-189`). Felder auf 16k Zeichen gekürzt (head+tail) mit `<elided chars=… reason="oversize"/>` (`:120-153`); alternativ `compressField` per separatem `maxTurns:1`-SDK-Call (`ClaudeProvider.ts:507-540`).
- Summary-Prompt: `--- MODE SWITCH: PROGRESS SUMMARY ---` mit `<summary><request/><investigated/><learned/><completed/><next_steps/><notes/></summary>` (`prompts.ts:200-223`).

Schema (`prompts.ts:24-62`, Parser `src/sdk/parser.ts:15-24`): `type` ∈ {bugfix, feature, refactor, change, discovery, decision, security_alert, security_note, sensitive}; `title`, `subtitle` (≤ 24 Wörter), `facts[]`, `narrative`, `concepts[]` ∈ {how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off}, `files_read[]`, `files_modified[]`. Parsing per Regex über Text-XML (`parser.ts:87-158`; TODO #2233 → Tool-Use). Konzepte am ersten `:` abgeschnitten, weil Injection-SQL exakt matcht (`:118-126`). Ungültiger Typ wird gespeichert, nicht abgelehnt (`:111`).

Storage: `observations` (`SessionStore.ts:1477-1495`) + `discovery_tokens`, `content_hash` = sha256(memory_session_id, title, narrative)[:16] mit `ON CONFLICT DO NOTHING` (`observations/store.ts:5-14`, `SessionStore.ts:2668`). `relevance_count` ohne Schreiber. FTS5: `observations_fts`, `session_summaries_fts`, `user_prompts_fts` (`SessionSearch.ts:78-148`).

Kosten: `discovery_tokens` = Token-Delta des Observers (`ClaudeProvider.ts:367-398`), also Observer-Kosten, nicht die der Hauptsession. Default-Modell `claude-haiku-4-5-20251001` über Subscription-Auth (`SettingsDefaultsManager.ts:141,152`). Tier-Routing (`SessionRoutes.ts:740-780`), `$TIER:`-Aliase (`model-aliases.ts`). Provider: Claude SDK, Gemini, OpenRouter/OpenAI-kompatibel, cmem.ai-Gateway mit Trial-Hinweisen im Kontext-Hook (`context.ts:100-115`). `CLAUDE_MEM_MAX_CONCURRENT_AGENTS=2`.

Fehler/Backoff: HTTP-Provider ≤ 2 Retries mit `100*2^n+jitter`, `Retry-After` (`retry.ts`). Claude-SDK-Pfad **ohne Retry**: Generator-Fehler verwirft den In-RAM-Batch (`SessionRoutes.ts:268-271`). Quota: `rate_limit_event` (`RateLimitStore.ts:197-261`); Circuit-Breaker `quota-cooldown.json` 30 min (`quota-cooldown.ts:118`). Prosa-Ablehnungen klassifiziert, nie in History (`ResponseProcessor.ts:296-375`). Konversation ab `CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS=400000` recycelt (`recycle-conversation.ts`). 429-Meldung: `observer-health.ts:321-345`.

## 3. Kontext-Einblendung

SessionStart (`ContextBuilder.ts:79-114`, `AgentFormatter.ts`):

```
# [project] recent context, 2026-10-08 3:48pm CEST
Mode: Code Development (code)
Legend: 🎯session ●bugfix ◆feature ↻refactor ✓change ○discovery ⚖decision …
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill
Stats: 50 obs (1,234t read) | 88,000t work | 98% savings
### Oct 7, 2026
S123 <summary.request> (time)
4567 3:48p ● Fixed auth token expiration
**Investigated**: … **Learned**: … **Completed**: … **Next Steps**: …
Access 88k tokens of past work via get_observations([IDs]) or mem-search skill.
```

Limits: `CLAUDE_MEM_CONTEXT_OBSERVATIONS=50`, `SESSION_COUNT=10`, `FULL_COUNT=0`; Filter nach Mode-Typen/Konzepten via `json_each(concepts)` (`ObservationCompiler.ts:33-70`). Savings (`TokenCalculator.ts:14-37`): `readTokens = chars/4`, `savings = Σdiscovery_tokens − readTokens`. Human-Variante nach `systemMessage` (`context.ts:143`). Observer-Health-Warnung unten (`ContextBuilder.ts:200-210`). Worktree-Parent als Projekt (`project-name.ts:90-98`), `merged_into_project` (`WorktreeAdoption.ts:228-231`).

UserPromptSubmit: standardmäßig nur Prompt registrieren. Mit `CLAUDE_MEM_SEMANTIC_INJECT=true` und ≥ 20 Zeichen Top-5 „Relevant Past Work“ (`SearchRoutes.ts:395-426`).

PreToolUse Read: Dateien ≥ 1500 Bytes; wenn mtime < neueste Beobachtung, pro-Datei-Timeline nach Tag, pro Session dedupliziert, Score „in files_modified +2, ≤ 3 Dateien +2“ (`file-context.ts:54-87, 118-135`).

MCP-Tools (`src/servers/mcp-server.ts:440-880`): `important_workflow`, `search`, `timeline`, `get_observations`, `session_start_context`, `smart_search/outline/unfold` (tree-sitter), `build/list/prime/query/rebuild/reprime_corpus` (KnowledgeAgent), `observation_*`. `work_state_read/write` existieren in diesem Checkout nicht. `/api/memory/save` speichert manuelle `discovery` (`MemoryRoutes.ts:28-60`).

## 4. Retrieval

`SearchManager.search` (`SearchManager.ts:471-615`): Pfad 1 Filter → SQLite; Pfad 2 Chroma (n=100) → Datumsfenster 90 Tage → Hydration aus SQLite in Chroma-Reihenfolge (`:383-440`); Pfad 3 FTS5 `MATCH … ORDER BY rank` (`SessionSearch.ts:271-279`). Keine Fusion/RRF. Chroma-Dokumente: Narrative, Text, jede Fact einzeln (`ChromaSync.ts:153-216`), Embedding durch chroma-mcp (onnx) via `uvx` (`ChromaMcpManager.ts:47`). Kein Reinforcement zur Laufzeit; Dedup nur `content_hash` innerhalb einer Session. Modes = JSON-Profile (`plugin/modes/*.json`), tauschen Typen, Konzepte, Emoji, Prompttexte (`ModeManager.ts`).

## 5. Lebenszyklus

Keine Konsolidierung, kein Vergessen, kein Verfall, kein Merging. Löschen manuell (`DataRoutes.ts:93-95`). Privacy: `<private>`, `<claude-mem-context>`, `<system-reminder>` gestrippt (`tag-stripping.ts:4-17`); `sensitive`/`security_alert` → Telegram. Cloud-Sync: Outbox/Entity-Heads/Dead-Letter (`SessionStore.ts:522-760`), `CloudSync.ts` → `sync.cmem.ai` (kostenpflichtig). Parallele Postgres-„Server-Runtime“ (`src/server/**`). Viewer (`src/ui/viewer`): SSE-Feed, ObservationCard, PromptCard, SummaryCard, Projektfilter, Settings, Logs, `/tv`.

## 6. Skills

`plugin/skills/`: nur mem-search, learn-codebase, knowledge-agent, timeline-report, weekly-digests, how-it-works greifen auf Memory zu. make-plan/do/smart-explore u. a. nicht.

## 7. Kluge Details

- Index statt Inhalt; Details auf Abruf; Legende hält Zeilen bei ~10 Tokens.
- Observer wird gesagt, er beobachte eine *andere* Session und sei stumm → keine Meta-Beobachtungen.
- Datei-Timeline beim Read, über mtime gegatet (`file-context.ts:255-265`).
- Recycle wird mit demselben SessionStart-Render geseedet.
- Sichtbare „Savings“ und Health-Warnung, die den Assistenten zuerst sprechen lässt.
- Worktree-bewusste Projektkette; Konzept-/Typ-Filter zur Abfragezeit.

## 8. Schwächen

- In-RAM-Buffer; SDK-Generator-Fehler verwirft Beobachtungen stumm (`SessionRoutes.ts:268`).
- Regex-XML-Parsing; ungültige Typen werden gespeichert.
- Savings-Metrik vergleicht Observer-Kosten mit Index-Größe, selbstbezüglich.
- Keine Fusion, kein Dedup über Sessions, kein Verfall; 90-Tage-Fenster versteckt ältere semantische Treffer.
- Schwere Abhängigkeiten: Bun + bun:sqlite, Claude-CLI-Spawn, `uvx chroma-mcp` + onnx, optional Redis/Postgres, Telegram, PostHog, cmem.ai-Trial-Hinweise im Kontext-Hook.
- 1,5 KB Shell-Resolver in jedem Hook dupliziert; Claude-Code-spezifische Transkriptpfade; `.claude.json`-Billing-Sniffing.
- 3,3k-Zeilen `SessionStore.ts` mit ~30 Ad-hoc-Migrationen; zwei parallele Storage-Stacks.
