# Agent Mem — Design

Stand: 2026-10-08. Dieses Dokument beantwortet, *wie* das System lernt. `PLAN.md` beantwortet, in welcher Reihenfolge es gebaut wird. Belege in `docs/evidence/`.

## 0. Das eigentliche Problem

Ein Coding-Agent kann seine Gewichte nicht ändern. Er kann aber vor jeder Entscheidung anderen Kontext sehen. Lernen heißt deshalb: **die richtige Erfahrung zum richtigen Entscheidungspunkt bringen, und die Erfahrung selbst aus Ergebnissen formen.** Das ist Reinforcement Learning mit zwei Besonderheiten:

1. Die Politik ist eingefroren. Was sich ändert, ist die Beobachtung, die sie bekommt.
2. Die Belohnung ist verzögert und spärlich: ein Test wird grün, ein Befehl läuft durch, der Nutzer korrigiert, ein Revert passiert.

Daraus folgen die drei Fragen, die jedes Memory für Agenten beantworten muss und die claude-mem und agentmemory nicht beantworten:

- **Credit Assignment:** Welche Aktionen haben zum Ergebnis geführt? Beide Systeme speichern Beobachtungen ohne Ergebnis-Label.
- **Entscheidungspunkt:** Wann und wo muss die Erfahrung sichtbar sein? Beide blenden beim Start ein, claude-mem zusätzlich beim Read einer Datei. Vor einem Befehl, vor einem Edit, nach einem Fehler: nichts.
- **Selbstkorrektur des Gelernten:** Was passiert, wenn eine Lektion eingeblendet wurde und der Agent trotzdem scheitert? Beide: nichts. Die Lektion bleibt und wird wieder eingeblendet.

Das Design unten ist um diese drei Fragen gebaut. Alles andere (Retrieval, Graph, Viewer) ist Infrastruktur dafür.

## 1. Drei Gedächtnisse, ein Store

| Gedächtnis | Inhalt | Entsteht durch | Wird genutzt bei |
|---|---|---|---|
| Episodisch | Turns, Events, Beobachtungen, Session-Notes | Hooks (deterministisch) + Memory-Agent | Suche, Belege, Timeline, Replay |
| Semantisch | Core-Block (user, project, rules), Fakten, Entscheidungen, Reflexionen | Memory-Agent aus Episoden | Start-Briefing, Prompt-Treffer |
| Prozedural | Fälle (Situation → Aktion → Ergebnis), Lektionen, Regeln, Rezepte | Episoden mit Ergebnis-Label | PreToolUse, Fehler-Hook, Prompt-Hook |

claude-mem hat nur das erste. agentmemory hat das erste und Ansätze des zweiten (Profile, Lessons mit Key). Das dritte, prozedurale, ist der Teil, der Verhalten ändert. Es ist das Zentrum des Neuaufbaus.

## 2. Episoden und Credit Assignment

### 2.1 Signale (deterministisch, aus Hooks)

| Signal | Erkennung | Vorzeichen | Stärke |
|---|---|---|---|
| Test rot → grün | gleicher `command_key` mit `kind=test`, Exit ≠ 0 dann Exit 0 | + | 1,0 |
| Build/Lint rot → grün | analog mit `kind=build|lint` | + | 0,8 |
| Befehl rot → grün | gleicher `command_key`, beliebige Art | + | 0,5 |
| Gleicher Fehler erneut | gleiche `error_sig` ≥ 2× in einer Session | − | 0,5 pro Wiederholung |
| Revert | `git checkout --`, `git restore`, `git reset --hard`, `git stash` auf zuvor editierte Dateien | − | 1,0 |
| Nutzer-Korrektur | Korrektur-Muster im Prompt („nein“, „nicht X, sondern Y“, „statt“, „again?“, „wieder falsch“) | − | 1,0 |
| Nutzer-Bestätigung | Bestätigungs-Muster („passt“, „genau“, „danke, funktioniert“) | + | 0,3 |
| Commit | `git commit` Exit 0 | + | 0,3 |
| Wiederholte Frage | Prompt-Embedding ≥ 0,9 zu einem Prompt derselben Session | − | 0,3 |
| Überlange Suche | > 30 Tool-Calls in einem Turn ohne Edit | − | 0,5 |

