"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const undici_1 = require("undici");
// Local repo analysis (Java/Joern parsing, feature detection, etc.) can run
// well past Node's default 300s undici headers/body timeout on large repos,
// which aborts the client side while the backend keeps working — leaving the
// user with a silent "fetch failed" and an orphaned server process still
// holding the port. Disable timeouts for this one long-running request.
const UPLOAD_AGENT = new undici_1.Agent({ headersTimeout: 0, bodyTimeout: 0 });
const DEFAULT_EXCLUDES = [
    '**/.git/**',
    '**/node_modules/**',
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/.next/**',
    '**/target/**',
    '**/*.pyc',
    '**/.codemd/**',
];
const ARTIFACT_OUTPUT_DIR = '.codemd';
const MCP_OUTPUT_DIR = 'mcp';
// deletion-report.py scores impact off whatever callgraph is already on disk
// (see its docstring) — it doesn't need a fresh regeneration to produce a
// useful uncommitted-edits report. This lets startup show that report
// immediately, before the background regeneration below even finishes.
function hasExistingCallgraphArtifacts(folder) {
    return fs.existsSync(path.join(folder.uri.fsPath, ARTIFACT_OUTPUT_DIR, 'combined_callgraph', 'combined_callgraph.json'));
}
const CODEMD_DIFF_SCHEME = 'codemd-diff';
const WORKSPACE_MCP_CONFIG_FILE = '.mcp.json';
const WORKSPACE_CODEX_DIR = '.codex';
const WORKSPACE_CODEX_CONFIG_FILE = '.codex/config.toml';
const WORKSPACE_CLAUDE_DIR = '.claude';
const WORKSPACE_CLAUDE_SETTINGS_FILE = '.claude/settings.local.json';
const WEBVIEW_SUPPORT_ARTIFACTS = [
    'lib/cytoscape/cytoscape.min.js',
];
const MCP_PROVIDER_ID = 'codemdGraphs.mcp';
const MCP_SERVER_NAME = 'codemd';
const MCP_SERVER_LABEL = 'codemd';
const LEGACY_MCP_SERVER_NAMES = ['CODE.md MCP', 'codemd_mcp_server'];
const MCP_SERVER_NAMES = [MCP_SERVER_NAME, ...LEGACY_MCP_SERVER_NAMES];
let managedVenvSetupPromise = null;
// Keys whose artifacts are bulky or not useful to mirror into the workspace.
// Keep SCIM vector/model artifacts: the backend uses them for semantic search.
const SKIPPED_ARTIFACT_KEY_PATTERN = /train_pairs|download_zip/i;
// combined_navigatable_callgraph.html is the only HTML artifact the panel
// ever displays (see LOCAL_GRAPH_RELATIVE_PATH below) or the MCP server ever
// reads. The per-language/file-graph *_cytoscape.html and
// file_graph_navigatable.html files used to be mirrored here too, but
// nothing in the current backend (main.py) writes them anymore — their
// generators are either uncalled or unreferenced — so any copies on disk are
// stale leftovers from an older build. Mirroring (and rewriting their script
// paths on every load) them was pure wasted work for a file nothing shows.
const MIRRORED_HTML_ARTIFACTS = new Set([
    'combined_callgraph/combined_navigatable_callgraph.html',
]);
function shouldMirrorArtifact(entry, relPath) {
    if (SKIPPED_ARTIFACT_KEY_PATTERN.test(entry.key)) {
        return false;
    }
    if (path.extname(relPath).toLowerCase() !== '.html') {
        return true;
    }
    return MIRRORED_HTML_ARTIFACTS.has(relPath.replace(/\\/g, '/'));
}
function workspaceRelativePath(folder, uri) {
    return path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
}
function workspaceWriteIsAllowed(normalizedRelPath, kind) {
    if (kind === 'file' &&
        (normalizedRelPath === WORKSPACE_MCP_CONFIG_FILE ||
            normalizedRelPath === WORKSPACE_CODEX_CONFIG_FILE ||
            normalizedRelPath === WORKSPACE_CLAUDE_SETTINGS_FILE)) {
        return true;
    }
    if (kind === 'directory' && (normalizedRelPath === WORKSPACE_CODEX_DIR || normalizedRelPath === WORKSPACE_CLAUDE_DIR)) {
        return true;
    }
    return normalizedRelPath === ARTIFACT_OUTPUT_DIR || normalizedRelPath.startsWith(`${ARTIFACT_OUTPUT_DIR}/`);
}
function assertWorkspaceWriteAllowed(uri, operation, kind) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
        return;
    }
    const relPath = workspaceRelativePath(folder, uri);
    const normalized = relPath.replace(/^\.?\//, '');
    if (!workspaceWriteIsAllowed(normalized, kind)) {
        throw new Error(`Blocked ${operation} to workspace file "${relPath}". CODE.md only writes ${ARTIFACT_OUTPUT_DIR}/, ${WORKSPACE_MCP_CONFIG_FILE}, and ${WORKSPACE_CLAUDE_SETTINGS_FILE}.`);
    }
}
async function safeWorkspaceCreateDirectory(uri) {
    assertWorkspaceWriteAllowed(uri, 'directory creation', 'directory');
    await vscode.workspace.fs.createDirectory(uri);
}
async function safeWorkspaceWriteFile(uri, content) {
    assertWorkspaceWriteAllowed(uri, 'file write', 'file');
    await vscode.workspace.fs.writeFile(uri, content);
}
async function safeWorkspaceCopy(source, target) {
    assertWorkspaceWriteAllowed(target, 'file copy', 'file');
    await vscode.workspace.fs.copy(source, target, { overwrite: true });
}
let serverProcess = null;
let outputChannel;
let statusBarItem;
let debugLogPath = '';
let staleServerCleanupPromise = null;
function initializeDebugLog(context) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    debugLogPath = folder
        ? path.join(folder.uri.fsPath, ARTIFACT_OUTPUT_DIR, 'codemd-extension-debug.log')
        : path.join(context.logUri.fsPath, 'codemd-extension-debug.log');
    try {
        fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
        fs.appendFileSync(debugLogPath, `\n===== CODE.md extension session ${new Date().toISOString()} =====\n`, 'utf8');
    }
    catch (err) {
        outputChannel?.appendLine(`[debugLog] could not initialize ${debugLogPath}: ${err?.message || String(err)}`);
    }
}
function logDebug(line) {
    outputChannel?.appendLine(line);
    if (!debugLogPath) {
        return;
    }
    try {
        fs.appendFileSync(debugLogPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
    }
    catch (err) {
        outputChannel?.appendLine(`[debugLog] append failed: ${err?.message || String(err)}`);
    }
}
// Every python process we spawn (the long-lived FastAPI server, and the
// one-shot CLI analyzer) can itself spawn Joern (java.exe) as a grandchild
// for Java call-graph analysis. Killing just the direct child leaves Joern
// running as an orphan holding CPU/memory and, on Windows, a lock on this
// extension's own install folder (which then blocks the next reinstall).
// Track every spawned process here so we can tree-kill all of them on stop.
const trackedProcesses = new Set();
function trackProcess(proc) {
    trackedProcesses.add(proc);
    proc.on('exit', () => trackedProcesses.delete(proc));
}
function killProcessTree(pid) {
    if (process.platform === 'win32') {
        // /T kills the whole descendant tree (e.g. java.exe spawned by the python
        // server), not just the one PID that .kill() would target. Fire-and-forget
        // async spawn — spawnSync here would block the whole extension host until
        // taskkill exits, and callers don't need to wait for the kill to finish.
        const proc = (0, child_process_1.spawn)('taskkill', ['/PID', String(pid), '/T', '/F']);
        proc.on('error', (err) => {
            outputChannel?.appendLine(`[killProcessTree] taskkill failed for PID ${pid}: ${err.message}`);
        });
    }
    else {
        try {
            // Requires the child to have been spawned with `detached: true` so its
            // pid is also its process group id; negative pid signals the whole group.
            process.kill(-pid, 'SIGKILL');
        }
        catch {
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch {
                // Already gone.
            }
        }
    }
}
/**
 * Best-effort cleanup for a stale server left running from a previous
 * Extension Host session (e.g. VS Code was force-closed or a reinstall tore
 * down the host mid-request, so deactivate() never ran). Finds whatever is
 * LISTENING on the configured port and tree-kills it before we try to start
 * our own server there. Windows-only for now (netstat -ano output format is
 * platform-specific); no-ops safely elsewhere.
 */
function killStaleServerOnPort(port) {
    if (process.platform !== 'win32') {
        return Promise.resolve();
    }
    // Async/non-blocking: spawnSync here would freeze the whole extension host
    // (and everything else running in it) until netstat exits. Nothing in
    // activate() depends on this finishing before it returns — our own server
    // is only started later, on demand — so fire it and let it resolve in the
    // background.
    const netstatStart = Date.now();
    outputChannel?.appendLine('[killStaleServerOnPort] spawning netstat -ano (async)...');
    let stdout = '';
    return new Promise((resolve) => {
        const proc = (0, child_process_1.spawn)('netstat', ['-ano']);
        proc.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        proc.on('error', (err) => {
            outputChannel?.appendLine(`\n--- Stale-server cleanup on port ${port} skipped: ${err.message} ---`);
            resolve();
        });
        proc.on('close', (code) => {
            outputChannel?.appendLine(`[killStaleServerOnPort] netstat -ano returned in ${Date.now() - netstatStart}ms (code=${code})`);
            if (code !== 0 || !stdout) {
                resolve();
                return;
            }
            const pids = new Set();
            for (const line of stdout.split('\n')) {
                if (!line.includes(`:${port} `) && !line.includes(`:${port}\r`)) {
                    continue;
                }
                if (!/LISTENING/i.test(line)) {
                    continue;
                }
                const match = line.trim().match(/(\d+)\s*$/);
                if (match) {
                    pids.add(Number(match[1]));
                }
            }
            if (pids.size === 0) {
                resolve();
                return;
            }
            let remaining = pids.size;
            const finishOne = () => {
                remaining -= 1;
                if (remaining <= 0) {
                    resolve();
                }
            };
            for (const pid of pids) {
                outputChannel?.appendLine(`\n--- Found a stale process (PID ${pid}) already listening on port ${port} from a previous session — killing it before starting a fresh server ---`);
                const killer = (0, child_process_1.spawn)('taskkill', ['/PID', String(pid), '/T', '/F']);
                killer.on('error', (err) => {
                    outputChannel?.appendLine(`[killStaleServerOnPort] taskkill failed for PID ${pid}: ${err.message}`);
                    finishOne();
                });
                killer.on('close', (taskkillCode) => {
                    outputChannel?.appendLine(`[killStaleServerOnPort] taskkill for PID ${pid} exited with code ${taskkillCode}`);
                    finishOne();
                });
            }
        });
    });
}
// Deliberately NOT context.extensionUri — that path is inside VS Code's
// versioned extension folder (…codeval-codemd-graphs-0.0.1) and changes on
// every reinstall. A command path baked into .mcp.json/config.toml that goes
// stale like that leaves any already-running Claude Code/Codex session
// pointed at a now-deleted file until the user manually reconnects. Mirroring
// the script into the workspace's own .codemd/mcp/ (see mirrorMcpServerScript)
// keeps this path stable across reinstalls so existing sessions never break.
function mcpServerScriptPath(workspaceRoot) {
    return path.join(workspaceRoot, ARTIFACT_OUTPUT_DIR, MCP_OUTPUT_DIR, 'codemd-mcp-server.js');
}
function mcpServerArgs(context, workspaceRoot, serverName = MCP_SERVER_NAME) {
    // --extension-root is only used for the server's optional lazy-refresh
    // feature (locating local-analyze.py/backend/); it's fine for it to trail
    // a reinstall by one activation cycle, since a stale value just makes that
    // best-effort refresh skip silently rather than breaking the connection.
    return [
        mcpServerScriptPath(workspaceRoot),
        '--workspace', workspaceRoot,
        '--server-name', serverName,
        '--extension-root', context.extensionUri.fsPath,
    ];
}
function registerMcpProvider(context) {
    const register = vscode.lm?.registerMcpServerDefinitionProvider;
    if (!register) {
        outputChannel?.appendLine('VS Code MCP provider API is not available in this editor version.');
        return;
    }
    context.subscriptions.push(register(MCP_PROVIDER_ID, {
        provideMcpServerDefinitions() {
            return (vscode.workspace.workspaceFolders || []).map((folder) => {
                const server = new vscode.McpStdioServerDefinition(MCP_SERVER_NAME, process.execPath, mcpServerArgs(context, folder.uri.fsPath), { CODEMD_WORKSPACE: folder.uri.fsPath }, context.extension.packageJSON?.version || '0.0.0');
                server.cwd = folder.uri;
                return server;
            });
        },
    }));
}
async function setupClaudeProjectMcp(context, folder) {
    const configUri = vscode.Uri.joinPath(folder.uri, WORKSPACE_MCP_CONFIG_FILE);
    let config = {};
    const existingText = fs.existsSync(configUri.fsPath) ? fs.readFileSync(configUri.fsPath, 'utf8') : '';
    if (fs.existsSync(configUri.fsPath)) {
        try {
            const existing = existingText.trim();
            config = existing ? JSON.parse(existing) : {};
        }
        catch (err) {
            throw new Error(`Could not read .mcp.json: ${err?.message || String(err)}`);
        }
    }
    config.mcpServers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
    // Legacy names only need to stay in .mcp.json long enough for Claude Code's
    // approval (keyed by name) to carry forward to the canonical name — once
    // "codemd" itself is approved, keep them out entirely instead of
    // re-registering duplicate servers on every activation forever.
    const enabledClaudeServers = readEnabledMcpjsonServers(folder);
    const approvedLegacyNames = isClaudeMcpServerApproved(folder)
        ? []
        : LEGACY_MCP_SERVER_NAMES.filter((name) => enabledClaudeServers.includes(name));
    for (const legacyName of LEGACY_MCP_SERVER_NAMES) {
        if (!approvedLegacyNames.includes(legacyName)) {
            delete config.mcpServers[legacyName];
        }
    }
    const serverConfigForName = (serverName) => ({
        command: 'node',
        args: mcpServerArgs(context, folder.uri.fsPath, serverName),
        env: {
            CODEMD_WORKSPACE: folder.uri.fsPath,
        },
    });
    config.mcpServers[MCP_SERVER_NAME] = serverConfigForName(MCP_SERVER_NAME);
    for (const legacyName of approvedLegacyNames) {
        config.mcpServers[legacyName] = serverConfigForName(legacyName);
    }
    const nextText = `${JSON.stringify(config, null, 2)}\n`;
    if (nextText === existingText) {
        return false;
    }
    await safeWorkspaceWriteFile(configUri, Buffer.from(nextText, 'utf8'));
    return true;
}
function claudeLocalSettingsUri(folder) {
    return vscode.Uri.joinPath(folder.uri, ...WORKSPACE_CLAUDE_SETTINGS_FILE.split('/'));
}
function readEnabledMcpjsonServers(folder) {
    const settingsPath = claudeLocalSettingsUri(folder).fsPath;
    if (!fs.existsSync(settingsPath)) {
        return [];
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return Array.isArray(parsed?.enabledMcpjsonServers) ? parsed.enabledMcpjsonServers : [];
    }
    catch {
        return [];
    }
}
// Only the *current* server name counts as approved. A legacy-only entry
// (from before an MCP_SERVER_NAME rename) is stale: .mcp.json no longer has
// that key, so Claude Code's own approval check wouldn't match it either —
// requestClaudeMcpApproval below migrates it forward instead of trusting it.
function isClaudeMcpServerApproved(folder) {
    return readEnabledMcpjsonServers(folder).includes(MCP_SERVER_NAME);
}
// Writes only a narrow, named allowlist entry (never enableAllProjectMcpServers)
// so approval is scoped to CODE.md's own server and can't be used to
// silently trust other/future entries in .mcp.json.
async function approveClaudeMcpServer(folder) {
    const settingsUri = claudeLocalSettingsUri(folder);
    let settings = {};
    if (fs.existsSync(settingsUri.fsPath)) {
        try {
            const existing = fs.readFileSync(settingsUri.fsPath, 'utf8').trim();
            settings = existing ? JSON.parse(existing) : {};
        }
        catch (err) {
            throw new Error(`Could not read ${WORKSPACE_CLAUDE_SETTINGS_FILE}: ${err?.message || String(err)}`);
        }
    }
    const enabled = Array.isArray(settings.enabledMcpjsonServers)
        ? settings.enabledMcpjsonServers.map((name) => String(name))
        : [];
    if (!enabled.includes(MCP_SERVER_NAME)) {
        enabled.push(MCP_SERVER_NAME);
    }
    settings.enabledMcpjsonServers = enabled;
    await safeWorkspaceCreateDirectory(vscode.Uri.joinPath(folder.uri, WORKSPACE_CLAUDE_DIR));
    await safeWorkspaceWriteFile(settingsUri, Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, 'utf8'));
}
async function migrateClaudeLegacyMcpApproval(folder) {
    if (isClaudeMcpServerApproved(folder)) {
        return false;
    }
    const enabled = readEnabledMcpjsonServers(folder);
    if (LEGACY_MCP_SERVER_NAMES.some((name) => enabled.includes(name))) {
        await approveClaudeMcpServer(folder);
        return true;
    }
    return false;
}
// Asks the user before pre-approving the codemd MCP server for Claude Code,
// so CODE.md never grants itself trust silently. Returns true only if the
// user said yes and the approval was written.
async function requestClaudeMcpApproval(folder) {
    if (await migrateClaudeLegacyMcpApproval(folder)) {
        return true;
    }
    if (isClaudeMcpServerApproved(folder)) {
        return false;
    }
    // Consent already granted under a pre-rename legacy name — carry it
    // forward under the current name instead of asking again.
    const enabled = readEnabledMcpjsonServers(folder);
    if (LEGACY_MCP_SERVER_NAMES.some((name) => enabled.includes(name))) {
        await approveClaudeMcpServer(folder);
        return true;
    }
    const choice = await vscode.window.showInformationMessage(`CODE.md: allow the "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}) server to run automatically with Claude Code in "${folder.name}"? ` +
        'This skips the manual /mcp approval step in Claude Code for this one server.', 'Allow', 'Not now');
    if (choice !== 'Allow') {
        return false;
    }
    await approveClaudeMcpServer(folder);
    return true;
}
function tomlString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function tomlStringArray(values) {
    return `[${values.map(tomlString).join(', ')}]`;
}
function tomlKey(value) {
    return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}
