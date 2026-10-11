# Mechanismen aus den neun Papern (Lesung 2026-10-08)

Legende: **D** = deterministisch (SQLite, Embeddings, Graph). **TE** = kurzer LLM-Schritt des Session-Agenten am Turn-Ende. **SS** = beim Session-Start. Seitenzahlen 1-basiert im PDF, Abschnitte aus dem Paper.

## P1 RAG (Lewis et al.)
- Retriever `p(z|x)` DPR, Top-K via MIPS; Generator auf `[x ; z]` [§2.1–2.3, S. 3–4]. Index hot-swappable: 2016- vs 2018-Wikipedia 70 %/68 % korrekt bei passendem Jahr, 12 %/4 % sonst [§4.5, S. 7–8]. 100-Wort-Chunks [§3, S. 5].
- LLM: keines zur Indexzeit. Alles D.
- Befund: BM25 schlägt Dense auf FEVER, Dense sonst → beide behalten. Zeitliche Korrektheit liegt im Index: versionieren, Gültigkeit taggen.

## P2 Generative Agents (Park et al.)
- Score `= α_rec·recency + α_imp·importance + α_rel·relevance`, α=1, min-max normalisiert; recency `0.995^(Stunden seit letztem Zugriff)`; relevance = Cosinus [§4.1, S. 9].
- Wichtigkeits-Prompt: „On the scale of 1 to 10, where 1 is purely mundane … and 10 is extremely poignant … rate the likely poignancy of the following piece of memory“ [§4.1, S. 9].
- Reflexion bei Σ Wichtigkeit der jüngsten Events > 150: Schritt A über die 100 jüngsten Einträge „3 most salient high-level questions“; Schritt B pro Frage abrufen, „5 high-level insights … (insight (because of 1, 5, 3))“; Einsichten mit Zeigern auf IDs speichern, selbst abrufbar [§4.2, S. 10].
- LLM: Wichtigkeit TE (ein Integer), Reflexion TE/SS bei Schwelle; Zähler, Fenster, Zitatparsing, Formel D. `last_accessed` vom Retriever pflegen.
- Befund: vollständige Architektur > ohne Reflexion [§6.3, S. 15]; Fehlermodi: unvollständiger Abruf, ausgeschmückte Erinnerungen [§6.5].

## P3 MemoryBank (Zhong et al.)
- Drei Speicher: rohe Turns, Tagesereignisse → Globalzusammenfassung, Tagespersönlichkeit → Portrait [§2.1, S. 3]. Dense Retrieval über Turns und Summaries als separate Items [§2.2, S. 4]. Vergessen `R = e^(−t/S)`, S=1 initial, bei Abruf `S += 1; t = 0` [§2.3, S. 4–5].
- LLM: Summaries TE/SS; Formel D.
- Befund: Retrieval-Genauigkeit und Antwortkorrektheit bewegten sich nicht gemeinsam [Tab. 2, S. 8] → `R` nur als Gewicht, nie als Wahrheitsfilter.

## P4 Reflexion (Shinn et al.)
- Schleife Actor → Evaluator → Self-Reflection → `mem.append`, `|mem| ≤ Ω` (1–3) [Alg. 1, S. 4–5]. Deterministische Trigger: gleiche Aktion + gleiche Beobachtung > 3, oder > 30 Aktionen pro Episode [§4.1, S. 5]. Programmierung: Tests per CoT, nur AST-valide, n ≤ 6, Ω=1 [§4.3, S. 7].
- LLM: Reflexionstext TE; Trigger, AST-Filter, Ausführung D.
- Befund: ALFWorld 130/134 mit Heuristik allein; HumanEval 80→91; MBPP 80→77 wegen 16,3 % falsch-positiver Testsuiten [Tab. 2, S. 8] → Lektion mit Belegart speichern (Testlauf vs. Selbsturteil).

## P5 MemGPT (Packer et al.)
- Hauptkontext = Systemanweisungen + editierbarer Working Context + FIFO mit rekursiver Summary; extern Recall + Archival [§2.1, S. 2–3]. Bei ~70 % „memory pressure“-Systemnachricht; bei 100 % Eviction in rekursive Summary [§2.2, S. 3]. Paginierte Funktionsergebnisse, `request_heartbeat` [§2.3–2.4].
- LLM: 70 %-Warnung D; Entscheidung TE; rekursive Summary TE. Paging, Zählung, Storage D.
- Befund: durchsuchbare Vollhistorie schlägt verlustbehaftete Summaries; Modell hört manchmal zu früh auf zu blättern [§3.1–3.2, S. 5–8] → harte Seitengröße, Summary nur Fallback.

## P6 HippoRAG (Gutiérrez et al.)
- Offline: NER, OpenIE mit Entitäten geseedet → Knoten, Tripel-Kanten; Synonymkanten bei cos > 0,8; Matrix |N|×|P| [§2.2, S. 4; §3.3, S. 6]. Online: Query-NER, Query-Knoten per Cosinus, Personalisierungsvektor mit Spezifität `s_i = 1/|P_i|`, PPR Dämpfung 0,5, `p = n′·P` [§2.3, S. 5].
- LLM: NER/OpenIE pro Memory TE; für Code reichen Regex-Entitäten (Pfade, Symbole, Pakete, Fehlercodes) D. PPR D.
- Befund: 2Wiki R@5 89,1 vs 68,2 ColBERT; Nachbarn ohne PPR schlechter als Baseline (74,7); Spezifität ~2–3 Punkte, Synonymkanten ~1–3 [Tab. 5, S. 8]. Fehler: 50 % NER-Misses, PPR ignoriert Query-Kontext [App. F] → PPR immer mit Dense/BM25 fusionieren.