Die Muster liefern nur Signale. Was sie bedeuten, entscheidet der Memory-Agent.

### 2.2 Episoden

Eine Episode öffnet mit einem negativen Signal (Fehler, Korrektur, Revert) und schließt mit dem passenden positiven Signal (gleicher `command_key` grün, Nutzer-Bestätigung) oder mit dem Session-Ende (offen). Der bisherige Code kennt das für Fehler → Fix als `recipes`. Neu wird es verallgemeinert:

```
episode(id, project, opened_turn, closed_turn | null, kind: error|correction|revert|search,
        key: error_sig | correction_hash | file_set, outcome: resolved|abandoned|open,
        actions: [turn_ids], reward: Σ Signale im Fenster)
```

Credit Assignment ist damit lokal: alle Aktionen zwischen Öffnung und Schluss gehören zur Episode. Das ist grob, aber korrekt genug für Coding, wo Fehler und Fix meist wenige Turns auseinanderliegen. Der Memory-Agent verfeinert: er benennt im `observe`-Output, welche Aktion der Episode die entscheidende war (`decisive_turn`), und begründet es. Die Begründung ist die Lektion.

### 2.3 Fälle (Memento)

Jede geschlossene Episode wird ein **Fall**:

```
case(id, project, situation: {error_sig?, command_key?, files[], packages[], concepts[], text},
     actions: [{turn_id, kind, summary}], outcome: resolved|abandoned,
     reward, decisive_turn, lesson_id?, evidence_type, created_at,
     stats: {retrieved, followed, succeeded_after, failed_after})
```

Memento (2025) zeigt, dass ein Fallspeicher mit Ergebnis-Labels, abgerufen zur Entscheidungszeit, die Leistung eines eingefrorenen LLM-Agenten messbar steigert, ohne Fine-Tuning. Entscheidend ist, dass **auch gescheiterte Fälle gespeichert und abgerufen werden**. „Wir haben X versucht, es hat nicht geholfen“ verhindert Wiederholung genauso wie „Y hat geholfen“.

Abruf eines Falls:

1. Exakter Schlüssel: gleiche `error_sig` oder gleicher `command_key` im aktuellen Projekt → sofort, im Hook, < 50 ms.
2. Ähnliche Situation: Embedding des Situationstexts ≥ 0,80, projektübergreifend, nur Fälle mit `evidence_type ∈ {test_run, user_said}`.
3. Ranking: `reward × success_rate × activation`, wobei `success_rate = (succeeded_after + 1) / (followed + 2)`.
4. Maximal 2 Fälle pro Entscheidungspunkt, einer davon darf negativ sein.

Das ist das, was „nicht denselben Fehler zweimal“ operationalisiert.

## 3. Entscheidungspunkte

| Hook | Situation | Was eingeblendet wird | Budget |
|---|---|---|---|
| PreToolUse Bash | `command_key`, Programm | Regel → Deny mit Grund. Fall mit gleichem Key → „Zuletzt: … Ergebnis: …“. Dead End auf Zieldatei → Warnung. | 80 Tokens |
| PreToolUse Edit/Write | Datei | Dead End (Revert) → Warnung. Datei-Timeline, wenn Anker ≠ aktueller Blob. Fall, dessen `files` die Datei enthält. | 150 Tokens |
| PreToolUse Read | Datei | Datei-Timeline wie claude-mem, aber mit „geändert seit“ aus Blob-Ankern statt mtime | 150 Tokens |
| PostToolUseFailure | `error_sig` | Fall mit gleicher Signatur: Aktionen und Ergebnis. Lektion. | 120 Tokens |
| UserPromptSubmit | Prompt-Embedding, Signale | ≤ 3 Beobachtungen chronologisch; passende Lektion; bei Korrektur-Signal „Korrektur erkannt, Regel wird vorgeschlagen“ | 200 Tokens |
| SessionStart | Projekt | Index, Core-Block, offene Episoden, Top-3 Lektionen, letzte Note | 1200 Tokens |