// "auto" means Codex runs codemd's tools without a per-call prompt, mirroring
// what approveClaudeMcpServer does for Claude Code's enabledMcpjsonServers gate.
// Must be one of Codex's actual accepted variants (auto/prompt/writes/approve) —
// "never" is not valid and makes config.toml fail to load.
function codexMcpBlock(context, workspaceRoot, approvalMode = 'prompt') {
    const block = [
        '# BEGIN CODE.md MCP',
        `[mcp_servers.${tomlKey(MCP_SERVER_NAME)}]`,
        'command = "node"',
        `args = ${tomlStringArray(mcpServerArgs(context, workspaceRoot))}`,
        `default_tools_approval_mode = ${tomlString(approvalMode)}`,
        '',
        `[mcp_servers.${tomlKey(MCP_SERVER_NAME)}.env]`,
        `CODEMD_WORKSPACE = ${tomlString(workspaceRoot)}`,
        '# END CODE.md MCP',
        '',
    ].join('\n');
    return block;
}
// Reads the codemd table's current approval mode out of a Codex config.toml's
// text so re-running Set Up MCP doesn't silently downgrade an "auto" approval
// back to "prompt". Also recognizes the legacy invalid "never" value written
// by older versions of this extension, so it's treated as already-approved.
function codexApprovalModeInConfig(configText) {
    const match = configText.match(/# BEGIN CODE\.md MCP[\s\S]*?# END CODE\.md MCP/);
    const scoped = match ? match[0] : configText;
    return /default_tools_approval_mode\s*=\s*"(auto|never)"/.test(scoped) ? 'auto' : 'prompt';
}
function isCodexConfigApproved(configPath) {
    if (!fs.existsSync(configPath)) {
        return false;
    }
    try {
        return codexApprovalModeInConfig(fs.readFileSync(configPath, 'utf8')) === 'auto';
    }
    catch {
        return false;
    }
}
function removeCodexMcpServerTables(existing) {
    const markerPattern = /# BEGIN CODE\.md MCP[\s\S]*?# END CODE\.md MCP\r?\n?/;
    const withoutMarkedBlock = existing.replace(markerPattern, '');
    const lines = withoutMarkedBlock.split(/\r?\n/);
    const kept = [];
    let skipping = false;
    const tableNamesToRemove = new Set(MCP_SERVER_NAMES.flatMap((name) => [`mcp_servers.${name}`, `mcp_servers.${name}.env`]));
    for (const line of lines) {
        const table = line.trim().match(/^\[([^\]]+)\]\s*$/)?.[1];
        if (table) {
            skipping = tableNamesToRemove.has(table) || tableNamesToRemove.has(table.replace(/"([^"]+)"/g, '$1'));
        }
        if (!skipping) {
            kept.push(line);
        }
    }
    return kept.join('\n').trimEnd();
}
function codexConfigWithMcp(existing, block) {
    const base = removeCodexMcpServerTables(existing);
    return `${base}${base.trim() ? '\n\n' : ''}${block}`;
}
async function setupCodexProjectMcp(context, folder) {
    const codexDir = vscode.Uri.joinPath(folder.uri, WORKSPACE_CODEX_DIR);
    const configUri = vscode.Uri.joinPath(folder.uri, ...WORKSPACE_CODEX_CONFIG_FILE.split('/'));
    let existing = '';
    if (fs.existsSync(configUri.fsPath)) {
        try {
            existing = fs.readFileSync(configUri.fsPath, 'utf8');
        }
        catch (err) {
            throw new Error(`Could not read ${WORKSPACE_CODEX_CONFIG_FILE}: ${err?.message || String(err)}`);
        }
    }
    const next = codexConfigWithMcp(existing, codexMcpBlock(context, folder.uri.fsPath, codexApprovalModeInConfig(existing)));
    if (next === existing) {
        return false;
    }
    await safeWorkspaceCreateDirectory(codexDir);
    await safeWorkspaceWriteFile(configUri, Buffer.from(next, 'utf8'));
    return true;
}
function codexUserConfigPath() {
    return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
}
async function setupCodexUserMcp(context, folder) {
    const configPath = codexUserConfigPath();
    const configDir = path.dirname(configPath);
    let existing = '';
    if (fs.existsSync(configPath)) {
        try {
            existing = fs.readFileSync(configPath, 'utf8');
        }
        catch (err) {
            throw new Error(`Could not read Codex user config ${configPath}: ${err?.message || String(err)}`);
        }
    }
    const next = codexConfigWithMcp(existing, codexMcpBlock(context, folder.uri.fsPath, codexApprovalModeInConfig(existing)));
    if (next === existing) {
        return { changed: false, path: configPath };
    }
    await fs.promises.mkdir(configDir, { recursive: true });
    await fs.promises.writeFile(configPath, next, 'utf8');
    return { changed: true, path: configPath };
}
// Flips the codemd table's approval mode to "auto" in both the project and
// user Codex configs, same idea as approveClaudeMcpServer but Codex has no
// separate allowlist file — the mode lives inline in config.toml.
async function approveCodexMcpServer(context, folder) {
    const codexDir = vscode.Uri.joinPath(folder.uri, WORKSPACE_CODEX_DIR);
    const projectConfigUri = vscode.Uri.joinPath(folder.uri, ...WORKSPACE_CODEX_CONFIG_FILE.split('/'));
    let existingProject = '';
    if (fs.existsSync(projectConfigUri.fsPath)) {
        existingProject = fs.readFileSync(projectConfigUri.fsPath, 'utf8');
    }
    await safeWorkspaceCreateDirectory(codexDir);
    await safeWorkspaceWriteFile(projectConfigUri, Buffer.from(codexConfigWithMcp(existingProject, codexMcpBlock(context, folder.uri.fsPath, 'auto')), 'utf8'));
    const userConfigPath = codexUserConfigPath();
    let existingUser = '';
    if (fs.existsSync(userConfigPath)) {
        existingUser = fs.readFileSync(userConfigPath, 'utf8');
    }
    await fs.promises.mkdir(path.dirname(userConfigPath), { recursive: true });
    await fs.promises.writeFile(userConfigPath, codexConfigWithMcp(existingUser, codexMcpBlock(context, folder.uri.fsPath, 'auto')), 'utf8');
}
function isCodexMcpServerApproved(folder) {
    const projectConfigPath = vscode.Uri.joinPath(folder.uri, ...WORKSPACE_CODEX_CONFIG_FILE.split('/')).fsPath;
    return isCodexConfigApproved(projectConfigPath) || isCodexConfigApproved(codexUserConfigPath());
}
// Copies the MCP server script into the workspace's own .codemd/mcp/ so the path
// written into .mcp.json/config.toml (see mcpServerScriptPath) never changes
// across extension reinstalls. Always re-copies (never skipped) so a version
// bump's script changes reach the mirror even though the launch path stays
// fixed — copyIfExists overwrites unconditionally.
async function mirrorMcpServerScript(context, folder) {
    const source = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'codemd-mcp-server.js');
    const targetDir = vscode.Uri.joinPath(folder.uri, ARTIFACT_OUTPUT_DIR, MCP_OUTPUT_DIR);
    await safeWorkspaceCreateDirectory(targetDir);
    const target = vscode.Uri.joinPath(targetDir, 'codemd-mcp-server.js');
    const copied = await copyIfExists(source, target);
    if (!copied) {
        outputChannel?.appendLine(`Could not mirror codemd-mcp-server.js into ${ARTIFACT_OUTPUT_DIR}/${MCP_OUTPUT_DIR}/ — bundled script was not found at ${source.fsPath}.`);
    }
}
async function setupProjectMcpConfigs(context, options) {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0) {
        if (!options.quiet) {
            vscode.window.showErrorMessage('CODE.md: Open a workspace before setting up MCP.');
        }
        return false;
    }
    const failures = [];
    const changedFolders = [];
    const changedCodexUserConfigs = new Set();
    for (const folder of folders) {
        try {
            await mirrorMcpServerScript(context, folder);
            const changedClaude = await setupClaudeProjectMcp(context, folder);
            const changedCodex = await setupCodexProjectMcp(context, folder);
            const changedCodexUser = await setupCodexUserMcp(context, folder);
            // Only ask for MCP approval on explicit, user-initiated setup — never
            // during the quiet background pass on activation.
            const approvedClaude = options.quiet ? await migrateClaudeLegacyMcpApproval(folder) : await requestClaudeMcpApproval(folder);
            if (changedCodexUser.changed) {
                changedCodexUserConfigs.add(changedCodexUser.path);
            }
            if (changedClaude || changedCodex || changedCodexUser.changed || approvedClaude) {
                changedFolders.push(folder.name);
            }
        }
        catch (err) {
            failures.push(`${folder.name}: ${err?.message || String(err)}`);
        }
    }
    if (failures.length) {
        const message = `CODE.md: MCP setup had ${failures.length} issue(s). ${failures.join(' ')}`;
        outputChannel?.appendLine(message);
        if (!options.quiet) {
            vscode.window.showWarningMessage(message);
        }
    }
    else if (changedFolders.length) {
        const codexUserConfigNote = changedCodexUserConfigs.size
            ? ` Codex user config updated: ${Array.from(changedCodexUserConfigs).join(', ')}.`
            : '';
        const message = `CODE.md: Updated MCP config for ${changedFolders.join(', ')}.${codexUserConfigNote} Open a new Claude Code or Codex session in this workspace, then check /mcp or the client's MCP server list for "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}).`;
        outputChannel?.appendLine(message);
        vscode.window.showInformationMessage(message);
    }
    else if (!options.quiet) {
        vscode.window.showInformationMessage(`CODE.md: MCP config is already up to date in the workspace and Codex user config, and "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}) is approved. No client restart needed.`);
    }
    return !failures.length && changedFolders.length > 0;
}
function resolveBundledCodexCli() {
    if (process.platform !== 'win32') {
        return null;
    }
    const extensionRoot = path.join(os.homedir(), '.vscode', 'extensions');
    try {
        const candidates = fs.readdirSync(extensionRoot)
            .filter((name) => /^openai\.chatgpt-/i.test(name))
            .sort()
            .reverse();
        for (const candidate of candidates) {
            const binDir = path.join(extensionRoot, candidate, 'bin');
            if (!fs.existsSync(binDir)) {
                continue;
            }
            const platformBins = fs.readdirSync(binDir).sort().reverse();
            for (const platformBin of platformBins) {
                const codexPath = path.join(binDir, platformBin, 'codex.exe');
                if (fs.existsSync(codexPath)) {
                    return codexPath;
                }
            }
        }
    }
    catch {
        return null;
    }
    return null;
}
// Mirrors resolveBundledCodexCli: the Claude Code VS Code extension ships its
// own native-binary/claude.exe, which `where.exe claude` won't find unless the
// standalone CLI is also separately installed and on PATH. Without this,
// claudeDetected (and MCP setup's terminal-launch dialog) reports "missing"
// even when Claude Code is demonstrably running.
function resolveBundledClaudeCli() {
    if (process.platform !== 'win32') {
        return null;
    }
    const extensionRoot = path.join(os.homedir(), '.vscode', 'extensions');
    try {
        const candidates = fs.readdirSync(extensionRoot)
            .filter((name) => /^anthropic\.claude-code-/i.test(name))
            .sort()
            .reverse();
        for (const candidate of candidates) {
            const claudePath = path.join(extensionRoot, candidate, 'resources', 'native-binary', 'claude.exe');
            if (fs.existsSync(claudePath)) {
                return claudePath;
            }
        }
    }
    catch {
        return null;
    }
    return null;
}
// Async/non-blocking (was spawnSync) — this runs on every panel resolve via
// mcpSetupStatus, and a synchronous spawn there froze the extension host for
// up to 3s (the timeout) per client checked whenever PATH lookup was slow.
function resolveCommand(command) {
    const fallback = () => {
        if (command === 'codex') {
            return resolveBundledCodexCli();
        }
        if (command === 'claude') {
            return resolveBundledClaudeCli();
        }
        return null;
    };
    return new Promise((resolve) => {
        const proc = process.platform === 'win32'
            ? (0, child_process_1.spawn)('where.exe', [command])
            : (0, child_process_1.spawn)('sh', ['-lc', `command -v ${JSON.stringify(command)}`]);
        let stdout = '';
        let settled = false;
        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            if (proc.pid) {
                killProcessTree(proc.pid);
            }
            finish(fallback());
        }, 3000);
        proc.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        proc.on('error', () => finish(fallback()));
        proc.on('close', (code) => {
            if (code === 0) {
                const firstMatch = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
                finish(firstMatch || command);
                return;
            }
            finish(fallback());
        });
    });
}
async function commandExists(command) {
    return Boolean(await resolveCommand(command));
}
function mcpClientDisplayName(client) {
    return client === 'claude' ? 'Claude Code' : 'Codex';
}
function shellQuotedPath(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}
function terminalLaunchCommand(commandPath) {
    if (!commandPath.includes(path.sep)) {
        return commandPath;
    }
    if (process.platform === 'win32' && !/\s/.test(commandPath)) {
        return commandPath;
    }
    const quoted = shellQuotedPath(commandPath);
    return process.platform === 'win32' ? `& ${quoted}` : quoted;
}
function openMcpApprovalCommand(terminal) {
    setTimeout(() => {
        terminal.sendText('/mcp');
    }, 1500);
}
function fileContains(filePath, needle) {
    try {
        return fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(needle);
    }
    catch {
        return false;
    }
}
async function mcpSetupStatus(folder) {
    const workspaceConfigPath = vscode.Uri.joinPath(folder.uri, WORKSPACE_MCP_CONFIG_FILE).fsPath;
    const codexProjectConfigPath = vscode.Uri.joinPath(folder.uri, ...WORKSPACE_CODEX_CONFIG_FILE.split('/')).fsPath;
    const userConfigPath = codexUserConfigPath();
    let workspaceConfig = false;
    try {
        const config = JSON.parse(fs.readFileSync(workspaceConfigPath, 'utf8'));
        workspaceConfig = MCP_SERVER_NAMES.some((name) => Boolean(config?.mcpServers?.[name]));
    }
    catch {
        workspaceConfig = false;
    }
    const codexServerNeedles = MCP_SERVER_NAMES.flatMap((name) => [
        `[mcp_servers.${tomlKey(name)}]`,
        `[mcp_servers.${name}]`,
    ]);
    const codexProjectConfig = codexServerNeedles.some((needle) => fileContains(codexProjectConfigPath, needle));
    const codexUserConfig = codexServerNeedles.some((needle) => fileContains(userConfigPath, needle));
    const [codexDetected, claudeDetected] = await Promise.all([commandExists('codex'), commandExists('claude')]);
    return {
        registered: workspaceConfig || codexProjectConfig || codexUserConfig,
        workspaceConfig,
        claudeApproved: isClaudeMcpServerApproved(folder),
        codexApproved: isCodexMcpServerApproved(folder),
        codexProjectConfig,
        codexUserConfig,
        codexUserConfigPath: userConfigPath,
        codexDetected,
        claudeDetected,
    };
}
async function openMcpClientTerminal(client, folder) {
    const commandPath = await resolveCommand(client);
    if (!commandPath) {
        const displayName = mcpClientDisplayName(client);
        vscode.window.showWarningMessage(`CODE.md: MCP config is ready, but ${displayName} CLI "${client}" was not found by VS Code. Install ${displayName}, add "${client}" to PATH, or restart VS Code after updating PATH.`);
        return;
    }
    const terminal = vscode.window.createTerminal({
        name: `CODE.md ${mcpClientDisplayName(client)}`,
        cwd: folder.uri.fsPath,
        env: client === 'codex' ? { CODEX_HOME: path.dirname(codexUserConfigPath()) } : undefined,
    });
    terminal.show();
    terminal.sendText(terminalLaunchCommand(commandPath));
    openMcpApprovalCommand(terminal);
    if (client === 'claude') {
        const message = isClaudeMcpServerApproved(folder)
            ? `CODE.md: "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}) is pre-approved for this workspace, Claude Code should pick it up automatically.`
            : `CODE.md: Claude Code started and CODE.md will open /mcp automatically. Approve "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}) if it is pending.`;
        vscode.window.showInformationMessage(message);
    }
    else {
        vscode.window.showInformationMessage(`CODE.md: Codex started and CODE.md will open /mcp automatically. Approve "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}) if it is pending.`);
    }
}
const LAST_ACTIVE_VERSION_KEY = 'codemdGraphs.lastActiveVersionSession';
function extensionBundleSignature(context) {
    try {
        const bundlePath = path.join(context.extensionUri.fsPath, 'out', 'extension.js');
        const stat = fs.statSync(bundlePath);
        return `${context.extension.packageJSON?.version || ''}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    }
    catch {
        return String(context.extension.packageJSON?.version || '');
    }
}
/**
 * VS Code registers contributes.viewsContainers/views (our activity-bar
 * webview) once when the window/renderer starts, and does NOT re-read them
 * when an extension is uninstalled+reinstalled or updated while the window
 * stays open — only the extension host restarts, which is why commands and
 * the backend server come back up fine. The already-resolved webview panel
 * is left pointing at the now-dead old host, so it silently stops receiving
 * postMessage updates (blank/frozen) until "Developer: Reload Window" forces
 * the renderer to re-resolve it against the current host.
 *
 * vscode.env.sessionId only changes on an actual window restart/reload, not
 * when just the extension host bounces — so comparing it lets us tell "this
 * is a genuinely new window" (no problem) apart from "the extension was
 * reinstalled/updated in a window that's still running" (webview is stale)
 * and only prompt in the latter case.
 */
function warnIfReactivatedInStaleWindow(context) {
    const currentVersion = String(context.extension.packageJSON?.version || '');
    const currentSignature = extensionBundleSignature(context);
    const stored = context.globalState.get(LAST_ACTIVE_VERSION_KEY);
    context.globalState.update(LAST_ACTIVE_VERSION_KEY, {
        version: currentVersion,
        signature: currentSignature,
        sessionId: vscode.env.sessionId,
    });
    const storedSignature = stored?.signature || stored?.version || '';
    if (!stored || stored.sessionId !== vscode.env.sessionId || storedSignature === currentSignature) {
        return;
    }
    outputChannel?.appendLine(`[activate] detected extension bundle change within the same window (${storedSignature} -> ${currentSignature}); prompting for reload.`);
    vscode.window
        .showInformationMessage('CODE.md was reinstalled/updated while this window was open. Reload the window to finish activating the graph view.', 'Reload Now')
        .then((choice) => {
        if (choice === 'Reload Now') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });
}
async function activate(context) {
    outputChannel = vscode.window.createOutputChannel('CODE.md');
    context.subscriptions.push(outputChannel);
    initializeDebugLog(context);
    outputChannel.appendLine('[activate] begin');
    logDebug(`[activate] debug log: ${debugLogPath}`);
    warnIfReactivatedInStaleWindow(context);
    const config = vscode.workspace.getConfiguration('codemdGraphs');
    // Stale server cleanup runs lazily right before starting a new backend. That
    // gives us a chance to reuse a healthy backend left from an extension-host
    // restart instead of killing it during activation.
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'codemdGraphs.open';
    statusBarItem.text = '$(circle-outline) CODE.md';
    statusBarItem.tooltip = 'CODE.md';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    outputChannel.appendLine('[activate] constructing GraphsViewProvider');
    const provider = new GraphsViewProvider(context);
    outputChannel.appendLine('[activate] GraphsViewProvider constructed');
    registerMcpProvider(context);
    outputChannel.appendLine('[activate] registerMcpProvider done');
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('codemdGraphs.panel', provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    outputChannel.appendLine('[activate] webview view provider registered');
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CODEMD_DIFF_SCHEME, new GitShowContentProvider()));
    context.subscriptions.push(vscode.commands.registerCommand('codemd', () => provider.reveal()));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.open', () => provider.reveal()));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.openEditor', () => provider.openEditorPanel()));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.generate', () => provider.runGenerate({ quiet: false })));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.setupMcp', () => setupProjectMcpConfigs(context, { quiet: false })));
    context.subscriptions.push(vscode.commands.registerCommand('codemdlocal.generate', () => provider.runGenerate({ quiet: false })));
    context.subscriptions.push(vscode.commands.registerCommand('codemdLocal.generate', () => provider.runGenerate({ quiet: false })));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.stopServer', stopServer));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.openDebugLog', async () => {
        if (!debugLogPath) {
            initializeDebugLog(context);
        }
        await vscode.window.showTextDocument(vscode.Uri.file(debugLogPath), { preview: false });
    }));
    // Kick off an initial background analysis so the graph is already there by
    // the time the user opens the panel — no manual "Generate" click needed.
    // ensureLocalGraphLoaded() (called from the provider's constructor above)
    // already showed whatever graph was mirrored on disk before this runs, so
    // this only ever builds/refreshes — it never blocks that first paint.
    if (vscode.workspace.workspaceFolders?.length) {
        const folder = vscode.workspace.workspaceFolders[0];
        if (config.get('autoWriteProjectMcpConfig') !== false) {
            // Awaited (unlike the analysis kick-off below, which deliberately
            // isn't) so the .mcp.json/config.toml rewrite — and the .codemd/
            // script mirror it depends on — is guaranteed on disk before a
            // freshly-opened terminal in this window could race to read it.
            await setupProjectMcpConfigs(context, { quiet: true });
        }
        const startupAnalysis = provider.runGenerate({ quiet: true });
        // Surface the panel itself, unprompted — previously the extension only
        // prepared the graph in the background and waited for the user to
        // discover and click the new "CODE.md" activity bar icon, so the
        // callgraph never actually appeared unless they knew to look for it.
        if (config.get('autoReveal') !== false) {
            outputChannel.appendLine('[activate] calling provider.reveal()');
            provider.reveal().then(() => outputChannel.appendLine('[activate] provider.reveal() resolved'), (err) => outputChannel.appendLine(`[activate] provider.reveal() REJECTED: ${err?.message || err}`));
        }
        // Don't make the user click "Check Uncommitted Edits" themselves the
        // first time, and don't make them wait for the regeneration above to
        // finish either — if a callgraph from a previous run is already on
        // disk, show its uncommitted-edits report right away.
        if (hasExistingCallgraphArtifacts(folder)) {
            void provider.runChangesCheckAfterInitialGraphPost({ quietIfBusy: true });
        }
        startupAnalysis
            .catch((err) => {
            outputChannel?.appendLine(`Startup analysis failed before change check: ${err?.message || String(err)}`);
        })
            .then(() => provider.runChangesCheckAfterInitialGraphPost({ focusHighestImpact: true, quietIfBusy: true }));
    }
    outputChannel.appendLine('[activate] end (synchronous portion returning)');
}
function deactivate() {
    stopServer();
}
// ---------------------------------------------------------------------------
// Local server lifecycle (same approach as vscode-extension-local, kept as an
// independent copy in this extension per its own settings namespace).
// ---------------------------------------------------------------------------
async function resolveBackendDir(context, quiet) {
    const config = vscode.workspace.getConfiguration('codemdGraphs');
    const configured = String(config.get('backendDir') || '').trim();
    if (configured) {
        if (path.isAbsolute(configured)) {
            return configured;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        return path.join(workspaceRoot, configured);
    }
    const bundledBackendDir = path.join(context.extensionUri.fsPath, 'backend');
    if (fs.existsSync(path.join(bundledBackendDir, 'main.py'))) {
        return bundledBackendDir;
    }
    // Background/quiet runs must never surface blocking native UI — a modal
    // folder picker popping up unprompted during automatic startup analysis
    // steals OS focus from whatever else is running (editor, terminal, other
    // tools). Fail quietly instead and let the user fix it via Settings or a
    // manual "Generate CODE.md" run, which is allowed to prompt.
    if (quiet) {
        throw new Error('codemdGraphs.backendDir is not set and no bundled backend was found. ' +
            'Set it in Settings, or run "Generate CODE.md" manually to be prompted for the folder.');
    }
    const picked = await vscode.window.showOpenDialog({
        title: 'Select the folder containing the CODE.md analyzer backend (main.py)',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Use this folder',
    });
    if (!picked || picked.length === 0) {
        throw new Error('codemdGraphs.backendDir is not set. Set it in Settings to the folder containing main.py.');
    }
    const chosen = picked[0].fsPath;
    await config.update('backendDir', chosen, vscode.ConfigurationTarget.Global);
    return chosen;
}
const REQUIREMENTS_HASH_FILE = '.requirements-hash';
/** Candidate ways to invoke a system Python 3, tried in order until one reports a working --version. */
function candidateSystemPythons() {
    if (process.platform === 'win32') {
        return [
            { cmd: 'py', args: ['-3'] },
            { cmd: 'python', args: [] },
            { cmd: 'python3', args: [] },
        ];
    }
    return [
        { cmd: 'python3', args: [] },
        { cmd: 'python', args: [] },
    ];
}
function findSystemPython() {
    for (const candidate of candidateSystemPythons()) {
        try {
            const result = (0, child_process_1.spawnSync)(candidate.cmd, [...candidate.args, '--version'], { timeout: 5000 });
            if (result.status === 0) {
                return candidate;
            }
        }
        catch {
            // Try the next candidate.
        }
    }
    return null;
}
function venvPythonPath(venvDir) {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}
// Backend setup steps (venv creation, pip installs — one of which pulls PyCG
// straight from git+https) and the analyzer run itself have no other way to
// fail: a stalled network fetch, a hung git-credential prompt, etc. would
// otherwise wait on proc.on('exit') forever, leaving the webview stuck on
// whatever status text was last posted with no way to recover short of
// reloading the window. Every spawn here is timeout-bounded and tree-killed
// (killProcessTree, not proc.kill()) so a wedged child can't survive past it.
const VENV_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const ANALYZE_CLI_TIMEOUT_MS = 20 * 60 * 1000;
function runCommand(cmd, args, cwd, onOutput, options = {}) {
    return new Promise((resolve, reject) => {
        const proc = (0, child_process_1.spawn)(cmd, args, { cwd, env: options.env, detached: options.detached });
        trackProcess(proc);
        let timedOut = false;
        const timer = options.timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                if (proc.pid) {
                    killProcessTree(proc.pid);
                }
            }, options.timeoutMs)
            : null;
        proc.stdout?.on('data', (chunk) => onOutput(chunk.toString()));
        proc.stderr?.on('data', (chunk) => onOutput(chunk.toString()));
        proc.on('error', (err) => {
            if (timer) {
                clearTimeout(timer);
            }
            reject(err);
        });
        proc.on('exit', (code) => {
            if (timer) {
                clearTimeout(timer);
            }
            if (timedOut) {
                reject(new Error(`"${cmd} ${args.join(' ')}" timed out after ${Math.round(options.timeoutMs / 1000)}s and was killed. Check the "CODE.md" output channel for what it was doing.`));
                return;
            }
            resolve(code ?? 1);
        });
    });
}
async function ensureVenvPip(pythonExe, backendDir, onStatus) {
    const pipVersionCode = await runCommand(pythonExe, ['-m', 'pip', '--version'], backendDir, (text) => outputChannel.append(text), { timeoutMs: VENV_SETUP_TIMEOUT_MS });
    if (pipVersionCode === 0) {
        return;
    }
    onStatus('Bootstrapping pip in the managed Python environment...');
    outputChannel.appendLine(`\n--- Bootstrapping pip in ${path.dirname(path.dirname(pythonExe))} ---`);
    const ensurePipCode = await runCommand(pythonExe, ['-m', 'ensurepip', '--upgrade'], backendDir, (text) => outputChannel.append(text), { timeoutMs: VENV_SETUP_TIMEOUT_MS });
    if (ensurePipCode !== 0) {
        throw new Error(`Failed to bootstrap pip in the managed Python environment (exit code ${ensurePipCode}). ` +
            'Repair your Python installation so "py -3 -m ensurepip --upgrade" succeeds, or set codemdGraphs.pythonPath to an interpreter with backend/requirements.txt installed.');
    }
}
/**
 * Ensures an isolated venv with the backend's requirements.txt installed exists in the
 * extension's global storage (persists across reloads, isolated per-user, unaffected by
 * extension updates replacing the bundled backend/ folder). Used whenever the user hasn't
 * explicitly overridden codemdGraphs.pythonPath, so a fresh install on any machine works
 * without the user manually installing Python packages first.
 */
async function ensureManagedVenvUnlocked(context, backendDir, onStatus) {
    const venvDir = path.join(context.globalStorageUri.fsPath, 'venv');
    const pythonExe = venvPythonPath(venvDir);
    const requirementsPath = path.join(backendDir, 'requirements.txt');
    const hashFile = path.join(venvDir, REQUIREMENTS_HASH_FILE);
    const requirementsHash = fs.existsSync(requirementsPath)
        ? crypto.createHash('sha256').update(fs.readFileSync(requirementsPath)).digest('hex')
        : '';
    const existingHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8').trim() : '';
    if (fs.existsSync(pythonExe) && requirementsHash && existingHash === requirementsHash) {
        return pythonExe;
    }
    await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    if (!fs.existsSync(pythonExe)) {
        const systemPython = findSystemPython();
        if (!systemPython) {
            throw new Error('Could not find a Python 3 installation on PATH (tried "py -3", "python", "python3"). ' +
                'Install Python 3 from python.org, or set codemdGraphs.pythonPath to an existing interpreter ' +
                'that already has backend/requirements.txt installed.');
        }
        onStatus('Setting up an isolated Python environment for the backend (first run only)…');
        outputChannel.appendLine(`\n--- Creating venv at ${venvDir} using ${systemPython.cmd} ${systemPython.args.join(' ')} ---`);
        const code = await runCommand(systemPython.cmd, [...systemPython.args, '-m', 'venv', venvDir], backendDir, (text) => outputChannel.append(text), { timeoutMs: VENV_SETUP_TIMEOUT_MS });
        if (code !== 0 || !fs.existsSync(pythonExe)) {
            throw new Error(`Failed to create a Python virtual environment at "${venvDir}" (exit code ${code}). ` +
                'Check the "CODE.md" output channel.');
        }
    }
    await ensureVenvPip(pythonExe, backendDir, onStatus);
    if (requirementsHash && existingHash !== requirementsHash) {
        onStatus('Installing backend dependencies (first run only, this can take a minute)…');
        outputChannel.appendLine(`\n--- Installing requirements.txt into ${venvDir} ---`);
        const code = await runCommand(pythonExe, ['-m', 'pip', 'install', '-q', '-r', requirementsPath], backendDir, (text) => outputChannel.append(text), { timeoutMs: VENV_SETUP_TIMEOUT_MS });
        if (code !== 0) {
            throw new Error(`Failed to install backend dependencies (exit code ${code}). Check the "CODE.md" output channel. ` +
                `If this repeats after closing VS Code, delete "${venvDir}" so CODE.md can recreate a clean environment.`);
        }
        await fs.promises.writeFile(hashFile, requirementsHash, 'utf8');
    }
    return pythonExe;
}
async function ensureManagedVenv(context, backendDir, onStatus) {
    if (managedVenvSetupPromise) {
        onStatus('Waiting for the managed Python environment setup to finish...');
        return managedVenvSetupPromise;
    }
    managedVenvSetupPromise = ensureManagedVenvUnlocked(context, backendDir, onStatus);
    try {
        return await managedVenvSetupPromise;
    }
    finally {
        managedVenvSetupPromise = null;
    }
}
async function backendPythonPath(context, backendDir, onStatus) {
    const config = vscode.workspace.getConfiguration('codemdGraphs');
    const pythonInspect = config.inspect('pythonPath');
    const userConfiguredPython = pythonInspect?.workspaceFolderValue ?? pythonInspect?.workspaceValue ?? pythonInspect?.globalValue;
    return userConfiguredPython
        ? String(userConfiguredPython)
        : ensureManagedVenv(context, backendDir, onStatus);
}
function localBackendEnv(context) {
    return {
        ...process.env,
        CODEVAL_OUTPUT_DIR: path.join(context.globalStorageUri.fsPath, 'backend-output'),
        SENTRY_ENABLED: 'false',
        SENTRY_DSN: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        GOOGLE_ANALYTICS_CLIENT_ID: '',
        GOOGLE_ANALYTICS_CLIENT_SECRET: '',
        CODEVAL_MIXPANEL_SECRET_KEY: '',
        CODEVAL_SECRET_ENCRYPTION_KEY: '',
    };
}
async function isServerReachable(baseUrl) {
    try {
        const res = await fetch(`${baseUrl}/openapi.json`);
        return res.ok;
    }
    catch {
        return false;
    }
}
async function ensureServerRunning(context, onStatus, quiet) {
    const config = vscode.workspace.getConfiguration('codemdGraphs');
    const host = String(config.get('host') || '127.0.0.1');
    const port = Number(config.get('port') || 8100);
    const baseUrl = `http://${host}:${port}`;
    if (await isServerReachable(baseUrl)) {
        outputChannel.appendLine(`\n--- Reusing existing local analysis service at ${baseUrl} ---`);
        return baseUrl;
    }
    if (serverProcess && serverProcess.exitCode === null) {
        onStatus('Waiting for the local analysis service to become reachable...');
        try {
            await waitForServerReady(baseUrl, serverProcess, 5000);
            return baseUrl;
        }
        catch {
            outputChannel.appendLine(`\n--- Local server process was running but unreachable at ${baseUrl}; restarting it. ---`);
            stopServer();
        }
    }
    if (!staleServerCleanupPromise) {
        staleServerCleanupPromise = killStaleServerOnPort(port)
            .finally(() => {
            staleServerCleanupPromise = null;
        });
    }
    onStatus('Checking for an old local analysis service...');
    await staleServerCleanupPromise;
    if (await isServerReachable(baseUrl)) {
        outputChannel.appendLine(`\n--- Reusing existing local analysis service at ${baseUrl} after stale-server cleanup ---`);
        return baseUrl;
    }
    const backendDir = await resolveBackendDir(context, quiet);
    const mainPyPath = path.join(backendDir, 'main.py');
    if (!fs.existsSync(mainPyPath)) {
        throw new Error(`Could not find main.py in "${backendDir}". Set codemdGraphs.backendDir to the folder containing the CODE.md analyzer backend.`);
    }
    const pythonPath = await backendPythonPath(context, backendDir, onStatus);
    const args = ['-m', 'uvicorn', 'main:app', '--host', host, '--port', String(port)];
    onStatus('Starting local analysis service…');
    outputChannel.appendLine(`\n--- Starting local server: ${pythonPath} ${args.join(' ')} (cwd: ${backendDir}) ---`);
    // This extension only does local analysis — no error/usage telemetry or
    // third-party integration should leave the machine. main.py defaults Sentry
    // to "on" for hosted service deployments, and Google
    // Analytics / Mixpanel activate whenever their credentials happen to be
    // present in the environment. Force all three off for the locally-spawned
    // server regardless of what's in the launching shell's environment.
    const proc = (0, child_process_1.spawn)(pythonPath, args, {
        cwd: backendDir,
        env: localBackendEnv(context),
        detached: process.platform !== 'win32',
    });
    serverProcess = proc;
    trackProcess(proc);
    proc.stdout.on('data', (chunk) => outputChannel.append(chunk.toString()));
    proc.stderr.on('data', (chunk) => outputChannel.append(chunk.toString()));
    proc.on('exit', (code) => {
        outputChannel.appendLine(`\n--- Local server exited with code ${code} ---`);
        if (serverProcess === proc) {
            serverProcess = null;
        }
    });
    proc.on('error', (err) => {
        outputChannel.appendLine(`\n--- Failed to start local server: ${err.message} ---`);
        if (serverProcess === proc) {
            serverProcess = null;
        }
    });
    await waitForServerReady(baseUrl, proc);
    return baseUrl;
}
function waitForServerReady(baseUrl, proc, timeoutMs = 120000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const check = async () => {
            if (proc.exitCode !== null) {
                reject(new Error('The local FastAPI server exited before it became ready. Check the "CODE.md" output channel, ' +
                    'and make sure requirements.txt is installed for the configured codemdGraphs.pythonPath.'));
                return;
            }
            try {
                const res = await fetch(`${baseUrl}/openapi.json`);
                if (res.ok) {
                    resolve();
                    return;
                }
            }
            catch {
                // Server not accepting connections yet.
            }
            if (Date.now() - start > timeoutMs) {
                reject(new Error(`Timed out waiting for the local FastAPI server to start at ${baseUrl}.`));
                return;
            }
            setTimeout(check, 750);
        };
        check();
    });
}
function stopServer() {
    if (trackedProcesses.size > 0) {
        outputChannel?.appendLine(`\n--- Stopping local server and ${trackedProcesses.size} tracked process(es) ---`);
        for (const proc of trackedProcesses) {
            if (proc.exitCode === null && proc.pid) {
                killProcessTree(proc.pid);
            }
        }
        trackedProcesses.clear();
    }
    serverProcess = null;
}
// ---------------------------------------------------------------------------
// Change detection: skip re-analysis on background startup when git shows
// nothing has changed since the last completed run.
// ---------------------------------------------------------------------------
const ANALYSIS_STATE_FILE = '.analysis-state.json';
const LOCAL_ANALYSIS_RESULT_FILE = '.analysis-result.json';
const MCP_USAGE_FILE = `${MCP_OUTPUT_DIR}/.mcp-usage.json`;
const LOCAL_GRAPH_RELATIVE_PATH = 'combined_callgraph/combined_navigatable_callgraph.html';
const SCIM_FUNCTIONS_RELATIVE_PATH = 'scim/functions.jsonl';
function localGraphFileUri(outDirUri) {
    return vscode.Uri.joinPath(outDirUri, ...LOCAL_GRAPH_RELATIVE_PATH.split('/'));
}
function localAnalysisResultFileUri(outDirUri) {
    return vscode.Uri.joinPath(outDirUri, LOCAL_ANALYSIS_RESULT_FILE);
}
function localMcpUsageFileUri(outDirUri) {
    return vscode.Uri.joinPath(outDirUri, ...MCP_USAGE_FILE.split('/'));
}
function localScimFunctionsFileUri(outDirUri) {
    return vscode.Uri.joinPath(outDirUri, ...SCIM_FUNCTIONS_RELATIVE_PATH.split('/'));
}
async function readMcpUsage(folder) {
    const setup = await mcpSetupStatus(folder);
    const configured = setup.registered;
    try {
        const outDirUri = vscode.Uri.joinPath(folder.uri, ARTIFACT_OUTPUT_DIR);
        const usage = JSON.parse(fs.readFileSync(localMcpUsageFileUri(outDirUri).fsPath, 'utf8'));
        // `clients` is keyed by whatever name each MCP client reported in its
        // `initialize` handshake (e.g. "claude-code", "codex"); usage recorded
        // before this field existed has no client breakdown at all.
        const clientCounts = usage?.clients && typeof usage.clients === 'object' ? usage.clients : {};
        const clients = Object.entries(clientCounts)
            .map(([name, calls]) => ({ name, calls: Number(calls) || 0 }))
            .sort((a, b) => b.calls - a.calls);
        const toolsByClientRaw = usage?.tools_by_client && typeof usage.tools_by_client === 'object' ? usage.tools_by_client : {};
        const toolsByClient = {};
        for (const [clientName, tools] of Object.entries(toolsByClientRaw)) {
            if (!tools || typeof tools !== 'object') {
                continue;
            }
            toolsByClient[String(clientName)] = Object.entries(tools)
                .reduce((normalized, [toolName, calls]) => {
                const callCount = Number(calls) || 0;
                if (callCount > 0) {
                    normalized[toolName] = callCount;
                }
                return normalized;
            }, {});
        }
        const recordedTotal = Number(usage?.total_calls || 0);
        const toolCalls = Object.values(usage?.tools && typeof usage.tools === 'object' ? usage.tools : {})
            .reduce((sum, calls) => sum + (Number(calls) || 0), 0);
        const resourceReads = Object.values(usage?.resources && typeof usage.resources === 'object' ? usage.resources : {})
            .reduce((sum, calls) => sum + (Number(calls) || 0), 0);
        return {
            configured,
            totalCalls: Math.max(recordedTotal, toolCalls + resourceReads),
            updatedAt: String(usage?.updated_at || ''),
            stale: !usage?.updated_at || (Date.now() - Date.parse(String(usage.updated_at || ''))) > 24 * 60 * 60 * 1000,
            clients,
            toolsByClient,
            setup,
            restartNeeded: configured && (!usage?.updated_at || (Date.now() - Date.parse(String(usage.updated_at || ''))) > 24 * 60 * 60 * 1000),
        };
    }
    catch {
        return { configured, totalCalls: 0, updatedAt: '', stale: true, clients: [], toolsByClient: {}, setup, restartNeeded: configured };
    }
}
// ---------------------------------------------------------------------------
// Local (offline) search over the already-generated callgraph artifacts.
// Matches node names directly instead of round-tripping to the backend's
// semantic /search endpoint, so results are deterministic and available
// without the local server running.
// ---------------------------------------------------------------------------
const LOCAL_SEARCH_GRAPH_CANDIDATES = [
    'combined_callgraph/combined_callgraph.json',
    'combined_callgraph/combined_navigatable_callgraph.json',
    'file_graph/file_graph.json',
];
const LOCAL_SEARCH_FUNCTION_FILE_CANDIDATES = [
    'python/python_callgraph.json',
    'javascript/javascript_callgraph.json',
    'csharp/csharp_callgraph.json',
    'java_merged/java_merged_callgraph.json',
    'tree_sitter_java/tree_sitter_java_callgraph.json',
    'javalang/javalang_callgraph.json',
];
function buildFileByNodeIndex(outDirFsPath) {
    const fileByNode = new Map();
    for (const relPath of LOCAL_SEARCH_FUNCTION_FILE_CANDIDATES) {
        const fsPath = path.join(outDirFsPath, ...relPath.split('/'));
        if (!fs.existsSync(fsPath)) {
            continue;
        }
        try {
            const data = JSON.parse(fs.readFileSync(fsPath, 'utf8'));
            const functionFiles = data?.function_files;
            if (!functionFiles || typeof functionFiles !== 'object') {
                continue;
            }
            for (const [fullName, file] of Object.entries(functionFiles)) {
                const parts = String(fullName).split('.');
                // Callgraph node names are often the same dotted path with the
                // leading package/module segment(s) stripped (e.g. "backend.main.foo"
                // -> "main.foo"), so index every meaningful suffix, not just the
                // exact key, without overwriting an earlier (more specific) match.
                for (let start = 0; start < parts.length - 1; start++) {
                    const suffix = parts.slice(start).join('.');
                    if (!fileByNode.has(suffix)) {
                        fileByNode.set(suffix, String(file));
                    }
                }
            }
        }
        catch {
            // Best-effort only — skip files that fail to parse.
        }
    }
    return fileByNode;
}
function loadLocalCallgraphIndex(outDirFsPath) {
    for (const relPath of LOCAL_SEARCH_GRAPH_CANDIDATES) {
        const fsPath = path.join(outDirFsPath, ...relPath.split('/'));
        if (!fs.existsSync(fsPath)) {
            continue;
        }
        try {
            const stat = fs.statSync(fsPath);
            const data = JSON.parse(fs.readFileSync(fsPath, 'utf8'));
            const nodes = Array.isArray(data?.nodes) ? data.nodes.map((n) => String(n)) : [];
            if (!nodes.length) {
                continue;
            }
            const nodeLabels = data?.node_labels && typeof data.node_labels === 'object' ? data.node_labels : {};
            const degree = new Map();
            const edges = Array.isArray(data?.edges) ? data.edges : [];
            for (const edge of edges) {
                const from = Array.isArray(edge) ? String(edge[0]) : String(edge?.from ?? edge?.source ?? '');
                const to = Array.isArray(edge) ? String(edge[1]) : String(edge?.to ?? edge?.target ?? '');
                if (from) {
                    degree.set(from, (degree.get(from) || 0) + 1);
                }
                if (to) {
                    degree.set(to, (degree.get(to) || 0) + 1);
                }
            }
            const entryPoints = Array.isArray(data?.entry_points) ? data.entry_points.map((n) => String(n)) : [];
            return {
                sourcePath: fsPath,
                sourceMtimeMs: stat.mtimeMs,
                nodes,
                nodeLabels,
                fileByNode: buildFileByNodeIndex(outDirFsPath),
                degree,
                entryPoints,
            };
        }
        catch {
            // Try the next candidate.
        }
    }
    return null;
}
/** Higher is a better match; null means the query doesn't match this node at all. */
function scoreLocalCallgraphMatch(query, node, label) {
    const lowerQuery = query.toLowerCase();
    const lowerNode = node.toLowerCase();
    const tail = lowerNode.split('.').pop() || lowerNode;
    const lowerLabel = String(label || '').toLowerCase();
    if (lowerNode === lowerQuery || tail === lowerQuery) {
        return 100;
    }
    if (tail.startsWith(lowerQuery)) {
        return 85;
    }
    if (lowerNode.startsWith(lowerQuery)) {
        return 75;
    }
    if (tail.includes(lowerQuery)) {
        return 60;
    }
    if (lowerNode.includes(lowerQuery)) {
        return 50;
    }
    if (lowerLabel.includes(lowerQuery)) {
        return 35;
    }
    return null;
}
function searchLocalCallgraph(index, query, limit = 12) {
    const matches = [];
    for (const node of index.nodes) {
        const label = index.nodeLabels[node] || '';
        const score = scoreLocalCallgraphMatch(query, node, label);
        if (score !== null) {
            matches.push({ node, score });
        }
    }
    matches.sort((a, b) => b.score - a.score || a.node.length - b.node.length || a.node.localeCompare(b.node));
    return matches.slice(0, limit).map(({ node }) => {
        const tail = node.split('.').pop() || node;
        return {
            label: index.nodeLabels[node] || node,
            file: index.fileByNode.get(node) || '',
            line: '',
            snippet: '',
            graphSymbol: node,
            fullName: node,
            symbol: tail,
            name: tail,
        };
    });
}
function normalizeBackendSearchResult(item) {
    const symbol = String(item?.graph_symbol || item?.graphSymbol || item?.fullName || item?.symbol || item?.name || '');
    const name = String(item?.name || item?.function || item?.title || (symbol.split('.').pop() || symbol));
    const file = String(item?.file || item?.path || '');
    const line = String(item?.line || item?.start_line || '');
    const label = String(item?.label || item?.title || symbol || name || file || 'Search result');
    const snippet = String(item?.snippet || item?.evidence || item?.code || item?.text || '');
    return {
        label,
        file,
        line,
        snippet,
        graphSymbol: symbol,
        fullName: String(item?.fullName || item?.full_name || symbol),
        symbol,
        name,
        impactScore: Number(item?.score || item?.evidence_strength || 0) || undefined,
    };
}
function normalizeBackendTextResult(item) {
    const file = String(item?.file || item?.path || '');
    const line = String(item?.line || item?.start_line || '');
    const kind = String(item?.kind || item?.source || 'Text match');
    const text = String(item?.text || item?.snippet || item?.evidence || '');
    return {
        label: file ? `${kind}: ${file}${line ? ':' + line : ''}` : kind,
        file,
        line,
        snippet: text,
        graphSymbol: '',
        fullName: '',
        symbol: '',
        name: kind,
    };
}
function htmlRelativePrefix(relPath) {
    const depth = relPath.replace(/\\/g, '/').split('/').length - 1;
    return depth > 0 ? '../'.repeat(depth) : './';
}
function rewriteHtmlArtifactForWebview(content, relPath) {
    const supportPrefix = htmlRelativePrefix(relPath);
    const diagnosticsScript = `
<script>
(function () {
  if (window.__codemdGraphDiagnosticsInstalled) { return; }
  window.__codemdGraphDiagnosticsInstalled = true;
  function send(event, detail) {
    try {
      parent.postMessage({
        codemdGraphDebug: true,
        event: event,
        detail: detail || {},
        href: location.href,
        title: document.title || '',
        readyState: document.readyState
      }, '*');
    } catch (_) {}
  }
  window.addEventListener('error', function (event) {
    send('error', {
      message: String(event && event.message || 'unknown error'),
      source: String(event && event.filename || ''),
      line: event && event.lineno,
      stack: event && event.error && event.error.stack ? String(event.error.stack) : ''
    });
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    send('unhandledrejection', {
      message: String(reason && reason.message || reason || 'unknown rejection'),
      stack: reason && reason.stack ? String(reason.stack) : ''
    });
  });
  window.addEventListener('DOMContentLoaded', function () {
    send('DOMContentLoaded', {
      scripts: document.scripts.length,
      cytoscapeLoaded: Boolean(window.cytoscape),
      bodyTextLength: document.body ? document.body.innerText.length : 0
    });
  });
  window.addEventListener('load', function () {
    setTimeout(function () {
      var cyEl = document.getElementById('cy');
      send('load', {
        cytoscapeLoaded: Boolean(window.cytoscape),
        cyElement: Boolean(cyEl),
        cyClientWidth: cyEl ? cyEl.clientWidth : null,
        cyClientHeight: cyEl ? cyEl.clientHeight : null,
        bodyTextLength: document.body ? document.body.innerText.length : 0
      });
    }, 0);
  });
})();
</script>`;
    // Matches whatever prefix the generator emitted — a bare absolute "/lib/…",
    // the generator's current "../lib/…", or a path nested at some other depth
    // — and normalizes it to the correct relative depth for this artifact's
    // actual location, so this stays correct even if the generator's own
    // convention changes later.
    const rewritten = content
        .replace(/(["'`])(?:\.\.\/)*\/?lib\/cytoscape\/cytoscape\.min\.js\1/g, `$1${supportPrefix}lib/cytoscape/cytoscape.min.js$1`)
        .replace('const initialElements = explicitElements.length ? explicitElements : [nodeElement(firstRoot)];', 'const initialElements = explicitElements.length ? explicitElements : flowElementsFor(firstRoot, 1, 16);');
    if (rewritten.includes('__codemdGraphDiagnosticsInstalled')) {
        return rewritten;
    }
    if (/<head[^>]*>/i.test(rewritten)) {
        return rewritten.replace(/<head([^>]*)>/i, `<head$1>\n${diagnosticsScript}`);
    }
    if (/<script\b/i.test(rewritten)) {
        return rewritten.replace(/<script\b/i, `${diagnosticsScript}\n<script`);
    }
    if (/<\/body>/i.test(rewritten)) {
        return rewritten.replace(/<\/body>/i, `${diagnosticsScript}\n</body>`);
    }
    return `${rewritten}\n${diagnosticsScript}`;
}
async function copyIfExists(source, target) {
    try {
        await vscode.workspace.fs.stat(source);
        await safeWorkspaceCopy(source, target);
        return true;
    }
    catch {
        return false;
    }
}
async function repairMirroredArtifactsForWebview(context, outDirUri) {
    for (const relPath of WEBVIEW_SUPPORT_ARTIFACTS) {
        const segments = relPath.split('/');
        const target = vscode.Uri.joinPath(outDirUri, ...segments);
        await safeWorkspaceCreateDirectory(vscode.Uri.joinPath(outDirUri, ...segments.slice(0, -1)));
        const bundled = vscode.Uri.joinPath(context.extensionUri, 'backend', ...segments);
        const copied = await copyIfExists(bundled, target);
        if (!copied) {
            outputChannel?.appendLine(`Skipped webview support artifact ${relPath}: bundled file was not found.`);
        }
    }
    for (const relPath of MIRRORED_HTML_ARTIFACTS) {
        const htmlUri = vscode.Uri.joinPath(outDirUri, ...relPath.split('/'));
        try {
            const original = Buffer.from(await vscode.workspace.fs.readFile(htmlUri)).toString('utf8');
            const rewritten = rewriteHtmlArtifactForWebview(original, relPath);
            if (rewritten !== original) {
                await safeWorkspaceWriteFile(htmlUri, Buffer.from(rewritten, 'utf8'));
            }
        }
        catch (err) {
            outputChannel?.appendLine(`Skipped webview rewrite for ${relPath}: ${err?.message || String(err)}`);
        }
    }
}
/**
 * Cheap proxy for "the workspace changed since the last analysis": the
 * current commit plus tracked/untracked file status, excluding our own
 * generated .codemd/ output (which changes on every run and would
 * otherwise make this always report "changed"). Returns null when the
 * workspace isn't a git repo (or has no commits yet) — callers should treat
 * that as "can't tell, so don't skip."
 */
/**
 * Runs git asynchronously (never spawnSync) — this can be called from the
 * extension host's shared, single-threaded event loop, and a slow git
 * invocation (e.g. under heavy concurrent disk I/O from a venv/pip install)
 * must not freeze every webview in the window while it waits.
 */
function execGitAsync(args, cwd) {
    return new Promise((resolve) => {
        const proc = (0, child_process_1.spawn)('git', args, { cwd });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('error', () => resolve({ status: null, stdout, stderr }));
        proc.on('exit', (code) => resolve({ status: code, stdout, stderr }));
    });
}
// Git's canonical hash for an empty tree — used as the "base" side when
// diffing a repo's root commit, which has no parent to diff against.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
async function resolveCommitParentRef(hash, cwd) {
    const result = await execGitAsync(['rev-parse', '--verify', `${hash}^`], cwd);
    return result.status === 0 ? (result.stdout || '').trim() : EMPTY_TREE_SHA;
}
async function computeGitStateHash(workspaceRoot) {
    const head = await execGitAsync(['rev-parse', 'HEAD'], workspaceRoot);
    if (head.status !== 0) {
        return null;
    }
    const status = await execGitAsync(['status', '--porcelain', '--', '.', `:!${ARTIFACT_OUTPUT_DIR}/**`], workspaceRoot);
    const statusText = status.status === 0 ? status.stdout : '';
    return crypto.createHash('sha256').update(head.stdout.trim() + '\n' + statusText).digest('hex');
}
function readStoredGitStateHash(outDirUri) {
    try {
        const raw = fs.readFileSync(path.join(outDirUri.fsPath, ANALYSIS_STATE_FILE), 'utf8');
        return JSON.parse(raw)?.gitStateHash || null;
    }
    catch {
        return null;
    }
}
async function writeStoredGitStateHash(outDirUri, hash) {
    const content = Buffer.from(JSON.stringify({ gitStateHash: hash, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    await safeWorkspaceWriteFile(vscode.Uri.joinPath(outDirUri, ANALYSIS_STATE_FILE), content);
}
function artifactUrlPrefix(uploadResult, codeMdUrl) {
    const repoId = String(uploadResult?.repo_id || '').trim();
    if (repoId) {
        const marker = `/${repoId}/`;
        const idx = codeMdUrl.indexOf(marker);
        if (idx >= 0) {
            return codeMdUrl.slice(0, idx + marker.length);
        }
    }
    const lastSlash = codeMdUrl.lastIndexOf('/');
    return lastSlash >= 0 ? codeMdUrl.slice(0, lastSlash + 1) : codeMdUrl;
}
function collectArtifactUrls(obj, prefix, seen, out) {
    if (!obj || typeof obj !== 'object') {
        return;
    }
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' && value.startsWith(prefix)) {
            if (!seen.has(value)) {
                seen.add(value);
                out.push({ key, url: value });
            }
        }
        else if (value && typeof value === 'object') {
            collectArtifactUrls(value, prefix, seen, out);
        }
    }
}
async function downloadArtifacts(serverUrl, outDirUri, uploadResult, codeMdUrl) {
    const prefix = artifactUrlPrefix(uploadResult, codeMdUrl);
    const seen = new Set();
    const entries = [];
    collectArtifactUrls(uploadResult, prefix, seen, entries);
    for (const entry of entries) {
        const relPath = entry.url === codeMdUrl ? 'CODE.md' : entry.url.slice(prefix.length);
        if (!relPath) {
            continue;
        }
        if (!shouldMirrorArtifact(entry, relPath)) {
            continue;
        }
        const segments = relPath.split('/');
        const fileName = segments.pop();
        try {
            const parentUri = vscode.Uri.joinPath(outDirUri, ...segments);
            if (segments.length > 0) {
                await safeWorkspaceCreateDirectory(parentUri);
            }
            const buffer = await fetchBuffer(`${serverUrl}${entry.url}`);
            await safeWorkspaceWriteFile(vscode.Uri.joinPath(parentUri, fileName), buffer);
        }
        catch (err) {
            outputChannel?.appendLine(`Skipped ${entry.key} (${entry.url}): ${err?.message || String(err)}`);
        }
    }
}
/**
 * The local server always runs on this same machine, so hand it the
 * workspace's absolute path and let it read the folder in place.
 */
async function analyzeLocalPath(serverUrl, folderPath, workspaceName, report) {
    const response = await (0, undici_1.fetch)(`${serverUrl}/analyze/local_path/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath, name: workspaceName }),
        dispatcher: UPLOAD_AGENT,
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(parseErrorDetail(text) || `HTTP ${response.status}`);
    }
    const started = JSON.parse(text);
    const jobId = String(started?.job_id || '');
    if (!jobId) {
        throw new Error('The local server did not return an analysis job id.');
    }
    return pollAnalyzeJob(serverUrl, jobId, report);
}
async function pollAnalyzeJob(serverUrl, jobId, report) {
    let lastMessage = '';
    for (;;) {
        const response = await fetch(`${serverUrl}/analyze/status/${jobId}`);
        const text = await response.text();
        if (!response.ok) {
            throw new Error(parseErrorDetail(text) || `HTTP ${response.status} while checking analysis status`);
        }
        const job = JSON.parse(text);
        const message = String(job?.message || '');
        if (message && message !== lastMessage) {
            lastMessage = message;
            report?.(message);
        }
        if (job?.status === 'completed') {
            const result = job?.result || job?.partial;
            if (!result) {
                throw new Error('The local analysis completed but did not return artifacts.');
            }
            return result;
        }
        if (job?.status === 'error' || job?.status === 'failed') {
            throw new Error(String(job?.error || job?.message || 'Local analysis failed.'));
        }
        await sleep(2000);
    }
}
async function analyzeLocalPathCli(context, outDirUri, folderPath, workspaceName, report, quiet) {
    const backendDir = await resolveBackendDir(context, quiet);
    const mainPyPath = path.join(backendDir, 'main.py');
    if (!fs.existsSync(mainPyPath)) {
        throw new Error(`Could not find main.py in "${backendDir}". Set codemdGraphs.backendDir to the folder containing the CODE.md analyzer backend.`);
    }
    const scriptPath = path.join(context.extensionUri.fsPath, 'scripts', 'local-analyze.py');
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Could not find the local analyzer CLI at "${scriptPath}".`);
    }
    const pythonPath = await backendPythonPath(context, backendDir, report);
    await safeWorkspaceCreateDirectory(outDirUri);
    const resultPath = localAnalysisResultFileUri(outDirUri).fsPath;
    const args = [
        scriptPath,
        '--path',
        folderPath,
        '--name',
        workspaceName,
        '--mirror-out',
        outDirUri.fsPath,
        '--result-json',
        resultPath,
    ];
    outputChannel.appendLine(`\n--- Running local analyzer CLI: ${pythonPath} ${args.join(' ')} (cwd: ${backendDir}) ---`);
    outputChannel.show(true);
    report('Analyzing locally with the CODE.md CLI (no FastAPI server needed for generation)...');
    const exitCode = await runCommand(pythonPath, args, backendDir, (text) => outputChannel.append(text), {
        env: localBackendEnv(context),
        detached: process.platform !== 'win32',
        timeoutMs: ANALYZE_CLI_TIMEOUT_MS,
    });
    if (exitCode !== 0) {
        throw new Error(`Local analyzer CLI failed with exit code ${exitCode}. Check the "CODE.md" output channel.`);
    }
    if (!fs.existsSync(resultPath)) {
        throw new Error(`Local analyzer CLI completed but did not write "${resultPath}".`);
    }
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
}
async function fetchBuffer(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function parseErrorDetail(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed?.detail || '';
    }
    catch {
        return text;
    }
}
function pickInitialGraphUrl(uploadResult) {
    const graphs = uploadResult?.graphs || {};
    return (graphs.navigatable_callgraph_html ||
        graphs.combined_navigatable_callgraph_html ||
        graphs.callgraph_html ||
        graphs.java_merged_navigatable_html ||
        '');
}
function compactSymbolName(symbol) {
    const parts = String(symbol || '').split('.');
    return parts.slice(-2).join('.') || symbol;
}
function impactedFilesFromChange(change) {
    return (change?.impact_files || []).map((item) => String(item || '')).filter(Boolean);
}
function uncommittedFilePath(file) {
    if (file && typeof file === 'object') {
        return String(file.path || file.file || '').replace(/\\/g, '/');
    }
    return String(file || '').replace(/\\/g, '/');
}
function uncommittedFileLabel(file) {
    if (!file || typeof file !== 'object') {
        return String(file || '');
    }
    const status = String(file.status || 'changed');
    const pathValue = uncommittedFilePath(file);
    const oldPath = String(file.old_path || '');
    if (oldPath && oldPath !== pathValue) {
        return `${status}: ${oldPath} -> ${pathValue}`;
    }
    return `${status}: ${pathValue}`;
}
function uncommittedFileStatus(file) {
    if (file && typeof file === 'object') {
        return String(file.status || 'changed').toLowerCase();
    }
    return 'changed';
}
function deletedFolderSummaries(files) {
    const counts = new Map();
    for (const file of files) {
        if (uncommittedFileStatus(file) !== 'deleted') {
            continue;
        }
        const filePath = uncommittedFilePath(file);
        const slash = filePath.lastIndexOf('/');
        if (slash <= 0) {
            continue;
        }
        const folder = filePath.slice(0, slash);
        counts.set(folder, (counts.get(folder) || 0) + 1);
    }
    return Array.from(counts.entries())
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([folder, count]) => `deleted folder: ${folder}/ (${count} files)`);
}
function parseEvidenceFileLabel(label) {
    const text = String(label || '').trim();
    const match = text.match(/^(added|modified|deleted|renamed|changed):\s+(.+)$/i);
    if (!match) {
        return { file: text, status: 'changed' };
    }
    const status = match[1].toLowerCase();
    const value = match[2].includes(' -> ') ? match[2].split(' -> ').pop() || match[2] : match[2];
    return { file: value.trim(), status };
}
function fileRiskSignals(file) {
    const filePath = uncommittedFilePath(file).toLowerCase();
    const name = path.basename(filePath);
    const signals = [];
    if (/(auth|login|logout|signup|password|passwd|credential|secret|token|jwt|oauth|saml|session|cookie|permission|rbac|acl|policy|crypto|encrypt|decrypt|hash|salt|csrf|cors|security)/i.test(filePath)) {
        signals.push('security/auth-sensitive path');
    }
    if (/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|poetry\.lock|cargo\.toml|cargo\.lock|go\.mod|go\.sum|pom\.xml|build\.gradle)$/i.test(filePath)) {
        signals.push('dependency or build manifest');
    }
    if (/(^|\/)(dockerfile|docker-compose\.ya?ml|render\.ya?ml|procfile|\.github\/workflows\/|azure-pipelines\.ya?ml|circleci|jenkinsfile|terraform|helm|k8s|kubernetes)/i.test(filePath)) {
        signals.push('deploy/CI/infrastructure config');
    }
    if (/(^|\/)(\.env|\.npmrc|\.pypirc|id_rsa|private[-_]?key|cert|certificate|keystore|secrets?)(\.|\/|$)/i.test(filePath)) {
        signals.push('secret-bearing file pattern');
    }
    if (/(migration|schema|database|db\/|sql\/)/i.test(filePath) || /\.(sql|sqlite|db)$/i.test(name)) {
        signals.push('database/schema change');
    }
    if (/(^|\/)(test|tests|spec|__tests__)(\/|$)/i.test(filePath) || /\.(test|spec)\.[jt]sx?$/i.test(name)) {
        signals.push('test coverage change');
    }
    return signals;
}
function assessFileChangeRisk(files) {
    let score = 0;
    const signals = new Set();
    const deletedCount = files.filter((file) => uncommittedFileStatus(file) === 'deleted').length;
    const addedCount = files.filter((file) => uncommittedFileStatus(file) === 'added').length;
    score += deletedCount * 15;
    score += addedCount * 8;
    if (deletedCount >= 20) {
        score += 80;
        signals.add('large deletion set');
    }
    else if (deletedCount >= 5) {
        score += 35;
        signals.add('multi-file deletion');
    }
    if (addedCount >= 20) {
        score += 35;
        signals.add('large addition set');
    }
    for (const file of files) {
        const status = uncommittedFileStatus(file);
        for (const signal of fileRiskSignals(file)) {
            signals.add(signal);
            if (signal === 'security/auth-sensitive path' || signal === 'secret-bearing file pattern') {
                score += status === 'deleted' ? 100 : 75;
            }
            else if (signal === 'dependency or build manifest' || signal === 'deploy/CI/infrastructure config' || signal === 'database/schema change') {
                score += status === 'deleted' ? 55 : 35;
            }
            else if (signal === 'test coverage change') {
                score += status === 'deleted' ? 25 : 5;
            }
        }
    }
    if (score >= 140) {
        return { label: 'Critical', level: 'critical', score, signals: Array.from(signals) };
    }
    if (score >= 55) {
        return { label: 'High', level: 'high', score, signals: Array.from(signals) };
    }
    if (score >= 20) {
        return { label: 'Medium', level: 'medium', score, signals: Array.from(signals) };
    }
    return { label: 'Review', level: 'unknown', score, signals: Array.from(signals) };
}
function impactedNodesFromChange(change) {
    return (change?.impact_radius || []).map((item) => String(item || '')).filter(Boolean);
}
// node_confidence (from get_impact_radius in helpers.py) tags each reached
// node "high" if it's reached via at least one resolved, parsed call edge,
// "low" if every path to it is a heuristic/name-matched edge (e.g. dynamic
// dispatch). Nodes missing from the map (older cached reports, or the
// no-callgraph fallback) are treated as unconfirmed rather than assumed safe.
function nodeConfidenceFromChange(change) {
    const raw = change?.node_confidence;
    return raw && typeof raw === 'object' ? raw : {};
}
function confirmedAndInferredNodes(impactedNodes, nodeConfidence) {
    const confirmed = [];
    const inferred = [];
    for (const node of impactedNodes) {
        if (nodeConfidence[node] === 'high') {
            confirmed.push(node);
        }
        else {
            inferred.push(node);
        }
    }
    return { confirmed, inferred };
}
function directCallersFromLevels(change) {
    return Object.values(change?.levels || {}).filter((level) => Number(level) === 1).length;
}
function impactScoreForModifiedChange(change) {
    const impactedNodes = impactedNodesFromChange(change).length;
    const impactedFiles = impactedFilesFromChange(change).length;
    const directCallers = directCallersFromLevels(change);
    const lowConfidenceEdges = Number(change?.confidence?.low || 0);
    return (directCallers * 20) + (impactedNodes * 8) + (impactedFiles * 12) + (lowConfidenceEdges * 2);
}
function impactScoreForDeletedChange(change) {
    const directCallers = Number(change?.direct_callers || 0);
    const directCallees = Number(change?.direct_callees || 0);
    const stillReferenced = change?.still_referenced ? 100 : 0;
    return stillReferenced + (directCallers * 25) + (directCallees * 5);
}
function fileTypeLabel(file) {
    const ext = path.extname(file).replace(/^\./, '').toUpperCase();
    return ext ? `${ext} files` : 'changed files';
}
// Deliberately stays action-oriented, not a listing of the impacted
// functions/files themselves — those already have their own headline counts
// in the metrics grid (Direct callers / Confirmed impact / Files) and, for
// the actual names, the collapsed "Impacted functions" section (see
// impactedFunctions on ChangeCard). Naming individual callers here just
// duplicated that list inline and was the main source of noise on wide
// fan-out changes (e.g. 30 confirmed nodes spelled out twice).
function checksForChange(change) {
    const impactedNodes = impactedNodesFromChange(change);
    const { inferred } = confirmedAndInferredNodes(impactedNodes, nodeConfidenceFromChange(change));
    const checks = new Set();
    const callSiteIssues = callSiteIssuesFromChange(change);
    if (callSiteIssues.length) {
        checks.add(`Fix ${callSiteIssues.length} broken call site(s) before committing — see Evidence`);
    }
    if (inferred.length > 0) {
        // Unconfirmed on purpose: only ever reached via a heuristic/name-matched
        // edge (e.g. dynamic dispatch), never a resolved, parsed call site.
        checks.add(`? Possible/inferred paths (${inferred.length}) — worth a manual check`);
    }
    if (!checks.size) {
        checks.add('Changed behavior at call sites');
        checks.add('Nearby tests or examples');
    }
    return Array.from(checks);
}
function checksForFiles(files) {
    const checks = new Set();
    if (files.length) {
        checks.add('File-level behavior');
        for (const file of files.slice(0, 4)) {
            checks.add(fileTypeLabel(file));
        }
    }
    if (!checks.size) {
        checks.add('Manual review');
    }
    return Array.from(checks).slice(0, 5);
}
function checksForRemovedChange(change) {
    const checks = new Set();
    if (Number(change?.direct_callers || 0) > 0) {
        checks.add('Direct caller behavior');
    }
    if (Number(change?.direct_callees || 0) > 0) {
        checks.add('Removed dependency behavior');
    }
    if (change?.still_referenced) {
        checks.add('Remaining references');
    }
    if (!checks.size) {
        checks.add('Nearby tests or examples');
    }
    return Array.from(checks).slice(0, 5);
}
function riskRank(level) {
    return { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 }[level] ?? 4;
}
// Picks the result to auto-focus in the graph. Excludes results with no
// graphSymbol (e.g. the "other changed files" aggregate card for files the
// parser doesn't support) — those can't resolve to a callgraph node, so
// auto-focusing one just sends a bogus root string to /search-result-graph
// and leaves the map showing a "no match" error instead of a real graph.
function pickHighestImpactGraphable(results) {
    return [...results]
        .filter((r) => r.graphSymbol)
        .sort((a, b) => (b.impactScore || 0) - (a.impactScore || 0))[0];
}
// cosmetic_only (from python_function_ast_unchanged in helpers.py) is only
// ever true/false when the parser could locate the same function in both
// the old and new source and successfully parse both — anything else
// (non-Python file, parse error, renamed symbol) comes through as null/
// undefined, which must fall through to the normal impact heuristic below
// rather than being treated as "confirmed cosmetic."
function isCosmeticOnlyChange(change) {
    return change?.cosmetic_only === true;
}
function signatureDiffFromChange(change) {
    const raw = change?.signature_diff;
    if (!raw || typeof raw !== 'object') {
        return {
            changed: false, addedRequired: [], addedOptional: [], removed: [], starArgsChanged: false, starKwargsChanged: false,
            oldSignatureText: '', newSignatureText: '',
        };
    }
    const toStrings = (v) => (Array.isArray(v) ? v.map((item) => String(item || '')).filter(Boolean) : []);
    return {
        changed: Boolean(raw.changed),
        addedRequired: toStrings(raw.added_required),
        addedOptional: toStrings(raw.added_optional),
        removed: toStrings(raw.removed),
        starArgsChanged: Boolean(raw.star_args_changed),
        starKwargsChanged: Boolean(raw.star_kwargs_changed),
        oldSignatureText: String(raw.old_signature_text || ''),
        newSignatureText: String(raw.new_signature_text || ''),
    };
}
// call_site_issues (from check_call_sites in scripts/deletion-report.py) are
// statically PROVEN incompatible — a caller's call expression was parsed and
// checked against the new signature, not guessed at. Every other outcome
// (call not found, *args/**kwargs spread, non-Python caller) is left out of
// this list entirely rather than reported as fine or broken.
function callSiteIssuesFromChange(change) {
    const raw = Array.isArray(change?.call_site_issues) ? change.call_site_issues : [];
    return raw
        .map((item) => ({
        caller: String(item?.caller || ''),
        file: String(item?.file || ''),
        line: item?.line ? Number(item.line) : undefined,
        reason: String(item?.reason || ''),
    }))
        .filter((issue) => issue.caller && issue.reason);
}
function modifiedRisk(change) {
    if (callSiteIssuesFromChange(change).length > 0) {
        // Not a heuristic: a call site was parsed and statically proven
        // incompatible with the new signature. This outranks every fan-in-based
        // bucket below because it isn't a guess about risk, it's a found bug.
        return { label: 'Breaking change', level: 'critical' };
    }
    if (isCosmeticOnlyChange(change)) {
        // A git-diff hunk touched the function's line span, but the parsed body
        // is byte-for-byte identical — whitespace/comments/formatting only.
        // Fan-in doesn't matter here: nothing behavioral changed, so this never
        // outranks a real modification regardless of caller count.
        return { label: 'Cosmetic only', level: 'low' };
    }
    const impactedNodes = impactedNodesFromChange(change).length;
    const impactedFiles = impactedFilesFromChange(change).length;
    const lowConfidence = Number(change?.confidence?.low || 0);
    const truncated = Boolean(change?.truncated);
    if (truncated || impactedNodes >= 100 || impactedFiles >= 8) {
        return { label: 'High', level: 'high' };
    }
    if (impactedNodes >= 25 || impactedFiles >= 3 || lowConfidence > 0) {
        return { label: 'Medium-high', level: 'medium' };
    }
    if (impactedNodes >= 5 || impactedFiles >= 2) {
        return { label: 'Medium', level: 'medium' };
    }
    return { label: 'Low', level: 'low' };
}
// Inferred nodes are real signal, not deleted — but they're never allowed to
// share a headline number with confirmed nodes (a blended "16% confidence"
// or an equally-sized "116 possible" tile both read as noise). They only
// ever show up as a secondary, clearly-labeled aside.
function confirmedEvidenceLines(impactedNodes, nodeConfidence) {
    const { confirmed, inferred } = confirmedAndInferredNodes(impactedNodes, nodeConfidence);
    const lines = [`Impact: ${confirmed.length} function${confirmed.length === 1 ? '' : 's'} may be affected through parsed calls`];
    if (inferred.length) {
        lines.push(`(+ ${inferred.length} more possible/unconfirmed — heuristic or name-matched edges, e.g. dynamic dispatch; not a traced call site)`);
    }
    return lines;
}
function changeResultSnippet(change) {
    const impactedFiles = impactedFilesFromChange(change);
    const lines = [];
    if (impactedFiles.length) {
        lines.push('Impacted files:');
        for (const file of impactedFiles.slice(0, 6)) {
            lines.push(`- ${file}`);
        }
        if (impactedFiles.length > 6) {
            lines.push(`- +${impactedFiles.length - 6} more`);
        }
    }
    return lines.join('\n');
}
function signatureDiffLine(diff) {
    if (!diff.changed) {
        return null;
    }
    const parts = [];
    if (diff.addedRequired.length) {
        parts.push(`added required parameter${diff.addedRequired.length === 1 ? '' : 's'}: ${diff.addedRequired.join(', ')}`);
    }
    if (diff.addedOptional.length) {
        parts.push(`added optional parameter${diff.addedOptional.length === 1 ? '' : 's'}: ${diff.addedOptional.join(', ')}`);
    }
    if (diff.removed.length) {
        parts.push(`removed parameter${diff.removed.length === 1 ? '' : 's'}: ${diff.removed.join(', ')}`);
    }
    if (diff.starArgsChanged) {
        parts.push('*args changed');
    }
    if (diff.starKwargsChanged) {
        parts.push('**kwargs changed');
    }
    return `Signature changed: ${parts.length ? parts.join('; ') : 'parameter shape changed'}`;
}
// The delta summary above ("+optional highlight_data") tells you what
// changed but not what the signature actually looks like now — show the
// rendered before/after so a reviewer doesn't have to open the file to see it.
function signatureTextLines(diff) {
    if (!diff.changed) {
        return [];
    }
    const lines = [];
    if (diff.addedRequired.length) {
        lines.push(`New required parameter: ${diff.addedRequired.join(', ')}`);
    }
    if (diff.addedOptional.length) {
        lines.push(`New optional parameter: ${diff.addedOptional.join(', ')}`);
    }
    if (diff.removed.length) {
        lines.push(`Removed parameter: ${diff.removed.join(', ')}`);
    }
    if (diff.starArgsChanged || diff.starKwargsChanged) {
        lines.push('Variadic parameter shape changed');
    }
    return lines;
}
function signatureDetails(diff) {
    if (!diff.changed) {
        return undefined;
    }
    const details = {
        oldSignature: diff.oldSignatureText || undefined,
        newSignature: diff.newSignatureText || undefined,
    };
    return details.oldSignature || details.newSignature ? details : undefined;
}
function buildModifiedChangeCard(change) {
    const symbol = String(change?.symbol || '');
    const impactedFiles = impactedFilesFromChange(change);
    const impactedNodes = impactedNodesFromChange(change);
    const nodeConfidence = nodeConfidenceFromChange(change);
    const { confirmed } = confirmedAndInferredNodes(impactedNodes, nodeConfidence);
    const directCallers = Object.values(change?.levels || {}).filter((level) => Number(level) === 1).length;
    const risk = modifiedRisk(change);
    const sigDiff = signatureDiffFromChange(change);
    const callSiteIssues = callSiteIssuesFromChange(change);
    const metrics = [
        { label: 'Files', value: String(impactedFiles.length) },
        { label: 'Direct callers', value: String(directCallers) },
        { label: 'Confirmed impact', value: String(confirmed.length) },
    ];
    if (callSiteIssues.length) {
        metrics.push({ label: 'Broken call sites', value: String(callSiteIssues.length) });
    }
    return {
        kind: 'modified',
        title: 'Modified function',
        symbol,
        // sigDiff.changed leads with the specific delta (e.g. "Signature changed:
        // added optional parameter: highlight_data") instead of a generic "verify call sites"
        // sentence — the specific line already told the reader exactly what
        // changed, so restating it as a separate Evidence bullet below would
        // just say the same thing twice.
        change: callSiteIssues.length
            ? `Signature change breaks ${callSiteIssues.length} existing call site(s) — see Evidence.`
            : isCosmeticOnlyChange(change)
                ? 'Only whitespace, comments, or formatting changed — the parsed body is identical, so behavior is unaffected.'
                : sigDiff.changed
                    ? signatureDiffLine(sigDiff)
                    : 'Function body changed; callers may observe different behavior.',
        risk: risk.label,
        riskLevel: risk.level,
        // Confirmed impact leads the metrics — the only reachable-node count
        // shown as a headline number. Inferred/possible nodes are real but only
        // ever surface as a secondary aside (see confirmedEvidenceLines), never
        // as an equally-weighted tile next to this one.
        metrics,
        // Broken call sites are a proven fact (a parsed call checked against the
        // new signature), so they lead Evidence — ahead of the reachable-node
        // counts, which are risk signals, not findings. The full before/after
        // signature is kept as a hover tooltip so Evidence can stay readable.
        evidence: [
            ...callSiteIssues.map((issue) => `Broken call: ${compactSymbolName(issue.caller)} (${issue.file}${issue.line ? ':' + issue.line : ''}) — ${issue.reason}`),
            ...signatureTextLines(sigDiff),
            ...confirmedEvidenceLines(impactedNodes, nodeConfidence),
        ],
        checks: checksForChange(change),
        signatureDetails: signatureDetails(sigDiff),
        // Backing list for the "Confirmed impact" metric — rendered collapsed
        // behind an expand toggle (see renderExpandableList) instead of spelled
        // out inline, so a wide fan-out (e.g. 30 nodes) doesn't dump every name
        // in front of the user by default.
        impactedFunctions: confirmed.map(compactSymbolName),
        actions: ['View diff', 'View impact graph'],
        startCollapsed: true,
        cosmeticOnly: isCosmeticOnlyChange(change),
        breaking: callSiteIssues.length > 0,
        signatureChanged: sigDiff.changed,
    };
}
function buildDeletedChangeCard(change) {
    const symbol = String(change?.symbol || '');
    const severity = String(change?.severity || 'UNKNOWN').toUpperCase();
    const level = severity === 'CRITICAL' ? 'critical' : severity === 'HIGH' ? 'high' : severity === 'LOW' ? 'low' : 'unknown';
    return {
        kind: 'removed',
        title: 'Removed function',
        symbol,
        change: Boolean(change?.still_referenced)
            ? 'Function was removed but still has direct callers.'
            : 'Function was removed from the analyzed source.',
        risk: severity === 'UNKNOWN' ? 'Unknown' : severity,
        riskLevel: level,
        metrics: [
            { label: 'Direct callers', value: String(change?.direct_callers || 0) },
            { label: 'Direct callees', value: String(change?.direct_callees || 0) },
            { label: 'Still referenced', value: change?.still_referenced ? 'Yes' : 'No' },
        ],
        evidence: [
            change?.still_referenced ? 'Direct caller edge remains' : 'No remaining direct caller found',
            severity === 'UNKNOWN' ? 'No callgraph available' : `Severity: ${severity}`,
        ],
        checks: checksForRemovedChange(change),
        actions: ['View diff', 'View impact graph'],
        startCollapsed: true,
    };
}
function buildOtherFilesCard(files) {
    const labels = files.map(uncommittedFileLabel).filter(Boolean);
    const deletedCount = files.filter((file) => uncommittedFileStatus(file) === 'deleted').length;
    const addedCount = files.filter((file) => uncommittedFileStatus(file) === 'added').length;
    const changedCount = Math.max(0, labels.length - deletedCount - addedCount);
    const risk = assessFileChangeRisk(files);
    const folderEvidence = deletedFolderSummaries(files);
    const riskEvidence = risk.signals.slice(0, 4).map((signal) => `risk signal: ${signal}`);
    const shown = labels.slice(0, Math.max(0, 12 - folderEvidence.length - riskEvidence.length));
    const more = Math.max(0, labels.length - shown.length);
    const hasDeletions = deletedCount > 0;
    const hasAdditions = addedCount > 0;
    const summaryParts = [
        `${labels.length} file${labels.length === 1 ? '' : 's'}`,
        deletedCount ? `${deletedCount} deleted` : '',
        addedCount ? `${addedCount} added` : '',
        changedCount ? `${changedCount} changed` : '',
    ].filter(Boolean);
    return {
        kind: 'files',
        title: hasDeletions ? 'Removed / changed files' : hasAdditions ? 'Added / changed files' : 'Other changed files',
        symbol: summaryParts.join(' | '),
        change: hasDeletions
            ? 'Git reports removed files or folders in this uncommitted change set.'
            : hasAdditions
                ? 'Git reports newly added files in this uncommitted change set.'
                : 'Changed files were not mapped to function-level graph nodes.',
        risk: risk.label,
        riskLevel: risk.level,
        metrics: [
            { label: 'Files', value: String(labels.length) },
            { label: 'Deleted', value: String(deletedCount) },
            { label: 'Added', value: String(addedCount) },
            { label: 'File risk', value: String(risk.score) },
            { label: 'Shown', value: more ? `${shown.length} +${more}` : String(shown.length) },
        ],
        evidence: folderEvidence.concat(riskEvidence).concat(shown).concat(more ? [`+${more} more`] : []),
        checks: risk.level === 'critical' || risk.level === 'high'
            ? [
                'Confirm file/folder add/remove intent with owner',
                'Review security, auth, secrets, dependency, deploy, and data-impact paths',
                'Run affected tests/build and smoke critical flows',
                ...checksForFiles(labels).slice(0, 2),
            ]
            : checksForFiles(labels),
        actions: ['View diff', 'View diff graph'],
        startCollapsed: false,
    };
}
// ---------------------------------------------------------------------------
// Blast Radius Report: same "modified" entries as the full changes list, but
// filtered down to functions whose caller footprint is actually risky. The
// underlying data (impact_radius/levels) already walks CALLERS of the changed
// function transitively (see get_impact_radius() in
// backend/features/core/helpers.py) — this just decides which of those are
// worth surfacing instead of showing every touched function.
// ---------------------------------------------------------------------------
const BLAST_RADIUS_DIRECT_CALLER_THRESHOLD = 5;
const BLAST_RADIUS_TOTAL_UPSTREAM_THRESHOLD = 15;
function blastRadiusEntriesFromReport(report) {
    const modified = Array.isArray(report?.modified) ? report.modified : [];
    const entries = [];
    for (const change of modified) {
        const directCallers = directCallersFromLevels(change);
        // Which changes get flagged stays based on total reachable nodes
        // (confirmed + inferred) on purpose — filtering this to confirmed-only
        // would silently drop wide-but-mostly-inferred changes from the report
        // entirely (a recall regression), not just declutter the display.
        const totalUpstream = impactedNodesFromChange(change).length;
        if (directCallers >= BLAST_RADIUS_DIRECT_CALLER_THRESHOLD || totalUpstream >= BLAST_RADIUS_TOTAL_UPSTREAM_THRESHOLD) {
            entries.push({
                symbol: String(change?.symbol || ''),
                file: String(change?.file || ''),
                directCallers,
                totalUpstream,
                affectedFiles: impactedFilesFromChange(change),
                affectedNodes: impactedNodesFromChange(change),
                nodeConfidence: nodeConfidenceFromChange(change),
            });
        }
    }
    entries.sort((a, b) => b.totalUpstream - a.totalUpstream || b.directCallers - a.directCallers);
    return entries;
}
function buildBlastRadiusCard(entry) {
    const shownFiles = entry.affectedFiles.slice(0, 6);
    const moreFiles = entry.affectedFiles.length - shownFiles.length;
    const affects = shownFiles.length
        ? `Affects: ${shownFiles.join(', ')}${moreFiles > 0 ? `, +${moreFiles} more` : ''}`
        : 'Affects: no file mapping available for the callgraph nodes reached';
    const { confirmed } = confirmedAndInferredNodes(entry.affectedNodes, entry.nodeConfidence);
    return {
        kind: 'blastRadius',
        title: 'High blast radius',
        symbol: `⚠️ ${entry.symbol}`,
        change: 'Function body changed and has enough callers that a behavior change could ripple widely.',
        risk: 'High',
        riskLevel: 'high',
        // Same rule as buildModifiedChangeCard: confirmed impact is the headline
        // number; inferred/possible nodes stay out of the metrics grid.
        metrics: [
            { label: 'Direct callers', value: String(entry.directCallers) },
            { label: 'Confirmed impact', value: String(confirmed.length) },
            { label: 'Files affected', value: String(entry.affectedFiles.length) },
        ],
        evidence: [affects, ...confirmedEvidenceLines(entry.affectedNodes, entry.nodeConfidence)],
        checks: checksForChange({
            impact_files: entry.affectedFiles,
            impact_radius: entry.affectedNodes,
            levels: Object.fromEntries(Array.from({ length: entry.directCallers }, (_, index) => [`caller-${index}`, 1])),
            node_confidence: entry.nodeConfidence,
        }),
        impactedFunctions: confirmed.map(compactSymbolName),
        actions: ['View diff', 'View impact graph'],
        startCollapsed: true,
    };
}
function buildChangesAnswer(report) {
    const modified = Array.isArray(report?.modified) ? report.modified : [];
    const deleted = Array.isArray(report?.deleted) ? report.deleted : [];
    const unsupported = Array.isArray(report?.unsupported_files) ? report.unsupported_files.map((f) => String(f || '')).filter(Boolean) : [];
    const uncommittedFiles = Array.isArray(report?.uncommitted_files) ? report.uncommitted_files : [];
    const impactedFileSet = new Set();
    for (const item of modified) {
        for (const file of impactedFilesFromChange(item)) {
            impactedFileSet.add(file);
        }
    }
    // These three counts are statically PROVEN facts (from python_function_
    // signature_diff / check_call_sites), not heuristic risk scores — lead
    // with them so the one or two changes actually worth opening aren't
    // buried under the raw "118 functions changed" count.
    const breaking = modified.filter((m) => callSiteIssuesFromChange(m).length > 0);
    const cosmeticOnly = modified.filter((m) => isCosmeticOnlyChange(m));
    const unprovenSignatureChanges = modified.filter((m) => !isCosmeticOnlyChange(m) && callSiteIssuesFromChange(m).length === 0 && signatureDiffFromChange(m).changed);
    const namesFor = (list) => {
        const names = list.slice(0, 5).map((m) => compactSymbolName(String(m?.symbol || '')));
        const more = list.length > 5 ? `, +${list.length - 5} more` : '';
        return `${names.join(', ')}${more}`;
    };
    const lines = [];
    if (breaking.length) {
        lines.push(`${breaking.length} breaking signature change(s) — call sites provably incompatible: ${namesFor(breaking)}.`);
    }
    if (unprovenSignatureChanges.length) {
        lines.push(`${unprovenSignatureChanges.length} other signature change(s), worth a manual look: ${namesFor(unprovenSignatureChanges)}.`);
    }
    const noSignatureChange = modified.length - breaking.length - unprovenSignatureChanges.length - cosmeticOnly.length;
    const cosmeticNote = cosmeticOnly.length ? `, ${cosmeticOnly.length} cosmetic-only` : '';
    lines.push(`${modified.length + deleted.length} function(s) touched in total (${noSignatureChange} body-only edit(s) with no signature change${cosmeticNote}) — see "Other Modified Functions" below.`);
    if (impactedFileSet.size) {
        lines.push(`${impactedFileSet.size} impacted file(s) found by the callgraph.`);
    }
    else {
        lines.push('No callgraph file impact found yet.');
    }
    if (unsupported.length) {
        lines.push(`${unsupported.length} other changed file(s) grouped separately.`);
    }
    if (uncommittedFiles.length) {
        lines.push(`${uncommittedFiles.length} uncommitted file(s) found by Git status.`);
    }
    if (!report?.callgraph_available) {
        lines.push('Callgraph unavailable; impact scoring is limited.');
    }
    return lines.join('\n');
}
function buildChangesAnswerLinks(report, diffRefs) {
    const modified = Array.isArray(report?.modified) ? report.modified : [];
    const signatureChanges = modified.filter((m) => !isCosmeticOnlyChange(m) && signatureDiffFromChange(m).changed);
    return signatureChanges.map((change) => {
        const symbol = String(change?.symbol || '');
        const label = compactSymbolName(symbol);
        const file = String(change?.file || '');
        const line = String(change?.line || '');
        const impactedNodes = impactedNodesFromChange(change);
        const nodeConfidence = nodeConfidenceFromChange(change);
        const confirmed = confirmedAndInferredNodes(impactedNodes, nodeConfidence).confirmed;
        const result = {
            label: `Modified function: ${label}`,
            file,
            line,
            snippet: signatureDiffLine(signatureDiffFromChange(change)) || '',
            graphSymbol: symbol,
            fullName: symbol,
            symbol: label,
            name: label,
            impactNodes: confirmed,
            impactFiles: impactedFilesFromChange(change),
            impactScore: impactScoreForModifiedChange(change),
            diffBase: diffRefs?.base,
            diffTarget: diffRefs?.target,
        };
        return { label, file, line, result };
    });
}
function mcpSetupHelpText(folder, context) {
    const workspace = folder.uri.fsPath;
    const claudeLines = isClaudeMcpServerApproved(folder)
        ? [
            'Claude Code:',
            `1. Close any running Claude Code session for ${workspace}.`,
            `2. Open a terminal in ${workspace} and run: claude`,
            `3. The CODE.md button can open Claude Code and send /mcp automatically.`,
            `"${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}) was already approved for this workspace (.claude/settings.local.json), so no /mcp approval should be needed.`,
            'If Windows says "claude is not recognized", the Claude Code CLI is not installed or is not on PATH yet.',
        ]
        : [
            'Claude Code:',
            `1. Close any running Claude Code session for ${workspace}.`,
            `2. Open a terminal in ${workspace} and run: claude`,
            '3. In Claude Code, type: /mcp. The CODE.md button can do this automatically after launching Claude Code.',
            `4. If "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}) is pending approval, approve it there. You can also check from a terminal with: claude mcp list`,
            'If Windows says "claude is not recognized", the Claude Code CLI is not installed or is not on PATH yet.',
        ];
    return [
        'CODE.md MCP config has been written for this workspace and Codex user config.',
        '',
        ...claudeLines,
        '',
        'Codex CLI:',
        `1. Close the current Codex session for ${workspace}.`,
        `2. Open a new terminal in ${workspace} and run: codex`,
        `3. Codex should read "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}) from: ${codexUserConfigPath()}`,
        '4. The current session will not hot-reload MCP config; it must be a new session.',
        `5. Type /mcp, or use the CODE.md button to send it automatically after launching Codex. If Codex asks whether to allow "${MCP_SERVER_NAME}", approve it there.`,
        'If Windows says "codex is not recognized", install the Codex CLI or add it to PATH first.',
        '',
        'Other MCP clients:',
        `Use a stdio MCP server named "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}).`,
        `Command: node ${mcpServerArgs(context, workspace).join(' ')}`,
        'Approval is controlled by the MCP client. CODE.md can register the server, but the user must approve/trust it inside the client when prompted.',
        '',
        'What the number means:',
        'The access count is historical. If the timestamp is old, Claude/Codex are not currently connected even though the config exists.',
    ].join('\n');
}
// Re-assigning an <iframe> src to the exact same string it already has is a
// no-op in every browser/webview engine — it does not reload. The scoped
// search-result graph is always written to the same fixed filename
// (build_first_available_search_graph's default graph_name), so without this,
// clicking a different result row after the first one silently keeps showing
// whatever graph loaded first, even though the backend wrote fresh content.
function withCacheBust(url) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}_t=${Date.now()}`;
}
// ---------------------------------------------------------------------------
// Virtual "old version" side of the "View diff" action: resolves
// codemd-diff:/<file>?<cwd,base,file> to `git show <base>:<file>` so it can
// be diffed against the real (working-tree) file with vscode's built-in
// diff editor, without needing a snapshot cache of the base ref.
// ---------------------------------------------------------------------------
class GitShowContentProvider {
    provideTextDocumentContent(uri) {
        let cwd = '';
        let base = 'HEAD';
        let file = '';
        try {
            ({ cwd, base, file } = JSON.parse(decodeURIComponent(uri.query)));
        }
        catch {
            return '# CODE.md: malformed diff request.';
        }
        try {
            const parsed = JSON.parse(decodeURIComponent(uri.query));
            if (parsed?.empty) {
                return '';
            }
        }
        catch {
            // The earlier parse already returned a malformed-request message.
        }
        // spawnSync's default 1MB maxBuffer silently overflows (ENOBUFS, status
        // null, no stderr) on any base-ref file bigger than that — which reads
        // exactly like "file not found at that ref" below unless raised.
        const result = (0, child_process_1.spawnSync)('git', ['show', `${base}:${file}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (result.error) {
            return `# CODE.md: could not load ${file} at ${base} — ${result.error.message}`;
        }
        if (result.status !== 0) {
            return `# CODE.md: could not load ${file} at ${base} (it may be newly added).\n# ${(result.stderr || '').trim()}`;
        }
        return result.stdout;
    }
}
// ---------------------------------------------------------------------------
// Webview view: search box + callgraph.
// ---------------------------------------------------------------------------
class GraphsViewProvider {
    context;
    view;
    baseUrl = '';
    ownerName = '';
    repoName = '';
    busy = false;
    hasGenerated = false;
    // Preferred graph source: the mirrored HTML file already sitting in
    // .codemd/, which renders instantly without needing the local server up.
    lastGraphFileUri = null;
    displayedGraphFileUri = null;
    // Fallback for graphs the local mirror doesn't cover (e.g. search results),
    // which only exist on the running local server.
    lastServerGraphUrl = '';
    lastDisplayedServerGraphUrl = '';
    // Guards the on-disk-graph adoption below so it only ever repairs once and
    // so nothing gets displayed (lastGraphFileUri/displayedGraphFileUri) until
    // that repair — which copies cytoscape.min.js into the workspace and
    // rewrites the mirrored HTML's script path — has actually finished.
    // Otherwise a webview that's ready before the repair completes would be
    // handed a graph that can't render, and since a later post of the same
    // webview URI is a no-op (iframe.src unchanged), it would stay blank.
    localGraphReadyPromise = null;
    searchHistory = [];
    lastStatus = 'Preparing callgraph in the background…';
    sidePanel;
    graphPanel;
    mcpUsageWatcher;
    mcpConfigWatcher;
    viewReady = false;
    sidePanelReady = false;
    localSearchIndex = null;
    changesBusy = false;
    commitsBusy = false;
    initialGraphPosted = false;
    initialGraphPostWaiters = [];
    // Set when a caller asks to focus the highest-impact change while a check
    // is already in flight (e.g. the startup sequence's post-regenerate call
    // racing the initial on-disk-artifacts call) — honored by whichever
    // runChangesCheck() is currently running instead of being dropped.
    pendingFocusHighestImpact = false;
    constructor(context) {
        this.context = context;
        outputChannel?.appendLine('[GraphsViewProvider.ctor] begin');
        this.ensureLocalGraphLoaded();
        outputChannel?.appendLine('[GraphsViewProvider.ctor] end');
    }
    async reveal() {
        outputChannel?.appendLine('[reveal] executing workbench.view.extension.codemdGraphs');
        await vscode.commands.executeCommand('workbench.view.extension.codemdGraphs');
        outputChannel?.appendLine('[reveal] executing codemdGraphs.panel.focus');
        await vscode.commands.executeCommand('codemdGraphs.panel.focus');
        outputChannel?.appendLine('[reveal] done');
    }
    resolveWebviewView(webviewView) {
        outputChannel?.appendLine('[resolveWebviewView] panel is being resolved.');
        this.view = webviewView;
        const folder = vscode.workspace.workspaceFolders?.[0];
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: folder ? [vscode.Uri.joinPath(folder.uri, ARTIFACT_OUTPUT_DIR)] : undefined,
        };
        const config = vscode.workspace.getConfiguration('codemdGraphs');
        const host = String(config.get('host') || '127.0.0.1');
        const port = Number(config.get('port') || 8100);
        webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message, 'view'));
        this.viewReady = false;
        webviewView.webview.html = getHtml(host, port, webviewView.webview.cspSource);
        // The panel may be opened well after background generation already
        // finished (or while it's still running) — sync it to current state
        // immediately instead of showing an empty "click Generate" state. If a
        // graph from a previous session is already sitting on disk, show it
        // right away rather than waiting on a fresh analysis.
        this.ensureLocalGraphLoaded(folder);
        this.post({ type: 'status', text: this.lastStatus });
        this.postGraph();
        this.postSearchHistory();
        this.postSearchSuggestions(folder);
        if (this.hasGenerated) {
            this.post({ type: 'generated' });
        }
        this.refreshMcpUsage(folder);
        this.ensureMcpUsageWatcher(folder);
        setTimeout(() => this.markWebviewReadyIfStillCurrent('view', webviewView), 750);
        outputChannel?.appendLine('[resolveWebviewView] panel resolution finished.');
    }
    openEditorPanel() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!this.sidePanel) {
            this.sidePanel = vscode.window.createWebviewPanel('codemdGraphs.sidePanel', 'codemd', vscode.ViewColumn.Beside, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: folder ? [vscode.Uri.joinPath(folder.uri, ARTIFACT_OUTPUT_DIR)] : undefined,
            });
            const messageDisposable = this.sidePanel.webview.onDidReceiveMessage((message) => this.handleMessage(message, 'side'));
            this.sidePanel.onDidDispose(() => {
                messageDisposable.dispose();
                this.sidePanel = undefined;
                this.sidePanelReady = false;
            });
        }
        const config = vscode.workspace.getConfiguration('codemdGraphs');
        const host = String(config.get('host') || '127.0.0.1');
        const port = Number(config.get('port') || 8100);
        this.sidePanelReady = false;
        this.sidePanel.webview.html = getHtml(host, port, this.sidePanel.webview.cspSource);
        this.sidePanel.reveal(vscode.ViewColumn.Beside, false);
        this.ensureLocalGraphLoaded(folder);
        this.post({ type: 'status', text: this.lastStatus });
        this.postGraph();
        this.postSearchHistory();
        this.postSearchSuggestions(folder);
        if (this.hasGenerated) {
            this.post({ type: 'generated' });
        }
        this.refreshMcpUsage(folder);
        this.ensureMcpUsageWatcher(folder);
        setTimeout(() => this.markWebviewReadyIfStillCurrent('side', this.sidePanel), 750);
    }
    openGraphPanel(currentGraphUrl) {
        if (!this.lastGraphFileUri && !this.lastServerGraphUrl && !this.lastDisplayedServerGraphUrl) {
            vscode.window.showInformationMessage('CODE.md: The callgraph is still being generated.');
            return;
        }
        if (!this.graphPanel) {
            const folder = vscode.workspace.workspaceFolders?.[0];
            this.graphPanel = vscode.window.createWebviewPanel('codemdGraphs.fullGraph', 'codemd', vscode.ViewColumn.Active, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: folder ? [vscode.Uri.joinPath(folder.uri, ARTIFACT_OUTPUT_DIR)] : undefined,
            });
            this.graphPanel.onDidDispose(() => {
                this.graphPanel = undefined;
            });
        }
        const url = this.normalizeCurrentServerGraphUrl(currentGraphUrl) ||
            this.resolveGraphUrlForWebview(this.graphPanel.webview);
        this.graphPanel.webview.html = getFullGraphHtml(url, this.graphPanel.webview.cspSource);
        this.graphPanel.reveal(vscode.ViewColumn.Active, false);
    }
    normalizeCurrentServerGraphUrl(url) {
        const value = String(url || '').trim();
        if (!value) {
            return '';
        }
        try {
            const parsed = new URL(value);
            const isLocalServer = (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
                && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
            return isLocalServer ? parsed.toString() : '';
        }
        catch {
            return '';
        }
    }
    async refreshMcpUsage(folder = vscode.workspace.workspaceFolders?.[0]) {
        if (!folder) {
            this.post({ type: 'mcpUsage', serverName: MCP_SERVER_NAME, configured: false, totalCalls: 0, updatedAt: '', stale: true, clients: [], toolsByClient: {}, setup: null, restartNeeded: false });
            return;
        }
        const usage = await readMcpUsage(folder);
        this.post({
            type: 'mcpUsage',
            serverName: MCP_SERVER_NAME,
            configured: usage.configured,
            totalCalls: usage.totalCalls,
            updatedAt: usage.updatedAt,
            stale: usage.stale,
            clients: usage.clients,
            toolsByClient: usage.toolsByClient,
            setup: usage.setup,
            restartNeeded: usage.restartNeeded,
        });
    }
    ensureMcpUsageWatcher(folder) {
        if (this.mcpUsageWatcher || !folder) {
            return;
        }
        const pattern = new vscode.RelativePattern(folder, `${ARTIFACT_OUTPUT_DIR}/${MCP_USAGE_FILE}`);
        this.mcpUsageWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.mcpUsageWatcher.onDidCreate(() => this.refreshMcpUsage(folder));
        this.mcpUsageWatcher.onDidChange(() => this.refreshMcpUsage(folder));
        this.mcpUsageWatcher.onDidDelete(() => this.refreshMcpUsage(folder));
        this.context.subscriptions.push(this.mcpUsageWatcher);
        const configPattern = new vscode.RelativePattern(folder, WORKSPACE_MCP_CONFIG_FILE);
        this.mcpConfigWatcher = vscode.workspace.createFileSystemWatcher(configPattern);
        this.mcpConfigWatcher.onDidCreate(() => this.refreshMcpUsage(folder));
        this.mcpConfigWatcher.onDidChange(() => this.refreshMcpUsage(folder));
        this.mcpConfigWatcher.onDidDelete(() => this.refreshMcpUsage(folder));
        this.context.subscriptions.push(this.mcpConfigWatcher);
    }
    /**
     * If a graph from a previous session already exists on disk, adopt it
     * without waiting for a fresh analysis. The repair (copying
     * cytoscape.min.js into the workspace and rewriting the mirrored HTML's
     * script path) must finish before lastGraphFileUri/displayedGraphFileUri
     * are set or anything is posted — otherwise a webview that's already ready
     * can be handed a graph that can't render yet, and since posting the same
     * webview URI again later is a no-op (an iframe doesn't reload when its
     * src is unchanged), it would stay blank for the rest of the session.
     */
    ensureLocalGraphLoaded(folder) {
        folder = folder || vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            outputChannel?.appendLine('[ensureLocalGraphLoaded] no workspace folder available yet — skipping.');
            return;
        }
        const outDirUri = vscode.Uri.joinPath(folder.uri, ARTIFACT_OUTPUT_DIR);
        const candidate = localGraphFileUri(outDirUri);
        const candidateExists = fs.existsSync(candidate.fsPath);
        outputChannel?.appendLine(`[ensureLocalGraphLoaded] candidate=${candidate.fsPath} exists=${candidateExists} `
            + `lastGraphFileUri=${!!this.lastGraphFileUri} localGraphReadyPromise=${!!this.localGraphReadyPromise}`);
        if (!this.lastGraphFileUri && !this.localGraphReadyPromise && candidateExists) {
            this.hasGenerated = true;
            this.lastGraphFileUri = candidate;
            this.lastDisplayedServerGraphUrl = '';
            this.displayedGraphFileUri = candidate;
            this.lastStatus = `Showing existing ${ARTIFACT_OUTPUT_DIR}/ callgraph.`;
            statusBarItem.text = '$(check) CODE.md: graph ready';
            statusBarItem.tooltip = 'CODE.md: showing existing callgraph';
            outputChannel?.appendLine(`[ensureLocalGraphLoaded] adopting on-disk graph, posting to webview (view=${!!this.view} viewReady=${this.viewReady}).`);
            this.post({ type: 'status', text: this.lastStatus });
            this.postDisplayedGraph();
            const index = this.getLocalSearchIndex();
            outputChannel?.appendLine(`[ensureLocalGraphLoaded] search index ${index ? `loaded (${index.nodes.length} nodes)` : 'FAILED to load'}.`);
            this.localGraphReadyPromise = repairMirroredArtifactsForWebview(this.context, outDirUri)
                .catch((err) => {
                outputChannel?.appendLine(`Skipped startup graph repair: ${err?.message || String(err)}`);
            })
                .then(() => {
                outputChannel?.appendLine(`[ensureLocalGraphLoaded] repair finished, re-posting graph (view=${!!this.view} viewReady=${this.viewReady}).`);
                this.hasGenerated = true;
                this.lastGraphFileUri = candidate;
                // A search performed earlier in this session (or a leftover from
                // before a "Regenerate" click) can leave a stale server-rendered
                // graph URL pinned as "the last displayed graph" — without
                // clearing it here, that stale URL wins over the callgraph we
                // just adopted from disk and the default navigatable graph
                // silently never appears.
                this.lastDisplayedServerGraphUrl = '';
                this.displayedGraphFileUri = candidate;
                this.lastStatus = `Showing existing ${ARTIFACT_OUTPUT_DIR}/ callgraph. Refreshing analysis in the background if needed.`;
                statusBarItem.text = '$(check) CODE.md: graph ready';
                statusBarItem.tooltip = 'CODE.md: showing existing callgraph';
                this.post({ type: 'status', text: this.lastStatus });
                this.postDisplayedGraph();
            });
        }
        else if (this.lastGraphFileUri && !this.displayedGraphFileUri && !this.lastDisplayedServerGraphUrl) {
            this.displayedGraphFileUri = this.lastGraphFileUri;
        }
        const resultPath = localAnalysisResultFileUri(outDirUri).fsPath;
        if (fs.existsSync(resultPath)) {
            try {
                const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
                this.ownerName = String(result?.owner_name || '');
                this.repoName = String(result?.repo_name || '');
            }
            catch {
                // Best-effort session recovery only.
            }
        }
    }
    /** Resolves the current graph to a URL usable by a specific webview (local file URIs are per-webview). */
    resolveGraphUrlForWebview(webview) {
        // The currently-displayed server-rendered subgraph (e.g. the default
        // focused node, or a search result) always wins — it's what's actually
        // showing in the sidebar, and it's the one graph guaranteed to render
        // (the full repo-wide static file is too large for the webview to lay out).
        if (this.lastDisplayedServerGraphUrl) {
            return this.lastDisplayedServerGraphUrl;
        }
        const fileUri = this.displayedGraphFileUri || this.lastGraphFileUri;
        if (fileUri) {
            return webview.asWebviewUri(fileUri).toString();
        }
        return this.lastServerGraphUrl;
    }
    postGraph() {
        let posted = false;
        if (this.view && this.viewReady) {
            const url = this.resolveGraphUrlForWebview(this.view.webview);
            outputChannel?.appendLine(`[postGraph] view ready, resolved url=${url ? url.slice(0, 120) : '(empty)'}`);
            if (url) {
                this.view.webview.postMessage({ type: 'graph', url });
                posted = true;
            }
        }
        else {
            outputChannel?.appendLine(`[postGraph] skipped — view=${!!this.view} viewReady=${this.viewReady}`);
        }
        if (this.sidePanel && this.sidePanelReady) {
            const url = this.resolveGraphUrlForWebview(this.sidePanel.webview);
            if (url) {
                this.sidePanel.webview.postMessage({ type: 'graph', url });
                posted = true;
            }
        }
        if (this.graphPanel) {
            const url = this.resolveGraphUrlForWebview(this.graphPanel.webview);
            if (url) {
                this.graphPanel.webview.html = getFullGraphHtml(url, this.graphPanel.webview.cspSource);
                posted = true;
            }
        }
        if (posted) {
            this.markInitialGraphPosted();
        }
    }
    markInitialGraphPosted() {
        if (this.initialGraphPosted) {
            return;
        }
        this.initialGraphPosted = true;
        const waiters = this.initialGraphPostWaiters.splice(0);
        for (const resolve of waiters) {
            resolve();
        }
    }
    async waitForInitialGraphPost(timeoutMs = 2000) {
        if (this.initialGraphPosted) {
            return;
        }
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            this.initialGraphPostWaiters.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    async runChangesCheckAfterInitialGraphPost(options = {}) {
        await this.waitForInitialGraphPost();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await this.runChangesCheck(options);
    }
    postDisplayedGraph() {
        if (this.lastDisplayedServerGraphUrl) {
            this.post({ type: 'graph', url: this.lastDisplayedServerGraphUrl });
            return;
        }
        this.postGraph();
    }
    rememberSearchResult(message) {
        if (message?.kind === 'changes' || message?.kind === 'blastRadius') {
            this.searchHistory = this.searchHistory.filter((item) => item?.kind !== message.kind);
        }
        else if (message?.kind === 'commitDetail') {
            // Re-analyzing the same commit replaces its old entry; a different
            // commit's analysis is kept alongside it rather than wiped.
            this.searchHistory = this.searchHistory.filter((item) => !(item?.kind === 'commitDetail' && item?.query === message.query));
        }
        this.searchHistory.push(message);
        this.searchHistory = this.searchHistory.slice(-10);
    }
    postSearchHistory() {
        if (this.searchHistory.length) {
            this.post({ type: 'searchHistory', items: this.searchHistory });
        }
    }
    scimFunctionSuggestions(folder = vscode.workspace.workspaceFolders?.[0]) {
        if (!folder) {
            return [];
        }
        const functionsPath = localScimFunctionsFileUri(vscode.Uri.joinPath(folder.uri, ARTIFACT_OUTPUT_DIR)).fsPath;
        if (!fs.existsSync(functionsPath)) {
            return [];
        }
        const seen = new Set();
        const suggestions = [];
        const add = (value) => {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            const normalized = text.toLowerCase();
            if (!text || seen.has(normalized)) {
                return;
            }
            seen.add(normalized);
            suggestions.push(text);
        };
        try {
            const lines = fs.readFileSync(functionsPath, 'utf8').split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                try {
                    const record = JSON.parse(trimmed);
                    add(record?.fullName);
                    add(record?.symbol);
                    add(record?.name);
                }
                catch {
                    // Skip a malformed JSONL row; the rest of the artifact is still useful.
                }
                if (suggestions.length >= 250) {
                    break;
                }
            }
        }
        catch (err) {
            outputChannel?.appendLine(`[scimFunctionSuggestions] could not read ${functionsPath}: ${err?.message || String(err)}`);
        }
        return suggestions;
    }
    postSearchSuggestions(folder = vscode.workspace.workspaceFolders?.[0]) {
        this.post({ type: 'searchSuggestions', functions: this.scimFunctionSuggestions(folder) });
    }
    post(message) {
        if (this.view && this.viewReady) {
            this.view.webview.postMessage(message);
        }
        if (this.sidePanel && this.sidePanelReady) {
            this.sidePanel.webview.postMessage(message);
        }
    }
    handleMessage(message, source = 'view') {
        if (!message || typeof message.type !== 'string') {
            outputChannel?.appendLine(`[handleMessage] dropped malformed message from ${source}: ${JSON.stringify(message)}`);
            return;
        }
        outputChannel?.appendLine(`[handleMessage] received type="${message.type}" from ${source}.`);
        try {
            this.handleMessageInner(message, source);
        }
        catch (err) {
            outputChannel?.appendLine(`[handleMessage] threw while handling type="${message.type}": ${err?.stack || err?.message || String(err)}`);
        }
    }
    handleMessageInner(message, source = 'view') {
        if (message.type === 'generate') {
            this.runGenerate({ quiet: false });
        }
        else if (message.type === 'search') {
            this.runSearch(String(message.query || ''));
        }
        else if (message.type === 'openFile') {
            this.openFile(String(message.file || ''), message.line);
        }
        else if (message.type === 'openGraphPanel') {
            this.openGraphPanel(message.currentGraphUrl);
        }
        else if (message.type === 'graphForResult') {
            this.runResultGraph(message.result || {});
        }
        else if (message.type === 'checkChanges') {
            this.runChangesCheck();
        }
        else if (message.type === 'blastRadius') {
            this.runBlastRadiusCheck();
        }
        else if (message.type === 'checkCommits') {
            this.runLatestCommitsCheck();
        }
        else if (message.type === 'analyzeCommit') {
            this.runCommitCheck(String(message.hash || ''));
        }
        else if (message.type === 'setupMcp') {
            this.setupMcpFromPanel();
        }
        else if (message.type === 'approveClaude') {
            this.approveClaudeFromPanel();
        }
        else if (message.type === 'approveCodex') {
            this.approveCodexFromPanel();
        }
        else if (message.type === 'openMcpClient') {
            this.openMcpClient(String(message.client || ''));
        }
        else if (message.type === 'viewDiff') {
            const refs = message.base && message.target ? { base: String(message.base), target: String(message.target) } : undefined;
            this.viewDiff(String(message.file || ''), refs, String(message.status || ''));
        }
        else if (message.type === 'clientError') {
            logDebug(`[webview error] ${message.message || ''} (${message.source || ''}:${message.line || ''})\n${message.stack || ''}`);
        }
        else if (message.type === 'webviewLog') {
            logDebug(`[webview] ${message.message || ''} ${message.detail ? JSON.stringify(message.detail) : ''}`);
        }
        else if (message.type === 'graphDebug') {
            logDebug(`[graph iframe] ${message.event || 'event'} ${message.href || ''} ${message.detail ? JSON.stringify(message.detail) : ''}`);
        }
        else if (message.type === 'ready') {
            // The webview's script has just attached its message listener — resend
            // current state, since anything posted right after setting .html can
            // be dropped if it arrives before the iframe finished loading.
            this.markWebviewReady(source);
        }
    }
    markWebviewReadyIfStillCurrent(source, webview) {
        if (source === 'side') {
            if (!webview || this.sidePanel !== webview || this.sidePanelReady) {
                return;
            }
        }
        else if (!webview || this.view !== webview || this.viewReady) {
            return;
        }
        outputChannel?.appendLine(`[markWebviewReadyIfStillCurrent] no ready message received from ${source}; replaying current state.`);
        this.markWebviewReady(source);
    }
    markWebviewReady(source) {
        if (source === 'side') {
            this.sidePanelReady = true;
        }
        else {
            this.viewReady = true;
        }
        this.post({ type: 'status', text: this.lastStatus });
        this.postDisplayedGraph();
        this.postSearchHistory();
        this.postSearchSuggestions();
        if (this.hasGenerated) {
            this.post({ type: 'generated' });
        }
        this.refreshMcpUsage();
    }
    async setupMcpFromPanel() {
        const changed = await setupProjectMcpConfigs(this.context, { quiet: false });
        this.refreshMcpUsage();
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) {
            const resultMessage = {
                type: 'searchResult',
                kind: 'mcpSetup',
                replace: false,
                query: 'MCP setup next steps',
                answer: mcpSetupHelpText(folder, this.context),
                results: [],
            };
            this.rememberSearchResult(resultMessage);
            this.post(resultMessage);
            // Always offer to launch a client terminal on this explicit,
            // user-initiated button press. Gating this on `changed` used to assume
            // an already-approved server is already connected in some running
            // session, but approval and actual connection are independent — a
            // client can be approved yet still show the server as failed/missing
            // (e.g. its CLI isn't on PATH), so the user needs this action every time.
            const choice = await vscode.window.showInformationMessage(changed
                ? 'CODE.md: MCP config is ready. Start a fresh client session and open /mcp to approve/use codemd.'
                : 'CODE.md: MCP config is already up to date. Open a client terminal to connect/reconnect codemd.', 'Open Codex /mcp', 'Open Claude Code /mcp');
            if (choice === 'Open Codex /mcp') {
                openMcpClientTerminal('codex', folder);
            }
            else if (choice === 'Open Claude Code /mcp') {
                openMcpClientTerminal('claude', folder);
            }
            return;
        }
        vscode.window.showInformationMessage('CODE.md: MCP config is ready. See the CODE.md panel for exact Claude Code and Codex restart/check steps.');
    }
    async approveClaudeFromPanel() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showWarningMessage('CODE.md: Open a workspace before approving an MCP client.');
            return;
        }
        try {
            await approveClaudeMcpServer(folder);
            this.refreshMcpUsage();
            vscode.window.showInformationMessage(`CODE.md: "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}) is pre-approved for Claude Code in "${folder.name}". Start a new Claude Code session to pick it up.`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`CODE.md: Could not approve Claude MCP: ${err?.message || String(err)}`);
        }
    }
    async approveCodexFromPanel() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showWarningMessage('CODE.md: Open a workspace before approving an MCP client.');
            return;
        }
        try {
            await approveCodexMcpServer(this.context, folder);
            this.refreshMcpUsage();
            vscode.window.showInformationMessage(`CODE.md: "${MCP_SERVER_NAME}" (${MCP_SERVER_LABEL}) tools are auto-approved for Codex in "${folder.name}". Start a new Codex session to pick it up.`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`CODE.md: Could not approve Codex MCP: ${err?.message || String(err)}`);
        }
    }
    openMcpClient(client) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showWarningMessage('CODE.md: Open a workspace before starting an MCP client.');
            return;
        }
        if (client === 'codex' || client === 'claude') {
            openMcpClientTerminal(client, folder);
        }
    }
    async openFile(file, line) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder || !file) {
            return;
        }
        try {
            const uri = await this.resolveFileUri(folder, file);
            if (!fs.existsSync(uri.fsPath)) {
                await this.viewDiff(file, undefined, 'deleted');
                return;
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            const lineNumber = Math.max(0, (Number(line) || 1) - 1);
            const range = editor.document.lineAt(Math.min(lineNumber, editor.document.lineCount - 1)).range;
            editor.selection = new vscode.Selection(range.start, range.start);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
        catch (err) {
            vscode.window.showWarningMessage(`CODE.md: Could not open ${file} — ${err?.message || String(err)}`);
        }
    }
    async viewDiff(file, refs, status) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder || !file) {
            return;
        }
        const base = refs?.base || 'HEAD';
        try {
            const oldUri = vscode.Uri.from({
                scheme: CODEMD_DIFF_SCHEME,
                path: `/${file}`,
                query: encodeURIComponent(JSON.stringify({ cwd: folder.uri.fsPath, base, file })),
            });
            let newUri;
            let label;
            if (refs?.target) {
                // A past commit, not live edits — both sides are `git show` virtual
                // docs (via the same GitShowContentProvider as the old side) rather
                // than the real working-tree file, since that may have moved on
                // since this commit landed.
                newUri = vscode.Uri.from({
                    scheme: CODEMD_DIFF_SCHEME,
                    path: `/${file}`,
                    query: encodeURIComponent(JSON.stringify({ cwd: folder.uri.fsPath, base: refs.target, file })),
                });
                label = `${file} (${base} ↔ ${refs.target})`;
            }
            else if (String(status || '').toLowerCase() === 'deleted' || !fs.existsSync(path.join(folder.uri.fsPath, file))) {
                newUri = vscode.Uri.from({
                    scheme: CODEMD_DIFF_SCHEME,
                    path: `/${file}`,
                    query: encodeURIComponent(JSON.stringify({ cwd: folder.uri.fsPath, base: '', file, empty: true })),
                });
                label = `${file} (${base} to deleted)`;
            }
            else {
                newUri = await this.resolveFileUri(folder, file);
                label = `${file} (${base} ↔ working tree)`;
            }
            await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, label);
        }
        catch (err) {
            vscode.window.showWarningMessage(`CODE.md: Could not open diff for ${file} — ${err?.message || String(err)}`);
        }
    }
    /**
     * Some backend analysis artifacts (e.g. the architecture feature catalog)
     * store paths with the leading source directory stripped, so a direct
     * join against the workspace root can 404. Fall back to a basename search
     * before giving up.
     */
    async resolveFileUri(folder, file) {
        const direct = vscode.Uri.joinPath(folder.uri, file);
        try {
            await vscode.workspace.fs.stat(direct);
            return direct;
        }
        catch {
            // fall through to basename search
        }
        const normalized = file.replace(/\\/g, '/');
        const baseName = normalized.split('/').pop() || normalized;
        const excludePattern = `{${DEFAULT_EXCLUDES.join(',')}}`;
        const matches = await vscode.workspace.findFiles(`**/${baseName}`, excludePattern, 10);
        if (matches.length === 0) {
            return direct;
        }
        const bestMatch = matches.find((candidate) => candidate.fsPath.replace(/\\/g, '/').endsWith(normalized)) || matches[0];
        return bestMatch;
    }
    async runGenerate(options) {
        const { quiet } = options;
        if (!quiet) {
            await this.reveal();
        }
        if (this.busy) {
            if (!quiet) {
                vscode.window.showInformationMessage('CODE.md: Already analyzing — please wait for it to finish.');
            }
            return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            if (!quiet) {
                vscode.window.showErrorMessage('CODE.md: Open a folder or workspace before generating CODE.md callgraphs.');
            }
            return;
        }
        const outDirUri = vscode.Uri.joinPath(folder.uri, ARTIFACT_OUTPUT_DIR);
        const graphFileUri = localGraphFileUri(outDirUri);
        if (quiet && fs.existsSync(graphFileUri.fsPath)) {
            this.ensureLocalGraphLoaded(folder);
            this.post({ type: 'status', text: this.lastStatus });
            this.postGraph();
            this.postSearchSuggestions(folder);
            this.post({ type: 'generated' });
            this.refreshMcpUsage(folder);
        }
        // Background startup runs are the ones that repeat needlessly on every
        // reload — skip them entirely when git shows no changes since the last
        // completed analysis. An explicit "Generate" click always runs for real.
        if (quiet && fs.existsSync(graphFileUri.fsPath)) {
            const currentHash = await computeGitStateHash(folder.uri.fsPath);
            const storedHash = readStoredGitStateHash(outDirUri);
            if (currentHash && storedHash && currentHash === storedHash) {
                const resultPath = localAnalysisResultFileUri(outDirUri).fsPath;
                if (fs.existsSync(resultPath)) {
                    try {
                        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
                        this.ownerName = String(result?.owner_name || '');
                        this.repoName = String(result?.repo_name || '');
                    }
                    catch {
                        // Best-effort session recovery only.
                    }
                }
                this.lastStatus = 'Up to date — no changes detected since the last analysis.';
                this.post({ type: 'status', text: this.lastStatus });
                // Repair (copy cytoscape.min.js into the workspace, rewrite the
                // mirrored HTML's script path) must finish before this graph is
                // adopted as last/displayed — otherwise a webview that's already
                // ready (e.g. via a concurrent ensureLocalGraphLoaded/resolveWebviewView
                // call) could be handed an unrepaired graph and, since re-posting the
                // same webview URI later is a no-op, it would stay blank.
                await repairMirroredArtifactsForWebview(this.context, outDirUri);
                this.hasGenerated = true;
                this.lastGraphFileUri = graphFileUri;
                if (!this.displayedGraphFileUri && !this.lastDisplayedServerGraphUrl) {
                    this.displayedGraphFileUri = graphFileUri;
                }
                this.postGraph();
                this.postSearchSuggestions(folder);
                this.post({ type: 'generated' });
                this.refreshMcpUsage(folder);
                statusBarItem.text = '$(check) CODE.md: up to date';
                statusBarItem.tooltip = 'CODE.md';
                return;
            }
        }
        this.busy = true;
        statusBarItem.text = '$(sync~spin) CODE.md: analyzing…';
        const status = (text) => {
            this.lastStatus = text;
            this.post({ type: 'status', text });
        };
        const runBody = async (report) => {
            try {
                const config = vscode.workspace.getConfiguration('codemdGraphs');
                const analysisMode = String(config.get('analysisMode') || 'cli').toLowerCase();
                const useServerForGeneration = analysisMode === 'server';
                let baseUrl = '';
                let uploadResult;
                report('Analyzing locally (this can take a while for large repos)…');
                if (useServerForGeneration) {
                    baseUrl = await ensureServerRunning(this.context, report, quiet);
                    report('Analyzing locally through the FastAPI companion server...');
                    uploadResult = await analyzeLocalPath(baseUrl, folder.uri.fsPath, folder.name, report);
                }
                else {
                    uploadResult = await analyzeLocalPathCli(this.context, outDirUri, folder.uri.fsPath, folder.name, report, quiet);
                }
                const codeMdUrl = uploadResult?.code_md_url;
                if (!codeMdUrl) {
                    throw new Error('The local analyzer did not return a CODE.md artifact.');
                }
                report('Fetching CODE.md and analysis artifacts…');
                await safeWorkspaceCreateDirectory(outDirUri);
                if (useServerForGeneration) {
                    await downloadArtifacts(baseUrl, outDirUri, uploadResult, codeMdUrl);
                }
                await repairMirroredArtifactsForWebview(this.context, outDirUri);
                this.baseUrl = baseUrl;
                this.ownerName = String(uploadResult?.owner_name || '');
                this.repoName = String(uploadResult?.repo_name || '');
                this.hasGenerated = true;
                const graphPath = pickInitialGraphUrl(uploadResult);
                if (baseUrl && graphPath) {
                    this.lastServerGraphUrl = `${baseUrl}${graphPath}`;
                }
                this.lastGraphFileUri = fs.existsSync(graphFileUri.fsPath) ? graphFileUri : null;
                if (!quiet || !this.lastDisplayedServerGraphUrl) {
                    this.lastDisplayedServerGraphUrl = '';
                }
                if (this.lastGraphFileUri && (!quiet || !this.displayedGraphFileUri || this.lastDisplayedServerGraphUrl)) {
                    this.displayedGraphFileUri = this.lastGraphFileUri;
                }
                this.postGraph();
                const newGitHash = await computeGitStateHash(folder.uri.fsPath);
                if (newGitHash) {
                    await writeStoredGitStateHash(outDirUri, newGitHash);
                }
                status(`Ready. Generated ${ARTIFACT_OUTPUT_DIR}/ — search below to explore the callgraph.`);
                this.postSearchSuggestions(folder);
                this.post({ type: 'generated' });
                this.refreshMcpUsage(folder);
                statusBarItem.text = '$(check) CODE.md: up to date';
                statusBarItem.tooltip = 'CODE.md';
            }
            catch (err) {
                const messageText = err?.message || String(err);
                status(`Error: ${messageText}`);
                statusBarItem.text = '$(error) CODE.md: analysis failed';
                statusBarItem.tooltip = `CODE.md: ${messageText}`;
                if (!quiet) {
                    vscode.window.showErrorMessage(`CODE.md: Failed to generate CODE.md callgraphs — ${messageText}`);
                }
                else {
                    outputChannel.appendLine(`Background analysis failed: ${messageText}`);
                }
            }
        };
        if (quiet) {
            await runBody(status);
        }
        else {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Generate CODE.md', cancellable: false }, async (progress) => {
                await runBody((text) => {
                    progress.report({ message: text });
                    status(text);
                });
            });
        }
        this.busy = false;
    }
    /** Loads (and caches) the local callgraph node index, rebuilding it if the source file changed on disk. */
    getLocalSearchIndex() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return null;
        }
        const outDirFsPath = path.join(folder.uri.fsPath, ARTIFACT_OUTPUT_DIR);
        if (this.localSearchIndex) {
            const stillCurrent = fs.existsSync(this.localSearchIndex.sourcePath)
                && fs.statSync(this.localSearchIndex.sourcePath).mtimeMs === this.localSearchIndex.sourceMtimeMs;
            if (stillCurrent) {
                return this.localSearchIndex;
            }
        }
        this.localSearchIndex = loadLocalCallgraphIndex(outDirFsPath);
        return this.localSearchIndex;
    }
    runLocalSearchFallback(trimmed, fallbackReason = '') {
        const index = this.getLocalSearchIndex();
        if (!index) {
            outputChannel?.appendLine('[runSearch] no local search index available.');
            const suffix = fallbackReason ? ` ${fallbackReason}` : '';
            this.post({ type: 'searchResult', error: `No semantic search or local callgraph found yet.${suffix} Click Regenerate to build one, then search again.` });
            return;
        }
        const results = searchLocalCallgraph(index, trimmed, 12);
        outputChannel?.appendLine(`[runSearch] local fallback ${results.length} result(s), posting (view=${!!this.view} viewReady=${this.viewReady}).`);
        const resultMessage = {
            type: 'searchResult',
            query: trimmed,
            answer: fallbackReason ? `Semantic search was unavailable, so these are local callgraph name matches. ${fallbackReason}` : '',
            results,
        };
        this.rememberSearchResult(resultMessage);
        this.post(resultMessage);
        this.post({ type: 'status', text: results.length ? 'Ready.' : `No local matches for "${trimmed}".` });
    }
    async runSearch(query) {
        const trimmed = query.trim();
        if (!trimmed) {
            return;
        }
        outputChannel?.appendLine(`[runSearch] query="${trimmed}"`);
        if (!this.ownerName || !this.repoName) {
            this.runLocalSearchFallback(trimmed, 'Repository identity was not available yet.');
            return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        const artifactRootPath = folder ? path.join(folder.uri.fsPath, ARTIFACT_OUTPUT_DIR) : '';
        this.post({ type: 'status', text: `Searching code semantics for "${trimmed}"...` });
        try {
            await this.ensureInteractiveServer();
            const response = await fetch(`${this.baseUrl}/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_name: this.ownerName,
                    repo_name: this.repoName,
                    artifact_root_path: artifactRootPath,
                    query: trimmed,
                    limit: 12,
                }),
            });
            const text = await response.text();
            if (!response.ok) {
                throw new Error(parseErrorDetail(text) || `HTTP ${response.status}`);
            }
            const data = JSON.parse(text || '{}');
            if (data?.error) {
                throw new Error(String(data.error));
            }
            const semanticResults = Array.isArray(data?.results) ? data.results.map(normalizeBackendSearchResult) : [];
            const textResults = Array.isArray(data?.text_results) ? data.text_results.map(normalizeBackendTextResult) : [];
            const seen = new Set();
            const results = [...semanticResults, ...textResults].filter((result) => {
                const key = `${result.graphSymbol}|${result.file}|${result.line}|${result.label}`;
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            }).slice(0, 18);
            if (!results.length) {
                const reason = data?.scim_error
                    ? `Semantic search reported: ${String(data.scim_error).slice(0, 240)}`
                    : 'Semantic search returned no results.';
                this.runLocalSearchFallback(trimmed, reason);
                return;
            }
            const graphUrl = data.search_graph_url || data.graph_url || '';
            if (graphUrl) {
                this.lastDisplayedServerGraphUrl = `${this.baseUrl}${graphUrl}`;
                this.post({ type: 'graph', url: withCacheBust(this.lastDisplayedServerGraphUrl) });
            }
            const resultMessage = {
                type: 'searchResult',
                query: trimmed,
                answer: data.answer || '',
                answerLinks: [],
                results,
            };
            this.rememberSearchResult(resultMessage);
            this.post(resultMessage);
            this.post({ type: 'status', text: 'Ready.' });
            return;
        }
        catch (err) {
            const reason = err?.message || String(err);
            outputChannel?.appendLine(`[runSearch] semantic search failed, falling back locally: ${reason}`);
            this.runLocalSearchFallback(trimmed, reason ? `Semantic search failed: ${String(reason).slice(0, 240)}` : '');
            return;
        }
        const index = this.getLocalSearchIndex();
        if (!index) {
            outputChannel?.appendLine('[runSearch] no local search index available.');
            this.post({ type: 'searchResult', error: 'No local callgraph found yet — click Regenerate to build one, then search again.' });
            return;
        }
        const results = searchLocalCallgraph(index, trimmed, 12);
        outputChannel?.appendLine(`[runSearch] ${results.length} result(s), posting (view=${!!this.view} viewReady=${this.viewReady}).`);
        const resultMessage = {
            type: 'searchResult',
            query: trimmed,
            answer: '',
            results,
        };
        this.rememberSearchResult(resultMessage);
        this.post(resultMessage);
        this.post({ type: 'status', text: results.length ? 'Ready.' : `No local matches for "${trimmed}".` });
    }
    async ensureInteractiveServer() {
        if (this.baseUrl && await isServerReachable(this.baseUrl)) {
            return this.baseUrl;
        }
        if (this.baseUrl) {
            this.baseUrl = '';
            this.post({ type: 'status', text: 'Restarting local graph service...' });
        }
        this.post({ type: 'status', text: 'Starting local search companion...' });
        const baseUrl = await ensureServerRunning(this.context, (text) => {
            this.lastStatus = text;
            this.post({ type: 'status', text });
        }, true);
        this.baseUrl = baseUrl;
        return baseUrl;
    }
    /** Renders a focused subgraph for a single search result — the server derives it on demand, so this lazily starts the local companion server rather than requiring it up front. */
    async runResultGraph(result) {
        if (!this.ownerName || !this.repoName) {
            return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        const artifactRootPath = folder ? path.join(folder.uri.fsPath, ARTIFACT_OUTPUT_DIR) : '';
        const label = String(result?.label || result?.symbol || result?.fullName || result?.name || 'result');
        this.post({ type: 'status', text: `Building graph for "${label}"…` });
        try {
            await this.ensureInteractiveServer();
            const response = await fetch(`${this.baseUrl}/search-result-graph`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_name: this.ownerName,
                    repo_name: this.repoName,
                    artifact_root_path: artifactRootPath,
                    result: {
                        graph_symbol: result?.graphSymbol || '',
                        fullName: result?.fullName || '',
                        symbol: result?.symbol || '',
                        name: result?.name || '',
                        file: result?.file || '',
                        impact_nodes: Array.isArray(result?.impactNodes) ? result.impactNodes : [],
                        impact_files: Array.isArray(result?.impactFiles) ? result.impactFiles : [],
                        change_card: result?.changeCard || null,
                    },
                }),
            });
            const text = await response.text();
            if (!response.ok) {
                throw new Error(parseErrorDetail(text) || `HTTP ${response.status}`);
            }
            const data = JSON.parse(text);
            const graphUrl = data.search_graph_url || data.diff_graph_url || data.file_graph_url || '';
            if (graphUrl) {
                this.lastDisplayedServerGraphUrl = `${this.baseUrl}${graphUrl}`;
                this.post({ type: 'graph', url: withCacheBust(this.lastDisplayedServerGraphUrl) });
                this.post({ type: 'status', text: (result?.impactNodes || result?.impactFiles) ? 'Showing diff graph.' : 'Ready.' });
            }
            else {
                // No callgraph node matched this result — fall back to whichever
                // durable graph (local mirror or last full-repo server graph) was
                // showing before the search, instead of leaving a stale graph up.
                this.postGraph();
                this.post({
                    type: 'status',
                    text: data.error || data.search_graph_error || `"${label}" did not match a node in the callgraph — showing the full graph.`,
                });
            }
        }
        catch (err) {
            const messageText = err?.message || String(err);
            this.post({ type: 'status', text: `Error: ${messageText}` });
        }
    }
    /**
     * "What changed since I started this session, and is anything I deleted
     * still referenced elsewhere?" Diffs the working tree against the git ref
     * captured at session start (scripts/deletion-report.py), scoring deleted
     * functions by how connected they were and computing the blast radius of
     * modified ones. Rendered through the same result-list UI as search —
     * clicking an entry opens its file and, where the symbol still resolves in
     * the callgraph, focuses that subgraph too.
     */
    changeTimeForFile(folder, file) {
        if (!file) {
            return 0;
        }
        try {
            return fs.statSync(path.join(folder.uri.fsPath, file)).mtimeMs;
        }
        catch {
            return 0;
        }
    }
    /**
     * Spawns scripts/deletion-report.py against the workspace root and parses
     * its JSON report. Shared by runChangesCheck (full list) and
     * runBlastRadiusCheck (filtered summary) — both need the identical
     * diff/callgraph data, just rendered differently.
     */
    async runDeletionReportScript(folder, onlyFiles, refs, onProgress, options) {
        const backendDir = await resolveBackendDir(this.context, true);
        const scriptPath = path.join(this.context.extensionUri.fsPath, 'scripts', 'deletion-report.py');
        const pythonPath = await backendPythonPath(this.context, backendDir, () => { });
        const base = refs?.base ?? 'HEAD';
        const args = [scriptPath, '--repo-root', folder.uri.fsPath, '--base', base, '--backend-dir', backendDir];
        if (refs?.target) {
            args.push('--target', refs.target);
        }
        if (options?.maxImpactSymbols && options.maxImpactSymbols > 0) {
            args.push('--max-impact-symbols', String(options.maxImpactSymbols));
        }
        for (const file of onlyFiles || []) {
            args.push('--only', file);
        }
        const stdout = await new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)(pythonPath, args, { cwd: backendDir, env: localBackendEnv(this.context) });
            let out = '';
            let err = '';
            trackProcess(proc);
            proc.stdout.on('data', (chunk) => { out += chunk.toString(); });
            proc.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                err += text;
                for (const line of text.split(/\r?\n/)) {
                    const match = line.match(/^\[codemd-progress\]\s*(.+)$/);
                    if (match) {
                        onProgress?.(match[1]);
                    }
                }
            });
            proc.on('error', reject);
            proc.on('exit', (code) => {
                if (code === 0) {
                    resolve(out);
                }
                else {
                    reject(new Error(err.trim() || `deletion-report.py exited with code ${code}`));
                }
            });
        });
        return { report: JSON.parse(stdout), base };
    }
    /**
     * Git's own diff (no Python, no callgraph) is enough to name the most
     * recently touched changed file, so this resolves well before
     * runDeletionReportScript's full multi-file pass would even finish loading
     * the callgraph.
     */
    async mostRecentlyChangedFile(folder) {
        const diff = await execGitAsync(['diff', '--name-only', '-M', 'HEAD', '--', '.', `:!${ARTIFACT_OUTPUT_DIR}/**`, ':!out/**', ':!dist/**', ':!build/**', ':!output*/**', ':!*.vsix', ':!*.pyc', ':!*.pyo'], folder.uri.fsPath);
        if (diff.status !== 0) {
            return null;
        }
        const files = diff.stdout.split('\n').map((f) => f.trim()).filter(Boolean);
        const untracked = await execGitAsync(['ls-files', '--others', '--exclude-standard', '--', '.', `:!${ARTIFACT_OUTPUT_DIR}/**`, ':!out/**', ':!dist/**', ':!build/**', ':!output*/**', ':!*.vsix', ':!*.pyc', ':!*.pyo'], folder.uri.fsPath);
        if (untracked.status === 0) {
            files.push(...untracked.stdout.split('\n').map((f) => f.trim()).filter(Boolean));
        }
        let best = null;
        let bestTime = -1;
        for (const file of files) {
            const t = this.changeTimeForFile(folder, file);
            if (t > bestTime) {
                bestTime = t;
                best = file;
            }
        }
        return best;
    }
    async postLatestChangeSketch(folder) {
        try {
            const file = await this.mostRecentlyChangedFile(folder);
            if (!file) {
                return;
            }
            const result = {
                label: `Latest changed file: ${file}`,
                file,
                line: '',
                snippet: 'Fast preview from Git status. Full function-level impact analysis is still running.',
                changeCard: {
                    kind: 'files',
                    title: 'Latest changed file',
                    change: file,
                    risk: 'Preview',
                    riskLevel: 'unknown',
                    metrics: [{ label: 'Mode', value: 'Fast preview' }],
                    evidence: [file],
                    checks: ['Review full report when it finishes'],
                    actions: ['View diff graph', 'View diff'],
                    startCollapsed: false,
                },
                graphSymbol: '',
                fullName: '',
                symbol: file,
                name: file,
                impactFiles: [file],
                impactScore: 1,
                changeTime: this.changeTimeForFile(folder, file),
            };
            this.post({
                type: 'searchResult',
                kind: 'changes',
                replace: true,
                query: 'Uncommitted Edits',
                answer: `Fast preview: ${file}. Running full function-level report in the background...`,
                defaultSort: 'impact',
                results: [result],
            });
            void this.runResultGraph(result);
        }
        catch (err) {
            outputChannel?.appendLine(`[postLatestChangeSketch] skipped: ${err?.message || String(err)}`);
        }
    }
    /**
     * Fast preview shown before the full batch report (runChangesCheck below)
     * completes: scopes deletion-report.py to just the single most recently
     * modified changed file (via --only) instead of every changed file, so it
     * finishes long before the full multi-file run. Best-effort only — the
     * full run that follows is authoritative and replaces this once it lands,
     * so any failure here just means no preview, not a broken check.
     */
    async postMostRecentChangePreview(folder) {
        try {
            const file = await this.mostRecentlyChangedFile(folder);
            if (!file) {
                return;
            }
            const { report } = await this.runDeletionReportScript(folder, [file], undefined, (message) => {
                this.post({ type: 'status', text: `Previewing most recent edit: ${message}` });
            }, { maxImpactSymbols: 1 });
            if (report.error) {
                return;
            }
            const [result] = this.buildChangeResults(report, folder);
            if (!result) {
                return;
            }
            if (!this.changesBusy) {
                return;
            }
            this.post({
                type: 'searchResult',
                kind: 'changes',
                replace: true,
                query: 'Uncommitted Edits',
                answer: `Showing the most recently changed function first (${result.symbol || result.name}) — still checking the rest of the diff…`,
                defaultSort: 'impact',
                results: [result],
            });
            void this.runResultGraph(result);
        }
        catch {
            // Best-effort preview only; the full run in runChangesCheck below is authoritative.
        }
    }
    /**
     * Shared by the fast single-file preview (postMostRecentChangePreview) and
     * the full run below — both turn the same deletion-report.py JSON shape
     * into the same NormalizedSearchResult cards, just over a different set of
     * changed files.
     */
    buildChangeResults(report, folder, options) {
        // changeTimeOverride is used for a specific historical commit, where the
        // live file's mtime on disk has nothing to do with when that commit
        // landed (and diffRefs points "View diff"/graph clicks at that commit's
        // ref pair instead of the default HEAD-vs-working-tree).
        const changeTimeFor = (file) => options?.changeTimeOverride ?? this.changeTimeForFile(folder, file);
        const diffBase = options?.diffRefs?.base;
        const diffTarget = options?.diffRefs?.target;
        const results = [];
        for (const d of report.deleted || []) {
            const symbol = String(d.symbol || '');
            const tail = symbol.split('.').pop() || symbol;
            const file = String(d.file || '');
            const card = buildDeletedChangeCard(d);
            results.push({
                label: `${card.title}: ${compactSymbolName(symbol)}`,
                file,
                line: String(d.line || ''),
                snippet: card.change,
                changeCard: card,
                graphSymbol: symbol,
                fullName: symbol,
                symbol: tail,
                name: tail,
                impactNodes: impactedNodesFromChange(d),
                impactFiles: impactedFilesFromChange(d),
                impactScore: impactScoreForDeletedChange(d),
                changeTime: changeTimeFor(file),
                diffBase,
                diffTarget,
            });
        }
        for (const m of report.modified || []) {
            const symbol = String(m.symbol || '');
            const tail = symbol.split('.').pop() || symbol;
            const file = String(m.file || '');
            const card = buildModifiedChangeCard(m);
            results.push({
                label: `${card.title}: ${compactSymbolName(symbol)}`,
                file,
                line: String(m.line || ''),
                snippet: card.change,
                changeCard: card,
                graphSymbol: symbol,
                fullName: symbol,
                symbol: tail,
                name: tail,
                // Only confirmed (resolved, parsed call edge) nodes seed the initial
                // cytoscape view — inferred/possible nodes are real but would drown
                // the diagram (e.g. 30 confirmed vs. 93 heuristic). They're still
                // reachable by clicking through the graph since the full callgraph
                // stays loaded underneath.
                impactNodes: confirmedAndInferredNodes(impactedNodesFromChange(m), nodeConfidenceFromChange(m)).confirmed,
                impactFiles: impactedFilesFromChange(m),
                impactScore: impactScoreForModifiedChange(m),
                changeTime: changeTimeFor(file),
                diffBase,
                diffTarget,
            });
        }
        const representedFiles = new Set();
        for (const d of report.deleted || []) {
            const file = String(d?.file || '').replace(/\\/g, '/');
            if (file) {
                representedFiles.add(file);
            }
        }
        for (const m of report.modified || []) {
            const file = String(m?.file || '').replace(/\\/g, '/');
            if (file) {
                representedFiles.add(file);
            }
        }
        const uncommittedFiles = Array.isArray(report.uncommitted_files) ? report.uncommitted_files : [];
        const otherFileRecords = uncommittedFiles.length
            ? uncommittedFiles.filter((file) => {
                const filePath = uncommittedFilePath(file);
                return filePath && (uncommittedFileStatus(file) === 'deleted' || !representedFiles.has(filePath));
            })
            : (report.unsupported_files || []).map((file) => ({ status: 'changed', path: String(file || '') }));
        const otherFilePaths = otherFileRecords.map(uncommittedFilePath).filter(Boolean);
        if (otherFileRecords.length) {
            const card = buildOtherFilesCard(otherFileRecords);
            const fileRisk = assessFileChangeRisk(otherFileRecords);
            results.push({
                label: card.title,
                file: '',
                line: '',
                snippet: card.change,
                changeCard: card,
                graphSymbol: '',
                fullName: '',
                symbol: '',
                name: '',
                impactNodes: [],
                impactFiles: otherFilePaths,
                impactScore: fileRisk.score + otherFilePaths.length * 3,
                changeTime: options?.changeTimeOverride ?? Math.max(0, ...otherFilePaths.map((file) => this.changeTimeForFile(folder, file))),
                diffBase,
                diffTarget,
            });
        }
        results.sort((a, b) => {
            const riskDelta = riskRank(a.changeCard?.riskLevel || 'unknown') - riskRank(b.changeCard?.riskLevel || 'unknown');
            return riskDelta || ((b.changeTime || 0) - (a.changeTime || 0));
        });
        return results;
    }
    async runChangesCheck(options = {}) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return;
        }
        if (this.changesBusy) {
            if (options.focusHighestImpact) {
                this.pendingFocusHighestImpact = true;
            }
            if (!options.quietIfBusy) {
                this.post({ type: 'status', text: 'Already checking changes — please wait.' });
            }
            return;
        }
        this.changesBusy = true;
        this.post({ type: 'status', text: 'Checking uncommitted edits…' });
        try {
            // Fast path: post the single most recently changed function (and open
            // its impact graph) before the full multi-file run below even starts
            // its callgraph work, so the panel shows something right away instead
            // of sitting on "Checking uncommitted edits…" for the whole batch.
            await this.postLatestChangeSketch(folder);
            const { report } = await this.runDeletionReportScript(folder, undefined, undefined, (message) => {
                this.post({ type: 'status', text: `Checking uncommitted edits: ${message}` });
            }, { maxImpactSymbols: 30 });
            if (report.error) {
                this.post({ type: 'status', text: `Error checking changes: ${report.error}` });
                return;
            }
            const results = this.buildChangeResults(report, folder);
            const answer = buildChangesAnswer(report);
            const answerLinks = buildChangesAnswerLinks(report);
            const resultMessage = {
                type: 'searchResult',
                kind: 'changes',
                replace: true,
                query: 'Uncommitted Edits',
                answer,
                answerLinks,
                defaultSort: 'impact',
                results,
            };
            this.rememberSearchResult(resultMessage);
            this.post(resultMessage);
            // The data list above is the whole point of "check changes" — release
            // the busy flag now so a user who clicks it again isn't told "Already
            // checking changes — please wait" for as long as the graph build
            // below takes. Building the highlighted subgraph can call
            // ensureInteractiveServer(), which spawns the local FastAPI server on
            // first use and can take up to waitForServerReady's 120s timeout; that
            // used to happen while still awaited here, holding changesBusy the
            // whole time and leaving the panel looking stuck/blank.
            this.changesBusy = false;
            const shouldFocusHighestImpact = options.focusHighestImpact || this.pendingFocusHighestImpact;
            this.pendingFocusHighestImpact = false;
            const highestImpact = shouldFocusHighestImpact ? pickHighestImpactGraphable(results) : undefined;
            if (highestImpact) {
                this.post({ type: 'status', text: `Showing highest-impact change in the graph: ${highestImpact.symbol || highestImpact.name || highestImpact.label}` });
                // Fire-and-forget: runResultGraph reports its own status/errors, and
                // must not block the changes list or hold changesBusy.
                void this.runResultGraph(highestImpact);
            }
            else {
                this.post({ type: 'status', text: 'Ready.' });
            }
        }
        catch (err) {
            this.post({ type: 'status', text: `Error checking changes: ${err?.message || String(err)}` });
        }
        finally {
            this.changesBusy = false;
        }
    }
    /**
     * Blast Radius Report: the same diff/callgraph data as runChangesCheck, but
     * filtered down to only the changed functions whose caller footprint
     * crosses BLAST_RADIUS_DIRECT_CALLER_THRESHOLD /
     * BLAST_RADIUS_TOTAL_UPSTREAM_THRESHOLD — everything else is dropped
     * silently so this stays a short, high-signal list instead of restating
     * every touched function.
     */
    async runBlastRadiusCheck() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return;
        }
        if (this.changesBusy) {
            this.post({ type: 'status', text: 'Already checking changes — please wait.' });
            return;
        }
        this.changesBusy = true;
        this.post({ type: 'status', text: 'Computing blast radius of uncommitted changes…' });
        try {
            const { report } = await this.runDeletionReportScript(folder);
            if (report.error) {
                this.post({ type: 'status', text: `Error computing blast radius: ${report.error}` });
                return;
            }
            const entries = blastRadiusEntriesFromReport(report);
            const results = entries.map((entry) => {
                const tail = entry.symbol.split('.').pop() || entry.symbol;
                const card = buildBlastRadiusCard(entry);
                return {
                    label: `${card.title}: ${compactSymbolName(entry.symbol)}`,
                    file: entry.file,
                    line: '',
                    snippet: card.change,
                    changeCard: card,
                    graphSymbol: entry.symbol,
                    fullName: entry.symbol,
                    symbol: tail,
                    name: tail,
                    // Same confirmed-only filtering as the modified-change graph above —
                    // the blast radius card's own headline count already excludes
                    // inferred nodes, so the graph it links to should match.
                    impactNodes: confirmedAndInferredNodes(entry.affectedNodes, entry.nodeConfidence).confirmed,
                    impactFiles: entry.affectedFiles,
                    impactScore: (entry.directCallers * 20) + (entry.totalUpstream * 8) + (entry.affectedFiles.length * 12),
                    changeTime: this.changeTimeForFile(folder, entry.file),
                };
            });
            const answer = entries.length
                ? `${entries.length} high-risk change(s) crossed the blast-radius threshold ` +
                    `(≥${BLAST_RADIUS_DIRECT_CALLER_THRESHOLD} direct callers or ≥${BLAST_RADIUS_TOTAL_UPSTREAM_THRESHOLD} total upstream-affected functions).`
                : '✅ No high-risk changes detected';
            const resultMessage = {
                type: 'searchResult',
                kind: 'blastRadius',
                replace: true,
                query: 'Blast Radius Report',
                answer,
                defaultSort: 'impact',
                results,
            };
            this.rememberSearchResult(resultMessage);
            this.post(resultMessage);
            this.post({ type: 'status', text: 'Ready.' });
        }
        catch (err) {
            this.post({ type: 'status', text: `Error computing blast radius: ${err?.message || String(err)}` });
        }
        finally {
            this.changesBusy = false;
        }
    }
    /**
     * Same impact/callgraph analysis as "Check Uncommitted Edits", but diffing
     * one past commit against its parent (base=hash^, target=hash) instead of
     * the working tree against HEAD — so clicking a "Latest Commits" row shows
     * that commit's changed functions, their blast radius graph, and its diff,
     * without depending on (or disturbing) whatever the working tree currently
     * looks like.
     */
    async runCommitCheck(hash) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder || !hash) {
            return;
        }
        if (this.changesBusy) {
            this.post({ type: 'status', text: 'Already checking changes — please wait.' });
            return;
        }
        this.changesBusy = true;
        this.post({ type: 'status', text: `Analyzing commit ${hash}...` });
        try {
            const parent = await resolveCommitParentRef(hash, folder.uri.fsPath);
            const meta = await execGitAsync(['log', '-1', '--format=%s%x1f%ct', hash], folder.uri.fsPath);
            const [subject = '', commitEpochSeconds = ''] = (meta.stdout || '').trim().split('\x1f');
            const commitTime = Number(commitEpochSeconds) ? Number(commitEpochSeconds) * 1000 : 0;
            const diffRefs = { base: parent, target: hash };
            const { report } = await this.runDeletionReportScript(folder, undefined, diffRefs);
            if (report.error) {
                this.post({ type: 'status', text: `Error analyzing commit ${hash}: ${report.error}` });
                return;
            }
            const results = this.buildChangeResults(report, folder, { changeTimeOverride: commitTime, diffRefs });
            const header = `Commit ${hash}${subject ? ` — "${subject}"` : ''}:`;
            const answer = results.length
                ? `${header}\n${buildChangesAnswer(report)}`
                : `${header} no impact detected in supported source files.`;
            const answerLinks = buildChangesAnswerLinks(report, diffRefs);
            const resultMessage = {
                type: 'searchResult',
                kind: 'commitDetail',
                replace: false,
                query: `Commit ${hash}`,
                answer,
                answerLinks,
                defaultSort: 'impact',
                results,
            };
            this.rememberSearchResult(resultMessage);
            this.post(resultMessage);
            this.changesBusy = false;
            const highestImpact = pickHighestImpactGraphable(results);
            if (highestImpact) {
                this.post({ type: 'status', text: `Showing highest-impact change in commit ${hash}: ${highestImpact.symbol || highestImpact.name || highestImpact.label}` });
                if (highestImpact.file) {
                    void this.viewDiff(highestImpact.file, diffRefs);
                }
                void this.runResultGraph(highestImpact);
            }
            else {
                // No result has a graphSymbol (e.g. a commit that only touches
                // docs/config/unsupported-language files) — pickHighestImpactGraphable
                // intentionally skips those to avoid a bogus graph lookup, but the
                // diff itself is still real and worth opening so the click isn't a
                // silent no-op.
                const fallbackFile = results.find((r) => r.file)?.file
                    || results.flatMap((r) => r.impactFiles || []).find(Boolean);
                if (fallbackFile) {
                    this.post({ type: 'status', text: `Commit ${hash} has no function-level graph data; showing diff for ${fallbackFile}.` });
                    void this.viewDiff(fallbackFile, diffRefs);
                }
                else {
                    this.post({ type: 'status', text: `Commit ${hash}: no diffable changes found.` });
                }
            }
        }
        catch (err) {
            this.post({ type: 'status', text: `Error analyzing commit ${hash}: ${err?.message || String(err)}` });
        }
        finally {
            this.changesBusy = false;
        }
    }
    async runLatestCommitsCheck() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return;
        }
        if (this.commitsBusy) {
            this.post({ type: 'status', text: 'Already checking latest commits - please wait.' });
            return;
        }
        this.commitsBusy = true;
        this.post({ type: 'status', text: 'Checking latest commits...' });
        try {
            const result = await execGitAsync([
                'log',
                '--date=short',
                '--name-status',
                '--pretty=format:__CODEMD_COMMIT__%x1f%h%x1f%an%x1f%ad%x1f%s',
                '-n',
                '8',
                '--',
            ], folder.uri.fsPath);
            if (result.status !== 0) {
                this.post({ type: 'status', text: `Error checking latest commits: ${(result.stderr || '').trim() || result.status}` });
                return;
            }
            const commits = [];
            let current = null;
            for (const line of (result.stdout || '').split(/\r?\n/)) {
                if (!line.trim()) {
                    continue;
                }
                if (line.startsWith('__CODEMD_COMMIT__\x1f')) {
                    const [, hash = '', author = '', date = '', subject = ''] = line.split('\x1f');
                    current = { hash, author, date, subject, files: [] };
                    commits.push(current);
                    continue;
                }
                if (current) {
                    const parts = line.split('\t').filter(Boolean);
                    const file = parts[parts.length - 1] || '';
                    if (file) {
                        current.files.push(file.replace(/\\/g, '/'));
                    }
                }
            }
            const results = commits.map((commit) => {
                const shownFiles = commit.files.slice(0, 20);
                return {
                    label: `${commit.hash} ${commit.subject} (${commit.date}, ${commit.author}; ${commit.files.length} file(s))`,
                    file: '',
                    line: '',
                    snippet: '',
                    fileList: shownFiles,
                    fileListMore: commit.files.length - shownFiles.length,
                    graphSymbol: '',
                    fullName: '',
                    symbol: commit.hash,
                    name: commit.subject,
                    commitHash: commit.hash,
                };
            });
            const answer = commits.length
                ? `Latest ${commits.length} commit(s). Click a commit to see its impact graph and diff, or a file below to open it directly.`
                : 'No commits found in this workspace.';
            const resultMessage = {
                type: 'searchResult',
                query: 'Latest Commits',
                answer,
                results,
            };
            this.rememberSearchResult(resultMessage);
            this.post(resultMessage);
            this.post({ type: 'status', text: 'Ready.' });
        }
        catch (err) {
            this.post({ type: 'status', text: `Error checking latest commits: ${err?.message || String(err)}` });
        }
        finally {
            this.commitsBusy = false;
        }
    }
}
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
function getFullGraphHtml(graphUrl, cspSource) {
    return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${cspSource} https://unpkg.com; connect-src ${cspSource}; frame-src ${cspSource} http://127.0.0.1:* http://localhost:*;">
<style>
  html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-editor-background); }
  iframe { width: 100vw; height: 100vh; border: 0; display: block; }
