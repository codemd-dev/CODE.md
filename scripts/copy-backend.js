// Bundles the analyzer backend into this extension so packaged installs do not
// depend on a development checkout at a particular path. Set
// CODEMD_BACKEND_SOURCE_DIR to refresh backend/ from an explicit source tree.
const fs = require('fs');
const path = require('path');

const repoRoot = process.env.CODEMD_BACKEND_SOURCE_DIR
  ? path.resolve(process.env.CODEMD_BACKEND_SOURCE_DIR)
  : '';
const backendDir = path.resolve(__dirname, '..', 'backend');

const ENTRIES = ['main.py', 'scim.py', 'supabase_client.py', 'requirements.txt', 'features', 'parsers', 'static', 'templates', 'lib'];

if (!repoRoot || !fs.existsSync(path.join(repoRoot, 'main.py'))) {
  console.error('copy-backend: CODEMD_BACKEND_SOURCE_DIR was not set to a backend containing main.py. Keeping existing bundled backend.');
  process.exit(0);
}

try {
  // maxRetries/retryDelay ride out transient Windows file locks (e.g. a
  // previously started local server still holding backend/ as its cwd).
  fs.rmSync(backendDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch (err) {
  console.error(
    `copy-backend: could not clear "${backendDir}" (${err.message}). ` +
      'Stop any running CODE.md analyzer server (or Extension Development Host) and try again.',
  );
  process.exit(1);
}
fs.mkdirSync(backendDir, { recursive: true });

for (const entry of ENTRIES) {
  const src = path.join(repoRoot, entry);
  if (!fs.existsSync(src)) {
    continue;
  }
  fs.cpSync(src, path.join(backendDir, entry), { recursive: true });
}

// Keep extension-local backend fixes in place even though this script mirrors
// the upstream backend before every compile/package.
const mainPy = path.join(backendDir, 'main.py');
let mainText = fs.readFileSync(mainPy, 'utf8');
mainText = mainText.replace(
  '@app.api_route("/dashboard", methods=["GET", "HEAD"])\n@app.api_route("/dashboard.html", methods=["GET", "HEAD"])\n@app.api_route("/dashboard.xml", methods=["GET", "HEAD"])\ndef dashboard():',
  '@app.get("/dashboard", operation_id="dashboard_get")\n@app.head("/dashboard", include_in_schema=False)\n@app.get("/dashboard.html", operation_id="dashboard_html_get")\n@app.head("/dashboard.html", include_in_schema=False)\n@app.get("/dashboard.xml", operation_id="dashboard_xml_get")\n@app.head("/dashboard.xml", include_in_schema=False)\ndef dashboard():',
);
mainText = mainText.replace(
  '@app.api_route("/dashboard", methods=["GET", "HEAD"], operation_id="dashboard_get")\n@app.api_route("/dashboard.html", methods=["GET", "HEAD"], operation_id="dashboard_html_get")\n@app.api_route("/dashboard.xml", methods=["GET", "HEAD"], operation_id="dashboard_xml_get")\ndef dashboard():',
  '@app.get("/dashboard", operation_id="dashboard_get")\n@app.head("/dashboard", include_in_schema=False)\n@app.get("/dashboard.html", operation_id="dashboard_html_get")\n@app.head("/dashboard.html", include_in_schema=False)\n@app.get("/dashboard.xml", operation_id="dashboard_xml_get")\n@app.head("/dashboard.xml", include_in_schema=False)\ndef dashboard():',
);
mainText = mainText.replace(
  'DEFAULT_OUTPUT_DIR_NAME = "output_a1b2c3d4"\nOUTPUT_URL_PREFIX = f"/{DEFAULT_OUTPUT_DIR_NAME}"',
  'DEFAULT_OUTPUT_DIR_NAME = "output_a1b2c3d4"\nOUTPUT_URL_PREFIX = f"/{DEFAULT_OUTPUT_DIR_NAME}"\nDEFAULT_LOCAL_OUTPUT_DIR = PARENT_ROOT / ".codemd" / "backend-output"',
);
mainText = mainText.replace(
  /    existing_candidates = \[\r?\n        PARENT_ROOT\.parent \/ "output" \/ DEFAULT_OUTPUT_DIR_NAME,\r?\n        PARENT_ROOT \/ "output" \/ DEFAULT_OUTPUT_DIR_NAME,\r?\n        PROJECT_ROOT \/ "output" \/ DEFAULT_OUTPUT_DIR_NAME,\r?\n    \]\r?\n    for candidate in existing_candidates:\r?\n        if not candidate\.exists\(\):\r?\n            continue\r?\n        try:\r?\n            candidate\.mkdir\(parents=True, exist_ok=True\)\r?\n            return candidate\r?\n        except OSError:\r?\n            logging\.warning\("Output directory is not writable: %s", candidate\)\r?\n\r?\n    for base_dir in \(PARENT_ROOT, PROJECT_ROOT\):\r?\n        candidate = base_dir \/ DEFAULT_OUTPUT_DIR_NAME\r?\n        try:\r?\n            candidate\.mkdir\(parents=True, exist_ok=True\)\r?\n            return candidate\r?\n        except OSError:\r?\n            logging\.warning\("Output directory is not writable: %s", candidate\)/,
  [
    '    try:',
    '        DEFAULT_LOCAL_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)',
    '        return DEFAULT_LOCAL_OUTPUT_DIR',
    '    except OSError:',
    '        logging.warning("Output directory is not writable: %s", DEFAULT_LOCAL_OUTPUT_DIR)',
  ].join('\n'),
);
mainText = mainText.replace(
  '    csharp_graph_changed = False\n    python_graph_changed = False',
  [
    '    csharp_graph_changed = False',
    '    html_ui_graph_changed = False',
    '    java_graph_changed = False',
    '    javascript_graph_changed = False',
    '    python_graph_changed = False',
  ].join('\n'),
);
mainText = mainText.replace(
  '        build_merged_java_outputs(output_repo_dir, {\n            "tree_sitter_java_json_path": tree_sitter_java_json if os.path.exists(tree_sitter_java_json) else "",\n            "callgraph_javalang_json_path": callgraph_json if os.path.exists(callgraph_json) else "",\n        })',
  '        build_merged_java_outputs(output_repo_dir, {\n            "tree_sitter_java_json_path": tree_sitter_java_json if os.path.exists(tree_sitter_java_json) else "",\n            "callgraph_javalang_json_path": callgraph_json if os.path.exists(callgraph_json) else "",\n        })\n        java_graph_changed = True',
);
mainText = mainText.replace(
  '            build_javascript_callgraph(cached_src_dir, javascript_dir)\n    elif os.path.exists(javascript_callgraph_json)',
  '            build_javascript_callgraph(cached_src_dir, javascript_dir)\n            javascript_graph_changed = True\n    elif os.path.exists(javascript_callgraph_json)',
);
mainText = mainText.replace(
  '            build_html_ui_graph(cached_src_dir, html_ui_dir)\n\n    if (\n        (python_graph_changed or csharp_graph_changed or not file_graph_current(file_graph_json) or not graph_artifacts_current) and',
  '            build_html_ui_graph(cached_src_dir, html_ui_dir)\n            html_ui_graph_changed = True\n\n    if (\n        (\n            python_graph_changed or\n            javascript_graph_changed or\n            csharp_graph_changed or\n            html_ui_graph_changed or\n            java_graph_changed or\n            not file_graph_current(file_graph_json) or\n            not graph_artifacts_current\n        ) and',
);
mainText = mainText.replace(
  '        write_cytoscape_json(reduced, reduced_joern_callgraph_json)\n\n    if os.path.exists(joern_callgraph_ordered_json)',
  '        write_cytoscape_json(reduced, reduced_joern_callgraph_json)\n        java_graph_changed = True\n\n    if os.path.exists(joern_callgraph_ordered_json)',
);
mainText = mainText.replace(
  '            python_graph_changed or\n            csharp_graph_changed or\n            not graph_artifacts_current or',
  '            python_graph_changed or\n            javascript_graph_changed or\n            csharp_graph_changed or\n            html_ui_graph_changed or\n            java_graph_changed or\n            not graph_artifacts_current or',
);
fs.writeFileSync(mainPy, mainText, 'utf8');

const helpersPy = path.join(backendDir, 'features', 'core', 'helpers.py');
if (fs.existsSync(helpersPy)) {
  let helpersText = fs.readFileSync(helpersPy, 'utf8');
  if (!helpersText.includes('SUPPORTED_SPAN_EXTENSIONS')) {
    helpersText = helpersText.replace(
      /(# ---------------------------------------------------------------------------\r?\n\r?\n)(def _python_module_name_for)/,
      '$1SUPPORTED_SPAN_EXTENSIONS = {".py"}\n\n$2',
    );
    fs.writeFileSync(helpersPy, helpersText, 'utf8');
  }
}

console.log(`copy-backend: bundled backend from "${repoRoot}" into "${backendDir}".`);
