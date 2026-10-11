# Beobachter-Aufrufe: verifizierte CLI-Flags (2026-10-08, lokal)

Geprüft mit `--help` der installierten Binaries. Copilot CLI ist auf dieser Maschine nicht installiert (nur `~/.copilot` der IDE), Phase 0 muss es installieren.

## Claude Code 2.1.294

Beobachter-Aufruf (Entwurf):

```
claude -p --bare --restricted --tools "" --strict-mcp-config --no-session-persistence \
  --output-format json --json-schema "$SCHEMA" --model haiku --effort low \
  --max-budget-usd 0.05 < bundle.txt
```

| Flag | Wirkung laut `--help` | Zweck |
|---|---|---|
| `-p` / `--print` | nicht-interaktiv | Hintergrund |
| `--bare` | „skip hooks (those defined in settings and by installed plugins)“ | Beobachter wird nicht selbst von agent-mem erfasst |
| `--restricted` | „removes the built-in tools that run commands or code … ignores user, project and local settings files … confines the file tools to the working directories … refuses bypassPermissions“ | keine Ausführung, keine fremden Settings |
| `--tools ""` | nur genannte Tools | gar keine Tools |
| `--strict-mcp-config` | nur MCP aus `--mcp-config` | keine MCP-Server |
| `--no-session-persistence` | Session nicht auf Platte | keine Transkripte, kein Import-Loop |
| `--output-format json` | ein Ergebnisobjekt | parsebar |
| `--json-schema <schema>` | „JSON Schema for structured output validation“ | Beobachter-Schema erzwingen |
| `--model`, `--effort` | Modell und Aufwand | Tier-Routing (haiku/low für einfache Turns) |
| `--max-budget-usd` | Kostendeckel pro Aufruf | Budget |
| `--setting-sources` | Settings-Quellen wählen | optional leer |

## Codex CLI 0.160.1

```
codex exec --ephemeral --ignore-user-config -s read-only -C "$EMPTY_DIR" --skip-git-repo-check \
  --output-schema schema.json -o out.json -m <model> < bundle.txt
```

| Flag | Wirkung | Zweck |
|---|---|---|
| `--ephemeral` | keine Session-Dateien | kein Import-Loop |
| `--ignore-user-config` | `config.toml` nicht laden, Auth bleibt | fremde Hooks/MCP aus |
| `-s read-only` | Sandbox nur lesen | keine Ausführung mit Wirkung |
| `-C <dir>` + `--skip-git-repo-check` | leeres Arbeitsverzeichnis | kein Projektzugriff |
| `--output-schema <file>` | JSON-Schema für die finale Antwort | Beobachter-Schema |
| `-o <file>` | letzte Nachricht in Datei | parsebar |
| `--json` | Events als JSONL | optional für Token-Zählung |
| `-m` | Modell | Tier-Routing |

Offen: ob `-s read-only` Shell-Aufrufe vollständig unterbindet oder nur deren Schreibwirkung; Phase 0 prüft mit einem Bundle, das zur Ausführung verleitet.

## Copilot CLI

Nicht installiert. Zu prüfen in Phase 0: `copilot -p`, Ausgabeformat, Tool-Abschaltung, oder Copilot SDK (Python) mit `useLoggedInUser` und leerer Tool-Liste.
