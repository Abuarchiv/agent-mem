# SDK-Beobachter über das Abo des Nutzers: Stand 2026-10-08

Frage: Kann ein Hintergrund-Beobachter (wie bei claude-mem) pro Harness das vorhandene Login des Nutzers nutzen, ohne API-Key? Was gilt für Enterprise? Wie verhält sich das zum Turn-Ende-Ansatz (Stop-Hook + `mem_observe`)?

## Claude Code / Claude Agent SDK

Quellen: [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [Support: Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

- OAuth-Login ist „intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications“.
- „Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.“
- Verboten: „third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users“; Tokens sammeln oder speichern.
- Erlaubt: „an end user from signing in to the unmodified Claude Code binary with their own Claude subscription“. Das Binary darf nicht verändert werden.
- Agent SDK overview: „Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods.“
- Support-Artikel, Update 2026-10-07: „Claude Max and Team plans now include monthly API credits, which cover the Claude Agent SDK, `claude -p`, the Claude API, and Claude Managed Agents. You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits.“ Update 2026-06-15: geplante Trennung pausiert, „nothing has changed“.
- Verlauf 2026 (Sekundärquellen): Januar serverseitige Sperre von Abo-Tokens außerhalb des Claude-Code-Harness („This credential is only authorized for use with Claude Code“), Februar Doku-Verschärfung, 4. April Abo-Limits gelten nicht mehr für Drittharnesses (OpenClaw zuerst), Mai Ankündigung eines SDK-Credits, 15. Juni Pause, 7. Oktober API-Credits für Max und Team.

Einordnung für ein lokales Tool: Das Tool startet das unveränderte `claude`-Binary (`claude -p` oder Agent SDK, das dasselbe Binary spawnt) unter dem eigenen Login des Nutzers auf dessen Rechner. Das ist „ordinary, individual usage“ und wird vom Support-Artikel ausdrücklich als „third-party apps … with your subscription limits“ genannt. Nicht erlaubt wäre: Tokens auslesen, eigener Login-Flow, Nutzung für fremde Nutzer. Enterprise: OAuth gilt, aber API-Credits nur für Max und Team; Enterprise-Admins können Nutzung einschränken; sicherster Weg dort ist ein vom Unternehmen gestellter API-Key. Politik hat sich 2026 viermal geändert.

## Codex CLI / Codex SDK / Sign in with ChatGPT

Quellen: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [Authentication](https://learn.chatgpt.com/docs/auth), [App Server](https://learn.chatgpt.com/docs/app-server), DevDay-Berichte zu „Sign in with ChatGPT“ (2026-09-29, u. a. [The New Stack](https://thenewstack.io/sign-in-with-chatgpt/)).

- SDK: „The Python SDK controls the local Codex app-server over JSON-RPC“; Beispiele setzen ein „signed-in account“ voraus; genannte Einsatzgebiete „Integrate Codex within your own application“, „Build Codex into your own internal tools and workflows“. SDK-Builds enthalten eine gepinnte CLI-Runtime. Kein JSON-Schema-Output im allgemeinen SDK; `codex exec --output-schema` existiert laut früherer Prüfung (`subscription-auth-review.md`).
- Auth: „API keys are still the recommended default for automation.“ ChatGPT-Login folgt „workspace permissions, role-based access control“. Enterprise-Admins erzwingen `forced_login_method`, `forced_chatgpt_workspace_id`, Credential-Store; Access-Tokens für Skripte nur mit Admin-Freigabe. „Don't expose Codex execution in untrusted or public environments.“
- App-Server: „If you are developing a new Codex integration intended for enterprise use, please contact OpenAI to get it added to a known clients list.“ `clientInfo.name` identifiziert den Client für Compliance-Logs.
- Sign in with ChatGPT (DevDay 2026-09-29): formales Programm, damit Drittanbieter-Tools die Plan-Kontingente von Plus/Pro nutzen; Open-Source-Tools (OpenCode, OpenClaw, Pi, T3) ausdrücklich dabei; Nutzer setzen pro App Wochenlimits; App braucht eine bei OpenAI registrierte `client_id`; Login und Plan-Nutzung sind getrennte Freigaben.

Einordnung: `codex exec` unter dem vorhandenen CLI-Login auf dem Rechner des Nutzers ist dokumentierter Einsatz („own internal tools“). Für ein veröffentlichtes Tool ist der saubere Weg die Registrierung bei „Sign in with ChatGPT“. Enterprise: Workspace-Admin kann Login-Methode erzwingen und Hintergrund-Nutzung praktisch unterbinden.

## Copilot CLI / Copilot SDK

Quellen: [copilot-sdk README](https://github.com/github/copilot-sdk), [docs/auth/authenticate.md](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md), [GitHub Docs: Authenticating with Copilot SDK](https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk), [Changelog 2026-07-27 App-Policy](https://github.blog/changelog/2026-07-27-manage-github-copilot-app-access-with-a-dedicated-policy/).

- SDK existiert für Node, Python, Go, .NET, Rust, Java; README: „generally available and follows semantic versioning“, MIT; einzelne Doku-Seiten sprechen noch von Preview. „All SDKs communicate with the Copilot CLI server via JSON-RPC“, CLI wird für Node/Python/.NET mitgeliefert.
- Auth-Methoden: „GitHub signed-in user – Uses stored OAuth credentials from `copilot` CLI login“ (Default, `useLoggedInUser`), OAuth GitHub App (`gho_`/`ghu_`), Env-Variablen (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`), Server-to-server (Org-Policy nötig), BYOK (kein Abo nötig).
- Billing: „Billing for the GitHub Copilot SDK is based on the same model as the Copilot CLI, with each prompt being counted towards your usage allowance.“ Seit 2026-06-01 heißen Premium Requests „AI Credits“; bei Enterprise ein gemeinsamer Pool.
- Enterprise: Copilot-CLI-Policy und seit Juli 2026 getrennte App-Policy („Enabled everywhere“ Default); EMU-Nutzer gehen über denselben OAuth-Weg; Org-Policies übersteuern.

Einordnung: Ein lokaler Hintergrund-Beobachter über das Copilot SDK mit dem vorhandenen `copilot login` ist möglich und dokumentiert. Die Annahme „bei Copilot gibt es kein SDK“ ist überholt. Im Unternehmen hängt es an der CLI-Policy und am AI-Credit-Budget.

## Vergleich der beiden Architekturen

| | A: SDK-Beobachter im Hintergrund (claude-mem-Modell) | B: Turn-Ende in der Session (Stop-Hook + `mem_observe`) |
|---|---|---|
| Codepfade | drei: Claude-Binary/Agent SDK, Codex SDK/app-server, Copilot SDK; je Prozess-Lifecycle, Slots, Retries, Quota, Modellwahl, Ausgabe-Parsing | einer: Hook gibt eine JSON-Zeile zurück, Agent ruft ein MCP-Tool |
| Was der Beobachter sieht | Tool-Ein- und Ausgaben, geratene Absicht | der Handelnde selbst, Absicht bekannt; deterministische Anhänge vom System |
| Kosten | ganze Tool-Ausgaben an ein zweites Modell, auf demselben Abo-Kontingent (Claude: Abo-Limits oder Max/Team-Credits; Codex: Plan-Kontingent; Copilot: AI Credits) | 150–300 Tokens pro Turn mit Tools im eigenen Kontext |
| Nutzererlebnis | unsichtbar, keine Latenz | ein sichtbarer Tool-Call, ~1 s am Turn-Ende |
| Zuverlässigkeit | hängt an Quota, Login-Zustand, Prozess; claude-mem verliert bei Fehlern Daten | hängt an Agent-Compliance; Stop-Block erzwingt es; Fallback roh |
| Policy-Risiko | Claude: viermal geändert in 2026, Enterprise ohne Credits; Codex: Registrierung für veröffentlichte Tools; Copilot: Org-Policy | keines, es ist gewöhnliche Nutzung des Harness |
| Enterprise | pro Harness Admin-Freigabe oder API-Key | funktioniert überall, wo der Nutzer den Harness benutzen darf |
| Parallel zur Session | zweiter Prozess konkurriert um Rate Limits | kein zweiter Prozess |
| Installation | SDK-Pakete pro Harness, Node-Runtime bei Copilot | nichts zusätzlich |

## Entscheidung

Standard ist B. Es ist ein Mechanismus statt drei, ohne Policy-Risiko, ohne Enterprise-Sonderfälle, und der Beobachter kennt die Absicht. Die befürchtete Komplexität von B ist eine JSON-Zeile im Stop-Hook plus ein Marker gegen Schleifen; die Komplexität von A sind drei SDK-Lebenszyklen.

A kommt später als Opt-in „Observer-Modus“, zuerst nur für Claude Code über `claude -p --output-format json`, weil der Support-Artikel vom 2026-10-07 diese Nutzung unter Abo-Limits ausdrücklich nennt. Zweck: Nutzer, die null Latenz wollen und Kontingent übrig haben. Codex und Copilot folgen nur, wenn Nutzer es verlangen; Codex dann über Sign-in-with-ChatGPT-Registrierung, Copilot über das SDK mit `useLoggedInUser`.
