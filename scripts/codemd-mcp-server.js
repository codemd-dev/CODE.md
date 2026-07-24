#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

// MCP clients (Claude Code, Codex, ...) don't auto-restart a stdio server
// that dies mid-session — the user has to notice and manually reconnect.
// respondToMessage/processBuffer already catch errors from a single
// request, but anything thrown outside that (e.g. a bug in the fire-and-
// forget refreshArtifactsInBackground path, or a rejected promise nobody
// awaited) would otherwise crash the whole process by default. These
// handlers only fire asynchronously, after daemonLog/artifactRoot below are
// already initialized, so logging and staying alive here trades a silent
// process death for a visible log line — strictly better for a long-lived
// server a client only spawns once per session.
process.on('uncaughtException', (err) => daemonLog(`uncaughtException: ${err && err.stack ? err.stack : String(err)}`));
process.on('unhandledRejection', (err) => daemonLog(`unhandledRejection: ${err && err.stack ? err.stack : String(err)}`));

const SERVER_VERSION = '0.0.24';
const PROTOCOL_VERSION = '2024-11-05';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : '';
}

const SERVER_NAME = argValue('--server-name') || 'codemd';
const SERVER_INSTRUCTIONS = [
  `${SERVER_NAME} — cached static-analysis index (callgraph, impact radius, repo docs) over this workspace's .codemd/ artifacts.`,
  `If these ${SERVER_NAME}_* tools are not directly callable (some MCP clients, including Claude Code, defer less-common tool schemas behind a lookup step), call that client's tool-search/discovery mechanism for them by name first — e.g. in Claude Code call ToolSearch with query "select:${SERVER_NAME}_search_artifacts,${SERVER_NAME}_get_impact_radius,${SERVER_NAME}_get_callers,${SERVER_NAME}_get_callees,${SERVER_NAME}_get_call_paths,${SERVER_NAME}_read_artifact,${SERVER_NAME}_semantic_search,${SERVER_NAME}_find_tests,${SERVER_NAME}_review_changes" — before assuming they are unavailable and falling back to grep/read.`,
  'Reach for it BEFORE and WHILE writing or editing code, not only when asked to explore:',
  '- Before editing or removing a function/route/component, call codemd_get_impact_radius (or the cheaper codemd_get_callers / codemd_get_callees) on it to see what calls it or what it calls, including dynamic-dispatch edges plain grep misses.',
  '- Before tracing how two symbols connect, call codemd_get_call_paths instead of manually following calls by hand.',
  '- To find likely symbol names before reading many files, call codemd_search_artifacts; it includes SCIM semantic vector matches when scim/vectors.sqlite is present.',
  '- For direct semantic code lookup, call codemd_semantic_search.',
  '- For "what tests cover X?" questions, call codemd_find_tests before claiming coverage is present or absent.',
  '- For "what changed?" or "what should I review?" questions, call codemd_review_changes to inspect the actual local git diff instead of searching for code that implements change review.',
  '- For a repository overview, call codemd_read_artifact (defaults to CODE.md).',
  'These artifacts are generated static analysis: some edges are regex-inferred rather than AST-resolved, and content can go stale if source changed since generation. Treat results as a fast lead, and verify against the actual source file before finalizing a change.',
].join('\n');
const workspaceRoot = path.resolve(argValue('--workspace') || process.env.CODEMD_WORKSPACE || process.cwd());
const artifactRoot = path.join(workspaceRoot, '.codemd');
const mcpRoot = path.join(artifactRoot, 'mcp');
const usagePath = path.join(mcpRoot, '.mcp-usage.json');
const RESOURCE_SCHEME = 'codemd';

// ---------------------------------------------------------------------------
// Freshness coordinator — mirrors CodeGraph's own daemon+lock pattern so this
// server can refresh .codemd/ on its own, without the VS Code extension
// needing to be running. Any client (Claude Code, Codex, VS Code, ...) spawns
// its own copy of this script, so multiple copies can race to re-analyze at
// once; a pidfile lock under .codemd/mcp/ ensures only one of them actually runs
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

