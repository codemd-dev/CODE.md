#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const SERVER_VERSION = '0.0.24';
const PROTOCOL_VERSION = '2024-11-05';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : '';
}

const SERVER_NAME = argValue('--server-name') || 'codemd';
const SERVER_INSTRUCTIONS = [
  `${SERVER_NAME} — cached static-analysis index (callgraph, impact radius, repo docs) over this workspace's .codemd/ artifacts.`,
  'Reach for it BEFORE and WHILE writing or editing code, not only when asked to explore:',
  '- Before editing or removing a function/route/component, call codemd_get_impact_radius (or the cheaper codemd_get_callers / codemd_get_callees) on it to see what calls it or what it calls, including dynamic-dispatch edges plain grep misses.',
  '- Before tracing how two symbols connect, call codemd_get_call_paths instead of manually following calls by hand.',
  '- To find likely symbol names before reading many files, call codemd_search_artifacts.',
  '- For a repository overview, call codemd_read_artifact (defaults to CODE.md).',
  'These artifacts are generated static analysis: some edges are regex-inferred rather than AST-resolved, and content can go stale if source changed since generation. Treat results as a fast lead, and verify against the actual source file before finalizing a change.',
].join('\n');
const workspaceRoot = path.resolve(argValue('--workspace') || process.env.CODEMD_WORKSPACE || process.cwd());
const artifactRoot = path.join(workspaceRoot, '.codemd');
const usagePath = path.join(artifactRoot, '.mcp-usage.json');
const RESOURCE_SCHEME = 'codemd';

// ---------------------------------------------------------------------------
// Freshness coordinator — mirrors CodeGraph's own daemon+lock pattern so this
// server can refresh .codemd/ on its own, without the VS Code extension
// needing to be running. Any client (Claude Code, Codex, VS Code, ...) spawns
// its own copy of this script, so multiple copies can race to re-analyze at
// once; a pidfile lock under .codemd/ ensures only one of them actually runs
// local-analyze.py at a time, and the rest just keep serving whatever's on
// disk. local-analyze.py already no-ops quickly when it finds no source
// changes ("Reusing cached local-path analysis"), so holding the lock only
// for the duration of one run is enough — no separate staleness heuristic is
// needed here, we just let local-analyze.py decide.
//
// This deliberately does NOT bootstrap a Python environment (creating a venv
// and pip-installing the analyzer's dependencies is slow, network-dependent,
// and out of scope for a lazy per-tool-call refresh). It only uses a venv the
// VS Code extension already provisioned, or a system python/python3/py -3 on
// PATH. If neither is available, refresh is skipped silently and the server
// just serves whatever is already in .codemd/ (same as before this change).
// ---------------------------------------------------------------------------

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const DAEMON_LOCK_PATH = path.join(artifactRoot, '.mcp-daemon.lock');
const DAEMON_LOG_PATH = path.join(artifactRoot, '.mcp-daemon.log');
const REFRESH_STATE_PATH = path.join(artifactRoot, '.mcp-refresh-state.json');
// Rebuilding is now cheap when nothing in a given language changed (the
// per-extension mtime filtering in backend/main.py), but a burst of tool
// calls during active editing would still mean re-invoking local-analyze.py
// (a fresh python process + a full walk of the source tree) on every single
// call. This cooldown caps how often we even attempt a refresh, so rapid-fire
// tool calls between edits don't each pay that cost — freshness becomes "at
// most once per cooldown window" instead of "once per tool call." Shared via
// a file (not an in-memory flag) since separate clients (Claude Code, Codex,
// VS Code) each spawn their own copy of this process.
const REFRESH_COOLDOWN_MS = 2 * 60 * 1000;
let refreshInFlight = false;