</style>
</head>
<body>
  <iframe src="${graphUrl}" title="CODE.md callgraph"></iframe>
</body>
</html>`;
}
function getHtml(host, port, cspSource) {
    const nonce = getNonce();
    const frameOrigin = `http://${host}:${port}`;
    return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${cspSource} https://unpkg.com; connect-src ${cspSource} ${frameOrigin} http://127.0.0.1:* http://localhost:*; frame-src ${cspSource} ${frameOrigin} http://127.0.0.1:* http://localhost:*;">
<style>
  html, body { height: 100%; margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  body { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  #graphPane { flex: 3 1 0; min-height: 80px; position: relative; }
  #graphFrame { position: absolute; inset: 0; width: 100%; height: 100%; border: none; display: none; }
  body.graph-rotated #graphFrame { inset: auto; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(90deg); transform-origin: center center; }
  #emptyState { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 12px; }
  #emptyState p { margin: 0; opacity: 0.8; font-size: 12px; }
  #emptyState p.emptyStateError { opacity: 1; color: var(--vscode-errorForeground); }
  #emptyStateRetryBtn { display: none; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #paneResizeHandle { flex: 0 0 7px; border-top: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); cursor: row-resize; background: var(--vscode-sideBar-background); position: relative; }
  #paneResizeHandle::before { content: ""; position: absolute; left: 50%; top: 2px; width: 36px; height: 2px; transform: translateX(-50%); border-top: 1px solid var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-descriptionForeground); opacity: 0.45; }
  #paneResizeHandle:hover, body.resizing-panes #paneResizeHandle { background: var(--vscode-list-hoverBackground); }
  body.resizing-panes { cursor: row-resize; user-select: none; }
  body.resizing-panes #graphFrame { pointer-events: none; }
  #chatPane { flex: 2 1 0; display: flex; flex-direction: column; min-height: 120px; overflow: hidden; }
  #statusRow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  #statusLine { flex: 1 1 150px; min-width: 120px; font-size: 11px; opacity: 0.7; }
  #statusRow button { flex: 0 0 auto; max-width: none; padding: 2px 8px; font-size: 11px; line-height: 1.2; white-space: nowrap; }
  body.graph-expanded #graphPane { flex: 1 1 auto; min-height: 100%; border-bottom: 0; }
  body.graph-expanded #paneResizeHandle { display: none; }
  body.graph-expanded #chatPane { display: none; }
  #graphToolbar { position: absolute; top: 8px; right: 8px; z-index: 5; display: flex; gap: 4px; }
  #graphToolbar button { padding: 3px 8px; font-size: 11px; opacity: 0.92; }
  #mcpUsageCard { margin: 8px; padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); }
  #mcpUsageHeadline { display: flex; align-items: center; gap: 8px; }
  .mcpDot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-descriptionForeground); }
  #mcpUsageCard.mcp-active .mcpDot { background: #3fb950; }
  #mcpUsageCard.mcp-idle .mcpDot { background: #d29922; }
  #mcpUsageLabel { font-size: 13px; font-weight: 600; }
  #mcpUsageSubtitle { font-size: 11px; opacity: 0.7; margin: 3px 0 0 18px; }
  #mcpSetupStatus { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 0 18px; }
  .mcpChip { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 7px; font-size: 10px; line-height: 16px; opacity: 0.9; }
  .mcpChip-ok { color: #3fb950; }
  .mcpChip-warn { color: #d29922; }
  .mcpChip-missing { color: var(--vscode-errorForeground); }
  #mcpActionRow { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 0 18px; }
  #mcpActionRow button { flex: 0 0 auto; padding: 2px 8px; font-size: 11px; line-height: 1.2; }
  #mcpActionRow button:disabled { opacity: 0.55; cursor: default; }
  #mcpActionRow:empty { display: none; }
  #mcpUsageByClient { margin: 4px 0 0 18px; font-size: 12px; opacity: 0.85; }
  #mcpUsageByClient:empty { display: none; margin-top: 0; }
  #mcpUsageByClient .clientLine { display: block; padding: 1px 0; }
  #setupMcpBtn { margin-left: auto; flex: 0 0 auto; padding: 2px 8px; font-size: 11px; line-height: 1.2; }
  body.has-results #mcpUsageCard { margin: 6px 8px; padding: 6px 10px; }
  body.has-results #mcpUsageLabel { font-size: 12px; }
  body.has-results #mcpUsageSubtitle,
  body.has-results #mcpSetupStatus,
  body.has-results #mcpActionRow,
  body.has-results #mcpUsageByClient { display: none; }
  #messages { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 12px; scrollbar-gutter: stable; }
  .msg { margin-bottom: 12px; }
  .msg .query { font-weight: 600; margin-bottom: 4px; }
  .msg .answer { white-space: pre-wrap; font-size: 12px; margin-bottom: 6px; }
  .answerFunctionLink { border: 0; padding: 0; background: transparent; color: var(--vscode-textLink-foreground); font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .answerFunctionLink:hover { color: var(--vscode-textLink-activeForeground); }
  .changeSymbolButton { border: 0; padding: 0; background: transparent; color: var(--vscode-textLink-foreground); font: inherit; text-align: left; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  .changeSymbolButton:hover { color: var(--vscode-textLink-activeForeground); }
  .msg .error { color: var(--vscode-errorForeground); font-size: 12px; }
  .resultToolbar { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin: 0 0 8px; font-size: 11px; opacity: 0.9; }
  .resultToolbar label { opacity: 0.8; }
  .resultToolbar select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 2px 6px; font-size: 11px; }
  .result { font-size: 12px; padding: 6px 8px; border-radius: 3px; margin-bottom: 5px; cursor: pointer; background: var(--vscode-list-hoverBackground); }
  .result:hover { background: var(--vscode-list-activeSelectionBackground); }
  .result.no-click { cursor: default; }
  .result.no-click:hover { background: var(--vscode-list-hoverBackground); }
  .commitFileRow { cursor: pointer; padding: 1px 4px; border-radius: 3px; }
  .commitFileRow:hover { background: var(--vscode-list-activeSelectionBackground); text-decoration: underline; }
  .commitFileMore { opacity: 0.6; font-size: 11px; margin-top: 2px; }
  .result .label { font-weight: 600; }
  .result .loc { opacity: 0.7; }
  .result .snippet { white-space: pre-wrap; opacity: 0.82; margin-top: 3px; line-height: 1.35; }
  .changeCard { display: grid; gap: 6px; }
  .changeCard.is-collapsed .changeDetails { display: none; }
  .result.is-collapsed .commitFileList { display: none; }
  .changeTop { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
  .changeTitleRow { display: flex; align-items: center; gap: 6px; }
  .changeTitle { font-size: 11px; opacity: 0.75; }
  .changeSymbol { font-size: 12px; font-weight: 700; word-break: break-word; }
  .riskPill { flex: 0 0 auto; border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 1px 7px; font-size: 10px; font-weight: 700; }
  .risk-critical, .risk-high { color: var(--vscode-errorForeground); }
  .risk-medium { color: var(--vscode-editorWarning-foreground); }
  .metricGrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
  .metric { border: 1px solid var(--vscode-panel-border); padding: 4px; border-radius: 3px; }
  .metricValue { display: block; font-size: 13px; font-weight: 700; }
  .metricLabel { display: block; opacity: 0.72; overflow-wrap: anywhere; }
  .changeSection { opacity: 0.88; line-height: 1.35; }
  .changeSectionTitle { font-weight: 700; opacity: 0.85; margin-bottom: 2px; }
  .signatureCompare { display: grid; gap: 5px; }
  .signatureBlock { display: grid; gap: 2px; }
  .signatureLabel { font-size: 10px; font-weight: 700; opacity: 0.72; text-transform: uppercase; }
  .signatureCode { display: block; margin: 0; padding: 5px 6px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }
  .expandToggle { display: block; width: 100%; text-align: left; border: none; background: transparent; color: inherit; font: inherit; padding: 0; cursor: pointer; }
  .expandToggle:hover { opacity: 1; text-decoration: underline; text-underline-offset: 2px; }
  .actionRow { display: flex; flex-wrap: wrap; gap: 4px; }
  .actionChip { border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 1px 5px; opacity: 0.88; }
  .actionChipClickable { cursor: pointer; }
  .actionChipClickable:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  .evidenceFileLink { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px; }
  .evidenceFileLink:hover { opacity: 1; color: var(--vscode-textLink-activeForeground); }
  .detailsToggle { flex: 0 0 auto; border: 1px solid var(--vscode-panel-border); border-radius: 3px; background: transparent; color: var(--vscode-foreground); padding: 0 4px; font-size: 10px; line-height: 16px; cursor: pointer; }
  .detailsToggle:hover { background: var(--vscode-list-hoverBackground); }
  .changeGroupBody { display: grid; gap: 5px; margin-top: 2px; }
  .changeGroupBody .result { margin-bottom: 0; }
  #searchForm { flex: 0 0 auto; display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
  #queryInput { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 6px; }
  @media (max-width: 480px) {
    #statusRow button { flex: 1 1 calc(50% - 6px); white-space: normal; }
    #setupMcpBtn { margin-left: 0; }
  }
</style>
</head>
<body>
  <div id="graphPane">
    <div id="graphToolbar">
      <button id="openGraphBtn" title="Open the graph in a full editor tab">Full Screen</button>
      <button id="rotateGraphBtn" title="Use a vertical graph view">Vertical</button>
      <button id="expandGraphBtn" title="Make the graph fill this side window">Expand</button>
    </div>
    <div id="emptyState">
      <p id="emptyStateText">Analyzing this workspace in the background — the callgraph will appear here automatically.</p>
      <button id="emptyStateRetryBtn" title="Try generating the callgraph again">Retry</button>
    </div>
    <iframe id="graphFrame"></iframe>
  </div>
  <div id="paneResizeHandle" role="separator" aria-label="Resize graph and report panes" aria-orientation="horizontal" title="Drag to resize the graph and report panes"></div>
  <div id="chatPane">
    <div id="statusRow">
      <span id="statusLine">Preparing callgraph in the background…</span>
      <button id="checkChangesBtn" title="Check local file edits that have not been committed yet.">Check Uncommitted Edits</button>
      <button id="blastRadiusBtn" title="Show only changed functions whose callers are numerous enough to be risky.">Blast Radius Report</button>
      <button id="checkCommitsBtn" title="Show the latest commits in this Git repository.">Check Latest Commits</button>
      <button id="generateBtn">Regenerate</button>
    </div>
    <div id="mcpUsageCard" title="Claude/Codex CODE.md MCP usage observed by the MCP wrapper.">
      <div id="mcpUsageHeadline">
        <span class="mcpDot"></span>
        <span id="mcpUsageLabel">CODE.md MCP (callgraph) used? Codex 0 total, Claude 0 total</span>
        <button id="setupMcpBtn" title="Write Claude/Codex MCP config for this workspace. You may still need to approve the server in your client.">Set Up MCP</button>
      </div>
      <div id="mcpUsageSubtitle"></div>
      <div id="mcpSetupStatus"></div>
      <div id="mcpActionRow">
        <button id="approveCodexBtn" title="Auto-approve codemd's tools in Codex so it stops prompting per call.">Approve Codex MCP</button>
        <button id="approveClaudeBtn" title="Pre-approve codemd for Claude Code via .claude/settings.local.json.">Approve Claude MCP</button>
        <button id="openCodexBtn" title="Start a fresh Codex session in this workspace and open /mcp.">Open Codex /mcp</button>
        <button id="openClaudeBtn" title="Start Claude Code in this workspace and open /mcp.">Open Claude Code /mcp</button>
      </div>
      <div id="mcpUsageByClient"></div>
    </div>
    <div id="messages"></div>
    <form id="searchForm">
      <input id="queryInput" type="text" placeholder="Search this codebase…" list="querySuggestions" autocomplete="off" />
      <datalist id="querySuggestions"></datalist>
      <button type="submit">Search</button>
    </form>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.addEventListener('error', (event) => {
    vscode.postMessage({
      type: 'clientError',
      message: String(event?.message || 'unknown error'),
      source: String(event?.filename || ''),
      line: event?.lineno,
      stack: event?.error?.stack ? String(event.error.stack) : '',
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    vscode.postMessage({
      type: 'clientError',
      message: 'Unhandled promise rejection: ' + String(event?.reason?.message || event?.reason || 'unknown'),
      stack: event?.reason?.stack ? String(event.reason.stack) : '',
    });
  });
  const graphFrame = document.getElementById('graphFrame');
  const graphPane = document.getElementById('graphPane');
  const chatPane = document.getElementById('chatPane');
  const paneResizeHandle = document.getElementById('paneResizeHandle');
  const emptyState = document.getElementById('emptyState');
  const emptyStateText = document.getElementById('emptyStateText');
  const emptyStateRetryBtn = document.getElementById('emptyStateRetryBtn');
  const statusLine = document.getElementById('statusLine');
  const mcpUsageCard = document.getElementById('mcpUsageCard');
  const mcpUsageLabel = document.getElementById('mcpUsageLabel');
  const mcpUsageSubtitle = document.getElementById('mcpUsageSubtitle');
  const mcpSetupStatus = document.getElementById('mcpSetupStatus');
  const mcpActionRow = document.getElementById('mcpActionRow');
  const openCodexBtn = document.getElementById('openCodexBtn');
  const openClaudeBtn = document.getElementById('openClaudeBtn');
  const approveCodexBtn = document.getElementById('approveCodexBtn');
  const approveClaudeBtn = document.getElementById('approveClaudeBtn');
  const mcpUsageByClient = document.getElementById('mcpUsageByClient');
  const setupMcpBtn = document.getElementById('setupMcpBtn');
  const messages = document.getElementById('messages');
  const generateBtn = document.getElementById('generateBtn');
  const checkChangesBtn = document.getElementById('checkChangesBtn');
  const blastRadiusBtn = document.getElementById('blastRadiusBtn');
  const checkCommitsBtn = document.getElementById('checkCommitsBtn');
  const openGraphBtn = document.getElementById('openGraphBtn');
  const rotateGraphBtn = document.getElementById('rotateGraphBtn');
  const expandGraphBtn = document.getElementById('expandGraphBtn');
  const searchForm = document.getElementById('searchForm');
  const queryInput = document.getElementById('queryInput');
  const querySuggestions = document.getElementById('querySuggestions');
  let graphLoadTimer = null;
  let lastGraphUrl = '';
  let searchHistoryQueries = [];
  let searchFunctionSuggestions = [];
  const DEFAULT_REPO_SEARCH_PROMPT_GROUPS = [
    ['Finding Code', [
      'Where is this feature implemented?',
      'Which file handles this feature?',
      'Where is {function} defined?',
      'Which component renders this screen?',
      'Where does this button or form submit?',
      'What does this repo do?',
      'What are the main entry points?',
    ]],
    ['Tracing Flows', [
      'What happens when the user clicks {button}?',
      'Show the flow from UI to backend',
      'Who calls {function}?',
      'What does {function} call?',
      'Show the full execution path for {operation}',
      'Trace API request flow for {route}',
      'Trace this value from UI to database',
    ]],
    ['Feature Analysis', [
      'How does this feature work overall?',
      'Explain the flow for this feature',
      'Walk me through how this feature runs',
      'Explain the full lifecycle of this feature',
      'What does this feature call and what calls it?',
      'Explain what data this feature reads and writes',
      'What external services does this feature depend on?',
      'What would break if this feature was removed?',
      'How does this feature get triggered?',
      'Describe the process for this feature, step by step',
    ]],
    ['Debugging', [
      'What code could cause this error?',
      'Why is this feature not working?',
      'Which code runs when this fails?',
      'Why is this value not being saved?',
      'Where is this error thrown?',
      'Where does this exception get thrown?',
      'What changed recently near this file?',
      'What changed recently near this broken feature?',
      'What was the last change to this file?',
      'What code path leads to this error message?',
      'What runs before this failure point?',
      'Is this error handled anywhere or does it bubble up?',
      'Where is this error being swallowed silently?',
      'What happens when this API returns a 500?',
      'Where could a null pointer occur in this flow?',
      'What conditions trigger this code path?',
      'What input would cause this function to fail?',
      'What writes to this database field?',
      'Where is this timeout being set?',
      'What happens when this external service fails?',
      'Where are retry attempts handled?',
      'Where is this value being mutated unexpectedly?',
      'Where is this object being modified after creation?',
    ]],
    ['Change Impact', [
      'What could break if I change {function}?',
      'What depends on this file?',
      'What else uses this variable or constant?',
      'Is this code safe to delete?',
      'Which functions are affected by this change?',
      'What changed recently?',
      'Summarize today\\'s commits',
      'When was this feature last changed and by whom?',
    ]],
    ['Architecture and Onboarding', [
      'How is authentication implemented?',
      'How does this feature work end to end?',
      'What is the overall architecture?',
      'Where should I add a new API endpoint?',
      'Which modules are most depended on?',
      'Find circular dependencies',
      'Find dependency hotspots',
      'What is the full lifecycle of this entity?',
      'What triggers this feature to activate?',
      'Is this code reachable from the UI?',
      'What other features depend on this feature?',
      'What third-party services does this feature depend on?',
      'What is the user-facing impact of this feature?',
    ]],
    ['Security and Data', [
      'Which APIs are internet exposed?',
      'Where is user input handled without validation?',
      'Where are secrets or tokens used?',
      'Where are database writes performed?',
      'Where is authentication checked?',
      'Where could SQL injection occur?',
      'Where is this value first set?',
      'What writes to this database field?',
      'Where is session state being modified?',
      'Find all places where secrets might be logged',
      'Show all API endpoints with no authentication check',
      'What data does this feature read and write?',
    ]],
    ['Cleanup and Tests', [
      'What functions are never called?',
      'Which files are never imported?',
      'Is this feature still used anywhere?',
      'Find duplicate logic across the codebase',
      'Which tests cover {function}?',
      'What scenarios are missing tests?',
      'How is this feature tested?',
      'Where could a null pointer occur in this flow?',
      'Show all unhandled exceptions in the codebase',
      'Show all deprecated function calls',
      'Find all hardcoded values that should be config',
      'Show all functions with no error handling',
      'Show all async functions missing await',
      'Find all functions over 200 lines',
    ]],
    ['TODOs and Analytics', [
      'Show TODO comments in this repo',
      'Which TODOs look important?',
      'Which TODOs are in high-risk code?',
      'Turn TODOs into work items',
      'Which code powers this analytics event?',
      'Map GA events to files and functions',
      'Which user flows have errors?',
    ]],
    ['AI-Generated Code', [
      'Where did AI place the code it just wrote?',
      'Is this new function actually being called?',
      'Where is the API key being used in the generated code?',
      'Did the AI wire this up to the right endpoint?',
      'What functions did the last AI change touch?',
    ]],
  ];
  const SEARCH_TEMPLATE_TOKEN_PATTERN = /\\{(function|fn|button|route|event|concept|module|operation)\\}/g;

  function searchTemplateFallback(template) {
    const replacements = {
      function: 'this function',
      fn: 'this function',
      button: 'this button',
      route: 'this route',
      event: 'this event',
      concept: 'this concept',
      module: 'this module',
      operation: 'this operation',
    };
    return String(template || '').replace(SEARCH_TEMPLATE_TOKEN_PATTERN, (_, token) => replacements[token] || 'this item');
  }

  function expandSearchTemplate(template) {
    const raw = String(template || '');
    const tokens = Array.from(new Set(Array.from(raw.matchAll(SEARCH_TEMPLATE_TOKEN_PATTERN)).map(match => match[1])));
    if (!tokens.length) {
      return [raw];
    }
    const functionToken = tokens.find(token => token === 'function' || token === 'fn');
    if (functionToken && searchFunctionSuggestions.length) {
      return searchFunctionSuggestions
        .slice(0, 60)
        .map(symbol => raw.replace(SEARCH_TEMPLATE_TOKEN_PATTERN, (_, token) => {
          if (token === 'function' || token === 'fn') {
            return symbol;
          }
          return searchTemplateFallback('{' + token + '}');
        }));
    }
    return [searchTemplateFallback(raw)];
  }

  function updateQuerySuggestions() {
    if (!querySuggestions) { return; }
    const seen = new Set();
    const suggestions = [];
    function add(value) {
      const text = String(value || '').replace(/\\s+/g, ' ').trim();
      const normalized = text.toLowerCase();
      if (!text || seen.has(normalized)) { return; }
      seen.add(normalized);
      suggestions.push(text);
    }
    searchHistoryQueries.forEach(add);
    DEFAULT_REPO_SEARCH_PROMPT_GROUPS.forEach(([, prompts]) => prompts.forEach(prompt => expandSearchTemplate(prompt).forEach(add)));
    querySuggestions.innerHTML = suggestions
      .slice(0, 220)
      .map(value => '<option value="' + escapeHtml(value) + '"></option>')
      .join('');
  }

  function webviewLog(message, detail) {
    vscode.postMessage({ type: 'webviewLog', message: String(message || ''), detail: detail || {} });
  }

  graphFrame.addEventListener('load', () => {
    if (graphLoadTimer) {
      clearTimeout(graphLoadTimer);
      graphLoadTimer = null;
    }
    webviewLog('graph iframe load', {
      src: graphFrame.src || '',
      width: graphFrame.clientWidth,
      height: graphFrame.clientHeight,
      display: graphFrame.style.display || ''
    });
  });

  graphFrame.addEventListener('error', () => {
    if (graphLoadTimer) {
      clearTimeout(graphLoadTimer);
      graphLoadTimer = null;
    }
    webviewLog('graph iframe error', { src: graphFrame.src || '' });
  });

  function clampGraphHeight(height) {
    const handleHeight = paneResizeHandle ? paneResizeHandle.getBoundingClientRect().height : 7;
    const minGraph = 80;
    const minChat = 120;
    const maxGraph = Math.max(minGraph, window.innerHeight - handleHeight - minChat);
    return Math.min(Math.max(height, minGraph), maxGraph);
  }

  function setGraphHeight(height, persist = true) {
    if (!graphPane) { return; }
    const next = clampGraphHeight(height);
    graphPane.style.flex = '0 0 ' + next + 'px';
    syncGraphRotationFrame();
    if (persist) {
      const previous = vscode.getState() || {};
      vscode.setState({ ...previous, graphPaneHeight: next });
    }
  }

  function restoreGraphHeight() {
    const saved = vscode.getState()?.graphPaneHeight;
    if (typeof saved === 'number' && Number.isFinite(saved)) {
      setGraphHeight(saved, false);
    }
  }

  restoreGraphHeight();

  function syncGraphRotationFrame() {
    if (!graphFrame || !graphPane) { return; }
    if (document.body.classList.contains('graph-rotated')) {
      const rect = graphPane.getBoundingClientRect();
      graphFrame.style.width = Math.max(1, rect.height) + 'px';
      graphFrame.style.height = Math.max(1, rect.width) + 'px';
      rotateGraphBtn.textContent = 'Normal';
      rotateGraphBtn.title = 'Return the graph view to normal orientation';
    } else {
      graphFrame.style.width = '';
      graphFrame.style.height = '';
      rotateGraphBtn.textContent = 'Vertical';
      rotateGraphBtn.title = 'Use a vertical graph view';
    }
  }

  if (vscode.getState()?.graphRotated) {
    document.body.classList.add('graph-rotated');
  }
  syncGraphRotationFrame();

  paneResizeHandle.addEventListener('pointerdown', (event) => {
    if (document.body.classList.contains('graph-expanded')) { return; }
    event.preventDefault();
    paneResizeHandle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-panes');
  });

  paneResizeHandle.addEventListener('pointermove', (event) => {
    if (!document.body.classList.contains('resizing-panes')) { return; }
    setGraphHeight(event.clientY);
  });

  function stopPaneResize(event) {
    if (!document.body.classList.contains('resizing-panes')) { return; }
    document.body.classList.remove('resizing-panes');
    try {
      paneResizeHandle.releasePointerCapture(event.pointerId);
    } catch {}
  }

  paneResizeHandle.addEventListener('pointerup', stopPaneResize);
  paneResizeHandle.addEventListener('pointercancel', stopPaneResize);
  window.addEventListener('resize', () => {
    const saved = vscode.getState()?.graphPaneHeight;
    if (typeof saved === 'number' && Number.isFinite(saved)) {
      setGraphHeight(saved);
    }
    syncGraphRotationFrame();
  });

  generateBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'generate' });
  });

  emptyStateRetryBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'generate' });
  });

  setupMcpBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'setupMcp' });
  });

  openCodexBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openMcpClient', client: 'codex' });
  });

  openClaudeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openMcpClient', client: 'claude' });
  });

  approveCodexBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'approveCodex' });
  });

  approveClaudeBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'approveClaude' });
  });

  checkChangesBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'checkChanges' });
  });

  blastRadiusBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'blastRadius' });
  });

  checkCommitsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'checkCommits' });
  });

  openGraphBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openGraphPanel', currentGraphUrl: graphFrame.src || '' });
  });

  rotateGraphBtn.addEventListener('click', () => {
    const rotated = document.body.classList.toggle('graph-rotated');
    const previous = vscode.getState() || {};
    vscode.setState({ ...previous, graphRotated: rotated });
    syncGraphRotationFrame();
  });

  expandGraphBtn.addEventListener('click', () => {
    const expanded = document.body.classList.toggle('graph-expanded');
    expandGraphBtn.textContent = expanded ? 'Collapse' : 'Expand';
    expandGraphBtn.title = expanded ? 'Show search and status again' : 'Make the graph fill this side window';
    syncGraphRotationFrame();
  });

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = queryInput.value.trim();
    if (!query) { return; }
    vscode.postMessage({ type: 'search', query });
    queryInput.value = '';
  });

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function parseEvidenceFileLabel(label) {
    const text = String(label || '').trim();
    const match = text.match(/^(added|modified|deleted|renamed|changed):\\s+(.+)$/i);
    if (!match) {
      return { file: text, status: 'changed' };
    }
    const status = match[1].toLowerCase();
    const value = match[2].includes(' -> ') ? match[2].split(' -> ').pop() || match[2] : match[2];
    return { file: value.trim(), status };
  }

  function appendCollapsibleSection(parent, title, body, count, startsExpanded) {
    const section = document.createElement('div');
    section.className = 'changeSection';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'changeSectionTitle expandToggle';
    toggle.setAttribute('aria-expanded', startsExpanded ? 'true' : 'false');
    const label = () => title + (count ? ' (' + count + ')' : '') + ' ' + (toggle.getAttribute('aria-expanded') === 'true' ? 'v' : '>');
    toggle.textContent = label();
    body.style.display = startsExpanded ? '' : 'none';
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      body.style.display = expanded ? 'none' : '';
      toggle.textContent = label();
    });
    section.appendChild(toggle);
    section.appendChild(body);
    parent.appendChild(section);
  }

  function renderListSection(parent, title, items) {
    if (!items || !items.length) { return; }
    const body = document.createElement('div');
    body.textContent = items.join(' • ');
    appendCollapsibleSection(parent, title, body, items.length, true);
  }

  function renderSignatureDetails(parent, details) {
    if (!details || (!details.oldSignature && !details.newSignature)) { return; }
    const body = document.createElement('div');
    body.className = 'signatureCompare';
    const count = Number(Boolean(details.oldSignature)) + Number(Boolean(details.newSignature));
    const addBlock = (label, value) => {
      if (!value) { return; }
      const block = document.createElement('div');
      block.className = 'signatureBlock';
      const heading = document.createElement('div');
      heading.className = 'signatureLabel';
      heading.textContent = label;
      const code = document.createElement('code');
      code.className = 'signatureCode';
      code.textContent = value;
      block.appendChild(heading);
      block.appendChild(code);
      body.appendChild(block);
    };
    addBlock('Old Signature', details.oldSignature);
    addBlock('New Signature', details.newSignature);
    appendCollapsibleSection(parent, 'Signature', body, count, true);
  }

  // A wide fan-out (e.g. 30 confirmed-impact functions) is real information,
  // but spelling every name out by default drowns the one thing that
  // actually changed. Collapsed here behind a toggle — the count is already
  // visible as a metric tile, so nothing is lost by hiding the list itself
  // until the user asks for it.
  function renderExpandableList(parent, title, items) {
    if (!items || !items.length) { return; }
    const body = document.createElement('div');
    body.textContent = items.join(' • ');
    appendCollapsibleSection(parent, title, body, items.length, false);
  }

  // Files bucketed into the "Other changed files" card have no single graph
  // node to hang a "View diff" action chip off of, but each entry is still a
  // real file — so make the evidence list itself clickable instead.
  function renderEvidenceFiles(parent, title, files, diffRefs) {
    if (!files || !files.length) { return; }
    const body = document.createElement('div');
    files.forEach((file, index) => {
      if (index > 0) {
        body.appendChild(document.createTextNode(' • '));
      }
      if (
        file.startsWith('+') && file.endsWith(' more') ||
        file.startsWith('risk signal:') ||
        file.startsWith('deleted folder:')
      ) {
        body.appendChild(document.createTextNode(file));
        return;
      }
      const link = document.createElement('span');
      link.className = 'evidenceFileLink';
      link.textContent = file;
      link.title = 'View diff for ' + file;
      link.addEventListener('click', (event) => {
        event.stopPropagation();
        const parsed = parseEvidenceFileLabel(file);
        vscode.postMessage({
          type: 'viewDiff',
          file: parsed.file,
          status: parsed.status,
          base: diffRefs && diffRefs.base,
          target: diffRefs && diffRefs.target,
        });
      });
      body.appendChild(link);
    });
    appendCollapsibleSection(parent, title, body, files.length, true);
  }

  function renderChangeCard(item, card, r) {
    item.classList.add('changeResult');
    item.textContent = '';
    const root = document.createElement('div');
    root.className = 'changeCard';
    const startsCollapsed = Boolean(card.startCollapsed);
    if (startsCollapsed) {
      root.classList.add('is-collapsed');
    }

    const top = document.createElement('div');
    top.className = 'changeTop';
    const titleBlock = document.createElement('div');
    const titleRow = document.createElement('div');
    titleRow.className = 'changeTitleRow';
    const detailsToggle = document.createElement('button');
    detailsToggle.type = 'button';
    detailsToggle.className = 'detailsToggle';
    detailsToggle.textContent = startsCollapsed ? '+' : '-';
    detailsToggle.title = startsCollapsed ? 'Show details' : 'Hide details';
    detailsToggle.setAttribute('aria-expanded', startsCollapsed ? 'false' : 'true');
    detailsToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const collapsed = root.classList.toggle('is-collapsed');
      detailsToggle.textContent = collapsed ? '+' : '-';
      detailsToggle.title = collapsed ? 'Show details' : 'Hide details';
      detailsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    titleRow.appendChild(detailsToggle);
    const title = document.createElement('div');
    title.className = 'changeTitle';
    title.textContent = card.title || 'Change';
    titleRow.appendChild(title);
    const symbol = document.createElement(r && (r.file || r.graphSymbol) ? 'button' : 'div');
    symbol.className = r && (r.file || r.graphSymbol) ? 'changeSymbol changeSymbolButton' : 'changeSymbol';
    symbol.textContent = card.symbol || item.dataset.label || '';
    if (symbol.tagName === 'BUTTON') {
      symbol.type = 'button';
      symbol.title = 'Open function and show impact graph';
      symbol.addEventListener('click', (event) => {
        event.stopPropagation();
        if (r.file) {
          vscode.postMessage({ type: 'openFile', file: r.file, line: r.line || '' });
        }
        if (r.graphSymbol) {
          vscode.postMessage({ type: 'graphForResult', result: r });
        }
      });
    }
    titleBlock.appendChild(titleRow);
    titleBlock.appendChild(symbol);
    const risk = document.createElement('span');
    risk.className = 'riskPill risk-' + String(card.riskLevel || 'unknown');
    risk.textContent = card.risk || 'Review';
    top.appendChild(titleBlock);
    top.appendChild(risk);
    root.appendChild(top);

    const details = document.createElement('div');
    details.className = 'changeDetails';

    if (card.change) {
      const change = document.createElement('div');
      change.textContent = card.change;
      appendCollapsibleSection(details, 'Change', change, 0, true);
    }

    renderSignatureDetails(details, card.signatureDetails);

    if (card.metrics && card.metrics.length) {
      const metrics = document.createElement('div');
      metrics.className = 'metricGrid';
      card.metrics.forEach((metric) => {
        const box = document.createElement('div');
        box.className = 'metric';
        const value = document.createElement('span');
        value.className = 'metricValue';
        value.textContent = String(metric.value || '');
        const label = document.createElement('span');
        label.className = 'metricLabel';
        label.textContent = String(metric.label || '');
        box.appendChild(value);
        box.appendChild(label);
        metrics.appendChild(box);
      });
      appendCollapsibleSection(details, 'Metrics', metrics, card.metrics.length, true);
    }

    const diffRefs = r && r.diffBase && r.diffTarget ? { base: r.diffBase, target: r.diffTarget } : undefined;
    if (card.kind === 'files') {
      renderEvidenceFiles(details, 'Evidence', card.evidence || [], diffRefs);
    } else {
      renderListSection(details, 'Evidence', card.evidence || []);
    }
    renderListSection(details, 'Recommended checks', card.checks || []);
    renderExpandableList(details, 'Impacted functions', card.impactedFunctions || []);

    if (card.actions && card.actions.length) {
      const actions = document.createElement('div');
      actions.className = 'actionRow';
      card.actions.forEach((action) => {
        const chip = document.createElement('span');
        chip.className = 'actionChip actionChipClickable';
        chip.textContent = action;
        chip.addEventListener('click', (event) => {
          event.stopPropagation();
          if (action === 'View diff' && r) {
            const file = r.file || (Array.isArray(r.impactFiles) && r.impactFiles.length ? r.impactFiles[0] : '');
            if (file) {
              vscode.postMessage({ type: 'viewDiff', file, base: diffRefs && diffRefs.base, target: diffRefs && diffRefs.target });
            }
          } else if ((action === 'View impact graph' || action === 'View diff graph') && r) {
            vscode.postMessage({ type: 'graphForResult', result: r });
          }
        });
        actions.appendChild(chip);
      });
      appendCollapsibleSection(details, 'Actions', actions, card.actions.length, true);
    }

    root.appendChild(details);
    item.appendChild(root);
  }

  function addMcpChip(label, tone, title) {
    const chip = document.createElement('span');
    chip.className = 'mcpChip mcpChip-' + tone;
    chip.textContent = label;
    if (title) { chip.title = title; }
    mcpSetupStatus.appendChild(chip);
  }

  function setMcpAction(button, visible, disabled) {
    button.style.display = visible ? '' : 'none';
    button.disabled = Boolean(disabled);
  }

  function resultRiskRank(r) {
    const ranks = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
    return ranks[(r.changeCard && r.changeCard.riskLevel) || 'unknown'] ?? 4;
  }

  function resultImpactValue(r) {
    return Number(r.impactScore || 0);
  }

  function resultDateValue(r) {
    return Number(r.changeTime || 0);
  }

  function sortedChangeResults(results, mode) {
    const copy = (results || []).slice();
    if (mode === 'date') {
      copy.sort((a, b) => resultDateValue(b) - resultDateValue(a) || resultImpactValue(b) - resultImpactValue(a));
    } else {
      copy.sort((a, b) => {
        const riskDelta = resultRiskRank(a) - resultRiskRank(b);
        return riskDelta || resultImpactValue(b) - resultImpactValue(a) || resultDateValue(b) - resultDateValue(a);
      });
    }
    return copy;
  }

  function appendResultItem(parent, r) {
    const item = document.createElement('div');
    item.className = 'result';
    item.dataset.label = r.label || '';
    const changedAt = resultDateValue(r);
    if (changedAt || resultImpactValue(r)) {
      const parts = [];
      if (changedAt) { parts.push('Last modified: ' + new Date(changedAt).toLocaleString()); }
      if (resultImpactValue(r)) { parts.push('Impact score: ' + resultImpactValue(r)); }
      item.title = parts.join(' | ');
    }
    if (r.changeCard) {
      renderChangeCard(item, r.changeCard, r);
    } else if (r.commitHash && r.fileList && r.fileList.length) {
      // Latest Commits rows get the same collapse affordance Uncommitted
      // Edits' change cards use (a +/- detailsToggle button) — just
      // collapsing the file list instead of a changeDetails block — so a
      // long commit history doesn't eat the whole panel by default.
      item.classList.add('is-collapsed');
      const labelRow = document.createElement('div');
      labelRow.className = 'changeTitleRow';
      const detailsToggle = document.createElement('button');
      detailsToggle.type = 'button';
      detailsToggle.className = 'detailsToggle';
      detailsToggle.textContent = '+';
      detailsToggle.title = 'Show changed files';
      detailsToggle.setAttribute('aria-expanded', 'false');
      detailsToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const collapsed = item.classList.toggle('is-collapsed');
        detailsToggle.textContent = collapsed ? '+' : '-';
        detailsToggle.title = collapsed ? 'Show changed files' : 'Hide changed files';
        detailsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
      labelRow.appendChild(detailsToggle);
      const labelSpan = document.createElement('span');
      labelSpan.className = 'label';
      labelSpan.textContent = r.label || '';
      labelRow.appendChild(labelSpan);
      item.appendChild(labelRow);
    } else {
      const loc = r.file ? (r.file + (r.line ? ':' + r.line : '')) : '';
      item.innerHTML = '<span class="label">' + escapeHtml(r.label) + '</span>' +
        (loc ? ' <span class="loc">' + escapeHtml(loc) + '</span>' : '');
    }
    if (r.fileList && r.fileList.length && !r.changeCard) {
      // A commit row stays clickable (see the commitHash handler below) to
      // run the same impact analysis "Check Uncommitted Edits" does, just
      // against this commit's diff — only bare file lists with no commit
      // behind them (no matches today, but keeps this safe) get the
      // no-click treatment.
      if (!r.commitHash) {
        item.classList.add('no-click');
      }
      const fileListEl = document.createElement('div');
      fileListEl.className = 'snippet commitFileList';
      r.fileList.forEach((f) => {
        const fileRow = document.createElement('div');
        fileRow.className = 'commitFileRow';
        fileRow.textContent = f;
        fileRow.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: 'openFile', file: f, line: '' });
        });
        fileListEl.appendChild(fileRow);
      });
      if (r.fileListMore) {
        const more = document.createElement('div');
        more.className = 'commitFileMore';
        more.textContent = '+' + r.fileListMore + ' more file(s) not shown';
        fileListEl.appendChild(more);
      }
      item.appendChild(fileListEl);
    } else if (r.snippet && !r.changeCard) {
      const snippet = document.createElement('div');
      snippet.className = 'snippet';
      snippet.textContent = String(r.snippet);
      item.appendChild(snippet);
    }
    if (r.commitHash) {
      item.title = 'Click to analyze this commit\\'s impact graph and diff.';
      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'analyzeCommit', hash: r.commitHash });
      });
    }
    const graphable = r.graphSymbol || r.fullName || r.symbol || r.name || (
      r.impactFiles && r.impactFiles.length ? r.impactFiles[0] : ''
    );
    if (!r.fileList && (r.file || graphable)) {
      item.addEventListener('click', () => {
        if (r.file) {
          vscode.postMessage({ type: 'openFile', file: r.file, line: r.line });
        }
        if (graphable) {
          vscode.postMessage({ type: 'graphForResult', result: r });
        }
      });
    }
    parent.appendChild(item);
  }

  function appendResultItems(parent, results) {
    parent.textContent = '';
    (results || []).forEach((r) => appendResultItem(parent, r));
  }

  // Low-impact and cosmetic-only change cards are individually collapsed
  // already, but a page full of them still buries the few cards worth
  // looking at. Fold a bucket into one row, collapsed the same way a single
  // card is, so it takes one line of scan space instead of N.
  function appendCollapsedGroup(parent, results, title, pillLabel, pillClass) {
    const item = document.createElement('div');
    item.className = 'result changeResult';
    const root = document.createElement('div');
    root.className = 'changeCard changeGroup is-collapsed';

    const top = document.createElement('div');
    top.className = 'changeTop';
    const titleBlock = document.createElement('div');
    const titleRow = document.createElement('div');
    titleRow.className = 'changeTitleRow';

    const showLabel = 'Show ' + title.toLowerCase();
    const hideLabel = 'Hide ' + title.toLowerCase();
    const detailsToggle = document.createElement('button');
    detailsToggle.type = 'button';
    detailsToggle.className = 'detailsToggle';
    detailsToggle.textContent = '+';
    detailsToggle.title = showLabel;
    detailsToggle.setAttribute('aria-expanded', 'false');
    detailsToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const collapsed = root.classList.toggle('is-collapsed');
      detailsToggle.textContent = collapsed ? '+' : '-';
      detailsToggle.title = collapsed ? showLabel : hideLabel;
      detailsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    titleRow.appendChild(detailsToggle);

    const titleEl = document.createElement('div');
    titleEl.className = 'changeTitle';
    titleEl.textContent = title;
    titleRow.appendChild(titleEl);

    const symbol = document.createElement('div');
    symbol.className = 'changeSymbol';
    symbol.textContent = results.length + (results.length === 1 ? ' function' : ' functions');
    titleBlock.appendChild(titleRow);
    titleBlock.appendChild(symbol);

    const risk = document.createElement('span');
    risk.className = 'riskPill risk-' + pillClass;
    risk.textContent = pillLabel;

    top.appendChild(titleBlock);
    top.appendChild(risk);
    root.appendChild(top);

    const details = document.createElement('div');
    details.className = 'changeDetails changeGroupBody';
    results.forEach((r) => appendResultItem(details, r));
    root.appendChild(details);

    item.appendChild(root);
    parent.appendChild(item);
  }

  function renderAnswerTextWithLinks(parent, text, links) {
    const linkMap = new Map();
    (links || []).forEach((link) => {
      if (link && link.label && !linkMap.has(link.label)) {
        linkMap.set(link.label, link);
      }
    });
    const labels = Array.from(linkMap.keys()).sort((a, b) => b.length - a.length);
    if (!labels.length) {
      parent.textContent = text || '';
      return;
    }
    let index = 0;
    const source = String(text || '');
    while (index < source.length) {
      let nextLabel = '';
      let nextIndex = -1;
      labels.forEach((label) => {
        const found = source.indexOf(label, index);
        if (found >= 0 && (nextIndex < 0 || found < nextIndex || (found === nextIndex && label.length > nextLabel.length))) {
          nextIndex = found;
          nextLabel = label;
        }
      });
      if (nextIndex < 0) {
        parent.appendChild(document.createTextNode(source.slice(index)));
        break;
      }
      if (nextIndex > index) {
        parent.appendChild(document.createTextNode(source.slice(index, nextIndex)));
      }
      const link = linkMap.get(nextLabel);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'answerFunctionLink';
      button.textContent = nextLabel;
      button.title = 'Open function and show impact graph';
      button.addEventListener('click', () => {
        if (link.file) {
          vscode.postMessage({ type: 'openFile', file: link.file, line: link.line || '' });
        }
        if (link.result) {
          vscode.postMessage({ type: 'graphForResult', result: link.result });
        }
      });
      parent.appendChild(button);
      index = nextIndex + nextLabel.length;
    }
  }

  // Change-list results carry a riskLevel (derived from impact score) that
  // plain search results don't, so only that list gets grouped. Cosmetic-only
  // changes get their own group, separate from "Low Impact Functions" —
  // they're a stronger, provable claim ("nothing behavioral changed") than
  // "probably low impact", and burying a real (if small) change in the same
  // bucket as a confirmed no-op would undersell the real one.
  function appendGroupedChangeResultItems(parent, results) {
    parent.textContent = '';
    const primary = [];
    const otherModified = [];
    const low = [];
    const cosmetic = [];
    (results || []).forEach((r) => {
      const card = r.changeCard;
      if (card && card.cosmeticOnly) {
        cosmetic.push(r);
        return;
      }
      const level = (card && card.riskLevel) || 'unknown';
      if (level === 'low') {
        low.push(r);
        return;
      }
      // Impact score (fan-in) is a heuristic, not a finding — a 'modified'
      // card only earns a top-level row if it's a proven-breaking or actual
      // signature change. Everything else is a body edit with no signature
      // change and just adds scan noise, so it folds into one collapsed row
      // the same way low-impact/cosmetic changes do. Non-'modified' kinds
      // (blast radius, removed, other files) always surface individually —
      // they're already pre-filtered to be worth a look.
      if (card && card.kind === 'modified' && !card.breaking && !card.signatureChanged) {
        otherModified.push(r);
        return;
      }
      primary.push(r);
    });
    primary.forEach((r) => appendResultItem(parent, r));
    if (otherModified.length === 1) {
      appendResultItem(parent, otherModified[0]);
    } else if (otherModified.length > 1) {
      appendCollapsedGroup(parent, otherModified, 'Other Modified Functions (no signature change)', 'Impact', 'medium');
    }
    if (low.length === 1) {
      appendResultItem(parent, low[0]);
    } else if (low.length > 1) {
      appendCollapsedGroup(parent, low, 'Low Impact Functions', 'Low', 'low');
    }
    if (cosmetic.length === 1) {
      appendResultItem(parent, cosmetic[0]);
    } else if (cosmetic.length > 1) {
      appendCollapsedGroup(parent, cosmetic, 'Cosmetic-only Changes', 'Cosmetic', 'low');
    }
  }

  function renderSearchResult(msg) {
    if (msg.replace) {
      messages.textContent = '';
    }
    const hasResults = Boolean((msg.results && msg.results.length) || msg.answer || msg.error);
    document.body.classList.toggle('has-results', hasResults || messages.children.length > 0);
    const wrapper = document.createElement('div');
    wrapper.className = 'msg';
    if (msg.query) {
      const q = document.createElement('div');
      q.className = 'query';
      q.textContent = msg.query;
      wrapper.appendChild(q);
    }
    if (msg.error) {
      const errEl = document.createElement('div');
      errEl.className = 'error';
      errEl.textContent = msg.error;
      wrapper.appendChild(errEl);
    } else {
      if (msg.answer) {
        const a = document.createElement('div');
        a.className = 'answer';
        renderAnswerTextWithLinks(a, msg.answer, msg.answerLinks || []);
        wrapper.appendChild(a);
      }
      const resultList = document.createElement('div');
      const isChangeList = msg.kind === 'changes' || msg.kind === 'blastRadius' || msg.kind === 'commitDetail';
      if (isChangeList && (msg.results || []).length > 1) {
        const toolbar = document.createElement('div');
        toolbar.className = 'resultToolbar';
        const label = document.createElement('label');
        label.textContent = 'Sort';
        const select = document.createElement('select');
        const impactOption = document.createElement('option');
        impactOption.value = 'impact';
        impactOption.textContent = 'Highest impact';
        const dateOption = document.createElement('option');
        dateOption.value = 'date';
        dateOption.textContent = 'Most recent';
        select.appendChild(impactOption);
        select.appendChild(dateOption);
        select.value = msg.defaultSort || 'impact';
        select.addEventListener('change', () => {
          appendGroupedChangeResultItems(resultList, sortedChangeResults(msg.results || [], select.value));
        });
        toolbar.appendChild(label);
        toolbar.appendChild(select);
        wrapper.appendChild(toolbar);
        appendGroupedChangeResultItems(resultList, sortedChangeResults(msg.results || [], select.value));
      } else {
        appendResultItems(resultList, msg.results || []);
      }
      wrapper.appendChild(resultList);
    }
    messages.appendChild(wrapper);
    messages.scrollTop = messages.scrollHeight;
  }

	  window.addEventListener('message', (event) => {
	    const msg = event.data;
	    if (msg && msg.codemdGraphDebug) {
	      vscode.postMessage({
	        type: 'graphDebug',
	        event: String(msg.event || ''),
	        href: String(msg.href || ''),
	        detail: msg.detail || {},
	      });
	      return;
	    }
	    if (msg.type === 'status') {
      statusLine.textContent = msg.text;
      const isError = /^Error:/.test(String(msg.text || ''));
      // Only overwrite the big centered pane while it's still the one showing
      // (i.e. no graph has loaded yet) — once a graph is up, background
      // regenerate status belongs in the small statusLine only.
      if (emptyState.style.display !== 'none') {
        emptyStateText.textContent = msg.text;
        emptyStateText.classList.toggle('emptyStateError', isError);
        emptyStateRetryBtn.style.display = isError ? '' : 'none';
      }
    } else if (msg.type === 'mcpUsage') {
      const total = Number(msg.totalCalls || 0);
      const configured = Boolean(msg.configured);
      const stale = Boolean(msg.stale);
      const setup = msg.setup || {};
      const serverName = msg.serverName || 'CODE.md MCP';
      const restartNeeded = Boolean(msg.restartNeeded);
      const updatedAt = msg.updatedAt ? new Date(msg.updatedAt).toLocaleString() : '';
      const toolsByClient = msg.toolsByClient && typeof msg.toolsByClient === 'object' ? msg.toolsByClient : {};
      const clients = Array.isArray(msg.clients) ? msg.clients : [];
      const callgraphTools = new Set([
        'codemd_get_call_paths',
        'codemd_get_impact_radius',
        'codemd_get_callers',
        'codemd_get_callees',
      ]);
      const overviewTools = new Set([
        'codemd_search_artifacts',
        'codemd_semantic_search',
        'codemd_read_artifact',
      ]);
      const statusTools = new Set([
        'codemd_status',
      ]);
      const clientLabel = (name) => /claude/i.test(String(name || '')) ? 'Claude' : /codex/i.test(String(name || '')) ? 'Codex' : String(name || 'Unknown');
      const countToolsFor = (label, toolSet) => Object.entries(toolsByClient)
        .filter(([clientName]) => clientLabel(clientName) === label)
        .reduce((sum, [, tools]) => sum + Object.entries(tools || {})
          .filter(([toolName]) => toolSet.has(toolName))
          .reduce((toolSum, [, calls]) => toolSum + Number(calls || 0), 0), 0);
      const totalCallsFor = (label) => clients
        .filter((c) => clientLabel(c && c.name) === label)
        .reduce((sum, c) => sum + Number(c && c.calls || 0), 0);
      const codexTotal = totalCallsFor('Codex');
      const claudeTotal = totalCallsFor('Claude');
      const codexOverview = countToolsFor('Codex', overviewTools);
      const claudeOverview = countToolsFor('Claude', overviewTools);
      const estimatedGraphSeconds = Object.values(toolsByClient)
        .reduce((sum, tools) => sum
          + (Number(tools?.codemd_get_callers || 0) * 15)
          + (Number(tools?.codemd_get_callees || 0) * 15)
          + (Number(tools?.codemd_get_call_paths || 0) * 30)
          + (Number(tools?.codemd_get_impact_radius || 0) * 30), 0);
      const estimatedGraphMinutes = Math.round(estimatedGraphSeconds / 60);
      const estimatedGraphText = estimatedGraphMinutes > 0
        ? ' · ~' + estimatedGraphMinutes + ' min graph exploration potentially avoided'
        : '';
      const usageTitle = !configured
        ? 'MCP is not set up for this workspace.'
        : total > 0
          ? stale
            ? ('Last observed MCP access: ' + (updatedAt || msg.updatedAt) + '. Open a new client session if "' + serverName + '" is missing from /mcp.')
            : ('Last observed MCP access: ' + (updatedAt || msg.updatedAt) + '. No MCP setup action needed.')
          : 'MCP config is ready. Open a new Codex or Claude Code session to connect "' + serverName + '".';
      mcpUsageLabel.textContent = 'CODE.md MCP: Codex ' + codexTotal + ', Claude ' + claudeTotal + estimatedGraphText;
      mcpUsageSubtitle.textContent = total > 0 ? ('Historical total: ' + total + '. Overview/search: Codex ' + codexOverview + ', Claude ' + claudeOverview + '. ' + usageTitle) : usageTitle;
      mcpUsageCard.title = usageTitle + ' Conservative estimate: callers/callees = 15s, call paths/impact radius = 30s. Search/read/status calls excluded. Not directly measured.';
      mcpSetupStatus.textContent = '';
      if (!configured) {
        addMcpChip('Set up MCP', 'missing', 'Write the workspace MCP config before starting a client.');
      }
      if (!setup.codexDetected) {
        addMcpChip('Codex CLI missing', 'warn', 'Codex is not on PATH for VS Code. Config can still be written; launch Codex manually if needed.');
      }
      if (!setup.claudeDetected) {
        addMcpChip('Claude CLI missing', 'warn', 'Claude Code is not installed or not on PATH.');
      }
      if (configured && setup.claudeDetected && !setup.claudeApproved) {
        addMcpChip('Approve Claude MCP', 'warn', 'Click Approve Claude MCP, or approve in Claude Code with /mcp.');
      }
      if (configured && setup.codexDetected && !setup.codexApproved) {
        addMcpChip('Approve Codex MCP', 'warn', 'Click Approve Codex MCP, or approve tool calls in Codex when prompted.');
      }
      if (configured && restartNeeded && (setup.codexApproved || setup.claudeApproved)) {
        addMcpChip('Open new client session', 'warn', 'Start a fresh Codex or Claude Code session so the MCP config is picked up.');
      }
      mcpSetupStatus.style.display = mcpSetupStatus.children.length ? '' : 'none';
      setMcpAction(setupMcpBtn, !configured, false);
      setMcpAction(openCodexBtn, configured && setup.codexDetected && (restartNeeded || !setup.codexApproved), false);
      setMcpAction(openClaudeBtn, configured && setup.claudeDetected && (restartNeeded || !setup.claudeApproved), false);
      setMcpAction(approveCodexBtn, configured && setup.codexDetected && !setup.codexApproved, false);
      setMcpAction(approveClaudeBtn, configured && setup.claudeDetected && !setup.claudeApproved, false);
      mcpActionRow.style.display = Array.from(mcpActionRow.children).some((button) => button.style.display !== 'none') ? '' : 'none';
      mcpUsageCard.classList.remove('mcp-active', 'mcp-idle');
      if (configured) {
        mcpUsageCard.classList.add(total > 0 && !stale ? 'mcp-active' : 'mcp-idle');
      }

      mcpUsageByClient.innerHTML = '';
      clients.forEach((c) => {
        const line = document.createElement('span');
        line.className = 'clientLine';
        const label = clientLabel(c.name);
        const tools = toolsByClient[c.name] || {};
        const callgraphCalls = Object.entries(tools)
          .filter(([toolName]) => callgraphTools.has(toolName))
          .reduce((sum, [, calls]) => sum + Number(calls || 0), 0);
        const overviewCalls = Object.entries(tools)
          .filter(([toolName]) => overviewTools.has(toolName))
          .reduce((sum, [, calls]) => sum + Number(calls || 0), 0);
        const statusCalls = Object.entries(tools)
          .filter(([toolName]) => statusTools.has(toolName))
          .reduce((sum, [, calls]) => sum + Number(calls || 0), 0);
        line.textContent = label + ': ' + Number(c.calls || 0) + ' total, ' + callgraphCalls + ' graph, ' + overviewCalls + ' overview/search, ' + statusCalls + ' status';
        mcpUsageByClient.appendChild(line);
      });
	    } else if (msg.type === 'graph') {
	      lastGraphUrl = String(msg.url || '');
	      webviewLog('graph message received', { url: lastGraphUrl });
	      graphFrame.src = msg.url;
	      graphFrame.style.display = 'block';
	      syncGraphRotationFrame();
	      emptyState.style.display = 'none';
	      if (graphLoadTimer) {
	        clearTimeout(graphLoadTimer);
	      }
	      graphLoadTimer = setTimeout(() => {
	        webviewLog('graph iframe load timeout', {
	          expectedUrl: lastGraphUrl,
	          currentSrc: graphFrame.src || '',
	          width: graphFrame.clientWidth,
	          height: graphFrame.clientHeight,
	          display: graphFrame.style.display || ''
	        });
	      }, 8000);
	    } else if (msg.type === 'generated') {
      // graph message (if any) already handled separately
    } else if (msg.type === 'searchHistory') {
      messages.textContent = '';
      searchHistoryQueries = (msg.items || []).map(item => item?.query || '');
      updateQuerySuggestions();
      (msg.items || []).forEach(renderSearchResult);
    } else if (msg.type === 'searchSuggestions') {
      searchFunctionSuggestions = (msg.functions || []).map(value => String(value || '').trim()).filter(Boolean);
      updateQuerySuggestions();
    } else if (msg.type === 'searchResult') {
      renderSearchResult(msg);
    }
  });

  updateQuerySuggestions();

  // Tell the extension host we're actually loaded and listening — state posted
  // right after webview.html is set can otherwise arrive before this point and
  // be silently dropped.
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
//# sourceMappingURL=extension.js.map