// --extension-root is passed explicitly because this script is mirrored into
// the workspace's own .codemd/mcp/ (see mirrorMcpServerScript in extension.ts) so
// its own launch path stays stable across extension reinstalls — meaning
// __dirname here is .codemd/mcp/, not the real (versioned) extension install
// dir where local-analyze.py/backend/ actually live. Falls back to the old
// __dirname-relative resolution for standalone/manual invocation.
const EXTENSION_ROOT = path.resolve(argValue('--extension-root') || path.resolve(__dirname, '..'));
const DAEMON_LOCK_PATH = path.join(mcpRoot, '.mcp-daemon.lock');
const DAEMON_LOG_PATH = path.join(mcpRoot, '.mcp-daemon.log');
const REFRESH_STATE_PATH = path.join(mcpRoot, '.mcp-refresh-state.json');
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
    fs.mkdirSync(mcpRoot, { recursive: true });
    fs.writeFileSync(REFRESH_STATE_PATH, JSON.stringify({ lastAttemptAt: Date.now() }));
  } catch {
    // Best-effort — worst case we just refresh a bit more often than intended.
  }
}

function daemonLog(line) {
  try {
    fs.mkdirSync(mcpRoot, { recursive: true });
    fs.appendFileSync(DAEMON_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Best-effort only — never let logging break the refresh path.
  }
}

// Same globalStorage convention VS Code uses for context.globalStorageUri,
// replicated here since this script has no `vscode` module to ask directly.
function vscodeGlobalStorageDirs() {
  const home = os.homedir();
  const EXT_IDS = ['codemd-dev.codemd-graphs', 'codeval.codeval-codemd-graphs'];
  const storageRoot = (() => {
    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage');
    }
    if (process.platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
    }
    return path.join(home, '.config', 'Code', 'User', 'globalStorage');
  })();
  return EXT_IDS.map((id) => path.join(storageRoot, id));
}

function vscodeGlobalStorageDir() {
  return vscodeGlobalStorageDirs()[0];
}

