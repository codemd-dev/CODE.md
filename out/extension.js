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
    '**/codemd.dev/**',
];
const ARTIFACT_OUTPUT_DIR = 'codemd.dev';
const WORKSPACE_MCP_CONFIG_FILE = '.mcp.json';
const WORKSPACE_CODEX_DIR = '.codex';
const WORKSPACE_CODEX_CONFIG_FILE = '.codex/config.toml';
const WEBVIEW_SUPPORT_ARTIFACTS = [
    'lib/cytoscape/cytoscape.min.js',
];
const MCP_PROVIDER_ID = 'codemdGraphs.mcp';
const MCP_SERVER_NAME = 'codemd';
let managedVenvSetupPromise = null;
// Keys whose artifacts are large, binary, or interpretive rather than direct
// analysis output (vector DBs, embeddings, training pairs) — not useful to
// mirror into the workspace.
const SKIPPED_ARTIFACT_KEY_PATTERN = /vector_db|embedding|train_pairs|download_zip/i;
const MIRRORED_HTML_ARTIFACTS = new Set([
    'combined_callgraph/combined_navigatable_callgraph.html',
    'file_graph/file_graph_cytoscape.html',
    'file_graph/file_graph_navigatable.html',
    'html_ui/html_ui_graph_cytoscape.html',
    'javascript/javascript_callgraph_cytoscape.html',
    'python/python_callgraph_cytoscape.html',
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
    if (kind === 'file' && (normalizedRelPath === WORKSPACE_MCP_CONFIG_FILE || normalizedRelPath === WORKSPACE_CODEX_CONFIG_FILE)) {
        return true;
    }
    if (kind === 'directory' && normalizedRelPath === WORKSPACE_CODEX_DIR) {
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
        throw new Error(`Blocked ${operation} to workspace file "${relPath}". CODE.md only writes ${ARTIFACT_OUTPUT_DIR}/ and ${WORKSPACE_MCP_CONFIG_FILE}.`);
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
        // server), not just the one PID that .kill() would target.
        (0, child_process_1.spawnSync)('taskkill', ['/PID', String(pid), '/T', '/F']);
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
        return;
    }
    try {
        const result = (0, child_process_1.spawnSync)('netstat', ['-ano'], { encoding: 'utf8' });
        if (result.status !== 0 || !result.stdout) {
            return;
        }
        const pids = new Set();
        for (const line of result.stdout.split('\n')) {
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
        for (const pid of pids) {
            outputChannel?.appendLine(`\n--- Found a stale process (PID ${pid}) already listening on port ${port} from a previous session — killing it before starting a fresh server ---`);
            killProcessTree(pid);
        }
    }
    catch (err) {
        outputChannel?.appendLine(`\n--- Stale-server cleanup on port ${port} skipped: ${err?.message || err} ---`);
    }
}
function mcpServerScriptPath(context) {
    return path.join(context.extensionUri.fsPath, 'scripts', 'codemd-mcp-server.js');
}
function mcpServerArgs(context, workspaceRoot) {
    return [mcpServerScriptPath(context), '--workspace', workspaceRoot];
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
                const server = new vscode.McpStdioServerDefinition('CODE.md', process.execPath, mcpServerArgs(context, folder.uri.fsPath), { CODEMD_WORKSPACE: folder.uri.fsPath }, context.extension.packageJSON?.version || '0.0.0');
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
    config.mcpServers[MCP_SERVER_NAME] = {
        command: 'node',
        args: mcpServerArgs(context, folder.uri.fsPath),
        env: {
            CODEMD_WORKSPACE: folder.uri.fsPath,
        },
    };
    const nextText = `${JSON.stringify(config, null, 2)}\n`;
    if (nextText === existingText) {
        return false;
    }
    await safeWorkspaceWriteFile(configUri, Buffer.from(nextText, 'utf8'));
    return true;
}
function tomlString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function tomlStringArray(values) {
    return `[${values.map(tomlString).join(', ')}]`;
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
    const block = [
        '# BEGIN CODE.md MCP',
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        'command = "node"',
        `args = ${tomlStringArray(mcpServerArgs(context, folder.uri.fsPath))}`,
        '',
        `[mcp_servers.${MCP_SERVER_NAME}.env]`,
        `CODEMD_WORKSPACE = ${tomlString(folder.uri.fsPath)}`,
        '# END CODE.md MCP',
        '',
    ].join('\n');
    const markerPattern = /# BEGIN CODE\.md MCP[\s\S]*?# END CODE\.md MCP\r?\n?/;
    const next = markerPattern.test(existing)
        ? existing.replace(markerPattern, block)
        : `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}`;
    if (next === existing) {
        return false;
    }
    await safeWorkspaceCreateDirectory(codexDir);
    await safeWorkspaceWriteFile(configUri, Buffer.from(next, 'utf8'));
    return true;
}
async function setupProjectMcpConfigs(context, options) {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0) {
        if (!options.quiet) {
            vscode.window.showErrorMessage('CODE.md: Open a workspace before setting up MCP.');
        }
        return;
    }
    const failures = [];
    const changedFolders = [];
    for (const folder of folders) {
        try {
            const changedClaude = await setupClaudeProjectMcp(context, folder);
            const changedCodex = await setupCodexProjectMcp(context, folder);
            if (changedClaude || changedCodex) {
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
        const message = `CODE.md: Updated ${WORKSPACE_MCP_CONFIG_FILE} and ${WORKSPACE_CODEX_CONFIG_FILE} for MCP access in ${changedFolders.join(', ')}.`;
        outputChannel?.appendLine(message);
        vscode.window.showInformationMessage(message);
    }
    else if (!options.quiet) {
        vscode.window.showInformationMessage(`CODE.md: MCP config is already up to date for Claude Code and Codex.`);
    }
}
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('CODE.md');
    context.subscriptions.push(outputChannel);
    const config = vscode.workspace.getConfiguration('codemdGraphs');
    killStaleServerOnPort(Number(config.get('port') || 8100));
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'codemdGraphs.open';
    statusBarItem.text = '$(circle-outline) CODE.md';
    statusBarItem.tooltip = 'CODE.md';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    const provider = new GraphsViewProvider(context);
    registerMcpProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('codemdGraphs.panel', provider));
    context.subscriptions.push(vscode.commands.registerCommand('codemd', () => provider.reveal()));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.open', () => provider.reveal()));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.openEditor', () => provider.openEditorPanel()));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.generate', () => provider.runGenerate({ quiet: false })));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.setupMcp', () => setupProjectMcpConfigs(context, { quiet: false })));
    context.subscriptions.push(vscode.commands.registerCommand('codemdlocal.generate', () => provider.runGenerate({ quiet: false })));
    context.subscriptions.push(vscode.commands.registerCommand('codemdLocal.generate', () => provider.runGenerate({ quiet: false })));
    context.subscriptions.push(vscode.commands.registerCommand('codemdGraphs.stopServer', stopServer));
    // Kick off an initial background analysis so the graph is already there by
    // the time the user opens the panel — no manual "Generate" click needed.
    if (vscode.workspace.workspaceFolders?.length) {
        if (config.get('autoWriteProjectMcpConfig') !== false) {
            setupProjectMcpConfigs(context, { quiet: true });
        }
        const startupAnalysis = provider.runGenerate({ quiet: true });
        // Surface the panel itself, unprompted — previously the extension only
        // prepared the graph in the background and waited for the user to
        // discover and click the new "CODE.md" activity bar icon, so the
        // callgraph never actually appeared unless they knew to look for it.
        if (config.get('autoReveal') !== false) {
            provider.reveal();
        }
        startupAnalysis
            .catch((err) => {
            outputChannel?.appendLine(`Startup analysis failed before change check: ${err?.message || String(err)}`);
        })
            .then(() => provider.runStartupChangesCheck());
    }
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
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, 'main.py'))) {
        return workspaceRoot;
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
        title: 'Select the folder containing the CodeVal FastAPI app (main.py)',
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
function runCommand(cmd, args, cwd, onOutput) {
    return new Promise((resolve, reject) => {
        const proc = (0, child_process_1.spawn)(cmd, args, { cwd });
        proc.stdout?.on('data', (chunk) => onOutput(chunk.toString()));
        proc.stderr?.on('data', (chunk) => onOutput(chunk.toString()));
        proc.on('error', reject);
        proc.on('exit', (code) => resolve(code ?? 1));
    });
}
async function ensureVenvPip(pythonExe, backendDir, onStatus) {
    const pipVersionCode = await runCommand(pythonExe, ['-m', 'pip', '--version'], backendDir, (text) => outputChannel.append(text));
    if (pipVersionCode === 0) {
        return;
    }
    onStatus('Bootstrapping pip in the managed Python environment...');
    outputChannel.appendLine(`\n--- Bootstrapping pip in ${path.dirname(path.dirname(pythonExe))} ---`);
    const ensurePipCode = await runCommand(pythonExe, ['-m', 'ensurepip', '--upgrade'], backendDir, (text) => outputChannel.append(text));
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
        const code = await runCommand(systemPython.cmd, [...systemPython.args, '-m', 'venv', venvDir], backendDir, (text) => outputChannel.append(text));
        if (code !== 0 || !fs.existsSync(pythonExe)) {
            throw new Error(`Failed to create a Python virtual environment at "${venvDir}" (exit code ${code}). ` +
                'Check the "CODE.md" output channel.');
        }
    }
    await ensureVenvPip(pythonExe, backendDir, onStatus);
    if (requirementsHash && existingHash !== requirementsHash) {
        onStatus('Installing backend dependencies (first run only, this can take a minute)…');
        outputChannel.appendLine(`\n--- Installing requirements.txt into ${venvDir} ---`);
        const code = await runCommand(pythonExe, ['-m', 'pip', 'install', '-q', '-r', requirementsPath], backendDir, (text) => outputChannel.append(text));
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
async function ensureServerRunning(context, onStatus, quiet) {
    const config = vscode.workspace.getConfiguration('codemdGraphs');
    const host = String(config.get('host') || '127.0.0.1');
    const port = Number(config.get('port') || 8100);
    const baseUrl = `http://${host}:${port}`;
    if (serverProcess && serverProcess.exitCode === null) {
        return baseUrl;
    }
    const backendDir = await resolveBackendDir(context, quiet);
    const mainPyPath = path.join(backendDir, 'main.py');
    if (!fs.existsSync(mainPyPath)) {
        throw new Error(`Could not find main.py in "${backendDir}". Set codemdGraphs.backendDir to the folder containing the CodeVal FastAPI app.`);
    }
    const pythonPath = await backendPythonPath(context, backendDir, onStatus);
    const args = ['-m', 'uvicorn', 'main:app', '--host', host, '--port', String(port)];
    onStatus(`Starting local FastAPI server (${pythonPath} ${args.join(' ')})…`);
    outputChannel.appendLine(`\n--- Starting local server: ${pythonPath} ${args.join(' ')} (cwd: ${backendDir}) ---`);
    outputChannel.show(true);
    // This extension only does local analysis — no error/usage telemetry or
    // third-party integration should leave the machine. main.py defaults Sentry
    // to "on" (with a baked-in DSN) for the hosted CodeVal service, and Google
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
const MCP_USAGE_FILE = '.mcp-usage.json';
const LOCAL_GRAPH_RELATIVE_PATH = 'combined_callgraph/combined_navigatable_callgraph.html';
function localGraphFileUri(outDirUri) {
    return vscode.Uri.joinPath(outDirUri, ...LOCAL_GRAPH_RELATIVE_PATH.split('/'));
}
function localAnalysisResultFileUri(outDirUri) {
    return vscode.Uri.joinPath(outDirUri, LOCAL_ANALYSIS_RESULT_FILE);
}
function localMcpUsageFileUri(outDirUri) {
    return vscode.Uri.joinPath(outDirUri, MCP_USAGE_FILE);
}
function readMcpUsage(folder) {
    let configured = false;
    try {
        const configPath = vscode.Uri.joinPath(folder.uri, WORKSPACE_MCP_CONFIG_FILE).fsPath;
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        configured = Boolean(config?.mcpServers?.[MCP_SERVER_NAME]);
    }
    catch {
        configured = false;
    }
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
        return {
            configured,
            totalCalls: Number(usage?.total_calls || 0),
            updatedAt: String(usage?.updated_at || ''),
            clients,
        };
    }
    catch {
        return { configured, totalCalls: 0, updatedAt: '', clients: [] };
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
function htmlRelativePrefix(relPath) {
    const depth = relPath.replace(/\\/g, '/').split('/').length - 1;
    return depth > 0 ? '../'.repeat(depth) : './';
}
function rewriteHtmlArtifactForWebview(content, relPath) {
    const supportPrefix = htmlRelativePrefix(relPath);
    // Matches whatever prefix the generator emitted — a bare absolute "/lib/…",
    // the generator's current "../lib/…", or a path nested at some other depth
    // — and normalizes it to the correct relative depth for this artifact's
    // actual location, so this stays correct even if the generator's own
    // convention changes later.
    return content
        .replace(/(["'`])(?:\.\.\/)*\/?lib\/cytoscape\/cytoscape\.min\.js\1/g, `$1${supportPrefix}lib/cytoscape/cytoscape.min.js$1`);
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
 * generated codemd.dev/ output (which changes on every run and would
 * otherwise make this always report "changed"). Returns null when the
 * workspace isn't a git repo (or has no commits yet) — callers should treat
 * that as "can't tell, so don't skip."
 */
function computeGitStateHash(workspaceRoot) {
    const head = (0, child_process_1.spawnSync)('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' });
    if (head.status !== 0) {
        return null;
    }
    const status = (0, child_process_1.spawnSync)('git', ['status', '--porcelain', '--', '.', `:!${ARTIFACT_OUTPUT_DIR}/**`], { cwd: workspaceRoot, encoding: 'utf8' });
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
        throw new Error(`Could not find main.py in "${backendDir}". Set codemdGraphs.backendDir to the folder containing the CodeVal backend.`);
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
    const exitCode = await new Promise((resolve, reject) => {
        const proc = (0, child_process_1.spawn)(pythonPath, args, {
            cwd: backendDir,
            env: localBackendEnv(context),
            detached: process.platform !== 'win32',
        });
        trackProcess(proc);
        proc.stdout.on('data', (chunk) => outputChannel.append(chunk.toString()));
        proc.stderr.on('data', (chunk) => outputChannel.append(chunk.toString()));
        proc.on('error', reject);
        proc.on('exit', (code) => resolve(code ?? 1));
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
    // codemd.dev/, which renders instantly without needing the local server up.
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
    // Captured once per session (first activation), not recomputed as "HEAD" on
    // every check — otherwise a commit made mid-session would silently move the
    // comparison point and "what changed since I started" would stop meaning
    // that. Falls back to HEAD (i.e. "since the last commit") outside a git repo
    // or before the first commit.
    sessionStartGitRef = null;
    changesBusy = false;
    commitsBusy = false;
    startupChangesCheckStarted = false;
    constructor(context) {
        this.context = context;
        this.ensureLocalGraphLoaded();
        this.captureSessionStartGitRef();
    }
    captureSessionStartGitRef() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return;
        }
        const result = (0, child_process_1.spawnSync)('git', ['rev-parse', 'HEAD'], { cwd: folder.uri.fsPath, encoding: 'utf8' });
        this.sessionStartGitRef = result.status === 0 ? result.stdout.trim() : null;
    }
    runStartupChangesCheck() {
        if (this.startupChangesCheckStarted) {
            return;
        }
        this.startupChangesCheckStarted = true;
        this.runChangesCheck({ focusLatestChange: true });
    }
    async reveal() {
        await vscode.commands.executeCommand('workbench.view.extension.codemdGraphs');
        await vscode.commands.executeCommand('codemdGraphs.panel.focus');
    }
    resolveWebviewView(webviewView) {
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
        if (this.hasGenerated) {
            this.post({ type: 'generated' });
        }
        this.refreshMcpUsage(folder);
        this.ensureMcpUsageWatcher(folder);
    }
    openEditorPanel() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!this.sidePanel) {
            this.sidePanel = vscode.window.createWebviewPanel('codemdGraphs.sidePanel', 'CODE.md', vscode.ViewColumn.Beside, {
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
        if (this.hasGenerated) {
            this.post({ type: 'generated' });
        }
        this.refreshMcpUsage(folder);
        this.ensureMcpUsageWatcher(folder);
    }
    openGraphPanel() {
        if (!this.lastGraphFileUri && !this.lastServerGraphUrl && !this.lastDisplayedServerGraphUrl) {
            vscode.window.showInformationMessage('CODE.md: The callgraph is still being generated.');
            return;
        }
        if (!this.graphPanel) {
            const folder = vscode.workspace.workspaceFolders?.[0];
            this.graphPanel = vscode.window.createWebviewPanel('codemdGraphs.fullGraph', 'CODE.md', vscode.ViewColumn.Active, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: folder ? [vscode.Uri.joinPath(folder.uri, ARTIFACT_OUTPUT_DIR)] : undefined,
            });
            this.graphPanel.onDidDispose(() => {
                this.graphPanel = undefined;
            });
        }
        const url = this.resolveGraphUrlForWebview(this.graphPanel.webview);
        this.graphPanel.webview.html = getFullGraphHtml(url, this.graphPanel.webview.cspSource);
        this.graphPanel.reveal(vscode.ViewColumn.Active, false);
    }
    refreshMcpUsage(folder = vscode.workspace.workspaceFolders?.[0]) {
        if (!folder) {
            this.post({ type: 'mcpUsage', configured: false, totalCalls: 0, updatedAt: '', clients: [] });
            return;
        }
        const usage = readMcpUsage(folder);
        this.post({
            type: 'mcpUsage',
            configured: usage.configured,
            totalCalls: usage.totalCalls,
            updatedAt: usage.updatedAt,
            clients: usage.clients,
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
            return;
        }
        const outDirUri = vscode.Uri.joinPath(folder.uri, ARTIFACT_OUTPUT_DIR);
        const candidate = localGraphFileUri(outDirUri);
        if (!this.lastGraphFileUri && !this.localGraphReadyPromise && fs.existsSync(candidate.fsPath)) {
            this.lastStatus = `Found an existing ${ARTIFACT_OUTPUT_DIR}/ callgraph — preparing it for display…`;
            statusBarItem.text = '$(sync~spin) CODE.md: preparing existing callgraph';
            statusBarItem.tooltip = 'CODE.md: preparing existing callgraph for display';
            this.post({ type: 'status', text: this.lastStatus });
            this.localGraphReadyPromise = repairMirroredArtifactsForWebview(this.context, outDirUri)
                .catch((err) => {
                outputChannel?.appendLine(`Skipped startup graph repair: ${err?.message || String(err)}`);
            })
                .then(() => {
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
        if (this.view && this.viewReady) {
            const url = this.resolveGraphUrlForWebview(this.view.webview);
            if (url) {
                this.view.webview.postMessage({ type: 'graph', url });
            }
        }
        if (this.sidePanel && this.sidePanelReady) {
            const url = this.resolveGraphUrlForWebview(this.sidePanel.webview);
            if (url) {
                this.sidePanel.webview.postMessage({ type: 'graph', url });
            }
        }
        if (this.graphPanel) {
            const url = this.resolveGraphUrlForWebview(this.graphPanel.webview);
            if (url) {
                this.graphPanel.webview.html = getFullGraphHtml(url, this.graphPanel.webview.cspSource);
            }
        }
    }
    postDisplayedGraph() {
        if (this.lastDisplayedServerGraphUrl) {
            this.post({ type: 'graph', url: this.lastDisplayedServerGraphUrl });
            return;
        }
        this.postGraph();
    }
    rememberSearchResult(message) {
        this.searchHistory.push(message);
        this.searchHistory = this.searchHistory.slice(-10);
    }
    postSearchHistory() {
        if (this.searchHistory.length) {
            this.post({ type: 'searchHistory', items: this.searchHistory });
        }
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
            return;
        }
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
            this.openGraphPanel();
        }
        else if (message.type === 'graphForResult') {
            this.runResultGraph(message.result || {});
        }
        else if (message.type === 'checkChanges') {
            this.runChangesCheck();
        }
        else if (message.type === 'checkCommits') {
            this.runLatestCommitsCheck();
        }
        else if (message.type === 'ready') {
            // The webview's script has just attached its message listener — resend
            // current state, since anything posted right after setting .html can
            // be dropped if it arrives before the iframe finished loading.
            if (source === 'side') {
                this.sidePanelReady = true;
            }
            else {
                this.viewReady = true;
            }
            this.post({ type: 'status', text: this.lastStatus });
            this.postDisplayedGraph();
            this.postSearchHistory();
            if (this.hasGenerated) {
                this.post({ type: 'generated' });
            }
            this.refreshMcpUsage();
        }
    }
    async openFile(file, line) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder || !file) {
            return;
        }
        try {
            const uri = await this.resolveFileUri(folder, file);
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
            this.post({ type: 'generated' });
            this.refreshMcpUsage(folder);
        }
        // Background startup runs are the ones that repeat needlessly on every
        // reload — skip them entirely when git shows no changes since the last
        // completed analysis. An explicit "Generate" click always runs for real.
        if (quiet && fs.existsSync(graphFileUri.fsPath)) {
            const currentHash = computeGitStateHash(folder.uri.fsPath);
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
                const newGitHash = computeGitStateHash(folder.uri.fsPath);
                if (newGitHash) {
                    await writeStoredGitStateHash(outDirUri, newGitHash);
                }
                status(`Ready. Generated ${ARTIFACT_OUTPUT_DIR}/ — search below to explore the callgraph.`);
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
    runSearch(query) {
        const trimmed = query.trim();
        if (!trimmed) {
            return;
        }
        const index = this.getLocalSearchIndex();
        if (!index) {
            this.post({ type: 'searchResult', error: 'No local callgraph found yet — click Regenerate to build one, then search again.' });
            return;
        }
        const results = searchLocalCallgraph(index, trimmed, 12);
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
        if (this.baseUrl) {
            return this.baseUrl;
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
                    result: {
                        graph_symbol: result?.graphSymbol || '',
                        fullName: result?.fullName || '',
                        symbol: result?.symbol || '',
                        name: result?.name || '',
                    },
                }),
            });
            const text = await response.text();
            if (!response.ok) {
                throw new Error(parseErrorDetail(text) || `HTTP ${response.status}`);
            }
            const data = JSON.parse(text);
            const graphUrl = data.search_graph_url || '';
            if (graphUrl) {
                this.lastDisplayedServerGraphUrl = `${this.baseUrl}${graphUrl}`;
                this.post({ type: 'graph', url: this.lastDisplayedServerGraphUrl });
                this.post({ type: 'status', text: 'Ready.' });
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
    async runChangesCheck(options = {}) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return;
        }
        if (this.changesBusy) {
            this.post({ type: 'status', text: 'Already checking changes — please wait.' });
            return;
        }
        this.changesBusy = true;
        this.post({ type: 'status', text: 'Checking what changed since this session started…' });
        try {
            const backendDir = await resolveBackendDir(this.context, true);
            const scriptPath = path.join(this.context.extensionUri.fsPath, 'scripts', 'deletion-report.py');
            const pythonPath = await backendPythonPath(this.context, backendDir, () => { });
            const usingSessionStart = Boolean(this.sessionStartGitRef);
            const base = this.sessionStartGitRef || 'HEAD';
            const args = [scriptPath, '--repo-root', folder.uri.fsPath, '--base', base, '--backend-dir', backendDir];
            const stdout = await new Promise((resolve, reject) => {
                const proc = (0, child_process_1.spawn)(pythonPath, args, { cwd: backendDir, env: localBackendEnv(this.context) });
                let out = '';
                let err = '';
                trackProcess(proc);
                proc.stdout.on('data', (chunk) => { out += chunk.toString(); });
                proc.stderr.on('data', (chunk) => { err += chunk.toString(); });
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
            const report = JSON.parse(stdout);
            if (report.error) {
                this.post({ type: 'status', text: `Error checking changes: ${report.error}` });
                return;
            }
            const results = [];
            for (const d of report.deleted || []) {
                const symbol = String(d.symbol || '');
                const tail = symbol.split('.').pop() || symbol;
                const file = String(d.file || '');
                results.push({
                    label: `[${d.severity}] Removed ${symbol}`,
                    file,
                    line: String(d.line || ''),
                    snippet: '',
                    graphSymbol: symbol,
                    fullName: symbol,
                    symbol: tail,
                    name: tail,
                    changeTime: this.changeTimeForFile(folder, file),
                });
            }
            for (const m of report.modified || []) {
                const symbol = String(m.symbol || '');
                const tail = symbol.split('.').pop() || symbol;
                const fileCount = (m.impact_files || []).length;
                const file = String(m.file || '');
                results.push({
                    label: `Modified ${symbol} — impact radius ${fileCount} file(s)`,
                    file,
                    line: '',
                    snippet: '',
                    graphSymbol: symbol,
                    fullName: symbol,
                    symbol: tail,
                    name: tail,
                    changeTime: this.changeTimeForFile(folder, file),
                });
            }
            results.sort((a, b) => (b.changeTime || 0) - (a.changeTime || 0));
            let answer = (report.summary || []).join('\n');
            if (!report.callgraph_available) {
                answer += '\n(No callgraph found yet — severities are unscored. Regenerate CODE.md for full scoring.)';
            }
            if ((report.unsupported_files || []).length) {
                answer += `\n(${report.unsupported_files.length} file(s) in unsupported languages changed too — not analyzed yet.)`;
            }
            const resultMessage = {
                type: 'searchResult',
                query: usingSessionStart ? 'Changes since this session started' : 'Changes since HEAD',
                answer,
                results,
            };
            this.rememberSearchResult(resultMessage);
            this.post(resultMessage);
            if (options.focusLatestChange && results.length) {
                const latest = results[0];
                this.post({ type: 'status', text: `Showing latest change in the graph: ${latest.symbol || latest.name || latest.label}` });
                await this.runResultGraph(latest);
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
    runLatestCommitsCheck() {
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
            const result = (0, child_process_1.spawnSync)('git', [
                'log',
                '--date=short',
                '--name-status',
                '--pretty=format:__CODEMD_COMMIT__%x1f%h%x1f%an%x1f%ad%x1f%s',
                '-n',
                '8',
                '--',
            ], { cwd: folder.uri.fsPath, encoding: 'utf8' });
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
                const file = commit.files[0] || '';
                const more = commit.files.length > 1 ? `, +${commit.files.length - 1} file(s)` : '';
                return {
                    label: `${commit.hash} ${commit.subject} (${commit.date}, ${commit.author}; ${commit.files.length} file(s)${more ? `: ${file}${more}` : ''})`,
                    file,
                    line: '',
                    snippet: commit.files.slice(0, 8).join('\n'),
                    graphSymbol: '',
                    fullName: '',
                    symbol: commit.hash,
                    name: commit.subject,
                };
            });
            const answer = commits.length
                ? `Latest ${commits.length} commit(s). Click a row to open the first changed file from that commit.`
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src ${cspSource} http://127.0.0.1:* http://localhost:*;">
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src ${cspSource} ${frameOrigin} http://127.0.0.1:* http://localhost:*;">
<style>
  html, body { height: 100%; margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  body { display: flex; flex-direction: column; }
  #graphPane { flex: 3 1 0; min-height: 120px; border-bottom: 1px solid var(--vscode-panel-border); position: relative; }
  #graphFrame { width: 100%; height: 100%; border: none; display: none; }
  #emptyState { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 12px; }
  #emptyState p { margin: 0; opacity: 0.8; font-size: 12px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #chatPane { flex: 2 1 0; display: flex; flex-direction: column; min-height: 100px; }
  #statusRow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  #statusLine { flex: 1 1 150px; min-width: 120px; font-size: 11px; opacity: 0.7; }
  #statusRow button { flex: 0 0 auto; max-width: 124px; padding: 2px 8px; font-size: 11px; line-height: 1.2; white-space: normal; }
  body.graph-expanded #graphPane { flex: 1 1 auto; min-height: 100%; border-bottom: 0; }
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
  #mcpUsageByClient { margin: 4px 0 0 18px; font-size: 12px; opacity: 0.85; }
  #mcpUsageByClient:empty { display: none; margin-top: 0; }
  #mcpUsageByClient .clientLine { display: block; padding: 1px 0; }
  #messages { flex: 1; overflow-y: auto; padding: 8px; }
  .msg { margin-bottom: 12px; }
  .msg .query { font-weight: 600; margin-bottom: 4px; }
  .msg .answer { white-space: pre-wrap; font-size: 12px; margin-bottom: 6px; }
  .msg .error { color: var(--vscode-errorForeground); font-size: 12px; }
  .result { font-size: 11px; padding: 3px 6px; border-radius: 2px; margin-bottom: 3px; cursor: pointer; background: var(--vscode-list-hoverBackground); }
  .result:hover { background: var(--vscode-list-activeSelectionBackground); }
  .result .label { font-weight: 600; }
  .result .loc { opacity: 0.7; }
  #searchForm { display: flex; gap: 4px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
  #queryInput { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 6px; }
</style>
</head>
<body>
  <div id="graphPane">
    <div id="graphToolbar">
      <button id="openGraphBtn" title="Open the graph in a full editor tab">Full Screen</button>
      <button id="expandGraphBtn" title="Make the graph fill this side window">Expand</button>
    </div>
    <div id="emptyState">
      <p>Analyzing this workspace in the background — the callgraph will appear here automatically.</p>
    </div>
    <iframe id="graphFrame"></iframe>
  </div>
  <div id="chatPane">
    <div id="statusRow">
      <span id="statusLine">Preparing callgraph in the background…</span>
      <button id="checkChangesBtn" title="Check local file edits that have not been committed yet.">Check Uncommitted Edits</button>
      <button id="checkCommitsBtn" title="Show the latest commits in this Git repository.">Check Latest Commits</button>
      <button id="generateBtn">Regenerate</button>
    </div>
    <div id="mcpUsageCard" title="Claude/Codex calls observed by the CODE.md MCP wrapper.">
      <div id="mcpUsageHeadline">
        <span class="mcpDot"></span>
        <span id="mcpUsageLabel">Claude/Codex calls to CODE.md: 0</span>
      </div>
      <div id="mcpUsageSubtitle"></div>
      <div id="mcpUsageByClient"></div>
    </div>
    <div id="messages"></div>
    <form id="searchForm">
      <input id="queryInput" type="text" placeholder="Search this codebase…" autocomplete="off" />
      <button type="submit">Search</button>
    </form>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const graphFrame = document.getElementById('graphFrame');
  const emptyState = document.getElementById('emptyState');
  const statusLine = document.getElementById('statusLine');
  const mcpUsageCard = document.getElementById('mcpUsageCard');
  const mcpUsageLabel = document.getElementById('mcpUsageLabel');
  const mcpUsageSubtitle = document.getElementById('mcpUsageSubtitle');
  const mcpUsageByClient = document.getElementById('mcpUsageByClient');
  const messages = document.getElementById('messages');
  const generateBtn = document.getElementById('generateBtn');
  const checkChangesBtn = document.getElementById('checkChangesBtn');
  const checkCommitsBtn = document.getElementById('checkCommitsBtn');
  const openGraphBtn = document.getElementById('openGraphBtn');
  const expandGraphBtn = document.getElementById('expandGraphBtn');
  const searchForm = document.getElementById('searchForm');
  const queryInput = document.getElementById('queryInput');

  generateBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'generate' });
  });

  checkChangesBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'checkChanges' });
  });

  checkCommitsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'checkCommits' });
  });

  openGraphBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openGraphPanel' });
  });

  expandGraphBtn.addEventListener('click', () => {
    const expanded = document.body.classList.toggle('graph-expanded');
    expandGraphBtn.textContent = expanded ? 'Collapse' : 'Expand';
    expandGraphBtn.title = expanded ? 'Show search and status again' : 'Make the graph fill this side window';
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

  function renderSearchResult(msg) {
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
        a.textContent = msg.answer;
        wrapper.appendChild(a);
      }
      (msg.results || []).forEach((r) => {
        const item = document.createElement('div');
        item.className = 'result';
        const loc = r.file ? (r.file + (r.line ? ':' + r.line : '')) : '';
        item.innerHTML = '<span class="label">' + escapeHtml(r.label) + '</span>' +
          (loc ? ' <span class="loc">' + escapeHtml(loc) + '</span>' : '');
        const graphable = r.graphSymbol || r.fullName || r.symbol || r.name;
        if (r.file || graphable) {
          item.addEventListener('click', () => {
            if (r.file) {
              vscode.postMessage({ type: 'openFile', file: r.file, line: r.line });
            }
            if (graphable) {
              vscode.postMessage({ type: 'graphForResult', result: r });
            }
          });
        }
        wrapper.appendChild(item);
      });
    }
    messages.appendChild(wrapper);
    messages.scrollTop = messages.scrollHeight;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'status') {
      statusLine.textContent = msg.text;
    } else if (msg.type === 'mcpUsage') {
      const total = Number(msg.totalCalls || 0);
      const configured = Boolean(msg.configured);
      const updatedAt = msg.updatedAt ? new Date(msg.updatedAt).toLocaleString() : '';
      const usageTitle = !configured
        ? 'No codemd server entry was found in .mcp.json.'
        : total > 0
          ? ('Last observed wrapper call: ' + (updatedAt || msg.updatedAt))
          : 'The project MCP config exists, but no client has called the CODE.md wrapper yet.';
      mcpUsageLabel.textContent = 'Claude/Codex calls to CODE.md: ' + total;
      mcpUsageSubtitle.textContent = usageTitle;
      mcpUsageCard.title = usageTitle + ' Only calls through CODE.md MCP tools are counted.';
      mcpUsageCard.classList.remove('mcp-active', 'mcp-idle');
      if (configured) {
        mcpUsageCard.classList.add(total > 0 ? 'mcp-active' : 'mcp-idle');
      }

      mcpUsageByClient.innerHTML = '';
      const clients = Array.isArray(msg.clients) ? msg.clients : [];
      clients.forEach((c) => {
        const line = document.createElement('span');
        line.className = 'clientLine';
        line.textContent = 'CODE.md used by ' + (c.name || 'unknown') + ': ' + c.calls + (c.calls === 1 ? ' call' : ' calls');
        mcpUsageByClient.appendChild(line);
      });
    } else if (msg.type === 'graph') {
      graphFrame.src = msg.url;
      graphFrame.style.display = 'block';
      emptyState.style.display = 'none';
    } else if (msg.type === 'generated') {
      // graph message (if any) already handled separately
    } else if (msg.type === 'searchHistory') {
      messages.textContent = '';
      (msg.items || []).forEach(renderSearchResult);
    } else if (msg.type === 'searchResult') {
      renderSearchResult(msg);
    }
  });

  // Tell the extension host we're actually loaded and listening — state posted
  // right after webview.html is set can otherwise arrive before this point and
  // be silently dropped.
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
//# sourceMappingURL=extension.js.map