Die Einblendung ist als Daten gerahmt und trägt ihre Herkunft: „verifiziert durch Testlauf“, „vom Nutzer gesagt“, „vom Agenten angenommen“. LongMemEval zeigt, dass das Lesen genauso viel ausmacht wie der Abruf; deshalb Chain-of-Note-Hinweis bei mehr als einem Treffer und chronologische Sortierung.

Copilot CLI ohne Prompt-Zeit-Kontext: die PreToolUse- und Fehler-Punkte tragen dort den Hauptteil, und das ist gut so, weil das die Punkte sind, an denen Verhalten entsteht.

## 4. Selbstkorrektur des Gelernten

Das ist der Mechanismus, den weder die Paper noch die Produkte haben, und der aus „Ablage“ „Lernen“ macht.

Jede prozedurale Einheit (Fall, Lektion, Regel, Rezept) hat Zähler: `shown`, `followed`, `succeeded_after`, `failed_after`, `overridden`.

- **followed**: nach Einblendung eines Falls führt der Agent eine Aktion aus, die dem Fall entspricht (gleicher `command_key` oder Edit einer der Fall-Dateien).
- **succeeded_after / failed_after**: die Episode, in der die Einblendung geschah, schließt mit + oder −.
- **overridden**: Deny einer Regel, gefolgt von demselben Befehl mit Override-Phrase oder Nutzer-Prompt, der ihn verlangt.

Konsequenzen, deterministisch:

| Zustand | Folge |
|---|---|
| `failed_after ≥ 2` und `succeeded_after = 0` | Job `revise`: Memory-Agent bekommt Fall, Lektion und die zwei gescheiterten Episoden und schreibt eine neue Revision oder markiert die Lektion `contradicted` |
| `shown ≥ 3`, `followed = 0` | Lektion verblasst schneller (Aktivierung × 0,5) |
| `overridden ≥ 2` | Regel wird deaktiviert, Vorschlag an Nutzer |
| `succeeded_after ≥ 3` in ≥ 2 Projekten | Lektion wird zur globalen Lektion vorgeschlagen |

Reflexion (das Paper) warnt genau davor: Lektionen aus falsch-positiven Tests verschlechtern das Ergebnis (MBPP 80 → 77). Deshalb trägt jede Lektion ihren `evidence_type`, und `self_judged`-Lektionen werden nie global und nie als Deny-Grundlage.

## 5. Der Memory-Agent

### 5.1 Eingabe pro Turn

```
{
  session: {id, harness, project, started_at, rolling_summary},
  open_episodes: [{id, kind, key, opened_turn, actions_so_far}],
  recent_observations: [letzte 10 Titel mit IDs],
  turn: {
    id, prompt (gekürzt 1500), final_answer (gekürzt 1500),
    tools: [{name, input (gekürzt 800), output (gekürzt 1200), exit_code, error_sig, files}],
    signals: [...], files_read, files_modified, commands, git: {head, dirty_files}
  },
  similar_existing: [Top-5 Beobachtungen nach Embedding, mit IDs und Titeln]
}
```

Zustandslos pro Turn, Kontext etwa 2k Tokens plus Turn. Vorteil gegenüber claude-mems langlebiger Konversation: kein Recycling, kein Verlust bei Absturz, derselbe Code für drei Harnesses, Spool-Replay trivial.

### 5.2 Ausgabe (JSON-Schema, validiert)

```
{
  observations: [{type, title, subtitle, facts[], narrative, concepts[], importance, evidence: [turn_ids],
                  relation: {to: id, op: add|update|supersede|noop}?}],
  episodes: [{id | new, kind, key, status: open|resolved|abandoned, decisive_turn?, why?}],
  lessons: [{text, situation_keys[], evidence_type, from_episode}],
  core_diff: [{section, key, value|null, why}],
  rolling_summary: "ein Absatz",
  skip_reason?: "noise|install|status_check"
}
```

