/* agent-mem view: renders the embedded snapshot. No network access; all text is escaped before it reaches the DOM. */
(() => {
  "use strict";

  const ICONS = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    timeline: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    memory: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    learned: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8-4.3-4.1 5.9-.9z"/>',
    graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8.4 6.4l7.2 1.2M6.8 8.4l2.4 7.2M16.4 10l-4.8 6"/>',
    health: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    session: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    cross: '<path d="M7 7l10 10M17 7L7 17"/>',
    dots: '<path d="M6 12h.01M12 12h.01M18 12h.01"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  };
  const icon = (name, size = 20, width = 1.8) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

  const NAV = [
    { id: "overview", label: "Overview", icon: "overview", group: "Memory", search: "Search requests, memories and files…" },
    { id: "timeline", label: "Timeline", icon: "timeline", group: "Memory", search: "Search requests, results, files and commands…" },
    { id: "memory", label: "Memories", icon: "memory", group: "Memory", search: "Search memories…" },
    { id: "learned", label: "Learned", icon: "learned", group: "Memory", search: "Search rules, recipes and preferences…" },
    { id: "graph", label: "Connections", short: "Links", icon: "graph", group: "Memory", search: "Search files, commands and errors…" },
    { id: "health", label: "Health", title: "Health & privacy", icon: "health", group: "System", search: "Search running parts…" },
  ];
  const MEMORY_KINDS = ["decision", "fact", "preference", "correction", "dead_end", "lesson", "summary", "native_note"];
  const PROFILE_LABEL = { "cmd:test": "Test command", "cmd:lint": "Lint command", "cmd:build": "Build command", "cmd:install": "Install command" };
  const ENTITY_KINDS = ["file", "command", "error", "package"];
  // Error signatures are stored as "sig:<hash>"; show them as short error ids.
  const entityLabel = (node) => (node.kind === "error" && node.key.startsWith("sig:") ? `error ${node.key.slice(4, 12)}` : node.key);
  const ENTITY_COLOR = { file: "--blue", command: "--green", error: "--coral", package: "--yellow" };

  const root = document.getElementById("root");
  let data = null;
  let graphController = null;
  const state = { view: "overview", project: "all", query: "", outcome: "all", session: undefined, turn: undefined, memory: undefined, kind: "all", invalid: false, hiddenKinds: new Set() };

  /* ---------------------------------------------------------------- helpers */

  const h = (value) => String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);
  const num = (value) => Number(value ?? 0).toLocaleString("en-US");
  const plural = (count, word, many = `${word}s`) => `${num(count)} ${count === 1 ? word : many}`;
  const readable = (code) => String(code ?? "").replace(/_/g, " ");
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
  const COMPONENT_LABEL = { indexer: "Search index", semantic: "Meaning search", observer: "Fact extraction", consolidation: "Cleanup", backup: "Backup" };
  const componentLabel = (name) => (name.startsWith("hook:") ? `${harnessLabel(name.slice(5))} hooks` : COMPONENT_LABEL[name] ?? readable(name));
  const outcomeLabel = (outcome) => ({ ok: "done", error: "failed", open: "open", unknown: "no result" })[outcome] ?? outcome;
  const outcomeTag = (outcome) => tag(outcomeLabel(outcome), outcome === "ok" ? "good" : outcome === "error" ? "bad" : outcome === "open" ? "warn" : "");
  const outcomeBadge = (outcome) => `<span class="badge ${h(outcome)}" title="${h(outcomeLabel(outcome))}">${icon(outcome === "ok" ? "check" : outcome === "error" ? "cross" : "dots", 15, 2.2)}</span>`;
  const limitReached = (list, key) => list.length >= (data.limits[key] ?? Infinity);

  // `agent-mem serve` builds the page fresh on every request; the page reloads itself every `refresh` seconds.
  const live = () => Boolean(data.served);
  const turns = () => data.turns.filter((turn) => inProject(turn.project_id));
  const sessions = () => data.sessions.filter((session) => inProject(session.project_id));
  const memories = () => data.memories.filter((memory) => inProjectOrGlobal(memory.project_id));
  const turnMatches = (turn) => matches([turn.prompt, turn.answer, ...turn.files, ...turn.commands, ...turn.errors, `T${turn.id}`]);
  const filteredTurns = () => turns().filter((turn) => (state.outcome === "all" || turn.outcome === state.outcome) && turnMatches(turn));

  function outcomePills() {
    const options = [["all", "All"], ["error", "Failed"], ["ok", "Done"], ["open", "Open"]];
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
    if (health.quarantine > 0) items.push({ tone: "warn", text: `<b>${plural(health.quarantine, "hook message")} could not be read</b> and ${health.quarantine === 1 ? "was" : "were"} set aside. Everything else was saved.`, view: "health" });
    const proposed = data.rules.filter((rule) => !rule.enabled && inProjectOrGlobal(rule.project_id)).length;
    if (proposed > 0) items.push({ tone: "info", text: `<b>${plural(proposed, "rule")} proposed from your corrections.</b> Review them before enabling.`, view: "learned" });
    for (const warning of health.config_warnings ?? []) items.push({ tone: "warn", text: `<b>Config:</b> ${h(warning)}`, view: "health" });
    return items;
  }

  function renderChrome() {
    const failing = attention().filter((item) => item.tone === "bad").length;
    const counts = { timeline: turns().length, memory: memories().filter((m) => !m.invalid_at).length, learned: data.rules.length + data.recipes.length };
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
      return `<div class="session-head">${icon("session", 17)}<b>${h(harnessLabel(session?.harness))}</b>${projectTag(items[0].project_id)}${session?.branch ? tag(session.branch, "mono") : ""}<span class="muted">${h(sessionRange(session, items))}</span></div>` +
        items.map((turn) => `<a class="turn-row" href="${hashFor("timeline", { turn: String(turn.id) })}"><span class="time">${h(clock(turn.started_at))}</span>${outcomeBadge(turn.outcome)}<span class="preview">${h(firstLine(request(turn.prompt)) || "(no request text)")}</span><span class="tags">${turn.files.length ? tag(plural(turn.files.length, "file")) : ""}${(data.actions[turn.id] ?? []).length ? tag(plural(data.actions[turn.id].length, "action")) : ""}</span></a>`).join("");
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
    const bars = days.map((key) => { const entry = perDay.get(key); return `<span title="${h(dayLabel(key))}: ${plural(entry.turns, "request")}, ${num(entry.errors)} failed"><i class="${key === today() ? "today" : ""}" style="height:${entry.turns ? Math.max(6, entry.turns / peak * 100) : 3}%"></i>${entry.errors ? `<i class="errors" style="height:${entry.errors / peak * 100}%"></i>` : ""}</span>`; }).join("");
    const activity = `<section class="block block-yellow"><i class="block-deco deco-tile"></i><h2>Activity</h2><div class="stats">${stat(num(turnCount), `${approx}requests`)}${stat(num(sessionCount), "sessions")}${stat(num(allTurns.filter((t) => t.outcome === "error").length), "failed")}</div><div class="block-foot"><div class="bars" role="img" aria-label="Requests per day over the last 14 days">${bars}</div><div class="bar-axis"><span>${h(dayLabel(days[0]))}</span><span>Today</span></div></div></section>`;

    const byKind = MEMORY_KINDS.map((kind) => [kind, valid.filter((memory) => memory.kind === kind).length]).filter(([, count]) => count > 0);
    const memoryBlock = `<section class="block block-pink"><i class="block-deco deco-circle"></i><h2>Memories <a href="${hashFor("memory")}" aria-label="Open memories">${icon("right", 20)}</a></h2><div class="big-number"><b>${num(valid.length)}</b><span>current${data.counts.memories_invalid && !scoped ? ` · ${num(data.counts.memories_invalid)} replaced by newer ones` : ""}</span></div><div class="block-foot">${byKind.length ? `<div class="split-bar">${byKind.map(([kind, count]) => `<span class="kind-${kind}" style="flex:${count}"></span>`).join("")}</div><div class="legend-row">${byKind.slice(0, 5).map(([kind, count]) => `<span><i class="kind-${kind}"></i>${h(readable(kind))} ${num(count)}</span>`).join("")}</div>` : `<span class="caption">Decisions, dead ends and preferences appear as agents work.</span>`}</div></section>`;

    const learning = data.learning;
    const learnBlock = `<section class="block block-blue"><i class="block-deco deco-star"></i><h2>Learning <a href="${hashFor("learned")}" aria-label="Open learned rules and recipes">${icon("right", 20)}</a></h2><div class="big-number"><b>${num(learning.errors_fixed)}</b><span>error fixes remembered</span></div><div class="block-foot"><div class="stats">${stat(num(learning.known_errors_recurred), "errors came back")}${stat(num(enabled), "rules active")}</div></div></section>`;

    const nodes = data.graph.nodes.filter((node) => inProjectOrGlobal(node.project_id));
    const graphBlock = `<section class="block block-green"><i class="block-deco deco-triangle"></i><h2>Connections <a href="${hashFor("graph")}" aria-label="Open connections">${icon("right", 20)}</a></h2><div class="big-number"><b>${num(scoped ? nodes.length : data.counts.entities)}</b><span>files, commands and errors</span></div><div class="block-foot"><span class="caption">${num(data.counts.edges)} links between things used in the same request</span></div></section>`;

    const list = filteredTurns().slice(0, 9);
    const feed = list.length ? turnRows(list) : empty(allTurns.length ? "No requests match" : "Nothing captured yet", allTurns.length ? "Try another search or outcome filter." : "Connect a harness with <code>agent-mem setup claude</code> (or codex, copilot, opencode) and start a session.");
    const latest = valid.slice(0, 5).map((memory) => `<a class="row row-link" href="${hashFor("memory", { m: String(memory.id) })}"><span class="tag kind-${h(memory.kind)}">${h(readable(memory.kind))}</span><div class="grow"><b>${inline(firstLine(memoryText(memory), 110))}</b><span>M${memory.id} · ${h(projectName(memory.project_id))} · ${h(when(memory.created_at))}</span></div></a>`).join("");
    const componentRows = Object.entries(data.health.components ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(0, 6).map(([component, info]) => {
      const failing = info.last_error_at && (!info.last_ok_at || info.last_error_at > info.last_ok_at);
      return `<div class="row"><i class="dot ${failing ? "bad" : "good"}"></i><b>${h(componentLabel(component))}</b><span class="value">${failing ? "failing" : `ok ${h(ago(info.last_ok_at))}`}</span></div>`;
    }).join("");
    return `<div class="page-head"><div><h1>${num(turnCount)} ${turnCount === 1 ? "request" : "requests"} in ${plural(sessionCount, "session")}</h1><p class="lede">${h(lede)}</p></div></div>
${alerts ? `<div class="alerts">${alerts}</div>` : ""}
<div class="blocks">${activity}${memoryBlock}${learnBlock}${graphBlock}</div>
<div class="columns">
<section class="panel"><div class="panel-head"><h2>Latest requests</h2><span class="spacer"></span>${outcomePills()}</div>${feed}<div class="panel-foot"><a class="text-link" href="${hashFor("timeline")}">Open timeline ${icon("right", 16)}</a></div></section>
<div class="stack">
<section class="panel"><div class="panel-head"><h2>Recently learned</h2><span class="spacer"></span>${valid.length ? `<a class="text-link" href="${hashFor("memory")}">All</a>` : ""}</div>${latest || empty("No memories yet", "Agents store them with <code>mem_remember</code>; hooks add decisions, corrections and dead ends.")}</section>
<section class="panel"><div class="panel-head"><h2>Running parts</h2><span class="spacer"></span><a class="text-link" href="${hashFor("health")}">Health</a></div>${componentRows || empty("No hooks have run yet", "Run <code>agent-mem doctor</code> after your first session.")}</section>
</div></div>`;
  }

  /* ---------------------------------------------------------------- timeline */

  function timelineView() {
    const list = filteredTurns();
    const selected = state.turn === undefined ? undefined : data.turns.find((turn) => String(turn.id) === state.turn);
    const filtering = state.query.trim() !== "" || state.outcome !== "all";
    const active = state.session ?? selected?.session_id ?? list[0]?.session_id ?? sessions()[0]?.id;
    const matching = new Set(list.map((turn) => turn.session_id));
    let lastDay = "";
    const cards = sessions().filter((session) => !filtering || matching.has(session.id)).map((session) => {
      const key = dayKey(session.started_at);
      const label = key === lastDay ? "" : `<div class="list-label">${h(dayLabel(key))}</div>`;
      lastDay = key;
      return `${label}<button type="button" class="session-card" data-action="session" data-value="${h(session.id)}" aria-pressed="${session.id === active}"><header>${icon("session", 17)}<b>${h(harnessLabel(session.harness))}</b></header><span class="meta">${projectTag(session.project_id)}${session.branch ? `<span class="mono muted">${h(session.branch)}</span>` : ""}</span><span class="meta muted"><span>${h(sessionRange(session, []))}</span><span>${plural(session.turns, "turn")}</span></span></button>`;
    }).join("");
    const session = data.sessions.find((item) => item.id === active);
    const feedTurns = list.filter((turn) => turn.session_id === active).slice().reverse();
    const head = session ? `<div class="panel-head"><h2>${h(harnessLabel(session.harness))}</h2>${projectTag(session.project_id)}${session.branch ? tag(session.branch, "mono") : ""}<small>${h(sessionRange(session, []))}${session.summarized_at ? " · summarized" : ""}</small></div>` : `<div class="panel-head"><h2>Turns</h2></div>`;
    const feed = feedTurns.length === 0
      ? empty(filtering ? "Nothing matches in this session" : "No loaded turns for this session", filtering ? "Clear the search or outcome filter." : `The page holds the latest ${num(data.limits.turns)} turns.`)
      : `<div class="feed">${feedTurns.map((turn) => {
        const actionCount = (data.actions[turn.id] ?? []).length;
        return `<div class="feed-item"><div class="feed-rail"><span class="time">${h(clock(turn.started_at))}</span>${outcomeBadge(turn.outcome)}</div><button type="button" class="turn-card ${h(turn.outcome)}" data-action="turn" data-value="${turn.id}" aria-pressed="${String(turn.id) === state.turn}"><header><b>T${turn.id}</b>${outcomeTag(turn.outcome)}<span class="muted">${[turn.files.length ? plural(turn.files.length, "file") : "", actionCount ? plural(actionCount, "action") : ""].filter(Boolean).join(" · ")}</span></header><p>${h(plain(request(turn.prompt)) || "(no request text)")}</p>${turn.answer ? `<p class="answer">${h(plain(turn.answer))}</p>` : ""}</button></div>`;
      }).join("")}</div>`;
    return `<div class="page-head"><div><h1>Timeline</h1><p class="lede">Every request you gave an agent: what it did and how it ended. Pick a session on the left, then a request.</p></div>${outcomePills()}</div>
<div class="timeline">
<div class="session-list">${cards || empty("No sessions", "Sessions appear after a connected harness runs.")}</div>
<section class="panel">${head}${feed}</section>
${turnDetail(selected, session)}
</div>`;
  }

  function turnDetail(turn, session) {
    if (!turn) return `<aside class="detail empty-detail" aria-label="Turn detail"><header><h2>Turn</h2></header><p>Select a turn to see the request, every action, the result and what was learned from it.</p><span class="notice">${icon("lock", 16)}Captured text is untrusted and shown as stored. This page makes no network requests.</span></aside>`;
    const actions = data.actions[turn.id] ?? [];
    const learned = data.memories.filter((memory) => memory.turn_id === turn.id);
    const closeHref = hashFor("timeline", session ? { session: session.id } : {});
    const actionList = actions.length ? `<span class="section-label">Actions (${actions.length})</span><ul class="actions">${actions.map((action) => `<li><header><b>${h(action.tool ?? "tool")}</b>${action.category ? tag(action.category) : ""}${action.failed ? tag(action.resolved ? "failed, fixed later" : "failed", action.resolved ? "warn" : "bad") : ""}${action.external ? tag("external content", "warn") : ""}${action.exit_code !== null && action.exit_code !== undefined ? `<span class="mono">exit ${h(action.exit_code)}</span>` : ""}</header>${action.command || action.input ? `<code>${h(action.command || action.input)}</code>` : ""}${action.error_line ? `<code class="error-line">${h(action.error_line)}</code>` : ""}</li>`).join("")}</ul>` : "";
    return `<aside class="detail ${h(turn.outcome)}" aria-label="Turn detail">
<header><h2>T${turn.id} · ${h(outcomeLabel(turn.outcome))}</h2><a class="round-button" href="${closeHref}" aria-label="Close turn detail">${icon("close", 16)}</a></header>
<div class="pill-group">${tag(projectName(turn.project_id))}${session ? tag(harnessLabel(session.harness)) : ""}${session?.branch ? tag(session.branch, "mono") : ""}${tag(`trust ${turn.trust}`)}</div>
<dl class="facts"><dt>Started</dt><dd>${h(full(turn.started_at))}</dd><dt>Ended</dt><dd>${h(turn.ended_at ? full(turn.ended_at) : "still open")}</dd><dt>Importance</dt><dd>${h(Number(turn.importance).toFixed(2))}</dd></dl>
<div class="copy-list">${copyable(`agent-mem show T${turn.id}`)}</div>
<span class="section-label">Request</span><div class="text-box">${h(request(turn.prompt) || "(no request text)")}</div>
${actionList}
${turn.answer ? `<span class="section-label">Result</span><div class="text-box">${h(turn.answer)}</div>` : ""}
${turn.truncated ? `<p class="notice"><span>Long text is shortened on this page. <code>agent-mem show T${turn.id}</code> prints more.</span></p>` : ""}
${turn.files.length ? `<span class="section-label">Files</span><div class="file-list">${turn.files.map((file) => tag(file, "mono")).join("")}</div>` : ""}
${turn.errors.length ? `<span class="section-label">Errors</span><ul class="actions">${turn.errors.map((error) => `<li><code class="error-line">${h(error)}</code></li>`).join("")}</ul>` : ""}
${learned.length ? `<span class="section-label">Learned from this turn</span><ul class="actions">${learned.map((memory) => `<li><header>${tag(readable(memory.kind), `kind-${memory.kind}`)}<a href="${hashFor("memory", { m: String(memory.id) })}"><b>M${memory.id}</b></a></header>${h(memoryText(memory))}</li>`).join("")}</ul>` : ""}
<span class="notice">${icon("lock", 16)}Captured text is untrusted and shown as stored. Secrets were redacted at capture.</span>
</aside>`;
  }

  /* ---------------------------------------------------------------- memories */

  function memoryView() {
    const all = memories();
    const pool = all.filter((memory) => state.invalid || !memory.invalid_at);
    const counts = new Map(MEMORY_KINDS.map((kind) => [kind, pool.filter((memory) => memory.kind === kind).length]));
    const shown = pool.filter((memory) => (state.kind === "all" || memory.kind === state.kind) && matches([memory.title, memory.body, memory.kind, memory.origin, `M${memory.id}`]));
    const pills = `<div class="pill-group" role="group" aria-label="Filter by kind"><button type="button" class="pill" data-action="kind" data-value="all" aria-pressed="${state.kind === "all"}">All ${num(pool.length)}</button>${MEMORY_KINDS.filter((kind) => counts.get(kind)).map((kind) => `<button type="button" class="pill" data-action="kind" data-value="${kind}" aria-pressed="${state.kind === kind}">${h(readable(kind))} ${num(counts.get(kind))}</button>`).join("")}<button type="button" class="pill" data-action="invalid" aria-pressed="${state.invalid}">Show replaced</button></div>`;
    const cards = shown.map((memory) => {
      const usage = memory.shown ? `used ${num(memory.used)} of ${num(memory.shown)} shown` : memory.used ? `used ${num(memory.used)}×` : "not used yet";
      const text = memoryText(memory);
      const extra = memory.body && !text.startsWith(memory.body.trim()) && memory.body.trim() !== memory.title.trim() ? memory.body : "";
      return `<article class="memory-card${memory.invalid_at ? " invalid" : ""}${String(memory.id) === state.memory ? " is-selected" : ""}"><header>${tag(readable(memory.kind), `kind-${memory.kind}`)}<b>M${memory.id}</b><span class="muted">${h(when(memory.created_at))}</span></header><h3><a class="card-link" href="${hashFor("memory", { m: String(memory.id) })}">${inline(text)}</a></h3>${extra ? `<p>${h(extra)}</p>` : ""}
<div class="meter" title="Rises when agents use this memory, fades when they do not"><span>relevance</span><span class="track"><i style="width:${Math.round(memory.activation * 100)}%"></i></span></div>
<footer>${projectTag(memory.project_id)}${tag(usage)}${memory.turn_id ? `<a class="tag" href="${hashFor("timeline", { turn: String(memory.turn_id) })}">from T${memory.turn_id}</a>` : ""}${memory.invalid_at ? tag(memory.superseded_by ? `replaced by M${memory.superseded_by}` : `invalid since ${dayLabel(dayKey(memory.invalid_at))}`, "warn") : ""}</footer></article>`;
    }).join("");
    const selected = state.memory === undefined ? undefined : data.memories.find((memory) => String(memory.id) === state.memory);
    return `<div class="page-head"><div><h1>Memories</h1><p class="lede">What your agents should keep in mind: decisions, facts, preferences and things that did not work. Memories that get used rank higher. Open one to see where it came from or to delete it.</p></div></div>
${pills}
<div class="${selected ? "with-detail" : ""}">
<div>${cards ? `<div class="cards">${cards}</div>` : empty(all.length ? "No memories match" : "No memories yet", all.length ? "Try another search or kind." : "Agents write them with the <code>mem_remember</code> MCP tool; hooks add decisions, corrections and dead ends.")}
${limitReached(data.memories, "memories") ? `<p class="muted">This page holds the latest ${num(data.limits.memories)} memories. <code>agent-mem search</code> finds older ones.</p>` : ""}</div>
${selected ? memoryDetail(selected) : ""}
</div>`;
  }

  // Observer facts store the first 120 characters of the body as title; show the whole sentence instead of the cut.
  const memoryText = (memory) => {
    const title = String(memory.title ?? "").trim();
    const body = String(memory.body ?? "").trim();
    return body.length > title.length && body.startsWith(title) ? body : title;
  };

  function memoryDetail(memory) {
    const id = `M${memory.id}`;
    const successor = memory.superseded_by ? data.memories.find((item) => item.id === memory.superseded_by) : undefined;
    const usage = memory.shown ? `used ${num(memory.used)} of ${num(memory.shown)} times shown` : memory.used ? `used ${num(memory.used)}×` : "not used yet";
    return `<aside class="detail memory-detail kind-${h(memory.kind)}" aria-label="Memory detail">
<header><h2>${id} · ${h(readable(memory.kind))}</h2><a class="round-button" href="${hashFor("memory")}" aria-label="Close memory detail">${icon("close", 16)}</a></header>
<div class="pill-group">${tag(projectName(memory.project_id))}${tag(memory.source)}${memory.origin ? tag(memory.origin) : ""}${tag(`trust ${memory.trust}`)}${memory.invalid_at ? tag("replaced", "warn") : ""}</div>
<div class="text-box">${inline(memoryText(memory))}${memory.body && !memoryText(memory).startsWith(memory.body.trim()) && memory.body.trim() !== memory.title.trim() ? `\n\n${h(memory.body)}` : ""}</div>
${memory.truncated ? `<p class="notice"><span>Long text is shortened on this page. <code>agent-mem show ${id}</code> prints all of it.</span></p>` : ""}
<dl class="facts"><dt>Created</dt><dd>${h(full(memory.created_at))}</dd><dt>Valid from</dt><dd>${h(full(memory.valid_from))}</dd>${memory.invalid_at ? `<dt>Invalid since</dt><dd>${h(full(memory.invalid_at))}</dd>` : ""}${memory.superseded_by ? `<dt>Replaced by</dt><dd>${successor ? `<a href="${hashFor("memory", { m: String(successor.id) })}">M${successor.id}</a> ${h(firstLine(memoryText(successor), 80))}` : `M${h(memory.superseded_by)}`}</dd>` : ""}<dt>Importance</dt><dd>${h(Number(memory.importance ?? 0).toFixed(2))}</dd><dt>Activation</dt><dd>${h(Math.round(memory.activation * 100))}%</dd><dt>Recall</dt><dd>${h(usage)}</dd>${memory.turn_id ? `<dt>From turn</dt><dd><a href="${hashFor("timeline", { turn: String(memory.turn_id) })}">T${memory.turn_id}</a></dd>` : ""}</dl>
<span class="section-label">Commands</span>
<div class="copy-list">${copyable(`agent-mem show ${id}`)}${copyable(`agent-mem purge --id ${id}`)}</div>
<p class="notice">${icon("lock", 16)}<span>Purge deletes the memory with its search keys and vectors and removes this page. An agent can do the same with the <code>mem_forget</code> tool.</span></p>
</aside>`;
  }

  /* ---------------------------------------------------------------- learned */

  function learnedView() {
    const rules = data.rules.filter((rule) => inProjectOrGlobal(rule.project_id) && matches([rule.pattern, rule.message]));
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
    return `<div class="page-head"><div><h1>Learned</h1><p class="lede">What agent-mem worked out by watching: rules from your corrections, fixes for errors, and the commands you use most. No AI model is involved.</p></div></div>
<section class="panel"><div class="panel-head"><h2>Rules</h2><small>Proposed rules only warn. Enabled rules can block a command.</small></div>${ruleRows ? `<div class="table-wrap"><table><thead><tr><th>Id</th><th>Rule</th><th>State</th><th>Evidence</th><th>Hits</th><th>Overrides</th><th>Project</th><th>Change with</th></tr></thead><tbody>${ruleRows}</tbody></table></div>` : empty("No rules yet", "Say “pnpm instead of npm” a few times and a rule is proposed.")}</section>
<div class="halves">
<section class="panel"><div class="panel-head"><h2>Error fixes</h2><small>a command failed, files were changed, then it passed</small></div>${recipeRows || empty("No fixes learned yet", "They appear after a failing command passes again in the same session.")}</section>
<section class="panel"><div class="panel-head"><h2>Preferences</h2><small>most used first</small></div>${profileRows || empty("No preferences yet", "Repeated choices such as package managers or test commands show up here.")}</section>
</div>`;
  }

  /* ---------------------------------------------------------------- graph */

  function graphView() {
    const nodes = data.graph.nodes.filter((node) => inProjectOrGlobal(node.project_id));
    const count = (kind) => nodes.filter((node) => node.kind === kind).length;
    const swatch = (kind) => `<i style="background:var(${ENTITY_COLOR[kind]})"></i>`;
    return `<div class="page-head"><div><h1>Connections</h1><p class="lede">Files, commands and errors that came up in the same request. Bigger dots come up more often. Click a dot to see what belongs with it.</p></div>
<div class="pill-group" role="group" aria-label="Show entity kinds">${ENTITY_KINDS.filter((kind) => count(kind)).map((kind) => `<button type="button" class="pill" data-action="entity-kind" data-value="${kind}" aria-pressed="${!state.hiddenKinds.has(kind)}">${h(kind)}s ${num(count(kind))}</button>`).join("")}</div></div>
<div class="graph-layout">
<section class="graph-stage" aria-label="Graph canvas"><div id="graph-host" class="graph-host"></div>
<div class="graph-controls"><button type="button" class="round-button" data-action="zoom" data-value="out" aria-label="Zoom out">${icon("minus", 18)}</button><button type="button" class="round-button" data-action="zoom" data-value="fit" aria-label="Fit graph">${icon("fit", 18)}</button><button type="button" class="round-button" data-action="zoom" data-value="in" aria-label="Zoom in">${icon("plus", 18)}</button></div>
<span class="graph-hint">Drag to move · scroll to zoom · F to fit · Esc to clear</span></section>
<div class="stack"><aside id="graph-inspector" class="inspector" aria-live="polite"></aside>
<section class="panel"><div class="panel-head"><h3>Legend</h3></div><div class="legend">${ENTITY_KINDS.map((kind) => `<span>${swatch(kind)}${h(kind)}</span>`).join("")}</div>${limitReached(data.graph.nodes, "graph_nodes") ? `<p class="muted" style="margin-top:12px;font-size:13px">Showing the ${num(data.limits.graph_nodes)} most connected of ${num(data.counts.entities)} things.</p>` : ""}</section></div>
</div>`;
  }

  function createGraph(host, inspector, sourceNodes, sourceEdges) {
    const describe = (node) => {
      if (!node) {
        inspector.innerHTML = `<span class="kicker">Connections</span><h2>How your work connects</h2><p>Click a dot to see what comes up with it most often.</p><div class="stats">${stat(num(nodes.length), "things")}${stat(num(edges.length), "links")}</div>`;
        return;
      }
      const links = edges.filter((edge) => edge.a === node.id || edge.b === node.id).sort((x, y) => y.weight - x.weight).slice(0, 8);
      inspector.innerHTML = `<span class="kicker">${h(node.kind)}</span><h2>${h(entityLabel(node))}</h2><div class="stats">${stat(num(node.degree), "links")}${stat(Number(node.strength).toFixed(2), "strength")}${stat(projectName(node.project_id), "project")}</div>${links.length ? `<span class="kicker">Occurs with</span><ul>${links.map((edge) => { const other = byId.get(edge.a === node.id ? edge.b : edge.a); return other ? `<li><i style="background:var(${ENTITY_COLOR[other.kind]})"></i><span>${h(entityLabel(other))}</span><span class="mono" style="margin-left:auto">${Number(edge.weight).toFixed(2)}</span></li>` : ""; }).join("")}</ul>` : ""}`;
    };
    const nodes = sourceNodes.map((node, index) => {
      const angle = index * 2.3999632297; const radius = 40 + Math.sqrt(index) * 38;
      return { ...node, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0, r: 6 + Math.min(14, Math.sqrt(node.degree) * 2.4) };
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    // Label only the strongest nodes; the rest get a label on hover, selection, search or zoom.
    const labelled = new Set([...nodes].sort((a, b) => b.strength - a.strength).slice(0, 40).map((node) => node.id));
    const rank = new Map([...nodes].sort((a, b) => b.strength - a.strength).map((node, index) => [node.id, index]));
    // On the canvas a command reads by what it runs: drop a leading `cd … &&` and `VAR=…` settings, fold heredoc scripts. The side panel keeps the full text.
    const commandCore = (text) => text.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, "").replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)(\s*;\s*|\s+))+/, "").replace(/\s+-?\s*<<-?\s*['"]?\w+['"]?[\s\S]*$/, " (script)").trim() || text;
    const shortLabel = (node) => { const label = node.kind === "command" ? commandCore(entityLabel(node)) : entityLabel(node); if (label.length <= 34) return label; return node.kind === "file" ? `…${label.slice(-33)}` : `${label.slice(0, 33)}…`; };
    const edges = sourceEdges.filter((edge) => byId.has(edge.a) && byId.has(edge.b));
    if (nodes.length === 0) {
      host.innerHTML = `<div class="graph-empty">No associations yet. They form when files, commands and errors occur in the same turn.</div>`;
      describe(undefined);
      return { zoomBy() {}, reset() {}, setQuery() {}, setHidden() {}, destroy() {} };
    }
    host.innerHTML = `<canvas tabindex="0" role="img" aria-label="Connections: ${nodes.length} files, commands and errors with ${edges.length} links. Drag to pan, scroll to zoom, press F to fit."></canvas>`;
    const canvas = host.querySelector("canvas");
    const context = canvas.getContext("2d");
    const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    const view = { x: 0, y: 0, scale: 1 };
    let width = 0, height = 0, raf = 0, alpha = 1, query = "", hidden = new Set(), selected, hover, drag, pointer, lastX = 0, lastY = 0, moved = 0;
    const shown = (node) => !hidden.has(node.kind);
    const hit = (node) => { const needle = query.trim().toLocaleLowerCase(); return needle === "" || node.key.toLocaleLowerCase().includes(needle); };
    const screen = (node) => ({ x: (node.x - view.x) * view.scale + width / 2, y: (node.y - view.y) * view.scale + height / 2 });
    const world = (cx, cy) => { const rect = canvas.getBoundingClientRect(); return { x: (cx - rect.left - width / 2) / view.scale + view.x, y: (cy - rect.top - height / 2) / view.scale + view.y }; };
    const at = (cx, cy) => { const p = world(cx, cy); for (let i = nodes.length - 1; i >= 0; i -= 1) { const n = nodes[i]; if (!shown(n)) continue; const reach = n.r + 6 / view.scale; if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= reach * reach) return n; } return undefined; };
    const draw = () => {
      const ink = css("--ink", "#1A1814");
      context.clearRect(0, 0, width, height);
      context.fillStyle = css("--graph-bg", "#F8F4EA"); context.fillRect(0, 0, width, height);
      const step = 22; const ox = ((-view.x * view.scale + width / 2) % step + step) % step; const oy = ((-view.y * view.scale + height / 2) % step + step) % step;
      context.fillStyle = css("--graph-dot", "rgba(26,24,20,.13)");
      for (let x = ox; x < width; x += step) for (let y = oy; y < height; y += step) context.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      const focus = selected ?? hover;
      const near = new Set(focus ? edges.flatMap((e) => (e.a === focus.id ? [e.b] : e.b === focus.id ? [e.a] : [])) : []);
      context.lineCap = "round";
      for (const edge of edges) {
        const a = byId.get(edge.a), b = byId.get(edge.b);
        if (!shown(a) || !shown(b)) continue;
        const pa = screen(a), pb = screen(b);
        const hot = focus && (edge.a === focus.id || edge.b === focus.id);
        context.globalAlpha = !(hit(a) && hit(b)) ? 0.05 : focus ? (hot ? 0.9 : 0.08) : 0.12 + edge.weight * 0.5;
        context.strokeStyle = ink; context.lineWidth = 0.6 + edge.weight * (hot ? 3.5 : 2.5);
        context.beginPath(); context.moveTo(pa.x, pa.y); context.lineTo(pb.x, pb.y); context.stroke();
      }
      const labels = [];
      for (const node of nodes) {
        if (!shown(node)) continue;
        const p = screen(node); const active = !focus || node === focus || near.has(node.id); const r = Math.max(3.5, node.r * view.scale);
        context.globalAlpha = !hit(node) ? 0.1 : active ? 1 : 0.2;
        context.fillStyle = css(ENTITY_COLOR[node.kind], "#AFC1F0"); context.strokeStyle = ink; context.lineWidth = 1.5;
        context.beginPath(); context.arc(p.x, p.y, r, 0, Math.PI * 2); context.fill(); context.stroke();
        if (node === selected) { context.globalAlpha = 0.18; context.lineWidth = 6; context.beginPath(); context.arc(p.x, p.y, r + 7, 0, Math.PI * 2); context.stroke(); }
        const searching = query.trim() !== "";
        const named = focus ? node === focus || near.has(node.id) : searching || nodes.length <= 40 || labelled.has(node.id) || view.scale > 1.8;
        if (named && hit(node)) labels.push({ node, p, r, active, priority: node === focus ? -1 : rank.get(node.id) });
      }
      // Labels last, most important first; a label that would overlap one already drawn is skipped.
      const placed = [];
      for (const { node, p, r, active } of labels.sort((a, b) => a.priority - b.priority)) {
        const text = shortLabel(node);
        context.font = `${node === selected ? 700 : 600} 12px ${css("--sans", "sans-serif")}`;
        const w = context.measureText(text).width; const x = p.x + r + 8;
        const box = { x: x - 4, y: p.y - 10, w: w + 8, h: 19 };
        if (node !== focus && placed.some((o) => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h)) continue;
        placed.push(box);
        context.fillStyle = css("--graph-bg", "#F8F4EA"); context.globalAlpha = (active ? 1 : 0.3) * 0.85; context.fillRect(box.x, box.y, box.w, box.h);
        context.globalAlpha = active ? 1 : 0.3; context.fillStyle = ink; context.fillText(text, x, p.y + 4);
      }
      context.globalAlpha = 1;
    };
    const tick = () => {
      raf = 0;
      if (alpha > 0.02) {
        for (let i = 0; i < nodes.length; i += 1) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j += 1) {
            const b = nodes[j]; let dx = b.x - a.x, dy = b.y - a.y; const d2 = Math.max(dx * dx + dy * dy, 64); const d = Math.sqrt(d2); const f = 1800 / d2; dx /= d; dy /= d;
            if (drag !== a) { a.vx -= dx * f * alpha; a.vy -= dy * f * alpha; }
            if (drag !== b) { b.vx += dx * f * alpha; b.vy += dy * f * alpha; }
          }
          if (drag !== a) { a.vx -= a.x * 0.002 * alpha; a.vy -= a.y * 0.002 * alpha; }
        }
        for (const edge of edges) {
          const a = byId.get(edge.a), b = byId.get(edge.b); const dx = b.x - a.x, dy = b.y - a.y; const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const f = (d - (140 - edge.weight * 70)) * 0.01 * (0.4 + edge.weight) * alpha;
          if (drag !== a) { a.vx += dx / d * f; a.vy += dy / d * f; }
          if (drag !== b) { b.vx -= dx / d * f; b.vy -= dy / d * f; }
        }
        for (const node of nodes) { if (drag === node) continue; node.vx = Math.max(-10, Math.min(10, node.vx)) * 0.85; node.vy = Math.max(-10, Math.min(10, node.vy)) * 0.85; node.x += node.vx; node.y += node.vy; }
        alpha *= 0.985;
      }
      draw();
      if (alpha > 0.02) raf = requestAnimationFrame(tick);
    };
    const wake = () => { alpha = Math.max(alpha, 0.3); if (!raf) raf = requestAnimationFrame(tick); };
    const select = (node) => { selected = node; describe(node); draw(); };
    const resize = () => { width = host.clientWidth; height = host.clientHeight; const ratio = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.max(1, Math.floor(width * ratio)); canvas.height = Math.max(1, Math.floor(height * ratio)); context.setTransform(ratio, 0, 0, ratio, 0, 0); draw(); };
    const fit = () => { const list = nodes.filter(shown); if (!list.length) return; const xs = list.map((n) => n.x), ys = list.map((n) => n.y); const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys); view.x = (minX + maxX) / 2; view.y = (minY + maxY) / 2; view.scale = Math.min(2.2, Math.max(0.18, Math.min(width / (Math.max(maxX - minX, 160) + 220), height / (Math.max(maxY - minY, 160) + 220)))); draw(); };
    const zoom = (factor, ox = 0, oy = 0) => { const next = Math.min(3, Math.max(0.15, view.scale * factor)); view.x += ox / view.scale - ox / next; view.y += oy / view.scale - oy / next; view.scale = next; draw(); };
    const down = (e) => { const rect = canvas.getBoundingClientRect(); pointer = e.pointerId; drag = at(e.clientX, e.clientY); moved = 0; lastX = e.clientX - rect.left; lastY = e.clientY - rect.top; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; };
    const move = (e) => {
      if (pointer === undefined) { const node = at(e.clientX, e.clientY); if (node !== hover) { hover = node; canvas.style.cursor = node ? "pointer" : "grab"; draw(); } return; }
      const rect = canvas.getBoundingClientRect(); const dx = e.clientX - rect.left - lastX, dy = e.clientY - rect.top - lastY; moved += Math.abs(dx) + Math.abs(dy);
      if (drag) { const p = world(e.clientX, e.clientY); drag.x = p.x; drag.y = p.y; wake(); } else { view.x -= dx / view.scale; view.y -= dy / view.scale; draw(); }
      lastX = e.clientX - rect.left; lastY = e.clientY - rect.top;
    };
    const up = (e) => { if (e.pointerId !== pointer) return; if (moved < 5) select(at(e.clientX, e.clientY)); pointer = undefined; drag = undefined; canvas.style.cursor = "grab"; };
    const leave = () => { if (pointer === undefined && hover) { hover = undefined; draw(); } };
    const wheel = (e) => { e.preventDefault(); const rect = canvas.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left - width / 2, e.clientY - rect.top - height / 2); };
    const key = (e) => { if (e.key === "f" || e.key === "F") fit(); else if (e.key === "+" || e.key === "=") zoom(1.15); else if (e.key === "-" || e.key === "_") zoom(1 / 1.15); else if (e.key === "Escape") select(undefined); else return; e.preventDefault(); };
    const scheme = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up); canvas.addEventListener("pointerleave", leave); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    scheme?.addEventListener?.("change", draw);
    observer?.observe(host);
    resize(); fit(); describe(undefined); wake();
    // Fit once more after the layout settles so the graph fills the stage.
    setTimeout(fit, 1200);
    return {
      zoomBy: (factor) => zoom(factor),
      reset: () => { select(undefined); fit(); },
      setQuery: (next) => { query = next; draw(); },
      setHidden: (kinds) => { hidden = new Set(kinds); if (selected && !shown(selected)) select(undefined); draw(); },
      destroy: () => { if (raf) cancelAnimationFrame(raf); observer?.disconnect(); scheme?.removeEventListener?.("change", draw); },
    };
  }

  /* ---------------------------------------------------------------- health */

  function healthView() {
    const health = data.health;
    const paused = Boolean(health.paused_until);
    const backupHours = date(health.last_backup_at) ? (Date.now() - date(health.last_backup_at).getTime()) / 36e5 : Infinity;
    const components = Object.entries(health.components ?? {}).filter(([name]) => matches([name, componentLabel(name)])).sort(([a], [b]) => a.localeCompare(b));
    const rows = components.map(([name, info]) => {
      const failing = info.last_error_at && (!info.last_ok_at || info.last_error_at > info.last_ok_at);
      return `<tr><td><i class="dot ${failing ? "bad" : "good"}" style="display:inline-block;margin-right:8px"></i><b>${h(componentLabel(name))}</b></td><td>${h(info.last_ok_at ? when(info.last_ok_at) : "never")}</td><td class="num">${num(info.ok_count)}</td><td class="num">${num(info.error_count)}</td><td>${info.last_error ? `<code>${h(firstLine(info.last_error, 160))}</code>` : '<span class="muted">—</span>'}</td></tr>`;
    }).join("");
    const semantic = String(health.semantic ?? "not indexed yet");
    return `<div class="page-head"><div><h1>Health &amp; privacy</h1><p class="lede">Is everything working? Green means yes. This is the state when the page was written; <code>agent-mem doctor</code> checks it right now.</p></div></div>
<div class="state-grid">
<section class="block ${paused ? "block-yellow" : "block-green"}"><i class="block-deco deco-triangle"></i><h2>Capture</h2><div class="big-number"><b>${paused ? "Paused" : "Active"}</b></div><span class="caption">${paused ? "Resume with <code>agent-mem resume</code>" : "Pause with <code>agent-mem pause --for 1h</code>"}</span></section>
<section class="block block-blue"><h2>Meaning search</h2><div class="big-number"><b>${semantic === "unavailable" || semantic === "not indexed yet" ? "Off" : "On"}</b></div><span class="caption">${semantic === "unavailable" || semantic === "not indexed yet" ? "Word search works. For search by meaning run <code>agent-mem models install</code>." : `Finds memories with other words, too. Model: ${h(semantic.split("/").pop())}`}</span></section>
<section class="block ${backupHours < 72 ? "block-pink" : "block-coral"}"><h2>Backup</h2><div class="big-number"><b style="font-size:26px">${h(ago(health.last_backup_at))}</b></div><span class="caption">${backupHours < 72 ? "Daily backups are kept in the data directory." : "Run <code>agent-mem backup</code>."}</span></section>
<section class="block block-yellow"><h2>Cleanup</h2><div class="big-number"><b style="font-size:26px">${h(ago(health.consolidated_at))}</b></div><span class="caption">Merges duplicates and retires outdated facts.</span></section>
</div>
<div class="columns">
<section class="panel"><div class="panel-head"><h2>Running parts</h2><small>green = working</small></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Part</th><th>Last worked</th><th>Runs</th><th>Errors</th><th>Last error</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty("Nothing has run yet", "Hooks report here after the first captured session.")}</section>
<div class="stack">
<section class="panel"><div class="panel-head"><h2>Storage</h2></div>
<div class="row"><b>Database</b><span class="value">${h(health.db_mb)} MB · schema v${h(health.schema)}</span></div>
<div class="row"><b>Waiting to be saved</b><span class="value">${plural(health.spool, "event")}</span></div>
<div class="row"><b>Could not be read</b><span class="value">${plural(health.quarantine, "file")}</span></div>
<div class="row"><b>Data directory</b><span class="value"><code>${h(health.data_dir)}</code></span></div></section>
<section class="panel"><div class="panel-head"><h2>Privacy</h2></div>
<div class="row"><span class="grow wrap"><b>Not encrypted at rest</b><span>Anyone who can read the data directory or its backups can read your memory.</span></span></div>
<div class="row"><span class="grow wrap"><b>This page is a local file</b><span>It holds a copy of recent data and makes no network requests. <code>agent-mem purge</code> deletes it too, unless you wrote it elsewhere with <code>--output</code>.</span></span></div>
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
    graphController?.destroy();
    graphController = null;
    view.innerHTML = { overview: overviewView, timeline: timelineView, memory: memoryView, learned: learnedView, graph: graphView, health: healthView }[state.view]();
    if (state.view === "graph") {
      const nodes = data.graph.nodes.filter((node) => inProjectOrGlobal(node.project_id));
      graphController = createGraph(document.getElementById("graph-host"), document.getElementById("graph-inspector"), nodes, data.graph.edges);
      graphController.setHidden(state.hiddenKinds);
      graphController.setQuery(state.query);
    }
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
    if (action === "entity-kind") {
      if (state.hiddenKinds.has(value)) state.hiddenKinds.delete(value); else state.hiddenKinds.add(value);
      target.setAttribute("aria-pressed", String(!state.hiddenKinds.has(value)));
      graphController?.setHidden(state.hiddenKinds);
      return;
    }
    if (action === "zoom" && graphController) {
      if (value === "in") graphController.zoomBy(1.2); else if (value === "out") graphController.zoomBy(1 / 1.2); else graphController.reset();
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target.id !== "project-select") return;
    state.project = event.target.value; state.session = undefined; renderChrome(); renderView();
  });
  let timer;
  document.addEventListener("input", (event) => {
    if (event.target.id !== "search") return;
    state.query = event.target.value;
    if (state.view === "graph") { graphController?.setQuery(state.query); return; }
    clearTimeout(timer);
    timer = setTimeout(renderView, 120);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.view !== "graph" && (state.memory !== undefined || state.turn !== undefined) && !event.target.closest?.("input")) {
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
    Object.assign(state, { query: saved.query ?? "", project: saved.project ?? state.project, outcome: saved.outcome ?? "all", kind: saved.kind ?? "all", invalid: Boolean(saved.invalid), hiddenKinds: new Set(saved.hiddenKinds ?? []) });
    if (state.project !== "all" && !data.projects.some((project) => project.id === state.project)) state.project = "all";
    return Number(saved.scroll) || 0;
  };
  // Reload to pick up the rewritten file, but never while the reader is active, typing, selecting text or in the graph.
  const reloadWhenIdle = () => {
    const active = document.activeElement;
    const busy = document.hidden || state.view === "graph" || Date.now() - lastActivity < 8000 || (active && (active.tagName === "INPUT" || active.tagName === "SELECT")) || String(getSelection?.() ?? "") !== "";
    if (busy) return;
    try { sessionStorage.setItem(SAVED, JSON.stringify({ query: state.query, project: state.project, outcome: state.outcome, kind: state.kind, invalid: state.invalid, hiddenKinds: [...state.hiddenKinds], scroll: window.scrollY })); } catch { /* storage off: reload without state */ }
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
