#!/usr/bin/env node
'use strict';

// PreToolUse hook (matcher: "Grep|Read|Bash|ToolSearch"). Enforces the
// codemd MCP tool-loading nudge that the SessionStart hook alone doesn't:
// a prose reminder in additionalContext can just be skipped, so this blocks
// the FIRST Grep/Read/Bash call of a session until ToolSearch has been used
// to load the codemd_* tools, then gets out of the way for the rest of the
// session (only the first occurrence is gated, not every call).

const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

const input = readStdinJson();
const toolName = String(input.tool_name || '');
const sessionId = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

const stateDir = path.join(os.tmpdir(), 'codemd-nudge');
fs.mkdirSync(stateDir, { recursive: true });
const loadedMarker = path.join(stateDir, `${sessionId}.loaded`);
const blockedMarker = path.join(stateDir, `${sessionId}.blocked`);

if (toolName === 'ToolSearch') {
  const query = JSON.stringify(input.tool_input || {});
  if (query.includes('codemd_search_artifacts') || query.includes('codemd_')) {
    fs.writeFileSync(loadedMarker, String(Date.now()));
  }
  process.exit(0);
}

if (fs.existsSync(loadedMarker) || fs.existsSync(blockedMarker)) {
  process.exit(0);
}

fs.writeFileSync(blockedMarker, String(Date.now()));
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'This project has a codemd MCP server with tools (codemd_search_artifacts, codemd_get_impact_radius, codemd_get_callers, codemd_get_callees, codemd_get_call_paths, codemd_read_artifact, codemd_semantic_search, codemd_find_tests, codemd_review_changes) that are deferred and more useful than raw Grep/Read/Bash for exploring or editing code in this repo. Call ToolSearch with query "select:codemd_search_artifacts,codemd_get_impact_radius,codemd_get_callers,codemd_get_callees,codemd_get_call_paths,codemd_read_artifact,codemd_semantic_search,codemd_find_tests,codemd_review_changes" first, then retry this call. (This only blocks once per session — later Grep/Read/Bash calls will go through.)',
  },
}));
process.exit(0);
