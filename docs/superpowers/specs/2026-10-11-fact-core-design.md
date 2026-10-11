# Fakten-Kern: Neuausrichtung nach mem0/Graphiti-Modell

Stand: 2026-10-11. Ersetzt die Reihenfolge in `REBUILD.md`, nicht deren Inhalt.

## Ziel
Agent Mem soll täglich im Harness laufen und auf denselben Benchmarks messbar mit mem0 mithalten. Erfolg heißt: Zahlen, nicht Doku.

## Annahmen
- Der Hintergrund-Observer unter dem eigenen Login ist gesetzt (PLAN.md). Damit ist LLM-Extraktion erlaubt.
- Neo4j und die mem0/Graphiti-SDKs werden nicht eingebaut. Übernommen wird das Datenmodell, die Speicherung bleibt SQLite.
- Pushen und Deployen bleiben aus, nur lokale Commits.

## Was übernommen wird
1. **Eine Schreib-Pipeline.** Der Observer liefert Kandidatenfakten. Ein deterministischer Schritt holt ähnliche vorhandene Fakten (FTS5 + Vektor) und der Observer entscheidet je Kandidat ADD, UPDATE, DELETE oder NOOP. Es gibt keinen zweiten Schreibpfad (Regex, Summarizer und `mem_remember` fallen weg oder rufen dieselbe Pipeline).
2. **Zeitachse pro Fakt.** Spalten `valid_at` und `invalid_at`. UPDATE und DELETE setzen `invalid_at`, löschen nicht. Suche liefert standardmäßig nur gültige Fakten, `as_of` erlaubt Zeitreisen.
3. **Entity Resolution.** Entitäten haben kanonischen Namen plus Aliase. Beim ADD sucht ein deterministischer Schritt Kandidaten, der Observer bestätigt den Merge.
4. **Scoping.** Jeder Fakt trägt `user`, `project`, `harness`, `session`. Suche filtert darauf.
5. **Messbarkeit.** Vergleichslauf gegen mem0 OSS (lokal über Ollama) auf Fixture und LongMemEval-S, gleiche Fragen, gleiche Metrik (Recall@k, Antwort-Treffer).

## Was bleibt (Harness-Schicht, gibt es bei mem0 nicht)
Hook-Capture für vier Harnesses, Spool, Privacy, MCP-Tools, Injection mit Deadline, Backups.

## Vertikaler Schnitt (erste Lieferung)
Nur Claude Code. Kette: Hook → Spool → Observer → Fakten-Pipeline → Injection beim nächsten Prompt. Fertig, wenn:
- eine echte Session Fakten erzeugt und die nächste sie korrekt injiziert,
- ein widersprechender Fakt den alten per `invalid_at` ablöst,
- der Vergleichslauf gegen mem0 vorliegt und im Spec-Anhang steht.

Danach erst Codex, Copilot, OpenCode, Viewer-Ansichten, Graph-Pfad (PPR).

## Streichliste
Alles ohne Messwert fliegt: Reranker als Standard, Viewer-Ansichten außer Fakten/Timeline, Budget-Tabelle und Tier-Routing bis zur ersten Kostenmessung.

## Risiken
- Observer-Qualität schwankt je Modell. Gegenmittel: Schema-Validierung, Raw-Fallback, Messung auf Gold-Set.
- Entity-Merge kann falsch fusionieren. Gegenmittel: Merge nur mit Observer-Bestätigung, Alias-Tabelle bleibt rückgängig machbar.

## Offen (wird in der Umsetzung entschieden)
Embedder-Wahl per Messung (e5-small, embeddinggemma, Qwen3-Embedding), Schwellwert je Modell neu kalibrieren.