function pythonSupportsSemanticSearch(candidate) {
  try {
    const result = spawnSync(
      candidate.cmd,
      [...candidate.args, '-c', 'import numpy, sqlite3, json'],
      { timeout: 5000 }
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function candidateVenvPythons() {
  if (process.platform === 'win32') {
    return vscodeGlobalStorageDirs().map((dir) => path.join(dir, 'venv', 'Scripts', 'python.exe'));
  }
  return vscodeGlobalStorageDirs().map((dir) => path.join(dir, 'venv', 'bin', 'python'));
}

function candidateSystemPythons() {
  return process.platform === 'win32'
    ? [{ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
}

function resolvePython() {
  for (const venvPython of candidateVenvPythons()) {
    const candidate = { cmd: venvPython, args: [] };
    if (fs.existsSync(venvPython) && pythonSupportsSemanticSearch(candidate)) {
      return candidate;
    }
  }
  for (const candidate of candidateSystemPythons()) {
    try {
      const result = spawnSync(candidate.cmd, [...candidate.args, '--version'], { timeout: 5000 });
      if (result.status === 0 && pythonSupportsSemanticSearch(candidate)) {
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
    fs.mkdirSync(mcpRoot, { recursive: true });
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
    '--result-json', path.join(artifactRoot, 'analysis', '.analysis-result.json'),
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

function artifactRelPathCandidates(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '') || 'CODE.md';
  if (['repo_stats.json', 'repo_text.json', 'repo_comments.json'].includes(normalized)) {
    return [`repo_text/${normalized}`, normalized];
  }
  if (normalized.startsWith('repo_text/')) {
    const legacyName = normalized.slice('repo_text/'.length);
    if (['repo_stats.json', 'repo_text.json', 'repo_comments.json'].includes(legacyName)) {
      return [normalized, legacyName];
    }
  }
  return [normalized];
}

function firstExistingArtifactPath(relPath) {
  const candidates = artifactRelPathCandidates(relPath);
  for (const candidate of candidates) {
    const filePath = safeJoin(artifactRoot, candidate);
    if (fs.existsSync(filePath)) {
      return { relPath: candidate, filePath };
    }
  }
  return { relPath: candidates[0], filePath: safeJoin(artifactRoot, candidates[0]) };
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
  fs.mkdirSync(mcpRoot, { recursive: true });
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
    'analysis/.analysis-result.json',
    'combined_callgraph/combined_callgraph.json',
    'combined_callgraph/combined_navigatable_callgraph.html',
    'file_graph/file_graph.json',
    'repo_text/repo_stats.json',
    'repo_text/repo_text.json',
    'repo_text/repo_comments.json',
    'scim/functions.jsonl',
    'scim/embedding_model.json',
    'scim/vectors.sqlite',
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
  const { filePath } = firstExistingArtifactPath(relPath);
  const text = readTextIfExists(filePath, Math.max(1000, Math.min(maxChars, 200000)));
  if (!text) {
    return `Artifact not found: ${relPath}\nWorkspace: ${workspaceRoot}`;
  }
  return text;
}

function listArtifactResources() {
  const candidates = [
    { path: 'CODE.md', name: 'CODE.md', mimeType: 'text/markdown', description: 'Compact generated repository overview.' },
    { path: 'repo_text/repo_stats.json', name: 'Repository Stats', mimeType: 'application/json', description: 'Lightweight repository facts.' },
    { path: 'repo_text/repo_text.json', name: 'Repository Text', mimeType: 'application/json', description: 'Extracted README, docs, and UI text.' },
    { path: 'repo_text/repo_comments.json', name: 'Repository Comments', mimeType: 'application/json', description: 'Extracted code comments, todos, and dashboard notes.' },
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
  const { filePath } = firstExistingArtifactPath(relPath);
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

function semanticSearchUnavailable(reason) {
  return {
    available: false,
    reason,
    source: 'scim/vectors.sqlite',
    matches: [],
  };
}

function searchScimVectors(args) {
  const query = String(args.query || '').trim();
  const limit = Math.max(1, Math.min(Number(args.limit || 12), 50));
  if (!query) {
    return semanticSearchUnavailable('query is required');
  }

  const datasetDir = path.join(artifactRoot, 'scim');
  const modelPath = path.join(datasetDir, 'embedding_model.json');
  const vectorDbPath = path.join(datasetDir, 'vectors.sqlite');
  const functionsPath = path.join(datasetDir, 'functions.jsonl');
  if (!fs.existsSync(modelPath) || !fs.existsSync(vectorDbPath)) {
    return semanticSearchUnavailable('SCIM vector artifacts are not available yet. Regenerate CODEMD to create scim/vectors.sqlite and scim/embedding_model.json.');
  }

  const python = resolvePython();
  if (!python) {
    return semanticSearchUnavailable('No Python interpreter was available to run SCIM semantic search.');
  }

  const backendDir = path.join(EXTENSION_ROOT, 'backend');
  if (!fs.existsSync(path.join(backendDir, 'scim.py'))) {
    return semanticSearchUnavailable('Bundled backend/scim.py was not found for semantic search.');
  }

  const code = String.raw`
import json
import re
import sqlite3
import sys
from pathlib import Path

dataset_dir = Path(sys.argv[1])
query = sys.argv[2]
limit = max(1, min(int(sys.argv[3]), 50))

import numpy as np
from scim import EmbeddingModel, blob_to_vector, cosine_np

model = EmbeddingModel.load(dataset_dir / "embedding_model.json")
query_vector = np.asarray(model.embed_query(query), dtype=np.float32)

records_by_key = {}
functions_path = dataset_dir / "functions.jsonl"
if functions_path.exists():
    with functions_path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except Exception:
                continue
            key = (str(record.get("symbol") or ""), str(record.get("path") or ""), int(record.get("start_line") or 0))
            records_by_key[key] = record

STOPWORDS = {
    "about", "code", "does", "file", "files", "find", "function", "functions",
    "method", "methods", "class", "classes", "where", "what", "which", "with",
    "exist", "exists", "implemented", "implementation", "show", "tell",
}

def lexical_tokens(text):
    parts = []
    for raw in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", str(text or "")):
        parts.append(raw.lower())
        split = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw).replace("_", " ").split()
        parts.extend(part.lower() for part in split)
    return {part for part in parts if len(part) >= 3 and part not in STOPWORDS}

query_tokens = lexical_tokens(query)
query_exact = str(query or "").strip().lower()

def snippet_for(symbol, path, start_line, metadata):
    record = records_by_key.get((str(symbol or ""), str(path or ""), int(start_line or 0))) or {}
    text = str(record.get("code") or metadata.get("evidence_text") or metadata.get("title") or "")
    text = " ".join(text.split())
    if len(text) > 700:
        text = text[:697] + "..."
    return text

def lexical_boost(symbol, path, start_line, metadata):
    record = records_by_key.get((str(symbol or ""), str(path or ""), int(start_line or 0))) or {}
    identity = " ".join([
        str(symbol or ""),
        str(path or ""),
        str(metadata.get("title") or ""),
        str(record.get("method_name") or ""),
        str(record.get("class_name") or ""),
    ])
    searchable = " ".join([identity, str(record.get("code") or metadata.get("evidence_text") or "")[:4000]])
    identity_lower = identity.lower()
    searchable_lower = searchable.lower()
    boost = 0.0
    if query_exact and query_exact in identity_lower:
        boost += 0.35
    if query_exact and query_exact in searchable_lower:
        boost += 0.12
    if query_tokens:
        identity_tokens = lexical_tokens(identity)
        searchable_tokens = lexical_tokens(searchable)
        identity_overlap = len(query_tokens & identity_tokens)
        searchable_overlap = len(query_tokens & searchable_tokens)
        boost += min(0.40, identity_overlap * 0.16)
        boost += min(0.18, searchable_overlap * 0.04)
    return boost

scored = []
with sqlite3.connect(dataset_dir / "vectors.sqlite") as connection:
    rows = connection.execute(
        "SELECT repo_id, symbol, path, start_line, end_line, embedding, metadata FROM vectors"
    )
    for repo_id, symbol, path, start_line, end_line, blob, metadata_json in rows:
        try:
            metadata = json.loads(metadata_json or "{}")
            score = cosine_np(query_vector, blob_to_vector(blob))
        except Exception:
            continue
        if metadata.get("is_typed_evidence") or metadata.get("is_derived_memory"):
            continue
        boost = lexical_boost(symbol, path, start_line, metadata)
        scored.append({
            "source": "scim/vectors.sqlite",
            "score": float(score + boost),
            "vector_score": float(score),
            "lexical_boost": float(boost),
            "repo_id": repo_id,
            "symbol": symbol,
            "path": path,
            "start_line": int(start_line or 0),
            "end_line": int(end_line or 0),
            "source_type": metadata.get("source_type") or "code_function",
            "title": metadata.get("title") or "",
            "snippet": snippet_for(symbol, path, start_line, metadata),
        })

scored.sort(key=lambda item: item["score"], reverse=True)
print(json.dumps({
    "available": True,
    "query": query,
    "source": "scim/vectors.sqlite",
    "model": "scim/embedding_model.json",
    "count": len(scored[:limit]),
    "matches": scored[:limit],
}, ensure_ascii=False))
`;

  const env = {
    ...process.env,
    PYTHONPATH: backendDir,
    SENTRY_ENABLED: 'false',
    SENTRY_DSN: '',
  };
  const result = spawnSync(python.cmd, [...python.args, '-c', code, datasetDir, query, String(limit)], {
    cwd: backendDir,
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || `SCIM semantic search exited ${result.status}`).trim().slice(-2000);
    daemonLog(`semantic search failed: ${reason}`);
    return semanticSearchUnavailable(reason);
  }
  try {
    const output = String(result.stdout || '').trim();
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');
    const payload = jsonStart >= 0 && jsonEnd >= jsonStart ? output.slice(jsonStart, jsonEnd + 1) : output;
    return JSON.parse(payload || '{}');
  } catch (err) {
    const reason = `Unable to parse SCIM semantic search output: ${err?.message || err}`;
    daemonLog(`${reason}: ${(result.stdout || '').slice(0, 1000)}`);
    return semanticSearchUnavailable(reason);
  }
}

const SEARCH_STOPWORDS = new Set([
  'about', 'actually', 'after', 'again', 'against', 'also', 'anything', 'around',
  'because', 'been', 'before', 'being', 'break', 'breaks', 'code', 'could',
  'does', 'file', 'files', 'find', 'from', 'function', 'functions', 'have',
  'here', 'implemented', 'into', 'this', 'that', 'their', 'there', 'these',
  'they', 'thing', 'what', 'when', 'where', 'which', 'with', 'work', 'works',
]);

const SEARCH_SYNONYMS = {
  autocomplete: ['suggest', 'suggestion', 'suggestions', 'complete', 'completion'],
  autocompletion: ['suggest', 'suggestion', 'suggestions', 'complete', 'completion'],
  bug: ['error', 'exception', 'fail', 'failure'],
  changed: ['diff', 'status', 'modified'],
  change: ['diff', 'status', 'modified'],
  start: ['entry', 'main', 'activate', 'startup'],
  starts: ['entry', 'main', 'activate', 'startup'],
  implemented: ['defined', 'handler', 'source'],
};

function searchTerms(query) {
  const terms = Array.from(new Set(String(query || '')
    .match(/[A-Za-z_][A-Za-z0-9_]*/g) || []))
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && !SEARCH_STOPWORDS.has(term));
  const expanded = new Set(terms);
  for (const term of terms) {
    for (const synonym of SEARCH_SYNONYMS[term] || []) {
      expanded.add(synonym);
    }
  }
  return Array.from(expanded);
}

function scoreTextForQuery(text, query, terms) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) {
    return 0;
  }
  const exact = String(query || '').trim().toLowerCase();
  let score = exact && haystack.includes(exact) ? 120 : 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length > 5 ? 12 : 8;
    }
  }
  return score;
}

function snippetForTerms(text, query, terms) {
  const haystack = String(text || '');
  const lower = haystack.toLowerCase();
  const exact = String(query || '').trim().toLowerCase();
  let index = exact ? lower.indexOf(exact) : -1;
  if (index < 0) {
    for (const term of terms) {
      index = lower.indexOf(term);
      if (index >= 0) {
        break;
      }
    }
  }
  if (index < 0) {
    index = 0;
  }
  const start = Math.max(0, index - 240);
  const end = Math.min(haystack.length, index + 520);
  return haystack.slice(start, end).replace(/\s+/g, ' ').trim();
}

function searchArtifacts(args) {
  const rawQuery = String(args.query || '').trim();
  const query = rawQuery.toLowerCase();
  const limit = Math.max(1, Math.min(Number(args.limit || 12), 50));
  if (!query) {
    return 'query is required';
  }

  const matches = [];
  const terms = searchTerms(rawQuery);
  const seen = new Set();
  const addMatch = (source, label, text) => {
    const haystack = String(text || '');
    const score = scoreTextForQuery(`${label}\n${haystack}`, rawQuery, terms);
    if (score <= 0) {
      return;
    }
    const key = `${source}\0${label}\0${snippetForTerms(haystack, rawQuery, terms).slice(0, 180)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    matches.push({
      source,
      label,
      score,
      snippet: snippetForTerms(haystack, rawQuery, terms),
    });
  };

  addMatch('CODE.md', 'CODE.md', readTextIfExists(path.join(artifactRoot, 'CODE.md'), 2_000_000));

  for (const relPath of ['repo_text/repo_text.json', 'repo_text/repo_comments.json']) {
    const data = readJsonIfExists(firstExistingArtifactPath(relPath).filePath);
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

  const functionsPath = path.join(artifactRoot, 'scim', 'functions.jsonl');
  if (fs.existsSync(functionsPath)) {
    for (const record of loadFunctionRecords()) {
      const symbol = record.symbol || record.fullName || record.name || '';
      addMatch('scim/functions.jsonl', symbol, [
        symbol,
        record.path || '',
        record.title || '',
        record.code || '',
      ].join('\n'));
    }
  }

  matches.sort((a, b) => b.score - a.score || String(a.source).localeCompare(String(b.source)) || String(a.label).localeCompare(String(b.label)));

  const semantic = searchScimVectors({ query: args.query, limit });
  return JSON.stringify({
    query: args.query,
    count: Math.min(matches.length, limit),
    matches: matches.slice(0, limit),
    semantic_count: semantic.matches.length,
    semantic_matches: semantic.matches,
    semantic_search: {
      available: semantic.available,
      source: semantic.source,
      model: semantic.model || '',
      reason: semantic.reason || '',
    },
  }, null, 2);
}

function isTestFile(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/').toLowerCase();
  const name = normalized.split('/').pop() || normalized;
  return (
    /(^|\/)(__tests__|tests?|spec)(\/|$)/.test(normalized) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /(_test|test_)[A-Za-z0-9_-]*\.py$/.test(name) ||
    /Test\.(java|kt|cs|go|rs)$/i.test(name)
  );
}

function sourceExtensionsForTests() {
  return new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.java', '.kt', '.kts', '.cs', '.go', '.rs',
    '.rb', '.php',
  ]);
}

function walkWorkspaceFiles(root, predicate, maxFiles = 20000) {
  const out = [];
  const skipped = new Set(['.git', '.codemd', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', '.pytest_cache', '.venv', 'venv', 'env']);
  const shouldSkipDir = (name) => {
    const lower = String(name || '').toLowerCase();
    return skipped.has(lower) || /^output[_-]/.test(lower) || /^artifact[_-]/.test(lower) || /^release[_-]/.test(lower);
  };
  const visit = (dir) => {
    if (out.length >= maxFiles) {
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) {
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
          visit(full);
        }
      } else if (entry.isFile() && predicate(full)) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

function loadFunctionRecords() {
  const functionsPath = path.join(artifactRoot, 'scim', 'functions.jsonl');
  if (!fs.existsSync(functionsPath)) {
    return [];
  }
  const records = [];
  for (const line of fs.readFileSync(functionsPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        // Skip malformed rows.
      }
    }
  return records;
}

function decodeJsonStringLiteral(raw) {
  if (raw === undefined || raw === null) {
    return '';
  }
  try {
    return JSON.parse(`"${String(raw)}"`);
  } catch {
    return String(raw);
  }
}

function loadFunctionRecordsLight() {
  const functionsPath = path.join(artifactRoot, 'scim', 'functions.jsonl');
  if (!fs.existsSync(functionsPath)) {
    return [];
  }
  const records = [];
  for (const line of fs.readFileSync(functionsPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const symbolMatch = line.match(/"symbol"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const pathMatch = line.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!symbolMatch || !pathMatch) {
      continue;
    }
    const startMatch = line.match(/"start_line"\s*:\s*([0-9]+)/);
    const callersMatch = line.match(/"callers"\s*:\s*(\[[^\]]*\])/);
    const calleesMatch = line.match(/"callees"\s*:\s*(\[[^\]]*\])/);
    let callers = [];
    let callees = [];
    try {
      callers = callersMatch ? JSON.parse(callersMatch[1]) : [];
    } catch {
      callers = [];
    }
    try {
      callees = calleesMatch ? JSON.parse(calleesMatch[1]) : [];
    } catch {
      callees = [];
    }
    records.push({
      symbol: decodeJsonStringLiteral(symbolMatch[1]),
      path: decodeJsonStringLiteral(pathMatch[1]),
      start_line: startMatch ? Number(startMatch[1]) : '',
      callers,
      callees,
    });
  }
  return records;
}

function resolveFunctionRecords(query, limit = 8) {
  const raw = String(query || '').trim();
  const lowered = raw.toLowerCase();
  const tail = functionTail(raw).toLowerCase();
  const terms = searchTerms(raw);
  const scored = [];
  for (const record of loadFunctionRecords()) {
    const symbol = String(record.symbol || record.fullName || record.name || '');
    const name = String(record.name || record.method_name || functionTail(symbol));
    const relPath = String(record.path || record.file || '');
    const haystack = `${symbol}\n${name}\n${relPath}\n${record.code || ''}`.toLowerCase();
    let score = 0;
    if (symbol.toLowerCase() === lowered || name.toLowerCase() === lowered) {
      score += 200;
    }
    if (functionTail(symbol).toLowerCase() === tail || name.toLowerCase() === tail) {
      score += 120;
    }
    if (lowered && haystack.includes(lowered)) {
      score += 80;
    }
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += term.length > 5 ? 12 : 8;
      }
    }
    if (score > 0) {
      scored.push({ score, record });
    }
  }
  scored.sort((a, b) => b.score - a.score || String(a.record.symbol || '').localeCompare(String(b.record.symbol || '')));
  return scored.slice(0, limit);
}

function likelySourceImportSpecifiers(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/');
  const ext = path.posix.extname(normalized);
  const withoutExt = ext ? normalized.slice(0, -ext.length) : normalized;
  const base = path.posix.basename(withoutExt);
  return Array.from(new Set([
    withoutExt,
    `./${withoutExt}`,
    `../${withoutExt}`,
    base,
    `./${base}`,
    `../${base}`,
  ].filter(Boolean)));
}

function findTests(args) {
  const query = String(args.query || args.symbol || args.node_query || '').trim();
  const limit = Math.max(1, Math.min(Number(args.limit || 12), 50));
  if (!query) {
    return JSON.stringify({ query, error: 'query is required', matches: [] }, null, 2);
  }
  const targets = resolveFunctionRecords(query, 8);
  const targetRecords = targets.map((item) => item.record);
  const targetTerms = new Set(searchTerms(query));
  for (const record of targetRecords) {
    const symbol = String(record.symbol || '');
    const name = String(record.name || record.method_name || functionTail(symbol));
    const relPath = String(record.path || '');
    for (const value of [symbol, name, functionTail(symbol), path.posix.basename(relPath, path.posix.extname(relPath))]) {
      for (const term of searchTerms(value)) {
        targetTerms.add(term);
      }
    }
  }

  const extSet = sourceExtensionsForTests();
  const testFiles = walkWorkspaceFiles(workspaceRoot, (full) => {
    const rel = path.relative(workspaceRoot, full).replace(/\\/g, '/');
    return extSet.has(path.extname(full).toLowerCase()) && isTestFile(rel);
  });
  const matches = [];
  for (const full of testFiles) {
    const rel = path.relative(workspaceRoot, full).replace(/\\/g, '/');
    let text = '';
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    let score = 0;
    const reasons = [];
    for (const record of targetRecords) {
      const symbol = String(record.symbol || '');
      const name = String(record.name || record.method_name || functionTail(symbol));
      const sourcePath = String(record.path || '').replace(/\\/g, '/');
      for (const spec of likelySourceImportSpecifiers(sourcePath)) {
        if (spec && lower.includes(spec.toLowerCase())) {
          score += 90;
          reasons.push(`imports/references ${spec}`);
          break;
        }
      }
      if (name && lower.includes(name.toLowerCase())) {
        score += 70;
        reasons.push(`mentions symbol ${name}`);
      }
      if (symbol && lower.includes(symbol.toLowerCase())) {
        score += 100;
        reasons.push(`mentions full symbol ${symbol}`);
      }
    }
    for (const term of targetTerms) {
      if (term.length >= 3 && lower.includes(term)) {
        score += term.length > 5 ? 8 : 5;
      }
    }
    if (score <= 0) {
      continue;
    }
    matches.push({
      file: rel,
      score,
      reasons: Array.from(new Set(reasons)).slice(0, 8),
      snippet: snippetForTerms(text, query, Array.from(targetTerms)).slice(0, 1200),
    });
  }
  matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return JSON.stringify({
    query,
    target_candidates: targetRecords.map((record) => ({
      symbol: record.symbol || '',
      path: record.path || '',
      start_line: record.start_line || record.startLine || '',
      end_line: record.end_line || record.endLine || '',
    })),
    test_file_count: testFiles.length,
    match_count: Math.min(matches.length, limit),
    matches: matches.slice(0, limit),
    note: matches.length
      ? 'Likely test coverage based on test-file naming, imports/path references, and symbol mentions. Verify assertions in the source test file.'
      : 'No likely test file references were found. This may mean the target is untested, tests use indirect integration coverage, or the target symbol was not indexed.',
  }, null, 2);
}

function runGit(args, timeout = 15000) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function parseGitStatusPorcelain(text) {
  const files = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const status = line.slice(0, 2).trim() || 'changed';
    let file = line.slice(3).trim();
    if (file.includes(' -> ')) {
      file = file.split(' -> ').pop().trim();
    }
    if (file) {
      files.push({ status, file: file.replace(/\\/g, '/') });
    }
  }
  return files;
}

function reviewChanges(args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit || 30), 100));
  const status = runGit(['status', '--porcelain=v1', '-uno']);
  if (status.status !== 0) {
    return JSON.stringify({
      available: false,
      error: (status.stderr || status.stdout || 'git status failed').trim(),
      matches: [],
    }, null, 2);
  }

  const allChangedFiles = parseGitStatusPorcelain(status.stdout);
  const stat = runGit(['diff', '--stat']);
  const nameStatus = runGit(['diff', '--name-status']);
  const functions = loadFunctionRecordsLight();
  const changedSet = new Set(allChangedFiles.map((item) => item.file));
  const changedFunctions = [];
  for (const record of functions) {
    const rel = String(record.path || '').replace(/\\/g, '/');
    if (!changedSet.has(rel)) {
      continue;
    }
    const symbol = String(record.symbol || record.fullName || record.name || '');
    const directCallers = (Array.isArray(record.callers) ? record.callers : []).map((item) => String(item || '')).filter(Boolean).sort();
    const directCallees = (Array.isArray(record.callees) ? record.callees : []).map((item) => String(item || '')).filter(Boolean).sort();
    changedFunctions.push({
      symbol,
      path: rel,
      start_line: record.start_line || record.startLine || '',
      direct_callers: directCallers.slice(0, 12),
      direct_callees: directCallees.slice(0, 12),
      review_priority: directCallers.length >= 5 ? 'high' : directCallers.length || directCallees.length ? 'medium' : 'low',
    });
  }
  changedFunctions.sort((a, b) =>
    (b.direct_callers.length - a.direct_callers.length) ||
    String(a.path).localeCompare(String(b.path)) ||
    String(a.symbol).localeCompare(String(b.symbol)),
  );

  return JSON.stringify({
    available: true,
    changed_file_count: allChangedFiles.length,
    changed_files: allChangedFiles.slice(0, limit),
    diff_name_status: nameStatus.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, limit),
    diff_stat: stat.stdout.trim(),
    changed_function_count: changedFunctions.length,
    changed_functions: changedFunctions.slice(0, limit),
    note: allChangedFiles.length
      ? 'Review priority is based on changed source symbols plus direct callers/callees from cached static analysis. Verify the diff and tests before merging.'
      : 'No tracked local git diff was found. Untracked files are intentionally excluded by default.',
  }, null, 2);
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

function scimReferenceTierInfo() {
  return {
    tier: 'medium',
    label: 'SCIM source-reference match - symbol name appears in a function body; verify dynamic dispatch and same-name methods in source',
  };
}

function addScimFunctionReferenceEdges(forward, backward, locations, nodes, edgeInfo) {
  const records = loadFunctionRecords();
  if (!records.length) {
    return;
  }
  const symbolsByName = new Map();
  const addCandidateName = (name, symbol) => {
    const key = String(name || '').trim().toLowerCase();
    if (key.length < 4 || !symbol) {
      return;
    }
    if (!symbolsByName.has(key)) {
      symbolsByName.set(key, new Set());
    }
    symbolsByName.get(key).add(symbol);
  };
  for (const record of records) {
    const symbol = String(record.symbol || record.fullName || record.name || '').trim();
    if (!symbol) {
      continue;
    }
    nodes.add(symbol);
    locations[symbol] = {
      file: String(record.path || record.file || locations[symbol]?.file || ''),
      line: record.start_line || record.startLine || locations[symbol]?.line,
    };
    const methodName = String(record.method_name || record.name || functionTail(symbol) || '').trim();
    const tail = functionTail(symbol);
    addCandidateName(methodName, symbol);
    addCandidateName(tail, symbol);
  }

  const tierInfo = scimReferenceTierInfo();
  const callNameRe = /(?:^|[^A-Za-z0-9_$#])(?:this\.|self\.|[A-Za-z_$][A-Za-z0-9_$]*\.)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (const record of records) {
    const from = String(record.symbol || record.fullName || record.name || '').trim();
    const codeLower = String(record.code || '').toLowerCase();
    if (!from || !codeLower) {
      continue;
    }
    const seenNames = new Set();
    for (const match of codeLower.matchAll(callNameRe)) {
      const name = String(match[1] || '').toLowerCase();
      if (seenNames.has(name)) {
        continue;
      }
      seenNames.add(name);
      const targets = symbolsByName.get(name);
      if (!targets) {
        continue;
      }
      for (const to of targets) {
        if (to === from) {
          continue;
        }
        addEdge(forward, from, to);
        addEdge(backward, to, from);
        recordEdgeInfo(edgeInfo, from, to, tierInfo, 'scim/functions.jsonl');
      }
    }
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

  addScimFunctionReferenceEdges(forward, backward, locations, nodes, edgeInfo);

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
    description: 'Read a generated CODE.md artifact such as CODE.md, repo_text/repo_stats.json, or combined_callgraph/combined_callgraph.json.',
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
    description: 'Search CODE.md, repo text, comments, callgraph node names, and SCIM semantic vectors when available. Use this to find likely symbols before reading many files.',
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
    name: 'codemd_semantic_search',
    description: 'Search scim/vectors.sqlite and return ranked semantic code matches with path, symbol, snippet, and score. Falls back with an availability reason when SCIM vectors are missing.',
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
  {
    name: 'codemd_find_tests',
    description: 'Find likely test files covering a function/file/symbol using SCIM functions.jsonl plus generic test-file naming, imports/path references, and symbol mentions. Use for questions like "what tests cover X?" before claiming something is untested.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Function, symbol, file path, or feature terms to find tests for.' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'codemd_review_changes',
    description: 'Summarize the actual local git diff and identify changed indexed functions plus direct callers/callees to guide code review. Use for questions like "what changed?" and "what should I review?".',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum changed files/functions to return.' },
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
    if (name === 'codemd_semantic_search') {
      recordUsage('tool', name);
      return { jsonrpc: '2.0', id, result: textResult(JSON.stringify(searchScimVectors(args), null, 2)) };
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
    if (name === 'codemd_find_tests') {
      recordUsage('tool', name);
      return { jsonrpc: '2.0', id, result: textResult(findTests(args)) };
    }
    if (name === 'codemd_review_changes') {
      recordUsage('tool', name);
      return { jsonrpc: '2.0', id, result: textResult(reviewChanges(args)) };
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