## P7 LongMemEval (Wu et al.)
- Design [Tab. 2, S. 7]: Wert = Runde (User + Assistant), Key = Wert + extrahierte Fakten (Expansion zur Indexzeit), Query = Frage + Zeitbereich als Filter, Lesen = chronologisch, JSON, Chain-of-Note [§4.2–5.5, S. 7–10].
- LLM: Fakten-Extraktion pro Runde TE; Zeitbereich SS nur mit starkem Modell (8B erfand Bereiche, Tab. 4); Sortierung, JSON, Datumsfilter D; CoN ist Prompt-Text.
- Befund: Runde vs Session besser für GPT-4o [Fig. 5]; `K = V + fact` +9,4 % Recall, +5,4 % Genauigkeit [Tab. 3, S. 9]; Zeitfilter +11,3 % Recall [§5.4]; Orakel-Retrieval verliert bis 10 Punkte ohne CoN+JSON [Fig. 6]; Budget leserabhängig; ChatGPT überschrieb frühere Fakten bei Updates [§4.1, S. 6].

## P8 A-MEM (Xu et al.)
- Note `{Inhalt, Zeit, Keywords, Tags, Kontextsatz, Embedding von concat, Links}` [§3.1, S. 4]; Ps1-Prompt für Keywords/Kontext/Tags [App. B.1, S. 19]; Links: Cosinus Top-k → „Should this memory be evolved?“ [§3.2]; Evolution: strengthen/merge/prune, Nachbar wird ersetzt [§3.3, B.3, S. 20]. Retrieval reiner Cosinus [§3.4].
- LLM: Ps1, Ps2/Ps3 je ein JSON-Call TE; Nachbarn D. Original unveränderlich lassen, Evolution als Revision mit `derived_from`.
- Befund: ohne Linking und Evolution am stärksten bei Multi-Hop schlechter [§4.4]; Gewinne enden ab k≈30–40 [§4.5].

## P9 Mem0 (Chhikara et al.)
- Extraktion `P = (S, letzte 10 Nachrichten, m_{t−1}, m_t)` mit laufender Summary S → Kandidaten Ω [§2.1, S. 3–4]. Update: pro ω Top-10 Ähnliche, LLM wählt ADD / UPDATE / DELETE / NOOP [§2.1, S. 4]. Mem0g: Entitäten + Relationen als Tripel; Knoten-Merge bei Cosinus > t; Konfliktdetektor markiert **ungültig statt zu löschen** [§2.2, S. 5–6].
- LLM: Extraktion + Entscheidung TE; Nachbarn, Anwenden, Invalid-Flag D.
- Befund: LoCoMo J: Vollkontext 72,9, Mem0 66,9, Mem0g 68,4; Mem0g bei Multi-Hop unter Mem0 (47,2 vs 51,2) [Tab. 2, S. 11]; p95-Latenz −91 %; adversariale Fragen ausgeschlossen, Abstention unbewiesen [§3.1].

## Mechanismen, die weder claude-mem noch agentmemory haben

1. Zugriffs-verfallende Aktualität `0.995^h` seit letztem Zugriff, vom Retriever gepflegt, fusioniert mit Wichtigkeit und Relevanz (P2). (agent-mem v1 hat ACT-R-Aktivierung, dasselbe Prinzip.)
2. Wichtigkeits-Integer zur Schreibzeit plus Σ-Schwellen-Reflexion mit zitierten Einsichten (P2).
3. MemoryBank-Stärkezähler `S += 1`, `R = e^(−t/S)` als Gewicht (P3).
4. Deterministische Reflexion-Trigger für Code: gleicher Tool-Call + gleiches Ergebnis > 3, > 30 Tool-Calls → Lektion erzwingen, mit Belegart, Ω-begrenzt einblenden (P4).
5. MemGPT-70 %-Druck-Hook mit editierbarem Working Context, der nach Compaction wieder eingeblendet wird; paginierte Suchergebnisse (P5).
6. PPR mit Knoten-Spezifität über Regex-Entitäten plus Agenten-Konzepte, Synonymkanten cos > 0,8, immer fusioniert (P6).
7. Key Expansion zur Indexzeit: Runde + Fakten als ein Dokument; Runde als Einheit (P7).
8. Zeitfilter + chronologisches JSON + Chain-of-Note-Hinweis in der Einblendung (P7).
9. A-MEM-Evolution als Revision mit `derived_from`, Re-Embedding von concat(Inhalt, Keywords, Tags, Kontext) (P8).
10. Mem0-Operationen mit Invalidierung statt Löschung, As-of abfragbar (P9).
11. Eval mit Gold-Beleg-IDs: Recall@k, All-Recall@k, Orakel-vs-real-QA trennt Retrieval- und Leseverlust (P7, P6).