Identität im Prompt: Beobachter einer fremden Session, dokumentiert für zukünftige Sessions, antwortet niemandem, erfindet nichts, das nicht in `turn` steht, zitiert Turn-IDs. Skip-Regeln wie claude-mem.

### 5.3 Validierung durch das System

- `evidence` ⊆ Turn-IDs dieser Session, sonst abgelehnt.
- `relation.op = supersede` nur, wenn `to` im selben Projekt liegt und nicht `origin = user`.
- `core_diff` auf `user` nur, wenn der Turn ein Nutzer-Signal enthielt.
- `lessons` mit `evidence_type = test_run` nur, wenn die Episode tatsächlich mit grünem Test schloss.
- Längen-Caps, `clean_text`, Konzepte normalisiert (lowercase, max 5).
- Embedding-Dedup: cos ≥ 0,92 zu bestehender Beobachtung → `update` statt `add`, Agent wird in der nächsten Eingabe darauf hingewiesen.

### 5.4 Hintergrund-Jobs

| Job | Auslöser | Eingabe | Ausgabe |
|---|---|---|---|
| `reflect` | Σ importance seit letzter Reflexion > 150 im Projekt | 100 jüngste Beobachtungen | 3 Fragen, dann 5 Einsichten mit `because of [ids]`, Typ `reflection`, importance vom Agenten |
| `evolve` | neue Beobachtung mit ≥ 5 Nachbarn (cos ≥ 0,80) | Beobachtung + Nachbarn | neue Revisionen der Nachbarn (Kontext, Tags), `derived_from`, Original bleibt |
| `revise` | siehe §4 | Fall, Lektion, gescheiterte Episoden | neue Lektions-Revision oder `contradicted` |
| `consolidate` | täglich im Leerlauf oder ab 30 `proposed` | Proposals, Core-Block, Statistik | bestätigen/verblassen, Core-Block-Diff, Duplikate mergen |
| `summarize` | Session-Ende | Beobachtungen, Episoden, Commits, Compaction-Summary | Session-Note |
| `rule` | Korrektur-Signal ≥ `min_corrections` | Korrekturen mit Prompts | Regel mit Muster, Grund, Beispiel; Status `proposed` |

Σ-Schwelle 150 und das 100-Fenster stammen aus Generative Agents. Reflexionen sind selbst abrufbar und können Eingabe weiterer Reflexionen sein. Für Coding erwarte ich Reflexionen wie „Tests in diesem Repo sind flaky bei paralleler Ausführung (wegen 412, 418, 430)“, also genau das, was ein Mensch nach einer Woche weiß.

## 6. Semantisches Gedächtnis: Core-Block

MemGPT-Working-Context, aber als Schlüssel-Wert mit Caps, nicht Freitext:

| Abschnitt | Cap | Schreibt | Beispiele |
|---|---|---|---|
| `user` | 500 Tokens | nur aus Nutzer-Signalen | Sprache, Paketmanager, Stil, „keine Co-Author-Zeilen“ |
| `project` | 1500 Tokens | Memory-Agent | Ziel, Stand, offene Probleme, Befehle die funktionieren, Konventionen, Fallen |
| `rules` | 300 Tokens | Regel-Job, Nutzer | aktive Regeln mit Grund |

Cap erzwingt Verdichtung: `consolidate` muss streichen, bevor es ergänzt. Jede Änderung ist eine Version mit `evidence`. Nach Compaction wird der Block wieder eingeblendet. Der MemGPT-Druck-Hinweis bei 70 % Transkriptgröße fordert den Session-Agenten auf, selbst `mem_core` zu nutzen; das ist der einzige Moment, in dem der Session-Agent schreiben soll.

## 7. Ranking und Vergessen

Score einer Einheit bei Abruf:

