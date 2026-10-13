/* agent-mem view: renders the embedded snapshot. No network access; all text is escaped before it reaches the DOM. */
(() => {
  "use strict";

  const ICONS = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    timeline: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    memory: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    learned: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8-4.3-4.1 5.9-.9z"/>',
    health: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    session: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    cross: '<path d="M7 7l10 10M17 7L7 17"/>',
    dots: '<path d="M6 12h.01M12 12h.01M18 12h.01"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  };
  const icon = (name, size = 20, width = 1.8) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

  const NAV = [
    { id: "overview", label: "Overview", icon: "overview", group: "Memory", search: "Search requests, memories and files…" },
    { id: "timeline", label: "Sessions", icon: "timeline", group: "Memory", search: "Search requests, results, files and commands…" },
    { id: "memory", label: "Memories", icon: "memory", group: "Memory", search: "Search memories…" },
    { id: "learned", label: "Learned", icon: "learned", group: "Memory", search: "Search lessons, rules, fixes and preferences…" },
    { id: "health", label: "Health", title: "Health & privacy", icon: "health", group: "System", search: "Search background jobs…" },
  ];
  // Order an agent acts on them: what you want, what was learned, what failed, what was decided, plain facts.
  const MEMORY_KINDS = ["preference", "correction", "lesson", "dead_end", "decision", "fact", "summary", "native_note"];
  const PROFILE_LABEL = { "cmd:test": "Test command", "cmd:lint": "Lint command", "cmd:build": "Build command", "cmd:install": "Install command" };

  const root = document.getElementById("root");
  let data = null;
  const state = { view: "overview", project: "all", query: "", outcome: "all", session: undefined, turn: undefined, memory: undefined, kind: "all", invalid: false };

  /* ---------------------------------------------------------------- helpers */

  const h = (value) => String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);
  const num = (value) => Number(value ?? 0).toLocaleString("en-US");
  const plural = (count, word, many = `${word}s`) => `${num(count)} ${count === 1 ? word : many}`;
  const readable = (code) => String(code ?? "").replace(/_/g, " ");
  // Memory kinds as the reader names them; native notes are the agents' own memory files, read in as they are.
  const KIND_LABEL = { dead_end: "dead end", native_note: "agent note" };
  const kindLabel = (kind) => KIND_LABEL[kind] ?? readable(kind);
  const ORIGIN_LABEL = { "codex-memory": "Codex memory file", "claude-auto-memory": "Claude Code memory file" };
  const firstLine = (text, limit = 160) => {
    const line = String(text ?? "").split("\n").find((part) => part.trim() !== "") ?? "";
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  };
  // A background-task notice is the harness talking, not the user: show its one-line summary.
  const request = (prompt) => {
    const notice = /^\s*<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>/.exec(prompt ?? "");
    return notice ? notice[1].trim() : String(prompt ?? "").trim();
  };
  // Previews read as sentences: markdown marks, table pipes and heading hashes are noise at a glance.
  const plain = (text) => String(text ?? "").replace(/\*\*|__|^#+\s*|^\s*[-*]\s+/gm, "").replace(/\s*\|[\s|:-]*/g, " · ").replace(/\s+/g, " ").replace(/^ · | · $/g, "").trim();
  // Backtick spans in stored text (rules, memory titles) read as code; everything else stays escaped.
  const inline = (text) => h(text).replace(/`([^`]+)`/g, "<code>$1</code>");
  const tag = (text, className = "") => `<span class="tag ${className}">${h(text)}</span>`;
  const stat = (value, label) => `<div class="stat"><b>${h(value)}</b><span>${h(label)}</span></div>`;
  // A command the reader can copy with one click; the visible text is the command itself.
  const copyable = (command) => `<button type="button" class="copy" data-action="copy" data-value="${h(command)}" title="Copy to clipboard"><code>${h(command)}</code>${icon("copy", 15)}</button>`;
  const empty = (title, body) => `<div class="empty"><b>${h(title)}</b><span>${body}</span></div>`;
  const matches = (values) => {
    const needle = state.query.trim().toLocaleLowerCase();
    return needle === "" || values.some((value) => String(value ?? "").toLocaleLowerCase().includes(needle));
  };

  const date = (iso) => { const value = iso ? new Date(iso) : null; return value && !Number.isNaN(value.getTime()) ? value : null; };
  const dayKey = (iso) => { const d = date(iso); return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "unknown"; };
  const today = () => dayKey(new Date().toISOString());
  const dayLabel = (key) => {
    if (key === "unknown") return "Undated";
    if (key === today()) return "Today";
    const y = new Date(); y.setDate(y.getDate() - 1);
    if (key === dayKey(y.toISOString())) return "Yesterday";
    const [year, month, day] = key.split("-").map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year === new Date().getFullYear() ? {} : { year: "numeric" }) });
  };
  const clock = (iso) => { const d = date(iso); return d ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—"; };
  const when = (iso) => { if (!date(iso)) return "—"; return dayKey(iso) === today() ? clock(iso) : `${dayLabel(dayKey(iso))} · ${clock(iso)}`; };
  const full = (iso) => { const d = date(iso); return d ? d.toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; };
  const ago = (iso) => {
    const d = date(iso); if (!d) return "never";
    const hours = (Date.now() - d.getTime()) / 36e5;
    if (hours < 1) return "less than an hour ago";
    if (hours < 48) return `${Math.round(hours)} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  };

  const projectIndex = (id) => data.projects.findIndex((project) => project.id === id);
  const projectName = (id) => {
    if (!id) return "global";
    const project = data.projects.find((item) => item.id === id);
    return project ? project.name : "unknown project";
  };
  const projectTag = (id) => (id ? tag(projectName(id), `p${Math.max(projectIndex(id), 0) % 6}`) : tag("global"));
  const inProject = (id) => state.project === "all" || id === state.project;
  const inProjectOrGlobal = (id) => state.project === "all" || id === state.project || !id;
  const harnessLabel = (harness) => ({ claude: "Claude Code", codex: "Codex", copilot: "Copilot CLI", opencode: "OpenCode" })[harness] ?? harness ?? "unknown";
  const hashFor = (view, params = {}) => { const query = new URLSearchParams(params).toString(); return `#/${view}${query ? `?${query}` : ""}`; };
  const COMPONENT_LABEL = { indexer: "Search index", semantic: "Meaning search", observer: "Fact extraction", consolidation: "Cleanup" };
  const componentLabel = (name) => {
    if (name.startsWith("hook:")) return `${harnessLabel(name.slice(5))} hooks`;
    if (name.startsWith("setup:")) return `${harnessLabel(name.slice(6))} setup`;
    return COMPONENT_LABEL[name] ?? readable(name);
  };
  // "error" means a command failed and nothing later fixed it; the turn itself usually still finished.
  const outcomeLabel = (outcome) => ({ ok: "done", error: "with errors", open: "running", unknown: "no result" })[outcome] ?? outcome;
  const outcomeTag = (outcome) => tag(outcomeLabel(outcome), outcome === "ok" ? "good" : outcome === "error" ? "bad" : outcome === "open" ? "warn" : "");
  const outcomeBadge = (outcome) => `<span class="badge ${h(outcome)}" title="${h(outcomeLabel(outcome))}">${icon(outcome === "ok" ? "check" : outcome === "error" ? "alert" : "dots", 15, 2.2)}</span>`;
  const limitReached = (list, key) => list.length >= (data.limits[key] ?? Infinity);

  // `agent-mem serve` builds the page fresh on every request; the page reloads itself every `refresh` seconds.
  const live = () => Boolean(data.served);
  const turns = () => data.turns.filter((turn) => inProject(turn.project_id));
  const sessions = () => data.sessions.filter((session) => inProject(session.project_id));
  const memories = () => data.memories.filter((memory) => inProjectOrGlobal(memory.project_id));
  // The observer's title says what was done; without one the request stands in for it.
  const headline = (turn) => turn.title || firstLine(request(turn.prompt));
  // The observer's session title; until it has run, the first request says what the session was about.
  const sessionTitle = (session) => {
    if (!session) return "";
    if (session.title) return session.title;
    const first = data.turns.filter((turn) => turn.session_id === session.id).reduce((a, b) => (a && a.started_at <= b.started_at ? a : b), null);
    return first ? headline(first) : "";
  };
  const sessionSummary = (session) => {
    const summary = session.summary || {};
    const part = (label, items) => (items && items.length ? `<span class="section-label">${label}</span><ul class="summary-list">${items.map((item) => `<li>${h(item)}</li>`).join("")}</ul>` : "");
    const body = part("Done", summary.completed) + part("Learned", summary.learned) + part("Next steps", summary.next_steps);
    return body ? `<div class="session-summary">${body}</div>` : "";
  };
  const turnMatches = (turn) => matches([turn.title, turn.prompt, turn.answer, ...turn.files, ...turn.commands, ...turn.errors, `T${turn.id}`]);
  const filteredTurns = () => turns().filter((turn) => (state.outcome === "all" || turn.outcome === state.outcome) && turnMatches(turn));

  function outcomePills() {
    const options = [["all", "All"], ["ok", "Done"], ["error", "With errors"], ["open", "Running"]];
    return `<div class="pill-group" role="group" aria-label="Filter by outcome">${options.map(([value, label]) => `<button type="button" class="pill" data-action="outcome" data-value="${value}" aria-pressed="${state.outcome === value}">${label}</button>`).join("")}</div>`;
  }

  /* ---------------------------------------------------------------- chrome */

  function attention() {
    const items = [];
    const health = data.health;
    if (health.paused_until) items.push({ tone: "warn", text: `<b>Capture is paused</b> ${health.paused_until === "forever" ? "until you resume it" : `until ${h(full(health.paused_until))}`}. Run <code>agent-mem resume</code>.`, view: "health" });
    for (const [component, info] of Object.entries(health.components ?? {})) {
      const failing = info.last_error_at && (!info.last_ok_at || info.last_error_at > info.last_ok_at);
      if (failing) items.push({ tone: "bad", text: `<b>${h(componentLabel(component))} is failing:</b> ${h(firstLine(info.last_error, 140))}`, view: "health" });
    }
    if (health.spool > 0) items.push({ tone: "warn", text: `<b>${plural(health.spool, "event")} waiting in the spool.</b> Run <code>agent-mem index</code>.`, view: "health" });
    // An old unreadable message stays visible on the health page; the banner is for fresh ones.
    const latest = data.quarantine_latest;
    const fresh = latest?.ts && Date.now() - (date(latest.ts)?.getTime() ?? 0) < 864e5;
    if (health.quarantine > 0 && fresh) items.push({ tone: "warn", text: `<b>${plural(health.quarantine, "hook message")} could not be read</b> and ${health.quarantine === 1 ? "was" : "were"} set aside. Everything else was saved.`, view: "health" });
    for (const agent of data.agents ?? []) {
      if (agent.connected && agent.paused_until) items.push({ tone: "warn", text: `<b>Fact extraction for ${h(agent.label)} is paused</b> until ${h(clock(agent.paused_until))} (quota or login of <code>${h(agent.stage)}</code>). Requests stay queued.`, view: "health" });
    }
    const proposed = data.rules.filter((rule) => !rule.enabled && inProjectOrGlobal(rule.project_id)).length;
    if (proposed > 0) items.push({ tone: "info", text: `<b>${plural(proposed, "rule")} proposed from your corrections.</b> Review them before enabling.`, view: "learned" });
    for (const warning of health.config_warnings ?? []) items.push({ tone: "warn", text: `<b>Config:</b> ${h(warning)}`, view: "health" });
    return items;
  }

  function renderChrome() {
    const failing = attention().filter((item) => item.tone === "bad").length;
    const counts = { timeline: state.project === "all" ? data.counts.turns : turns().length, memory: state.project === "all" ? data.counts.memories : memories().filter((m) => !m.invalid_at).length, learned: data.rules.length + data.recipes.length + memories().filter((m) => m.kind === "lesson" && !m.invalid_at).length };
    const count = (id) => {
      if (id === "health") return failing > 0 ? `<span class="nav-count is-alert">${failing}</span>` : "";
      const value = counts[id];
      return value ? `<span class="nav-count">${num(value)}</span>` : "";
    };
    const groups = ["Memory", "System"].map((group) => `<div class="nav-label">${group}</div>${NAV.filter((item) => item.group === group).map((item) => `<a class="nav-item" href="${hashFor(item.id)}" data-nav="${item.id}">${icon(item.icon, 19)}<span>${h(item.label)}</span>${count(item.id)}</a>`).join("")}`).join("");
    const paused = Boolean(data.health.paused_until);
    const chips = data.projects.length > 5
      ? `<label class="sr-only" for="project-select">Project</label><select id="project-select" class="scope-select"><option value="all">All projects</option>${data.projects.map((project) => `<option value="${h(project.id)}"${project.id === state.project ? " selected" : ""}>${h(project.name)}</option>`).join("")}</select>`
      : `<span class="scopes-label">In:</span><button type="button" class="chip" data-action="project" data-value="all" aria-pressed="${state.project === "all"}">All projects</button>${data.projects.map((project, index) => `<button type="button" class="chip" data-action="project" data-value="${h(project.id)}" title="${h(project.root)}" aria-pressed="${state.project === project.id}"><span class="chip-dot p${index % 6}"></span>${h(project.name)}</button>`).join("")}`;
    root.innerHTML = `<div class="app">
<aside class="sidebar" aria-label="Viewer navigation">
<a class="brand" href="${hashFor("overview")}">agent-mem<span class="brand-badge">v${h(String(data.agent_mem).split(".")[0])}</span></a>
<nav aria-label="Sections">${groups}</nav>
<div class="sidebar-foot"><strong><i class="dot ${paused ? "warn" : "good"}"></i>${paused ? "Capture paused" : "Capture active"}</strong>${live() ? `<span><b class="live">Live</b> · updated ${h(clock(data.generated_at))}, every ${num(data.refresh)} s.<br>Always on at this address.</span>` : `<span>Snapshot from ${h(full(data.generated_at))}<br>Run <code>agent-mem view</code> for the live viewer</span>`}</div>
</aside>
<div class="main">
<header class="topbar">
<label class="search"><span class="search-icon">${icon("search", 18)}</span><span class="sr-only">Search</span><input id="search" type="search" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
<div class="scopes" role="group" aria-label="Project">${data.project_id ? "" : chips}</div>
</header>
<main id="view" tabindex="-1"></main>
</div>
</div>
<nav class="bottom-nav" aria-label="Sections">${NAV.map((item) => `<a href="${hashFor(item.id)}" data-nav="${item.id}">${icon(item.icon, 20)}<span>${h(item.short ?? item.label)}</span></a>`).join("")}</nav>`;
  }

  function syncChrome() {
    document.querySelectorAll("[data-nav]").forEach((link) => {
      if (link.dataset.nav === state.view) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
    const item = NAV.find((entry) => entry.id === state.view);
    const input = document.getElementById("search");
    if (input && item) {
      input.placeholder = item.search;
      input.setAttribute("aria-label", item.search.replace(/…$/, ""));
      if (input.value !== state.query) input.value = state.query;
    }
    document.title = `${item ? item.title ?? item.label : "Viewer"} · agent-mem`;
  }

  /* ---------------------------------------------------------------- overview */

  function sessionRange(session, list) {
    const start = session?.started_at ?? list[list.length - 1]?.started_at;
    const end = session?.ended_at ?? session?.last_event_at ?? list[0]?.started_at;
    if (!end || end === start) return `started ${when(start)}`;
    return `${when(start)} – ${dayKey(start) === dayKey(end) ? clock(end) : when(end)}`;
  }

  function turnRows(list) {
    const groups = new Map();
    for (const turn of list) {
      const group = groups.get(turn.session_id) ?? [];
      group.push(turn);
      groups.set(turn.session_id, group);
    }
    return [...groups.entries()].map(([sessionId, items]) => {
      const session = data.sessions.find((item) => item.id === sessionId);
      const title = sessionTitle(session);
      return `<div class="session-head">${icon("session", 17)}<b class="session-title">${h(title || harnessLabel(session?.harness))}</b><span class="session-meta">${projectTag(items[0].project_id)}<span class="muted">${h(harnessLabel(session?.harness))} · ${h(sessionRange(session, items))}</span></span></div>` +
        items.map((turn) => `<a class="turn-row" href="${hashFor("timeline", { turn: String(turn.id) })}"><span class="time">${h(clock(turn.started_at))}</span>${outcomeBadge(turn.outcome)}<span class="preview">${turn.type ? tag(turn.type) : ""}${h(headline(turn) || "(no request text)")}</span><span class="tags">${turn.files.length ? tag(plural(turn.files.length, "file")) : ""}${(data.actions[turn.id] ?? []).length ? tag(plural(data.actions[turn.id].length, "action")) : ""}</span></a>`).join("");
    }).join("");
  }

  function overviewView() {
    const allTurns = turns();
    const allSessions = sessions();
    const scoped = state.project !== "all";
    const turnCount = scoped ? allTurns.length : data.counts.turns;
    const sessionCount = scoped ? allSessions.length : data.counts.sessions;
    const approx = scoped && (limitReached(data.turns, "turns") || limitReached(data.sessions, "sessions")) ? "latest " : "";
    const names = scoped ? [projectName(state.project)] : data.projects.map((project) => project.name);
    const valid = memories().filter((memory) => !memory.invalid_at);
    const recipes = data.recipes.filter((recipe) => inProject(recipe.project_id));
    const rules = data.rules.filter((rule) => inProjectOrGlobal(rule.project_id));
    const enabled = rules.filter((rule) => rule.enabled).length;
    const lede = [
      names.length === 0 ? "Nothing captured yet." : `Across ${names.length > 3 ? plural(names.length, "project") : names.join(" and ")}.`,
      `agent-mem keeps what your coding agents did and learned, and reminds them in the next session.`,
    ].join(" ");
    const alerts = attention().map((item) => `<div class="alert ${item.tone}">${icon("alert", 20)}<p>${item.text}</p><a class="text-link" href="${hashFor(item.view)}">Show</a></div>`).join("");

    const days = [];
    for (let offset = 13; offset >= 0; offset -= 1) { const d = new Date(); d.setDate(d.getDate() - offset); days.push(dayKey(d.toISOString())); }
    const perDay = new Map(days.map((key) => [key, { turns: 0, errors: 0 }]));
    for (const turn of allTurns) { const entry = perDay.get(dayKey(turn.started_at)); if (entry) { entry.turns += 1; if (turn.outcome === "error") entry.errors += 1; } }
    const peak = Math.max(1, ...[...perDay.values()].map((entry) => entry.turns));
    const bars = days.map((key) => { const entry = perDay.get(key); return `<span title="${h(dayLabel(key))}: ${plural(entry.turns, "request")}, ${num(entry.errors)} with errors"><i class="${key === today() ? "today" : ""}" style="height:${entry.turns ? Math.max(6, entry.turns / peak * 100) : 3}%"></i>${entry.errors ? `<i class="errors" style="height:${entry.errors / peak * 100}%"></i>` : ""}</span>`; }).join("");
    const activity = `<section class="block block-yellow"><i class="block-deco deco-tile"></i><h2>Activity</h2><div class="stats">${stat(num(turnCount), `${approx}requests`)}${stat(num(sessionCount), "sessions")}${stat(num(allTurns.filter((t) => t.outcome === "error").length), "with errors")}</div><div class="block-foot"><div class="bars" role="img" aria-label="Requests per day over the last 14 days">${bars}</div><div class="bar-axis"><span>${h(dayLabel(days[0]))}</span><span>Today</span></div></div></section>`;

    const byKind = MEMORY_KINDS.map((kind) => [kind, valid.filter((memory) => memory.kind === kind).length]).filter(([, count]) => count > 0);
    const memoryBlock = `<section class="block block-pink"><i class="block-deco deco-circle"></i><h2>Memories <a href="${hashFor("memory")}" aria-label="Open memories">${icon("right", 20)}</a></h2><div class="big-number"><b>${num(scoped ? valid.length : data.counts.memories)}</b><span>current${data.counts.memories_invalid && !scoped ? ` · ${num(data.counts.memories_invalid)} replaced by newer ones` : ""}</span></div><div class="block-foot">${byKind.length ? `<div class="split-bar">${byKind.map(([kind, count]) => `<span class="kind-${kind}" style="flex:${count}"></span>`).join("")}</div><div class="legend-row">${byKind.slice(0, 5).map(([kind, count]) => `<span><i class="kind-${kind}"></i>${h(kindLabel(kind))} ${num(count)}</span>`).join("")}</div>` : `<span class="caption">Decisions, dead ends and preferences appear as agents work.</span>`}</div></section>`;

    const learning = data.learning;
    const learnBlock = `<section class="block block-blue"><i class="block-deco deco-star"></i><h2>Learning <a href="${hashFor("learned")}" aria-label="Open learned rules and recipes">${icon("right", 20)}</a></h2><div class="big-number"><b>${num(learning.errors_fixed)}</b><span>${learning.errors_fixed === 1 ? "error fix" : "error fixes"} remembered</span></div><div class="block-foot"><div class="stats">${stat(num(learning.known_errors_recurred), "errors came back")}${stat(num(enabled), "rules active")}</div></div></section>`;


    const list = filteredTurns().slice(0, 9);
    const feed = list.length ? turnRows(list) : empty(allTurns.length ? "No requests match" : "Nothing captured yet", allTurns.length ? "Try another search or outcome filter." : "Connect a harness with <code>agent-mem setup claude</code> (or codex, copilot, opencode) and start a session.");
    const latest = valid.slice(0, 5).map((memory) => `<a class="row row-link" href="${hashFor("memory", { m: String(memory.id) })}"><span class="tag kind-${h(memory.kind)}">${h(kindLabel(memory.kind))}</span><div class="grow"><b>${inline(firstLine(memoryText(memory), 110))}</b><span>M${memory.id} · ${h(projectName(memory.project_id))} · ${h(when(memory.created_at))}</span></div></a>`).join("");
    const componentRows = Object.entries(data.health.components ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(0, 6).map(([component, info]) => {
      const failing = info.last_error_at && (!info.last_ok_at || info.last_error_at > info.last_ok_at);
      return `<div class="row"><i class="dot ${failing ? "bad" : "good"}"></i><b>${h(componentLabel(component))}</b><span class="value">${failing ? "failing" : `ok ${h(ago(info.last_ok_at))}`}</span></div>`;
    }).join("");
    return `<div class="page-head"><div><h1>${num(turnCount)} ${turnCount === 1 ? "request" : "requests"} in ${plural(sessionCount, "session")}</h1><p class="lede">${h(lede)}</p></div></div>
${alerts ? `<div class="alerts">${alerts}</div>` : ""}
<div class="blocks">${activity}${memoryBlock}${learnBlock}</div>
<div class="columns">
<section class="panel"><div class="panel-head"><h2>Latest requests</h2><span class="spacer"></span>${outcomePills()}</div>${feed}<div class="panel-foot"><a class="text-link" href="${hashFor("timeline")}">All sessions ${icon("right", 16)}</a></div></section>
<div class="stack">
<section class="panel"><div class="panel-head"><h2>Recently learned</h2><span class="spacer"></span>${valid.length ? `<a class="text-link" href="${hashFor("memory")}">All</a>` : ""}</div>${latest || empty("No memories yet", "Agents store them with <code>mem_remember</code>; hooks add decisions, corrections and dead ends.")}</section>
<section class="panel"><div class="panel-head"><h2>Background jobs</h2><span class="spacer"></span><a class="text-link" href="${hashFor("health")}">Health</a></div>${componentRows || empty("No hooks have run yet", "Run <code>agent-mem doctor</code> after your first session.")}</section>
</div></div>`;
  }

  /* ---------------------------------------------------------------- timeline */

  function timelineView() {
    const list = filteredTurns();
    const selected = state.turn === undefined ? undefined : data.turns.find((turn) => String(turn.id) === state.turn);
    const filtering = state.query.trim() !== "" || state.outcome !== "all";
    const active = state.session ?? selected?.session_id ?? list[0]?.session_id ?? sessions().find((item) => item.turns > 0)?.id;
    const matching = new Set(list.map((turn) => turn.session_id));
    let lastDay = "";
    // Sessions without a request (opened and closed, or only a hook check) only fill the list.
    const listed = sessions().filter((session) => session.turns > 0 || session.id === state.session);
    const hidden = sessions().length - listed.length;
    const cards = listed.filter((session) => !filtering || matching.has(session.id)).map((session) => {
      const key = dayKey(session.started_at);
      const label = key === lastDay ? "" : `<div class="list-label">${h(dayLabel(key))}</div>`;
      lastDay = key;
      return `${label}<button type="button" class="session-card" data-action="session" data-value="${h(session.id)}" aria-pressed="${session.id === active}"><b class="session-title">${h(sessionTitle(session) || "(no request yet)")}</b><span class="meta">${projectTag(session.project_id)}<span class="muted">${h(harnessLabel(session.harness))}</span></span><span class="meta muted"><span>${h(sessionRange(session, []))}</span><span>${plural(session.turns, "request")}</span></span></button>`;
    }).join("");
    const session = data.sessions.find((item) => item.id === active);
    const feedTurns = list.filter((turn) => turn.session_id === active).slice().reverse();
    const head = session ? `<div class="panel-head session-panel-head"><h2>${h(sessionTitle(session) || harnessLabel(session.harness))}</h2><span class="session-meta">${projectTag(session.project_id)}${tag(harnessLabel(session.harness))}${session.branch ? tag(session.branch, "mono") : ""}<small>${h(sessionRange(session, []))}</small></span></div>${sessionSummary(session)}` : `<div class="panel-head"><h2>Requests</h2></div>`;
    const feed = feedTurns.length === 0
      ? empty(filtering ? "Nothing matches in this session" : "No loaded turns for this session", filtering ? "Clear the search or outcome filter." : `The page holds the latest ${num(data.limits.turns)} turns.`)
      : `<div class="feed">${feedTurns.map((turn) => {
        const actionCount = (data.actions[turn.id] ?? []).length;
        return `<div class="feed-item"><div class="feed-rail"><span class="time">${h(clock(turn.started_at))}</span>${outcomeBadge(turn.outcome)}</div><button type="button" class="turn-card ${h(turn.outcome)}" data-action="turn" data-value="${turn.id}" aria-pressed="${String(turn.id) === state.turn}"><header><b>T${turn.id}</b>${turn.type ? tag(turn.type) : ""}${turn.outcome === "ok" ? "" : outcomeTag(turn.outcome)}<span class="muted">${[turn.files.length ? plural(turn.files.length, "file") : "", actionCount ? plural(actionCount, "action") : ""].filter(Boolean).join(" · ")}</span></header>${turn.title ? `<p><b>${h(turn.title)}</b></p>` : ""}<p>${h(plain(request(turn.prompt)) || "(no request text)")}</p>${turn.answer ? `<p class="answer">${h(plain(turn.answer))}</p>` : ""}</button></div>`;
      }).join("")}</div>`;
    return `<div class="page-head"><div><h1>Sessions</h1><p class="lede">Every request you gave an agent: what it did and how it ended. Pick a session on the left, then a request.</p></div>${outcomePills()}</div>
<div class="timeline">
<div class="session-list">${cards || empty("No sessions", "Sessions appear after a connected harness runs.")}${hidden ? `<p class="caption">${plural(hidden, "session")} without a request hidden.</p>` : ""}</div>
<section class="panel">${head}${feed}</section>
${turnDetail(selected, session)}
</div>`;
  }

  // Memories the hooks gave the agent during this turn; the first turn also gets the session-start briefing.
  function recallList(turn) {
    const all = (data.recalls ?? []).filter((recall) => recall.session_id === turn.session_id);
    const first = data.turns.filter((other) => other.session_id === turn.session_id).reduce((a, b) => (a && a.started_at <= b.started_at ? a : b), null);
    const end = turn.ended_at ?? "9999";
    const seen = new Set();
    const items = all.filter((recall) => (recall.ts >= turn.started_at && recall.ts <= end) || (first?.id === turn.id && recall.ts < turn.started_at))
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .filter((recall) => { const key = recall.owner_type + recall.owner_id; if (seen.has(key)) return false; seen.add(key); return true; });
    if (!items.length) return "";
    const row = (recall) => {
      const isMemory = recall.owner_type === "m";
      const label = `${isMemory ? "M" : "T"}${recall.owner_id}`;
      const memory = isMemory ? data.memories.find((item) => item.id === recall.owner_id) : undefined;
      const other = isMemory ? undefined : data.turns.find((item) => item.id === recall.owner_id);
      const text = memory ? memoryText(memory) : other ? headline(other) : "";
      const href = isMemory ? hashFor("memory", { m: String(recall.owner_id) }) : hashFor("timeline", { turn: String(recall.owner_id) });
      const when = recall.ts < turn.started_at ? "at session start" : clock(recall.ts);
      return `<li><header>${memory ? tag(kindLabel(memory.kind), `kind-${memory.kind}`) : tag("request")}<a href="${href}"><b>${label}</b></a><span class="muted">${h(when)}</span></header>${text ? h(firstLine(text, 160)) : ""}</li>`;
    };
    return `<span class="section-label">Given to the agent (${items.length})</span><ul class="actions">${items.map(row).join("")}</ul>`;
  }

  function turnDetail(turn, session) {
    if (!turn) return `<aside class="detail empty-detail" aria-label="Turn detail"><header><h2>Turn</h2></header><p>Select a turn to see the request, every action, the result and what was learned from it.</p><span class="notice">${icon("lock", 16)}Captured text is untrusted and shown as stored. This page makes no network requests.</span></aside>`;
    const actions = data.actions[turn.id] ?? [];
    const learned = data.memories.filter((memory) => memory.turn_id === turn.id);
    const closeHref = hashFor("timeline", session ? { session: session.id } : {});
    // One line per action: what the agent said it does, then the command or file; failures stand out, the rest stays quiet.
    const actionList = actions.length ? `<span class="section-label">Actions (${actions.length})</span><ul class="actions">${actions.map((action) => `<li class="${action.failed && !action.resolved ? "is-failed" : ""}"><header><b>${h(action.tool ?? "tool")}</b>${action.note ? `<span class="action-note">${h(action.note)}</span>` : ""}${action.failed ? tag(action.resolved ? "failed, fixed later" : `failed${action.exit_code ? ` · exit ${action.exit_code}` : ""}`, action.resolved ? "warn" : "bad") : ""}${action.external ? tag("external content", "warn") : ""}</header>${action.input || action.command ? `<code>${h(firstLine(action.input || action.command, 200))}</code>` : ""}${action.error_line ? `<code class="error-line">${h(action.error_line)}</code>` : ""}</li>`).join("")}</ul>` : "";
    return `<aside class="detail ${h(turn.outcome)}" aria-label="Turn detail">
<header><h2>T${turn.id} · ${h(outcomeLabel(turn.outcome))}</h2><a class="round-button" href="${closeHref}" aria-label="Close turn detail">${icon("close", 16)}</a></header>
${turn.title ? `<p class="detail-title">${turn.type ? tag(turn.type) : ""}<b>${h(turn.title)}</b></p>` : ""}
<div class="pill-group">${projectTag(turn.project_id)}${session ? tag(harnessLabel(session.harness)) : ""}${session?.branch ? tag(session.branch, "mono") : ""}</div>
<dl class="facts"><dt>Started</dt><dd>${h(full(turn.started_at))}</dd><dt>Ended</dt><dd>${h(turn.ended_at ? full(turn.ended_at) : "still running")}</dd></dl>
<div class="copy-list">${copyable(`agent-mem show T${turn.id}`)}</div>
<span class="section-label">Request</span><div class="text-box">${h(request(turn.prompt) || "(no request text)")}</div>
${actionList}
${turn.answer ? `<span class="section-label">Result</span><div class="text-box">${h(turn.answer)}</div>` : ""}
${turn.truncated ? `<p class="notice"><span>Long text is shortened on this page. <code>agent-mem show T${turn.id}</code> prints more.</span></p>` : ""}
${turn.files.length ? `<span class="section-label">Files</span><div class="file-list">${turn.files.map((file) => tag(file, "mono")).join("")}</div>` : ""}
${turn.errors.length ? `<span class="section-label">Errors</span><ul class="actions">${turn.errors.map((error) => `<li><code class="error-line">${h(error)}</code></li>`).join("")}</ul>` : ""}
${recallList(turn)}
${learned.length ? `<span class="section-label">Learned from this turn</span><ul class="actions">${learned.map((memory) => `<li><header>${tag(kindLabel(memory.kind), `kind-${memory.kind}`)}<a href="${hashFor("memory", { m: String(memory.id) })}"><b>M${memory.id}</b></a></header>${h(memoryText(memory))}</li>`).join("")}</ul>` : ""}
<span class="notice">${icon("lock", 16)}Captured text is untrusted and shown as stored. Secrets were redacted at capture.</span>
</aside>`;
  }

  /* ---------------------------------------------------------------- memories */

  function memoryView() {
    const all = memories();
    const pool = all.filter((memory) => state.invalid || !memory.invalid_at);
    const counts = new Map(MEMORY_KINDS.map((kind) => [kind, pool.filter((memory) => memory.kind === kind).length]));
    const shown = pool.filter((memory) => (state.kind === "all" || memory.kind === state.kind) && matches([memory.title, memory.body, memory.kind, memory.origin, `M${memory.id}`]));
    const pills = `<div class="pill-group" role="group" aria-label="Filter by kind"><button type="button" class="pill" data-action="kind" data-value="all" aria-pressed="${state.kind === "all"}">All ${num(pool.length)}</button>${MEMORY_KINDS.filter((kind) => counts.get(kind)).map((kind) => `<button type="button" class="pill" data-action="kind" data-value="${kind}" aria-pressed="${state.kind === kind}">${h(kindLabel(kind))} ${num(counts.get(kind))}</button>`).join("")}<button type="button" class="pill" data-action="invalid" aria-pressed="${state.invalid}">Show replaced</button></div>`;
    // One group per session: a session's facts, decisions and lessons belong together. Notes read in from the
    // agents' own memory files have no session; they get one group per file kind at the end.
    const groups = new Map();
    for (const memory of shown) {
      const key = memory.session_id ? `s:${memory.session_id}` : memory.source === "native" ? `f:${memory.origin ?? ""}` : "other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(memory);
    }
    const order = (key) => (key.startsWith("s:") ? 0 : key.startsWith("f:") ? 1 : 2);
    const keys = [...groups.keys()].sort((a, b) => order(a) - order(b));
    const searching = state.query.trim() !== "";
    const row = (memory) => `<a class="memory-row${memory.invalid_at ? " invalid" : ""}${String(memory.id) === state.memory ? " is-selected" : ""}" href="${hashFor("memory", { m: String(memory.id) })}">${tag(kindLabel(memory.kind), `kind-${memory.kind}`)}<span class="memory-text">${inline(memoryText(memory))}</span><span class="muted mono">M${memory.id}</span></a>`;
    const sections = keys.map((key, index) => {
      const items = groups.get(key).sort((a, b) => MEMORY_KINDS.indexOf(a.kind) - MEMORY_KINDS.indexOf(b.kind) || b.id - a.id);
      const session = key.startsWith("s:") ? data.sessions.find((item) => item.id === key.slice(2)) : undefined;
      let title = "Saved outside a session";
      let meta = projectTag(items[0].project_id);
      if (key.startsWith("s:")) {
        title = sessionTitle(session) || "Earlier session";
        meta += `<span class="muted">${session ? `${h(harnessLabel(session.harness))} · ${h(when(session.started_at))}` : h(when(items[0].created_at))}</span>`;
      } else if (key.startsWith("f:")) {
        title = ORIGIN_LABEL[key.slice(2)] ?? "Agent memory files";
        meta = `<span class="muted">read in as written, newest first</span>`;
      }
      const open = searching || index < 3 || items.some((memory) => String(memory.id) === state.memory);
      return `<details class="memory-group"${open ? " open" : ""}><summary><span class="group-title">${h(title)}</span><span class="group-meta">${meta}<span class="count">${plural(items.length, "memory", "memories")}</span></span></summary><div class="memory-rows">${items.map(row).join("")}</div></details>`;
    }).join("");
    const cards = sections;
    const selected = state.memory === undefined ? undefined : data.memories.find((memory) => String(memory.id) === state.memory);
    return `<div class="page-head"><div><h1>Memories</h1><p class="lede">What your agents keep in mind, grouped by the session it came from. Click one to see where it came from or to delete it.</p></div></div>
${pills}
<div class="${selected ? "with-detail" : ""}">
<div>${cards ? `<div class="memory-groups">${cards}</div>` : empty(all.length ? "No memories match" : "No memories yet", all.length ? "Try another search or kind." : "Agents write them with the <code>mem_remember</code> MCP tool; hooks add decisions, corrections and dead ends.")}
${limitReached(data.memories, "memories") ? `<p class="muted">This page holds the latest ${num(data.limits.memories)} memories. <code>agent-mem search</code> finds older ones.</p>` : ""}</div>
${selected ? memoryDetail(selected) : ""}
</div>`;
  }

  // Observer facts store the first 120 characters of the body as title; show the whole sentence instead of the cut.
  const memoryText = (memory) => {
    const title = String(memory.title ?? "").trim();
    const body = String(memory.body ?? "").trim();
    const stem = title.replace(/(?:…|\.\.\.)$/, "").trimEnd();
    return body.length > stem.length && body.startsWith(stem) ? body : title;
  };

  // Where a memory came from, in words: an agent's own memory file, the background extraction, or the agent itself.
  function memorySource(memory) {
    if (memory.source === "native") return ORIGIN_LABEL[memory.origin] ?? "agent memory file";
    if (memory.kind === "lesson") return "lesson from a turn";
    if (memory.source === "agent" && memory.turn_id) return `extracted from a ${harnessLabel(memory.origin)} turn`;
    return memory.origin ? `saved by ${harnessLabel(memory.origin)}` : "saved by an agent";
  }

  function memoryDetail(memory) {
    const id = `M${memory.id}`;
    const successor = memory.superseded_by ? data.memories.find((item) => item.id === memory.superseded_by) : undefined;
    const usage = memory.shown ? `shown ${plural(memory.shown, "time")}, used ${plural(memory.used, "time")}` : memory.used ? `used ${plural(memory.used, "time")}` : "not yet";
    return `<aside class="detail memory-detail kind-${h(memory.kind)}" aria-label="Memory detail">
<header><h2>${id} · ${h(kindLabel(memory.kind))}</h2><a class="round-button" href="${hashFor("memory")}" aria-label="Close memory detail">${icon("close", 16)}</a></header>
<div class="pill-group">${projectTag(memory.project_id)}${tag(memorySource(memory))}${memory.invalid_at ? tag("replaced", "warn") : ""}</div>
<div class="text-box">${inline(memoryText(memory))}${memory.body && !memoryText(memory).startsWith(memory.body.trim()) && memory.body.trim() !== memory.title.trim() ? `\n\n${h(memory.body)}` : ""}</div>
${memory.truncated ? `<p class="notice"><span>Long text is shortened on this page. <code>agent-mem show ${id}</code> prints all of it.</span></p>` : ""}
<dl class="facts"><dt>Created</dt><dd>${h(full(memory.created_at))}</dd>${memory.valid_from && dayKey(memory.valid_from) !== dayKey(memory.created_at) ? `<dt>Valid from</dt><dd>${h(full(memory.valid_from))}</dd>` : ""}${memory.invalid_at ? `<dt>Invalid since</dt><dd>${h(full(memory.invalid_at))}</dd>` : ""}${memory.superseded_by ? `<dt>Replaced by</dt><dd>${successor ? `<a href="${hashFor("memory", { m: String(successor.id) })}">M${successor.id}</a> ${h(firstLine(memoryText(successor), 80))}` : `M${h(memory.superseded_by)}`}</dd>` : ""}<dt>Given to agents</dt><dd>${h(usage)}</dd>${memory.turn_id ? `<dt>From turn</dt><dd><a href="${hashFor("timeline", { turn: String(memory.turn_id) })}">T${memory.turn_id}</a></dd>` : ""}</dl>
<span class="section-label">Commands</span>
<div class="copy-list">${copyable(`agent-mem show ${id}`)}${copyable(`agent-mem purge --id ${id}`)}</div>
<p class="notice">${icon("lock", 16)}<span>Purge deletes the memory with its search keys and vectors and removes this page. An agent can do the same with the <code>mem_forget</code> tool.</span></p>
</aside>`;
  }

  /* ---------------------------------------------------------------- learned */

  function learnedView() {
    const rules = data.rules.filter((rule) => inProjectOrGlobal(rule.project_id) && matches([rule.pattern, rule.message]));
    const lessons = memories().filter((memory) => memory.kind === "lesson" && !memory.invalid_at && matches([memory.title, memory.body, `M${memory.id}`]));
    // Same row as "Recently learned" on the overview; the turn link is the evidence the lesson was drawn from.
    const lessonRows = lessons.map((memory) => `<a class="row row-link" href="${hashFor("memory", { m: String(memory.id) })}"><div class="grow"><b>${inline(firstLine(memoryText(memory), 200))}</b><span>M${memory.id}${memory.turn_id ? ` · from T${memory.turn_id}` : ""} · ${h(projectName(memory.project_id))} · ${h(when(memory.created_at))}${memory.used ? ` · used ${num(memory.used)}×` : ""}</span></div></a>`).join("");
    const recipes = data.recipes.filter((recipe) => inProject(recipe.project_id) && matches([recipe.error_text, recipe.command_key, ...recipe.files]));
    const profile = data.profile.filter((item) => inProject(item.project_id) && matches([item.key, item.value]));
    const ruleRows = rules.map((rule) => `<tr><td><b>R${rule.id}</b></td><td>${inline(rule.message)}<br><span class="muted">pattern</span> <code>${h(rule.pattern)}</code></td><td>${rule.enabled ? tag("enabled", "good") : tag("proposed", "info")}</td><td class="num">${num(rule.evidence)}</td><td class="num">${num(rule.hits)}</td><td class="num">${num(rule.overrides)}</td><td>${projectTag(rule.project_id)}</td><td>${copyable(`agent-mem rules ${rule.enabled ? "disable" : "enable"} ${rule.id}`)}</td></tr>`).join("");
    const recipeRows = recipes.map((recipe) => `<div class="recipe"><code class="error-line">${h(firstLine(recipe.error_text, 200))}</code><div class="recipe-meta"><code>${h(recipe.command_key)}</code>${recipe.files.slice(0, 4).map((file) => tag(file, "mono")).join("")}</div><div class="recipe-meta">${tag(`fixed ${num(recipe.successes)}×`, "good")}${recipe.recurrences ? tag(`recurred ${num(recipe.recurrences)}×`, "warn") : ""}${projectTag(recipe.project_id)}<span class="muted">${h(when(recipe.updated_at))}</span></div></div>`).join("");
    const groups = new Map();
    for (const item of profile) groups.set(item.key, [...(groups.get(item.key) ?? []), item]);
    const profileRows = [...groups.entries()].map(([key, items]) => {
      const rows = items.slice(0, 5).map((item) => `<div class="row"><code class="grow clip" title="${h(item.value)}">${h(firstLine(item.value.replace(/\s*…?\[truncated\]…?\s*/g, " … "), 90))}</code><span class="value">${plural(item.count, "time")}</span></div>`).join("");
      const more = items.length > 5 ? `<p class="muted more">${plural(items.length - 5, "more variant")}, used less often</p>` : "";
      return `<div class="pref-group"><span class="section-label">${h(PROFILE_LABEL[key] ?? readable(key))}</span>${rows}${more}</div>`;
    }).join("");
    return `<div class="page-head"><div><h1>Learned</h1><p class="lede">What agent-mem worked out by watching: lessons from mistakes, fixes and your corrections, rules, fixes for errors, and the commands you use most.</p></div></div>
<section class="panel"><div class="panel-head"><h2>Lessons</h2><small>written in the background when a turn shows a mistake and its fix, a correction of yours or a failed approach; the best ones start every session</small></div>${lessonRows || empty("No lessons yet", "They appear after a turn in which something went wrong and was fixed, or you corrected the agent.")}</section>
<section class="panel"><div class="panel-head"><h2>Rules</h2><small>Proposed rules only warn. Enabled rules can block a command.</small></div>${ruleRows ? `<div class="table-wrap"><table><thead><tr><th>Id</th><th>Rule</th><th>State</th><th>Evidence</th><th>Hits</th><th>Overrides</th><th>Project</th><th>Change with</th></tr></thead><tbody>${ruleRows}</tbody></table></div>` : empty("No rules yet", "Say “pnpm instead of npm” a few times and a rule is proposed.")}</section>
<div class="halves">
<section class="panel"><div class="panel-head"><h2>Error fixes</h2><small>a command failed, files were changed, then it passed</small></div>${recipeRows || empty("No fixes learned yet", "They appear after a failing command passes again in the same session.")}</section>
<section class="panel"><div class="panel-head"><h2>Preferences</h2><small>most used first</small></div>${profileRows || empty("No preferences yet", "Repeated choices such as package managers or test commands show up here.")}</section>
</div>`;
  }

  /* ---------------------------------------------------------------- health */

  function agentRow(agent) {
    const recording = agent.connected ? '<i class="dot good"></i> Connected' : agent.cli ? '<i class="dot warn"></i> Not connected' : '<span class="muted">Not installed</span>';
    let facts = '<span class="muted">kept as written (no model)</span>';
    if (!agent.enabled) facts = '<span class="muted">off in config</span>';
    else if (agent.stage) facts = `<code>${h(agent.model)}</code> <span class="muted">via ${h(agent.stage)}</span>${agent.paused_until ? ` ${tag(`paused until ${clock(agent.paused_until)}`, "warn")}` : ""}`;
    const today = agent.facts_ok_today || agent.facts_failed_today ? `${num(agent.facts_ok_today)} runs${agent.facts_failed_today ? ` · ${num(agent.facts_failed_today)} failed` : ""}` : '<span class="muted">—</span>';
    let next = '<span class="muted">—</span>';
    if (agent.cli && !agent.connected) next = `<code>agent-mem setup ${h(agent.harness)} --write</code>`;
    else if (agent.connected && !agent.stage && agent.enabled) next = agent.harness === "opencode" ? 'Add <code>"ollama"</code> to <code>observe.providers</code> for facts' : `Install the <code>${h(agent.harness)}</code> CLI for facts`;
    return `<tr><td><b>${h(agent.label)}</b></td><td>${recording}</td><td>${facts}</td><td>${today}</td><td>${next}</td></tr>`;
  }

  function healthView() {
    const health = data.health;
    const paused = Boolean(health.paused_until);
    const components = Object.entries(health.components ?? {}).filter(([name]) => matches([name, componentLabel(name)])).sort(([a], [b]) => a.localeCompare(b));
    const rows = components.map(([name, info]) => {
      const failing = info.last_error_at && (!info.last_ok_at || info.last_error_at > info.last_ok_at);
      return `<tr><td><i class="dot ${failing ? "bad" : "good"}" style="display:inline-block;margin-right:8px"></i><b>${h(componentLabel(name))}</b></td><td>${h(info.last_ok_at ? when(info.last_ok_at) : "never")}</td><td class="num">${num(info.ok_count)}</td><td class="num">${num(info.error_count)}</td><td>${failing ? `<code>${h(firstLine(info.last_error, 160))}</code>` : info.last_error ? `<span class="muted">earlier: ${h(firstLine(info.last_error, 80))} (${h(when(info.last_error_at))})</span>` : '<span class="muted">—</span>'}</td></tr>`;
    }).join("");
    const semantic = String(health.semantic ?? "not indexed yet");
    const agentRows = (data.agents ?? []).filter((agent) => matches([agent.label, agent.stage, agent.model])).map(agentRow).join("");
    return `<div class="page-head"><div><h1>Health &amp; privacy</h1><p class="lede">Is everything working? Green means yes. This is the state when the page was written; <code>agent-mem doctor</code> checks it right now.</p></div></div>
<div class="state-grid">
<section class="block ${paused ? "block-yellow" : "block-green"}"><i class="block-deco deco-triangle"></i><h2>Capture</h2><div class="big-number"><b>${paused ? "Paused" : "Active"}</b></div><span class="caption">${paused ? "Resume with <code>agent-mem resume</code>" : "Pause with <code>agent-mem pause --for 1h</code>"}</span></section>
<section class="block block-blue"><h2>Meaning search</h2><div class="big-number"><b>${semantic === "unavailable" || semantic === "not indexed yet" ? "Off" : "On"}</b></div><span class="caption">${semantic === "unavailable" || semantic === "not indexed yet" ? "Word search works. For search by meaning run <code>agent-mem models install</code>." : `Finds memories with other words, too. Model: ${h(semantic.split("/").pop())}`}</span></section>
<section class="block block-yellow"><h2>Cleanup</h2><div class="big-number"><b style="font-size:26px">${h(ago(health.consolidated_at))}</b></div><span class="caption">Merges duplicates and retires outdated facts.</span></section>
</div>
<section class="panel"><div class="panel-head"><h2>Agents</h2><small>which agents are recorded and which model turns their requests into facts</small></div><div class="table-wrap"><table class="agents"><thead><tr><th>Agent</th><th>Recording</th><th>Facts by</th><th>Today</th><th>Next step</th></tr></thead><tbody>${agentRows}</tbody></table></div></section>
<div class="columns">
<section class="panel"><div class="panel-head"><h2>Background jobs</h2><small>green = working</small></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Job</th><th>Last worked</th><th>Runs</th><th>Errors</th><th>Last error</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty("Nothing has run yet", "Hooks report here after the first captured session.")}</section>
<div class="stack">
<section class="panel"><div class="panel-head"><h2>Storage</h2></div>
<div class="row"><b>Database</b><span class="value">${h(health.db_mb)} MB · schema v${h(health.schema)}</span></div>
<div class="row"><b>Waiting to be saved</b><span class="value">${plural(health.spool, "event")}</span></div>
<div class="row"><span class="grow wrap"><b>Could not be read</b>${data.quarantine_latest ? `<span>Latest ${h(when(data.quarantine_latest.ts))}: ${h(data.quarantine_latest.reason)}</span>` : ""}</span><span class="value">${plural(health.quarantine, "file")}</span></div>
<div class="row"><b>Data directory</b><span class="value"><code>${h(health.data_dir)}</code></span></div></section>
<section class="panel"><div class="panel-head"><h2>Privacy</h2></div>
<div class="row"><span class="grow wrap"><b>Not encrypted at rest</b><span>Anyone who can read the data directory can read your memory.</span></span></div>
<div class="row"><span class="grow wrap"><b>Only on this computer</b><span>The viewer listens on 127.0.0.1 and makes no requests to the internet. Pages saved with <code>agent-mem view --output</code> hold a copy of recent data.</span></span></div>
<div class="row"><span class="grow wrap"><b>Redaction</b><span>Secrets are redacted and private sections dropped before anything is stored.</span></span></div></section>
</div></div>`;
  }

  /* ---------------------------------------------------------------- routing */

  function readRoute() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path = "", query = ""] = raw.split("?");
    const params = new URLSearchParams(query);
    state.view = NAV.some((item) => item.id === path) ? path : "overview";
    if (state.view === "timeline") {
      state.turn = params.get("turn") ?? undefined;
      state.session = params.get("session") ?? undefined;
      if (state.turn !== undefined && state.session === undefined) state.session = data.turns.find((turn) => String(turn.id) === state.turn)?.session_id;
    }
    state.memory = state.view === "memory" ? params.get("m") ?? undefined : undefined;
  }

  function renderView() {
    const view = document.getElementById("view");
    if (!view) return;
    view.innerHTML = { overview: overviewView, timeline: timelineView, memory: memoryView, learned: learnedView, health: healthView }[state.view]();
    syncChrome();
  }

  function navigate() {
    const previous = state.view;
    readRoute();
    renderView();
    if (previous !== state.view) { window.scrollTo({ top: 0 }); document.getElementById("view")?.focus({ preventScroll: true }); }
    if ((state.turn !== undefined || state.memory !== undefined) && window.matchMedia("(max-width: 1320px)").matches) document.querySelector(".detail")?.scrollIntoView({ block: "start" });
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const { action, value } = target.dataset;
    if (action === "project") { state.project = value; state.session = undefined; renderChrome(); renderView(); return; }
    if (action === "outcome") { state.outcome = value; renderView(); return; }
    if (action === "kind") { state.kind = value; renderView(); return; }
    if (action === "invalid") { state.invalid = !state.invalid; renderView(); return; }
    if (action === "copy") {
      const done = () => { target.classList.add("is-copied"); target.setAttribute("aria-label", "Copied"); setTimeout(() => { target.classList.remove("is-copied"); target.removeAttribute("aria-label"); }, 1400); };
      // execCommand needs no permission and works for file:// pages; the selection stays if both ways fail.
      const range = document.createRange(); range.selectNodeContents(target.querySelector("code"));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      let copied = false;
      try { copied = document.execCommand("copy"); } catch { copied = false; }
      if (copied) { getSelection().removeAllRanges(); done(); } else navigator.clipboard?.writeText(value).then(() => { getSelection().removeAllRanges(); done(); }, () => {});
      return;
    }
    if (action === "session") { location.hash = hashFor("timeline", { session: value }); return; }
    if (action === "turn") { location.hash = hashFor("timeline", state.session ? { session: state.session, turn: value } : { turn: value }); return; }
  });
  document.addEventListener("change", (event) => {
    if (event.target.id !== "project-select") return;
    state.project = event.target.value; state.session = undefined; renderChrome(); renderView();
  });
  let timer;
  document.addEventListener("input", (event) => {
    if (event.target.id !== "search") return;
    state.query = event.target.value;
    clearTimeout(timer);
    timer = setTimeout(renderView, 120);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (state.memory !== undefined || state.turn !== undefined) && !event.target.closest?.("input")) {
      location.hash = state.view === "memory" ? hashFor("memory") : hashFor("timeline", state.session ? { session: state.session } : {});
      return;
    }
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable)) return;
    event.preventDefault();
    document.getElementById("search")?.focus();
  });
  window.addEventListener("hashchange", navigate);

  const SAVED = "agent-mem-view";
  let lastActivity = 0;
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) document.addEventListener(type, () => { lastActivity = Date.now(); }, { passive: true, capture: true });
  const restore = () => {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(SAVED) ?? "null"); sessionStorage.removeItem(SAVED); } catch { return 0; }
    if (!saved) return 0;
    Object.assign(state, { query: saved.query ?? "", project: saved.project ?? state.project, outcome: saved.outcome ?? "all", kind: saved.kind ?? "all", invalid: Boolean(saved.invalid) });
    if (state.project !== "all" && !data.projects.some((project) => project.id === state.project)) state.project = "all";
    return Number(saved.scroll) || 0;
  };
  // Reload to pick up the rewritten file, but never while the reader is active, typing or selecting text.
  const reloadWhenIdle = () => {
    const active = document.activeElement;
    const busy = document.hidden || Date.now() - lastActivity < 8000 || (active && (active.tagName === "INPUT" || active.tagName === "SELECT")) || String(getSelection?.() ?? "") !== "";
    if (busy) return;
    try { sessionStorage.setItem(SAVED, JSON.stringify({ query: state.query, project: state.project, outcome: state.outcome, kind: state.kind, invalid: state.invalid, scroll: window.scrollY })); } catch { /* storage off: reload without state */ }
    location.reload();
  };

  try {
    data = JSON.parse(document.getElementById("agent-mem-data").textContent);
    if (data.project_id) state.project = data.project_id;
    const scroll = restore();
    renderChrome();
    readRoute();
    renderView();
    if (scroll) window.scrollTo({ top: scroll });
    // A sleeping tab catches up on its own; the server builds a fresh page on every reload.
    if (data.refresh) setInterval(reloadWhenIdle, data.refresh * 1000);
  } catch (error) {
    root.innerHTML = `<div class="app"><div class="main"><div class="empty"><b>The page could not read its snapshot.</b><span class="mono">${h(error && error.message ? error.message : "unknown error")}</span></div></div></div>`;
  }
})();