function cooldownActive() {
  try {
    const state = JSON.parse(fs.readFileSync(REFRESH_STATE_PATH, 'utf8'));
    return Date.now() - Number(state.lastAttemptAt || 0) < REFRESH_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function recordRefreshAttempt() {
  try {
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(REFRESH_STATE_PATH, JSON.stringify({ lastAttemptAt: Date.now() }));
  } catch {
    // Best-effort — worst case we just refresh a bit more often than intended.
  }
}

function daemonLog(line) {
  try {
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.appendFileSync(DAEMON_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Best-effort only — never let logging break the refresh path.
  }
}

// Same globalStorage convention VS Code uses for context.globalStorageUri,
// replicated here since this script has no `vscode` module to ask directly.
function vscodeGlobalStorageDir() {
  const home = os.homedir();
  const EXT_ID = 'codeval.codeval-codemd-graphs';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage', EXT_ID);
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', EXT_ID);
  }
  return path.join(home, '.config', 'Code', 'User', 'globalStorage', EXT_ID);
}

function candidateSystemPythons() {
  return process.platform === 'win32'
    ? [{ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
}

function resolvePython() {
  const venvPython = process.platform === 'win32'
    ? path.join(vscodeGlobalStorageDir(), 'venv', 'Scripts', 'python.exe')
    : path.join(vscodeGlobalStorageDir(), 'venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return { cmd: venvPython, args: [] };
  }
  for (const candidate of candidateSystemPythons()) {
    try {
      const result = spawnSync(candidate.cmd, [...candidate.args, '--version'], { timeout: 5000 });
      if (result.status === 0) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// Exclusive-create the lock file; on EEXIST, reclaim it only if its owning
// PID is no longer alive (crashed holder), otherwise another live process
// already owns the refresh.
function acquireDaemonLock() {
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  try {
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(DAEMON_LOCK_PATH, payload, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') {
      return false;
    }
  }
  try {
    const existing = JSON.parse(fs.readFileSync(DAEMON_LOCK_PATH, 'utf8'));
    process.kill(existing.pid, 0); // throws if that PID isn't running
    return false;
  } catch {
    // Stale lock (owner gone, or unreadable) — reclaim it.
    try {
      fs.writeFileSync(DAEMON_LOCK_PATH, payload);
      return true;
    } catch {
      return false;
    }
  }
}

function releaseDaemonLock() {
  try {
    const existing = JSON.parse(fs.readFileSync(DAEMON_LOCK_PATH, 'utf8'));
    if (existing.pid === process.pid) {
      fs.unlinkSync(DAEMON_LOCK_PATH);
    }
  } catch {
    // Already gone — nothing to do.
  }
}

// Fire-and-forget: kicks off a re-analysis if nothing else is already doing
// one, and returns immediately without blocking whatever tool call triggered
// it. Freshness is eventually-consistent, same as CodeGraph's own "index lags
// writes by ~1s" behavior — callers see current on-disk artifacts now, and
// more current ones on their next call.
function refreshArtifactsInBackground() {
  if (refreshInFlight) {
    return;
  }
  if (cooldownActive()) {
    return;
  }
  const python = resolvePython();
  if (!python) {
    return;
  }
  const scriptPath = path.join(EXTENSION_ROOT, 'scripts', 'local-analyze.py');
  const backendDir = path.join(EXTENSION_ROOT, 'backend');
  if (!fs.existsSync(scriptPath) || !fs.existsSync(path.join(backendDir, 'main.py'))) {
    return;
  }
  if (!acquireDaemonLock()) {
    return;
  }
  recordRefreshAttempt();

  refreshInFlight = true;
  const args = [
    ...python.args,
    scriptPath,
    '--path', workspaceRoot,
    '--name', path.basename(workspaceRoot),
    '--mirror-out', artifactRoot,
    '--result-json', path.join(artifactRoot, '.analysis-result.json'),
  ];
  const env = {
    ...process.env,
    CODEVAL_OUTPUT_DIR: path.join(vscodeGlobalStorageDir(), 'backend-output'),
    SENTRY_ENABLED: 'false',
    SENTRY_DSN: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    GOOGLE_ANALYTICS_CLIENT_ID: '',
    GOOGLE_ANALYTICS_CLIENT_SECRET: '',
    CODEVAL_MIXPANEL_SECRET_KEY: '',
    CODEVAL_SECRET_ENCRYPTION_KEY: '',
  };

  const finish = (note) => {
    if (note) {
      daemonLog(note);
    }
    refreshInFlight = false;
    releaseDaemonLock();
  };

  let proc;
  try {
    proc = spawn(python.cmd, args, { cwd: backendDir, env });
  } catch (err) {
    finish(`spawn failed: ${err?.message || err}`);
    return;
  }
  let stderr = '';
  proc.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  proc.on('error', (err) => finish(`refresh error: ${err?.message || err}`));
  proc.on('close', (code) => finish(code === 0 ? '' : `local-analyze.py exited ${code}: ${stderr.slice(-2000)}`));
}

function safeJoin(root, relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(root, normalized);
  const rootWithSep = path.resolve(root) + path.sep;
  if (target !== path.resolve(root) && !target.startsWith(rootWithSep)) {
    throw new Error(`Path escapes artifact root: ${relPath}`);
  }
  return target;
}

function readTextIfExists(filePath, maxChars = 20000) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return '';
  }
  const text = fs.readFileSync(filePath, 'utf8');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} chars]` : text;
}

function readJsonIfExists(filePath) {
  const text = readTextIfExists(filePath, 20_000_000);
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

function textResult(text) {
  return { content: [{ type: 'text', text: String(text || '') }] };
}

function resourceUriForPath(relPath) {
  return `${RESOURCE_SCHEME}://artifact/${encodeURIComponent(String(relPath || 'CODE.md'))}`;
}

function relPathFromResourceUri(uri) {
  const text = String(uri || '');
  const prefix = `${RESOURCE_SCHEME}://artifact/`;
  if (!text.startsWith(prefix)) {
    throw new Error(`Unsupported CODE.md resource URI: ${uri}`);
  }
  return decodeURIComponent(text.slice(prefix.length)) || 'CODE.md';
}

// Populated from the MCP `initialize` handshake's `clientInfo` field (see
// handleRequest below). Each stdio MCP client (Claude Code, Codex, etc.)
// spawns its own instance of this script per session, so this is stable for
// the lifetime of the process — every recordUsage() call in that process
// really did come from this one client.
let currentClient = { name: 'unknown', version: '' };

function readUsage() {
  try {
    if (!fs.existsSync(usagePath)) {
      return { total_calls: 0, tools: {}, clients: {}, tools_by_client: {}, resources: {}, updated_at: '' };
    }
    const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    return {
      total_calls: Number(usage.total_calls || 0),
      tools: usage.tools && typeof usage.tools === 'object' ? usage.tools : {},
      clients: usage.clients && typeof usage.clients === 'object' ? usage.clients : {},
      tools_by_client: usage.tools_by_client && typeof usage.tools_by_client === 'object' ? usage.tools_by_client : {},
      resources: usage.resources && typeof usage.resources === 'object' ? usage.resources : {},
      updated_at: String(usage.updated_at || ''),
    };
  } catch {
    return { total_calls: 0, tools: {}, clients: {}, tools_by_client: {}, resources: {}, updated_at: '' };
  }
}

function recordUsage(kind, name) {
  fs.mkdirSync(artifactRoot, { recursive: true });
  const usage = readUsage();
  usage.total_calls += 1;
  const bucketName = kind === 'resource' ? 'resources' : 'tools';
  usage[bucketName] = usage[bucketName] && typeof usage[bucketName] === 'object' ? usage[bucketName] : {};
  usage[bucketName][name] = Number(usage[bucketName][name] || 0) + 1;

  const clientKey = currentClient.name || 'unknown';
  usage.clients[clientKey] = Number(usage.clients[clientKey] || 0) + 1;
  usage.tools_by_client[clientKey] = usage.tools_by_client[clientKey] || {};
  const clientUsageKey = kind === 'resource' ? `resource:${name}` : name;
  usage.tools_by_client[clientKey][clientUsageKey] = Number(usage.tools_by_client[clientKey][clientUsageKey] || 0) + 1;

  usage.updated_at = new Date().toISOString();
  fs.writeFileSync(usagePath, `${JSON.stringify(usage, null, 2)}\n`, 'utf8');
  return usage;
}

function artifactStatus() {
  const files = [
    'CODE.md',
    '.analysis-result.json',
    'combined_callgraph/combined_callgraph.json',
    'combined_callgraph/combined_navigatable_callgraph.html',
    'file_graph/file_graph.json',
    'repo_stats.json',
    'repo_text.json',
  ];
  const rows = files.map((relPath) => {
    const filePath = path.join(artifactRoot, relPath);
    if (!fs.existsSync(filePath)) {
      return { path: relPath, exists: false };
    }
    const stat = fs.statSync(filePath);
    return { path: relPath, exists: true, bytes: stat.size, modified: stat.mtime.toISOString() };
  });
  return {
    workspaceRoot,
    artifactRoot,
    artifactRootExists: fs.existsSync(artifactRoot),
    files: rows,
  };
}

function readArtifact(args) {
  const relPath = args.path || 'CODE.md';
  const maxChars = Number(args.max_chars || 30000);
  const filePath = safeJoin(artifactRoot, relPath);
  const text = readTextIfExists(filePath, Math.max(1000, Math.min(maxChars, 200000)));
  if (!text) {
    return `Artifact not found: ${relPath}\nWorkspace: ${workspaceRoot}`;
  }
  return text;
}

function listArtifactResources() {
  const candidates = [
    { path: 'CODE.md', name: 'CODE.md', mimeType: 'text/markdown', description: 'Compact generated repository overview.' },
    { path: 'repo_stats.json', name: 'Repository Stats', mimeType: 'application/json', description: 'Lightweight repository facts.' },
    { path: 'repo_text.json', name: 'Repository Text', mimeType: 'application/json', description: 'Extracted README, docs, and UI text.' },
    { path: 'combined_callgraph/combined_callgraph.json', name: 'Combined Callgraph', mimeType: 'application/json', description: 'Merged graph of repository entry points, calls, routes, and UI structure.' },
    { path: 'python/python_callgraph.json', name: 'Python Callgraph', mimeType: 'application/json', description: 'Function-level Python callgraph, when Python was present.' },
    { path: 'javascript/javascript_callgraph.json', name: 'JavaScript Callgraph', mimeType: 'application/json', description: 'Function-level JavaScript/TypeScript callgraph, when JavaScript was present.' },
    { path: 'file_graph/file_graph.json', name: 'File Dependency Graph', mimeType: 'application/json', description: 'File dependency and navigation graph.' },
    { path: 'html_ui/html_ui_graph.json', name: 'HTML UI Graph', mimeType: 'application/json', description: 'DOM and UI element graph for buttons, links, inputs, and forms.' },
  ];
  return candidates
    .filter((entry) => fs.existsSync(path.join(artifactRoot, entry.path)))
    .map((entry) => ({
      uri: resourceUriForPath(entry.path),
      name: entry.name,
      description: entry.description,
      mimeType: entry.mimeType,
    }));
}

function readArtifactResource(uri) {
  const relPath = relPathFromResourceUri(uri);
  const filePath = safeJoin(artifactRoot, relPath);
  const text = readTextIfExists(filePath, 2_000_000);
  if (!text) {
    throw new Error(`Artifact not found: ${relPath}`);
  }
  recordUsage('resource', relPath);
  const mimeType = relPath.endsWith('.json') ? 'application/json' : relPath.endsWith('.md') ? 'text/markdown' : 'text/plain';
  return {
    contents: [
      {
        uri: resourceUriForPath(relPath),
        mimeType,
        text,
      },
    ],
  };
}

function flattenTextEntries(value, prefix = '') {
  const out = [];
  if (typeof value === 'string') {
    out.push({ path: prefix, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => out.push(...flattenTextEntries(item, `${prefix}[${index}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(...flattenTextEntries(child, prefix ? `${prefix}.${key}` : key));
    }
  }
  return out;
}

function searchArtifacts(args) {
  const query = String(args.query || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(Number(args.limit || 12), 50));
  if (!query) {
    return 'query is required';
  }

  const matches = [];
  const addMatch = (source, label, text) => {
    if (matches.length >= limit) {
      return;
    }
    const haystack = String(text || '');
    const index = haystack.toLowerCase().indexOf(query);
    if (index < 0) {
      return;
    }
    const start = Math.max(0, index - 240);
    const end = Math.min(haystack.length, index + query.length + 360);
    matches.push({
      source,
      label,
      snippet: haystack.slice(start, end).replace(/\s+/g, ' ').trim(),
    });
  };

  addMatch('CODE.md', 'CODE.md', readTextIfExists(path.join(artifactRoot, 'CODE.md'), 2_000_000));

  for (const relPath of ['repo_text.json', 'repo_comments.json']) {
    const data = readJsonIfExists(path.join(artifactRoot, relPath));
    for (const entry of flattenTextEntries(data).slice(0, 5000)) {
      addMatch(relPath, entry.path, entry.text);
    }
  }

  for (const relPath of ['combined_callgraph/combined_callgraph.json', 'python/python_callgraph.json', 'javascript/javascript_callgraph.json']) {
    const data = readJsonIfExists(path.join(artifactRoot, relPath));
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    for (const node of nodes) {
      addMatch(relPath, 'node', typeof node === 'string' ? node : JSON.stringify(node));
    }
  }

  return JSON.stringify({ query: args.query, count: matches.length, matches }, null, 2);
}

function addEdge(adjacency, from, to) {
  if (!from || !to) {
    return;
  }
  if (!adjacency[from]) {
    adjacency[from] = new Set();
  }
  adjacency[from].add(to);
}

// Confidence tiers reflect how the edge was produced, not just whether it
// exists. An AST-resolved call (python-ast, joern) is strong evidence a call
// really happens; a regex-matched one (javascript-regex) can be a same-named
// method false positive; a structural graph (renders/imports) isn't a call
// at all. Ranked so the strongest evidence for a given edge wins when the
// same edge shows up in more than one source (e.g. combined + per-language).
const TIER_RANK = { high: 3, medium: 2, low: 1 };

function classifyParserTier(relPath, parser) {
  const p = String(parser || '').toLowerCase();
  if (p.includes('regex') || p.includes('heuristic') || p.includes('infer')) {
    return { tier: 'medium', label: `regex/heuristic static match (${parser}) — can include same-named-method false positives` };
  }
  if (p.includes('ast') || p.includes('joern') || p.includes('javalang') || p.includes('tree-sitter')) {
    return { tier: 'high', label: `AST-resolved static call (${parser})` };
  }
  if (relPath.includes('html_ui')) {
    return { tier: 'low', label: 'structural render/import graph — not a resolved function call' };
  }
  if (relPath.includes('combined_callgraph')) {
    return { tier: 'medium', label: 'merged cross-language graph; original parser for this edge is unavailable' };
  }
  return { tier: 'medium', label: 'static analysis (parser unspecified)' };
}

function edgeKey(from, to) {
  return `${from}${to}`;
}

function recordEdgeInfo(edgeInfo, from, to, tierInfo, sourceRelPath) {
  if (!from || !to || !tierInfo) {
    return;
  }
  const key = edgeKey(from, to);
  const existing = edgeInfo[key];
  if (!existing || TIER_RANK[tierInfo.tier] > TIER_RANK[existing.tier]) {
    edgeInfo[key] = { tier: tierInfo.tier, label: tierInfo.label, sources: new Set([sourceRelPath]) };
  } else {
    existing.sources.add(sourceRelPath);
  }
}

function addEdgesFromGraph(graph, forward, backward, edgeInfo, sourceRelPath) {
  const tierInfo = classifyParserTier(sourceRelPath, graph?.parser);
  const record = (from, to) => recordEdgeInfo(edgeInfo, from, to, tierInfo, sourceRelPath);

  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    const from = Array.isArray(edge) ? edge[0] : edge?.source || edge?.from || edge?.caller;
    const to = Array.isArray(edge) ? edge[1] : edge?.target || edge?.to || edge?.callee;
    addEdge(forward, from, to);
    addEdge(backward, to, from);
    record(from, to);
  }

  const looksLikeLegacyAdjacency =
    graph &&
    typeof graph === 'object' &&
    !Array.isArray(graph) &&
    !Array.isArray(graph.nodes) &&
    !Array.isArray(graph.edges);
  if (looksLikeLegacyAdjacency) {
    for (const [caller, callees] of Object.entries(graph)) {
      if (!Array.isArray(callees)) {
        continue;
      }
      for (const callee of callees) {
        const to = typeof callee === 'string' ? callee : callee?.callee_fullName || callee?.callee || callee?.target;
        addEdge(forward, caller, to);
        addEdge(backward, to, caller);
        record(caller, to);
      }
    }
  }

  for (const entry of Array.isArray(graph) ? graph : []) {
    const caller = entry?.method || entry?.caller || entry?.source;
    for (const call of Array.isArray(entry?.calls) ? entry.calls : []) {
      const callee = call?.callee_fullName || call?.callee || call?.target;
      addEdge(forward, caller, callee);
      addEdge(backward, callee, caller);
      record(caller, callee);
    }
  }
}

function mergeLocationIndex(index, graph) {
  const functionFiles = graph?.function_files && typeof graph.function_files === 'object' ? graph.function_files : {};
  for (const [node, file] of Object.entries(functionFiles)) {
    if (!index[node]) {
      index[node] = { file: String(file || '') };
    }
  }

  const metadata = graph?.node_metadata && typeof graph.node_metadata === 'object' ? graph.node_metadata : {};
  for (const [node, meta] of Object.entries(metadata)) {
    if (!meta || typeof meta !== 'object') {
      continue;
    }
    index[node] = {
      file: meta.file || index[node]?.file || '',
      line: meta.lineno || meta.line || meta.start_line || index[node]?.line,
    };
  }
}

function loadImpactGraph() {
  // Per-language sources are loaded before the merged combined_callgraph so
  // their precise parser tier (see classifyParserTier) wins recordEdgeInfo's
  // "keep the strongest evidence" tie-break for any edge duplicated in both.
  const relPaths = [
    'python/python_callgraph.json',
    'javascript/javascript_callgraph.json',
    'html_ui/html_ui_graph.json',
    'combined_callgraph/combined_callgraph.json',
  ];
  const forward = {};
  const backward = {};
  const locations = {};
  const nodes = new Set();
  const sources = [];
  const edgeInfo = {};
  const coverage = [];

  for (const relPath of relPaths) {
    const graph = readJsonIfExists(path.join(artifactRoot, relPath));
    if (!graph) {
      continue;
    }
    sources.push(relPath);
    for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
      if (node) {
        nodes.add(String(node));
      }
    }
    addEdgesFromGraph(graph, forward, backward, edgeInfo, relPath);
    mergeLocationIndex(locations, graph);
    if (graph.raw_call_count !== undefined && graph.resolved_call_count !== undefined) {
      const raw = Number(graph.raw_call_count) || 0;
      const resolved = Number(graph.resolved_call_count) || 0;
      coverage.push({
        source: relPath,
        parser: graph.parser || '',
        raw_call_count: raw,
        resolved_call_count: resolved,
        resolution_rate: raw > 0 ? Number((resolved / raw).toFixed(3)) : null,
      });
    }
  }

  for (const [from, tos] of Object.entries(forward)) {
    nodes.add(from);
    for (const to of tos) {
      nodes.add(to);
    }
  }
  for (const [to, froms] of Object.entries(backward)) {
    nodes.add(to);
    for (const from of froms) {
      nodes.add(from);
    }
  }

  return { forward, backward, locations, nodes: Array.from(nodes).sort(), sources, edgeInfo, coverage };
}

function edgeConfidence(graph, from, to) {
  const info = graph.edgeInfo[edgeKey(from, to)];
  if (!info) {
    return { tier: 'unknown', label: 'edge provenance unavailable' };
  }
  return { tier: info.tier, label: info.label, sources: Array.from(info.sources) };
}

// Summarizes confidence across a set of edges: the weakest tier present sets
// the honest overall bound (a path/radius is only as trustworthy as its
// least-certain hop), plus a note about analysis coverage gaps so results
// read as "best evidence found" rather than "the complete truth".
function summarizeConfidence(edgeRows, coverage) {
  const counts = { high: 0, medium: 0, low: 0, unknown: 0 };
  for (const row of edgeRows) {
    counts[row.confidence?.tier || 'unknown'] += 1;
  }
  const total = edgeRows.length;
  let overall = 'high';
  if (counts.low > 0 || counts.unknown > 0) {
    overall = 'low';
  } else if (counts.medium > 0) {
    overall = 'medium';
  }
  const notes = [];
  if (counts.medium > 0) {
    notes.push(`${counts.medium} of ${total} edge(s) come from regex/heuristic or merged sources rather than a resolved AST call — treat those hops as likely-but-unconfirmed.`);
  }
  if (counts.low > 0) {
    notes.push(`${counts.low} of ${total} edge(s) come from structural (render/import) graphs, not resolved function calls.`);
  }
  const lowCoverage = coverage.filter((c) => c.resolution_rate !== null && c.resolution_rate < 0.5);
  for (const c of lowCoverage) {
    notes.push(`${c.source} (${c.parser}) only resolved ${Math.round(c.resolution_rate * 100)}% of raw call sites (${c.resolved_call_count}/${c.raw_call_count}) — the true call graph is likely larger than what's shown here.`);
  }
  if (total === 0) {
    overall = 'unknown';
  }
  return { overall, edge_tier_counts: counts, notes };
}

function functionTail(name) {
  return String(name || '').split(/[.#/\\:-]/).filter(Boolean).pop() || String(name || '');
}

function resolveNodes(query, nodes, limit = 12) {
  const raw = String(query || '').trim();
  if (!raw) {
    return [];
  }
  const lowered = raw.toLowerCase();
  const tail = functionTail(raw).toLowerCase();
  const exact = nodes.filter((node) => node.toLowerCase() === lowered);
  if (exact.length) {
    return exact.slice(0, limit);
  }
  const tailMatches = nodes.filter((node) => functionTail(node).toLowerCase() === tail);
  if (tailMatches.length) {
    return tailMatches.slice(0, limit);
  }
  const contains = nodes.filter((node) => node.toLowerCase().includes(lowered));
  if (contains.length) {
    return contains.slice(0, limit);
  }
  return nodes.filter((node) => functionTail(node).toLowerCase().includes(tail)).slice(0, limit);
}

// `isBackward` flags that `adjacency` is the reversed (callee -> caller) map,
// so the real call direction for confidence lookup is (next -> node) rather
// than (node -> next).
function traverse(startNodes, adjacency, maxDepth, maxNodes, graph, isBackward) {
  const visited = {};
  const edges = [];
  const queue = [];
  for (const node of startNodes) {
    if (!node || visited[node] !== undefined) {
      continue;
    }
    visited[node] = 0;
    queue.push(node);
  }
  while (queue.length && Object.keys(visited).length < maxNodes) {
    const node = queue.shift();
    const depth = visited[node];
    if (depth >= maxDepth) {
      continue;
    }
    for (const next of Array.from(adjacency[node] || []).sort()) {
      const confidence = isBackward ? edgeConfidence(graph, next, node) : edgeConfidence(graph, node, next);
      edges.push({ from: node, to: next, depth: depth + 1, confidence });
      if (visited[next] === undefined) {
        visited[next] = depth + 1;
        queue.push(next);
      }
      if (Object.keys(visited).length >= maxNodes) {
        break;
      }
    }
  }
  return { visited, edges };
}

// Per-node confidence: a node can be reached by more than one edge in the
// traversal, so its tier is the strongest evidence among the edges leading
// into it (not just whichever edge BFS happened to visit first). Root nodes
// have no incoming edge and are the query itself, so they're tagged 'root'
// rather than 'unknown'.
function nodeConfidenceMap(edges) {
  const best = {};
  for (const edge of edges) {
    const current = best[edge.to];
    const rank = TIER_RANK[edge.confidence?.tier] || 0;
    if (!current || rank > (TIER_RANK[current.tier] || 0)) {
      best[edge.to] = edge.confidence;
    }
  }
  return best;
}

function nodeRows(visited, locations, roots, edges) {
  const rootSet = new Set(roots);
  const confidenceByNode = nodeConfidenceMap(edges || []);
  return Object.entries(visited)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([node, depth]) => ({
      node,
      file: locations[node]?.file || '',
      line: locations[node]?.line || undefined,
      depth,
      root: rootSet.has(node),
      confidence: rootSet.has(node)
        ? { tier: 'root', label: 'starting node' }
        : confidenceByNode[node] || { tier: 'unknown', label: 'edge provenance unavailable' },
    }));
}

function impactRadius(args) {
  const nodeQuery = args.node_query || args.query || '';
  const direction = String(args.direction || 'backward').toLowerCase();
  const maxDepthRaw = args.max_depth === undefined || args.max_depth === null ? 50 : Number(args.max_depth);
  const maxDepth = Math.max(1, Math.min(Number.isFinite(maxDepthRaw) ? maxDepthRaw : 50, 200));
  const maxNodes = Math.max(1, Math.min(Number(args.max_nodes || 500), 2000));
  const graph = loadImpactGraph();
  const roots = resolveNodes(nodeQuery, graph.nodes, Number(args.root_limit || 12));
  if (!roots.length) {
    return JSON.stringify({ query: nodeQuery, roots: [], affected: [], message: 'No matching callgraph node found.', sources: graph.sources }, null, 2);
  }

  const includeForward = direction === 'forward' || direction === 'both';
  const includeBackward = direction === 'backward' || direction === 'both' || !includeForward;
  const result = {
    query: nodeQuery,
    direction: includeForward && includeBackward ? 'both' : includeForward ? 'forward' : 'backward',
    roots: roots.map((node) => ({ node, file: graph.locations[node]?.file || '', line: graph.locations[node]?.line || undefined })),
    sources: graph.sources,
    max_depth: maxDepth,
    max_nodes: maxNodes,
  };

  if (includeBackward) {
    const walk = traverse(roots, graph.backward, maxDepth, maxNodes, graph, true);
    result.callers = nodeRows(walk.visited, graph.locations, roots, walk.edges);
    result.caller_edges = walk.edges;
  }
  if (includeForward) {
    const walk = traverse(roots, graph.forward, maxDepth, maxNodes, graph, false);
    result.callees = nodeRows(walk.visited, graph.locations, roots, walk.edges);
    result.callee_edges = walk.edges;
  }

  const rows = [...(result.callers || []), ...(result.callees || [])];
  const files = Array.from(new Set(rows.map((row) => row.file).filter(Boolean))).sort();
  result.files = files;
  result.affected_count = rows.filter((row) => !row.root).length;
  result.file_count = files.length;
  result.coverage = graph.coverage;
  result.confidence = summarizeConfidence([...(result.caller_edges || []), ...(result.callee_edges || [])], graph.coverage);
  return JSON.stringify(result, null, 2);
}

// Cheap, single-hop convenience wrapper: same traversal machinery as
// codemd_get_impact_radius, just pinned to backward direction and a shallow
// default depth so it reads like a direct "who calls this" lookup.
function callersOrCallees(args, direction) {
  return impactRadius({ ...args, direction, max_depth: args.max_depth === undefined ? 1 : args.max_depth });
}

function pathDepth(parent, node) {
  let depth = 0;
  for (let cur = node; parent[cur] !== null && parent[cur] !== undefined; cur = parent[cur]) {
    depth += 1;
  }
  return depth;
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Loopless k-shortest paths (Yen's algorithm) from `start` to any node in
// `targetSet`, over an unweighted graph — so each "shortest path" sub-search
// is a plain BFS rather than Dijkstra. This is what lets codemd_get_call_paths
// surface a route one hop longer than the absolute shortest (e.g. the one
// that bypasses a generic error handler), not just the single shallowest
// chain, without needing a real shortest-path library.
function kShortestPaths(graph, start, targetSet, maxDepth, k) {
  function bfsFrom(from, bannedEdges, bannedNodes) {
    const parent = { [from]: null };
    const queue = [from];
    let targetNode = null;
    while (queue.length) {
      const node = queue.shift();
      if (targetSet.has(node)) {
        targetNode = node;
        break;
      }
      const depth = pathDepth(parent, node);
      if (depth >= maxDepth) {
        continue;
      }
      for (const next of Array.from(graph.forward[node] || []).sort()) {
        if (bannedNodes.has(next) || bannedEdges.has(edgeKey(node, next))) {
          continue;
        }
        if (!(next in parent)) {
          parent[next] = node;
          queue.push(next);
        }
      }
    }
    if (!targetNode) {
      return null;
    }
    const nodes = [];
    for (let cur = targetNode; cur !== null; cur = parent[cur]) {
      nodes.unshift(cur);
    }
    return nodes;
  }

  const found = [];
  const first = bfsFrom(start, new Set(), new Set());
  if (!first) {
    return found;
  }
  found.push(first);

  const candidates = [];
  while (found.length < k) {
    const prevPath = found[found.length - 1];
    for (let i = 0; i < prevPath.length - 1; i++) {
      const spurNode = prevPath[i];
      const rootPath = prevPath.slice(0, i + 1);

      // Ban whichever next-hop edge each previously found path used out of
      // this same root prefix, so the spur search is forced to diverge.
      const bannedEdges = new Set();
      for (const p of found) {
        if (p.length > i && arraysEqual(p.slice(0, i + 1), rootPath)) {
          bannedEdges.add(edgeKey(p[i], p[i + 1]));
        }
      }
      // Ban the earlier root-path nodes (not the spur node itself) so the
      // spliced path can't loop back through its own prefix.
      const bannedNodes = new Set(rootPath.slice(0, i));

      const spurPath = bfsFrom(spurNode, bannedEdges, bannedNodes);
      if (!spurPath) {
        continue;
      }
      const totalPath = rootPath.slice(0, -1).concat(spurPath);
      const key = totalPath.join('>');
      if (!candidates.some((c) => c.key === key) && !found.some((f) => f.join('>') === key)) {
        candidates.push({ key, nodes: totalPath });
      }
    }
    if (!candidates.length) {
      break;
    }
    candidates.sort((a, b) => a.nodes.length - b.nodes.length || a.key.localeCompare(b.key));
    found.push(candidates.shift().nodes);
  }

  return found;
}

// Finds the top-K distinct loopless paths of calls from a source symbol to a
// target symbol through the forward callgraph — e.g. "how does clicking
// Generate end up calling analyze_local_path?". Paths are ranked shortest
// first but are NOT limited to ties for the single shortest length: a path
// one hop longer than the shortest (e.g. one that skips a shared error
// handler) can still show up within max_paths. Distinct from impact radius
// (which answers "what's near this node in any direction") and from
// callers/callees (single hop): this is a targeted, multi-hop route between
// two points.
function findCallPaths(args) {
  const fromQuery = args.from_query || args.from || '';
  const toQuery = args.to_query || args.to || '';
  const maxDepthRaw = args.max_depth === undefined || args.max_depth === null ? 12 : Number(args.max_depth);
  const maxDepth = Math.max(1, Math.min(Number.isFinite(maxDepthRaw) ? maxDepthRaw : 12, 60));
  const maxPaths = Math.max(1, Math.min(Number(args.max_paths || 3), 10));
  const graph = loadImpactGraph();

  const fromRoots = resolveNodes(fromQuery, graph.nodes, Number(args.root_limit || 8));
  const toRoots = resolveNodes(toQuery, graph.nodes, Number(args.root_limit || 8));
  if (!fromRoots.length || !toRoots.length) {
    return JSON.stringify(
      {
        from_query: fromQuery,
        to_query: toQuery,
        from_candidates: fromRoots,
        to_candidates: toRoots,
        paths: [],
        message: !fromRoots.length ? 'No callgraph node matched from_query.' : 'No callgraph node matched to_query.',
        sources: graph.sources,
      },
      null,
      2,
    );
  }

  const targetSet = new Set(toRoots);
  const seen = new Set();
  const nodeSequences = [];
  for (const start of fromRoots) {
    for (const nodes of kShortestPaths(graph, start, targetSet, maxDepth, maxPaths)) {
      const key = nodes.join('>');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      nodeSequences.push(nodes);
    }
  }
  // Rank shortest-first across all from-candidates combined, so a distinct
  // fuzzy-matched start doesn't crowd out a shorter path from another start.
  nodeSequences.sort((a, b) => a.length - b.length || a.join('>').localeCompare(b.join('>')));

  const paths = nodeSequences.slice(0, maxPaths).map((nodesOnPath) => {
    const edges = [];
    for (let i = 0; i < nodesOnPath.length - 1; i++) {
      edges.push({ from: nodesOnPath[i], to: nodesOnPath[i + 1], confidence: edgeConfidence(graph, nodesOnPath[i], nodesOnPath[i + 1]) });
    }
    return {
      from: nodesOnPath[0],
      to: nodesOnPath[nodesOnPath.length - 1],
      length: edges.length,
      nodes: nodesOnPath.map((node) => ({ node, file: graph.locations[node]?.file || '', line: graph.locations[node]?.line || undefined })),
      edges,
      confidence: summarizeConfidence(edges, graph.coverage),
    };
  });

  return JSON.stringify(
    {
      from_query: fromQuery,
      to_query: toQuery,
      from_candidates: fromRoots,
      to_candidates: toRoots,
      sources: graph.sources,
      coverage: graph.coverage,
      max_depth: maxDepth,
      max_paths: maxPaths,
      paths,
      message: paths.length ? undefined : 'No call path found within max_depth between the resolved candidates.',
    },
    null,
    2,
  );
}

const tools = [
  {
    name: 'codemd_status',
    description: 'Report whether CODE.md analysis artifacts exist for this workspace.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'codemd_read_artifact',
    description: 'Read a generated CODE.md artifact such as CODE.md, repo_stats.json, or combined_callgraph/combined_callgraph.json.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path under .codemd. Defaults to CODE.md.' },
        max_chars: { type: 'number', description: 'Maximum characters to return.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'codemd_search_artifacts',
    description: 'Search CODE.md, repo text, comments, and callgraph node names for a query. Use this to find likely symbols before reading many files.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'codemd_get_call_paths',
    description:
      'Find the top-K distinct call paths from one symbol to another through the cached static callgraph — "how does A end up reaching B?". Ranked shortest-first but not limited to ties for the single shortest length, so a path one hop longer (e.g. one that bypasses a shared error handler) can still surface — useful since the shortest route isn\'t always the one a developer actually cares about. Returns the node/edge sequence for each path plus a confidence rating per edge and overall, since some edges are regex-inferred rather than AST-resolved. Prefer this over manually tracing calls by hand when you need to explain or verify a specific route between two points in the code.',
    inputSchema: {
      type: 'object',
      required: ['from_query', 'to_query'],
      properties: {
        from_query: { type: 'string', description: 'Fuzzy symbol/route to start from, e.g. GenerateButton.onClick or api.analyze_local_path.' },
        to_query: { type: 'string', description: 'Fuzzy symbol/route to reach, e.g. backend.main.analyze_local_path.' },
        max_depth: { type: 'number', description: 'Maximum hops to search before giving up. Defaults to 12, capped at 60.' },
        max_paths: { type: 'number', description: 'Maximum distinct paths to return, ranked shortest-first across all matched from-candidates (not just one path per candidate). Defaults to 3, capped at 10.' },
        root_limit: { type: 'number', description: 'Maximum fuzzy candidates to try for from_query/to_query.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'codemd_get_impact_radius',
    description:
      'Resolve a fuzzy function/UI/API node name and return everything reachable from it in the cached static callgraph — callers, callees, or both — with per-node AND per-edge confidence scoring (AST-resolved vs regex-inferred vs structural, plus static-analysis coverage caveats), not just one aggregate score for the whole response. Each returned node carries the confidence tier of its strongest incoming edge, so low-confidence nodes reached only through regex-inferred or structural edges (e.g. dynamic dispatch/callbacks) can be flagged separately from AST-resolved ones. Use before editing a symbol to see its full blast radius, not just its direct neighbors.',
    inputSchema: {
      type: 'object',
      required: ['node_query'],
      properties: {
        node_query: { type: 'string', description: 'Fuzzy symbol or route name, such as analyzeLocalPath or backend.main.analyze_local_path.' },
        direction: { type: 'string', enum: ['backward', 'forward', 'both'], description: 'backward finds callers/dependents; forward finds callees/dependencies; both returns both.' },
        max_depth: { type: 'number', description: 'Maximum BFS depth. Defaults high enough for broad blast-radius search.' },
        max_nodes: { type: 'number', description: 'Maximum nodes to return. Defaults to 500, capped at 2000.' },
        root_limit: { type: 'number', description: 'Maximum fuzzy root matches to traverse.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'codemd_get_callers',
    description: 'Cheap shortcut for codemd_get_impact_radius(direction=backward, max_depth=1) — just the direct callers of a symbol, nothing further upstream.',
    inputSchema: {
      type: 'object',
      required: ['node_query'],
      properties: {
        node_query: { type: 'string' },
        max_depth: { type: 'number', description: 'Defaults to 1 (direct callers only).' },
        max_nodes: { type: 'number' },
        root_limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'codemd_get_callees',
    description: 'Cheap shortcut for codemd_get_impact_radius(direction=forward, max_depth=1) — just what a symbol directly calls, nothing further downstream.',
    inputSchema: {
      type: 'object',
      required: ['node_query'],
      properties: {
        node_query: { type: 'string' },
        max_depth: { type: 'number', description: 'Defaults to 1 (direct callees only).' },
        max_nodes: { type: 'number' },
        root_limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
];

function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    handshakeComplete = true;
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    if (params.clientInfo && typeof params.clientInfo === 'object') {
      currentClient = {
        name: String(params.clientInfo.name || 'unknown'),
        version: String(params.clientInfo.version || ''),
      };
    }
    refreshArtifactsInBackground();
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      },
    };
  }
  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: listArtifactResources() } };
  }
  if (method === 'resources/read') {
    try {
      return { jsonrpc: '2.0', id, result: readArtifactResource(params.uri) };
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: err?.message || String(err) } };
    }
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    refreshArtifactsInBackground();
    if (name === 'codemd_status') {
      recordUsage('tool', name);
      return { jsonrpc: '2.0', id, result: textResult(JSON.stringify(artifactStatus(), null, 2)) };
    }
    if (name === 'codemd_read_artifact') {
      recordUsage('tool', name);
      return { jsonrpc: '2.0', id, result: textResult(readArtifact(args)) };
    }
    if (name === 'codemd_search_artifacts') {
      recordUsage('tool', name);
      return { jsonrpc: '2.0', id, result: textResult(searchArtifacts(args)) };
    }
    if (name === 'codemd_get_call_paths') {
      recordUsage('tool', name);
      return { jsonrpc: '2.0', id, result: textResult(findCallPaths(args)) };
    }
    if (name === 'codemd_get_impact_radius') {
      recordUsage('tool', name);
      return { jsonrpc: '2.0', id, result: textResult(impactRadius(args)) };
    }
    if (name === 'codemd_get_callers') {
      recordUsage('tool', name);
      return { jsonrpc: '2.0', id, result: textResult(callersOrCallees(args, 'backward')) };
    }
    if (name === 'codemd_get_callees') {
      recordUsage('tool', name);
      return { jsonrpc: '2.0', id, result: textResult(callersOrCallees(args, 'forward')) };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
  if (id === undefined || id === null) {
    return null;
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

let inputBuffer = Buffer.alloc(0);
let transportMode = null;
let handshakeComplete = false;
let handshakeTimer = setTimeout(() => {
  if (!handshakeComplete) {
    process.exit(1);
  }
}, 30000);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (transportMode === 'line') {
    process.stdout.write(`${body.toString('utf8')}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function respondToMessage(message) {
  try {
    const response = handleRequest(message);
    if (response) {
      send(response);
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: err && err.message ? err.message : String(err) },
    });
  }
}

function processBuffer() {
  for (;;) {
    const textStart = inputBuffer.toString('utf8', 0, Math.min(inputBuffer.length, 32));
    if (/^Content-Length:/i.test(textStart)) {
      transportMode = 'headers';
      const headerEnd = inputBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const header = inputBuffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        inputBuffer = inputBuffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (inputBuffer.length < bodyEnd) {
        return;
      }
      const body = inputBuffer.slice(bodyStart, bodyEnd).toString('utf8');
      inputBuffer = inputBuffer.slice(bodyEnd);
      try {
        respondToMessage(JSON.parse(body));
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: err && err.message ? err.message : String(err) },
        });
      }
      continue;
    }

    transportMode = 'line';
    const newlineEnd = inputBuffer.indexOf('\n');
    if (newlineEnd < 0) {
      return;
    }
    const line = inputBuffer.slice(0, newlineEnd).toString('utf8').trim();
    inputBuffer = inputBuffer.slice(newlineEnd + 1);
    if (!line) {
      continue;
    }
    try {
      respondToMessage(JSON.parse(line));
    } catch (err) {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: err && err.message ? err.message : String(err) },
      });
    }
  }
}

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processBuffer();
});

process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