```
score = rrf_norm
      × (0.5 + 0.5·σ(B))            B = ln Σ_j t_j^-0.5     ACT-R-Aktivierung über accesses (übernommen)
      × (0.7 + 0.3·importance/10)                           Generative Agents
      × (0.5 + usefulness)           usefulness = (used+1)/(shown+2)   Memento
      × trust                        user 1.0, test_run 1.0, observer 0.9, self_judged 0.7, external 0.3
      × project_boost                1.2 im aktuellen Projekt
      × R                            R = e^(−t/S), S += 1 bei Abruf     MemoryBank, nur als Gewicht
```

Vergessen heißt: Score fällt unter die Index-Schwelle. Nichts wird gelöscht. `raw` ohne Veredelung nach 14 Tagen nur noch per Suche; `proposed` ohne Nutzung nach 30 Tagen unter der Schwelle; `confirmed` verblasst nur über Aktivierung. Supersede setzt `invalid_at`, As-of-Abfragen bleiben möglich. LongMemEval dokumentiert, dass ChatGPT Fakten bei Updates überschreibt; genau das darf hier nicht passieren.

## 8. Retrieval

- Index-Dokument pro Turn: Prompt + letzte Antwort + Titel + Fakten + Konzepte der Beobachtungen (LongMemEval: +9,4 % Recall). Beobachtungen, Fälle, Lektionen zusätzlich einzeln.
- Kandidaten: FTS5 trigram mit Präfix; Vektor; PPR über Entitätsgraph mit Spezifität 1/|P_i|, Dämpfung 0,5, Synonymkanten cos > 0,8. Nie PPR allein (HippoRAG: Nachbarn ohne PPR schlechter als Baseline).
- Fusion: RRF k = 60, normalisiert über aktive Streams, +5 % pro zusätzlichem zustimmendem Stream (agentmemory). Session-Diversität 3.
- Zeit: „gestern“, „letzte Woche“, `since/until`, `as_of`.
- Abstention: Vektortreffer nur mit lexikalischer oder Graph-Stütze; Mindestscore kalibriert pro Modell auf dem Fixture.
- Darstellung: chronologisch, JSON-nah, Chain-of-Note-Hinweis, 10 pro Seite.

## 9. Was über die Paper hinausgeht

1. **Ergebnis-gelabelte Fälle mit negativen Beispielen** (§2.3), abrufbar per deterministischem Schlüssel im Hook. Memento liefert die Idee, keines der Produkte hat sie.
2. **Selbstkorrektur des Gelernten** (§4): Lektionen und Regeln haben Erfolgsstatistik und werden revidiert oder deaktiviert.
3. **Herkunftsabhängige Wirkung**: `evidence_type` bestimmt Trust, Deny-Fähigkeit und Globalisierung.
4. **Anker-basierte Staleness** statt mtime: Git-Blob-Hash pro Beobachtung und Fall; „seit damals geändert“ ist exakt.
5. **Cross-Harness-Transfer**: ein in Codex gelernter Fall wirkt in Claude Code am selben Entscheidungspunkt.
6. **Zustandsloser Beobachter mit Spool**: kein Verlust, kein Recycling, drei Harnesses mit einem Code.
7. **Nordstern-Metrik „Wiederholungsrate“**: Anteil der Fehlersignaturen, die nach einem Fall mit `outcome = resolved` erneut auftreten. Das ist die Zahl, die „lernt wie ein Mensch“ misst.

## 10. Offene Punkte, die ich nicht entscheiden kann

- Tagesbudget des Beobachters als Anteil des Abos: ohne Messung nur Schätzung. Vorschlag 2 %, Messung in Phase 10.
- Ob Reflexionen in Coding-Projekten mehr Wert als Kosten haben: Generative Agents belegt es für soziale Simulation, nicht für Code. Deshalb Job mit Schwelle und Abschaltmöglichkeit.
- Ob Fälle projektübergreifend abgerufen werden sollen: Fehlersignaturen sind oft projektspezifisch. Default: exakter Schlüssel projektübergreifend, Embedding-Ähnlichkeit nur im Projekt.
