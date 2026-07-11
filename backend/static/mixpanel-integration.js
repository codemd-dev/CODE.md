// Mixpanel activity integration: a parallel workflow to the Google Analytics
// section. GA uses OAuth (per-browser session); Mixpanel uses a static
// project token + service account, so the connection is saved server-side
// (Supabase) instead of a session cookie. Works for any analyzed GitHub repo,
// not just CodeVal itself.

function parseGitHubRepo(url) {
  const match = String(url || "").match(/github\.com\/([^/]+)\/([^/?#]+)/);
  if (!match) return { owner: "", repo: "" };
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

function mixpanelCurrentRepo() {
  const analysis = typeof currentAnalysis === "function" ? currentAnalysis() : null;
  if (analysis?.owner_name && analysis?.repo_name) {
    return { owner: analysis.owner_name, repo: analysis.repo_name };
  }
  const repoUrlInput = document.getElementById("repoUrl")?.value || "";
  return parseGitHubRepo(repoUrlInput);
}

function setMixpanelStatus(message) {
  const status = document.getElementById("mixpanelStatus");
  if (status) status.textContent = message;
}

function setMixpanelPreview(data) {
  const preview = document.getElementById("mixpanelPreview");
  if (!preview) return;
  preview.style.display = "block";
  preview.textContent = JSON.stringify(data, null, 2);
}

async function connectMixpanel() {
  const { owner, repo } = mixpanelCurrentRepo();
  if (!owner || !repo) {
    setMixpanelStatus("Analyze a repository (or enter a GitHub URL above) before connecting Mixpanel.");
    return;
  }
  const projectId = document.getElementById("mixpanelProjectId")?.value.trim() || "";
  const projectToken = document.getElementById("mixpanelProjectToken")?.value.trim() || "";
  const serviceUsername = document.getElementById("mixpanelServiceUsername")?.value.trim() || "";
  const serviceSecret = document.getElementById("mixpanelServiceSecret")?.value.trim() || "";
  const region = document.getElementById("mixpanelRegion")?.value || "US";
  if (!projectId || !projectToken || !serviceUsername || !serviceSecret) {
    setMixpanelStatus("Fill in the Mixpanel project ID, project token, and service account credentials first.");
    return;
  }

  setMixpanelStatus(`Connecting Mixpanel for ${owner}/${repo}...`);
  const connectButton = document.getElementById("mixpanelConnectButton");
  if (connectButton) connectButton.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/mixpanel/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_name: owner,
        repo_name: repo,
        project_id: projectId,
        project_token: projectToken,
        service_account_username: serviceUsername,
        service_account_secret: serviceSecret,
        region,
      }),
    });
    const data = await parseJsonResponse(response);
    setMixpanelPreview(data);
    if (data.ok) {
      setMixpanelStatus(`Mixpanel connected for ${owner}/${repo}. You can now load user activity.`);
      const loadButton = document.getElementById("mixpanelLoadActivityButton");
      if (loadButton) loadButton.disabled = false;
    } else {
      setMixpanelStatus(data.detail || data.message || "Mixpanel connection failed.");
    }
  } catch (err) {
    setMixpanelStatus(`Mixpanel connection failed. ${err.message || err}`);
  } finally {
    if (connectButton) connectButton.disabled = false;
  }
}

function setupMixpanelActivityTracking() {
  const { owner, repo } = mixpanelCurrentRepo();
  const projectToken = document.getElementById("mixpanelProjectToken")?.value.trim() || "MIXPANEL_PROJECT_TOKEN";
  const snippet = `<script src="https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js"></script>
<script
  src="https://cdn.codeval.ai/autotrack_core.js"
  data-repository-owner="${owner || "OWNER"}"
  data-repository-name="${repo || "REPO"}"></script>
<script
  src="https://cdn.codeval.ai/autotrack_mixpanel.js"
  data-project-token="${projectToken}"
  data-record-sessions-percent="5"></script>`;
  const snippetPreview = document.getElementById("mixpanelSnippetPreview");
  if (snippetPreview) {
    snippetPreview.style.display = "block";
    snippetPreview.textContent = snippet;
  }
  setMixpanelStatus("Install this snippet in the app you want to track, then use Load User Activity once events start arriving. For production, keep record_sessions_percent low (1-5).");
}

function renderMixpanelEventsTable(rows) {
  const body = document.getElementById("mixpanelEventsRows");
  const text = document.getElementById("mixpanelEventsTableText");
  if (!body) return;
  const items = Array.isArray(rows) ? rows : [];
  window.lastMixpanelRows = items;
  const mappedOnly = Boolean(document.getElementById("mixpanelMappedOnlyToggle")?.checked);
  const mappedItems = items
    .map((row, originalIndex) => ({ row, originalIndex }))
    .filter(item => Array.isArray(item.row.mapped_callgraph_nodes) && item.row.mapped_callgraph_nodes.length);
  const visibleItems = mappedOnly ? mappedItems : items.map((row, originalIndex) => ({ row, originalIndex }));
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No Mixpanel activity events loaded yet.</td></tr>`;
    if (text) text.textContent = "No Mixpanel rows returned for this selection.";
    return;
  }
  const mappedCount = mappedItems.length;
  if (text) {
    if (mappedOnly) {
      text.textContent = mappedCount
        ? `Showing ${Math.min(visibleItems.length, 50)} mapped Mixpanel row${visibleItems.length === 1 ? "" : "s"}; ${mappedCount} total mapped to callgraph nodes.`
        : "No Mixpanel rows are mapped to callgraph nodes yet.";
    } else {
      text.textContent = mappedCount
        ? `Showing ${Math.min(items.length, 50)} of ${items.length} Mixpanel rows; ${mappedCount} mapped to callgraph nodes.`
        : `Showing ${Math.min(items.length, 50)} of ${items.length} Mixpanel rows. No callgraph node matched yet; populate function_name, callgraph_node, endpoint, source_element, or trigger_element to map clicks to code.`;
    }
  }
  if (!visibleItems.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No mapped Mixpanel events found for this selection.</td></tr>`;
    return;
  }
  body.innerHTML = visibleItems.slice(0, 50).map(({ row, originalIndex }) => {
    const target = [row.function_name, row.symbol_name, row.file_path].filter(Boolean).join(" | ");
    const mapped = Array.isArray(row.mapped_callgraph_nodes)
      ? row.mapped_callgraph_nodes.slice(0, 3).join(" | ")
      : row.mapped_callgraph_node || "";
    const endpoint = [row.method, row.endpoint || row.request_url].filter(Boolean).join(" ");
    const bugActions = mixpanelRowIsBugCandidate(row)
      ? `<button type="button" class="ghost" data-quality-validate="${escapeHtml(mixpanelFindingId(row, originalIndex))}" onclick="validateMixpanelBug(${originalIndex})">Validate bug</button>
         <button type="button" class="ghost" data-quality-fix="${escapeHtml(mixpanelFindingId(row, originalIndex))}" onclick="analyzeMixpanelBugFix(${originalIndex})">Get fix</button>
         <button type="button" class="ghost" data-quality-resolve="${escapeHtml(mixpanelFindingId(row, originalIndex))}" onclick="resolveMixpanelBug(${originalIndex})">Resolve</button>`
      : "";
    return `
      <tr>
        <td>${escapeHtml(row.event_time || "")}</td>
        <td><strong>${escapeHtml(row.event_name || "")}</strong></td>
        <td>${escapeHtml(target || "-")}</td>
        <td>${escapeHtml(mapped || "-")}</td>
        <td>${escapeHtml(endpoint || "-")}</td>
        <td>${escapeHtml(row.error_message || row.ui_message || "-")}</td>
        <td><div class="graph-actions"><button type="button" onclick="createMixpanelEventGraph(${originalIndex})">Create graph</button>${bugActions}</div></td>
      </tr>
    `;
  }).join("");
}

function mixpanelHashText(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function mixpanelFindingId(row, index) {
  return `mixpanel_${mixpanelHashText(JSON.stringify({
    index,
    event_name: row?.event_name || "",
    event_time: row?.event_time || "",
    endpoint: row?.endpoint || row?.request_url || "",
    mapped: row?.mapped_callgraph_nodes || [],
    error: row?.error_message || row?.ui_message || row?.response_body || ""
  }))}`;
}

function mixpanelRowIsBugCandidate(row = {}) {
  const mapped = Array.isArray(row.mapped_callgraph_nodes) && row.mapped_callgraph_nodes.length;
  const status = Number(row.status || 0);
  const text = [
    row.event_name,
    row.error_message,
    row.ui_message,
    row.response_body,
    row.status_text,
    row.severity
  ].filter(Boolean).join(" ").toLowerCase();
  return Boolean(mapped && (
    status >= 400 ||
    /\b(error|exception|failure|failed|timeout|rejected|denied|unauthorized|forbidden|fatal|backend_error)\b/.test(text)
  ));
}

function mixpanelFindingFromRow(index) {
  const row = (window.lastMixpanelRows || [])[Number(index)] || {};
  const mappedNodes = Array.isArray(row.mapped_callgraph_nodes) ? row.mapped_callgraph_nodes : [];
  const endpoint = [row.method, row.endpoint || row.request_url].filter(Boolean).join(" ");
  const message = row.error_message || row.ui_message || row.response_body || row.status_text || row.event_name || "Mapped Mixpanel error";
  const symbol = row.function_name || row.symbol_name || mappedNodes[0] || "";
  const finding = {
    id: mixpanelFindingId(row, index),
    group: "bugs",
    type: "mixpanel_mapped_user_error",
    title: `Mapped Mixpanel error: ${row.event_name || endpoint || symbol || "user activity"}`,
    message: `Mixpanel captured an error event that maps to code. ${message}`,
    severity: Number(row.status || 0) >= 500 ? "high" : "medium",
    confidence: mappedNodes.length ? "high" : "medium",
    source: "mixpanel",
    path: row.file_path || "",
    file: row.file_path || "",
    symbol,
    evidence: [
      `Event: ${row.event_name || ""}`,
      endpoint ? `Endpoint: ${endpoint}` : "",
      row.page_path ? `Page path: ${row.page_path}` : "",
      row.status ? `Status: ${row.status} ${row.status_text || ""}` : "",
      message ? `Observed error: ${message}` : "",
      mappedNodes.length ? `Mapped callgraph nodes: ${mappedNodes.join(", ")}` : "",
      row.top_frame ? `Top frame: ${row.top_frame}` : "",
      row.stack_hash ? `Stack hash: ${row.stack_hash}` : ""
    ].filter(Boolean),
    recommendation: "Validate this production/user activity error against the mapped code path, then generate a fix if the evidence confirms a real bug.",
    mixpanel_event: row
  };
  window.qualitySignalItemsById = window.qualitySignalItemsById || {};
  window.qualitySignalItemsById[finding.id] = finding;
  return finding;
}

function setMixpanelBugReview(title, body, subtitle = "", isPending = false) {
  const output = document.getElementById("mixpanelBugReviewOutput");
  if (output && typeof renderSearchAnswerBox === "function") {
    output.innerHTML = renderSearchAnswerBox(title, body, subtitle, isPending);
  } else if (output) {
    output.textContent = [title, subtitle, body].filter(Boolean).join("\n\n");
  }
}

function setMixpanelBugStatus(message) {
  const status = document.getElementById("mixpanelBugReviewStatus");
  if (status) status.textContent = message;
  if (document.getElementById("selfHealingStatus")) document.getElementById("selfHealingStatus").textContent = message;
}

function mixpanelCurrentAnalysisRunId() {
  const analysis = typeof currentAnalysis === "function" ? currentAnalysis() : null;
  return analysis?.supabase_analysis_run_id || analysis?.supabase?.analysis_run_id || analysis?.analysis_run_id || analysis?.id || "";
}

async function validateMixpanelBug(index) {
  const finding = mixpanelFindingFromRow(index);
  if (typeof validateQualitySignalBug === "function") {
    setMixpanelBugReview("Mixpanel Bug Validation", "Checking whether this mapped user error is a real bug.", finding.title, true);
    setMixpanelBugStatus("Validating mapped Mixpanel error...");
    await validateQualitySignalBug(finding.id);
    const shared = document.getElementById("selfHealingProposal")?.innerHTML || document.getElementById("qualitySignalLlmOutput")?.innerHTML || "";
    const output = document.getElementById("mixpanelBugReviewOutput");
    if (shared && output) output.innerHTML = shared;
    return;
  }
}

async function analyzeMixpanelBugFix(index) {
  const finding = mixpanelFindingFromRow(index);
  if (typeof analyzeQualitySignalFix === "function") {
    setMixpanelBugReview("Mixpanel Proposed Fix", "Generating an evidence-backed repair proposal from the mapped error.", finding.title, true);
    setMixpanelBugStatus("Preparing proposed fix from mapped Mixpanel error...");
    await analyzeQualitySignalFix(finding.id);
    const shared = document.getElementById("selfHealingProposal")?.innerHTML || document.getElementById("qualitySignalLlmOutput")?.innerHTML || "";
    const output = document.getElementById("mixpanelBugReviewOutput");
    if (shared && output) {
      output.innerHTML = shared;
    }
    return;
  }
}

async function resolveMixpanelBug(index) {
  const finding = mixpanelFindingFromRow(index);
  const analysisRunId = mixpanelCurrentAnalysisRunId();
  if (!analysisRunId) {
    setMixpanelBugStatus("Restore or run an analysis before resolving mapped Mixpanel bugs.");
    return;
  }
  setMixpanelBugStatus("Resolving mapped Mixpanel bug...");
  try {
    const response = await fetch(`${API_BASE}/quality-signals/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        analysis_run_id: analysisRunId,
        finding_id: finding.id,
        finding,
        resolution_note: "Resolved from Mixpanel mapped user activity."
      })
    });
    const data = await parseJsonResponse(response);
    finding.status = data.status || "resolved";
    finding.resolved_at = data.resolved_at || new Date().toISOString();
    setMixpanelBugReview("Mixpanel Bug Resolved", `Resolved ${finding.title}.`, "Saved to the bug database.");
    setMixpanelBugStatus("Mapped Mixpanel bug marked resolved.");
    renderMixpanelEventsTable(window.lastMixpanelRows || []);
  } catch (err) {
    setMixpanelBugStatus(err.message || "Unable to resolve mapped Mixpanel bug.");
  }
}

async function createMixpanelEventGraph(index) {
  const row = (window.lastMixpanelRows || [])[Number(index)];
  const { owner, repo } = mixpanelCurrentRepo();
  const block = document.getElementById("mixpanelSelectedEventGraphBlock");
  const frame = document.getElementById("mixpanelSelectedEventGraphFrame");
  const text = document.getElementById("mixpanelSelectedEventGraphText");
  const title = document.getElementById("mixpanelSelectedEventGraphTitle");
  const openLink = document.getElementById("mixpanelSelectedEventGraphOpenLink");
  if (block) block.style.display = "block";
  if (!row) {
    if (text) text.textContent = "This Mixpanel row is no longer available. Reload user activity and try again.";
    return;
  }
  if (!owner || !repo) {
    if (text) text.textContent = "Analyze or restore a repository first so this Mixpanel row can be mapped to the callgraph.";
    return;
  }
  const label = row.event_name || row.button_name || row.endpoint || row.request_url || "Mixpanel activity";
  if (title) title.textContent = `Selected row: ${label}`;
  if (text) text.textContent = `Creating a callgraph map for ${label}...`;
  if (frame) {
    frame.style.display = "none";
    frame.removeAttribute("src");
  }
  if (openLink) {
    openLink.style.display = "none";
    openLink.removeAttribute("href");
  }
  try {
    const response = await fetch(`${API_BASE}/mixpanel/event-callgraph`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_name: owner, repo_name: repo, row }),
    });
    const data = await parseJsonResponse(response);
    const graphUrl = typeof cacheBustedUrl === "function" ? cacheBustedUrl(data.graph_url) : data.graph_url;
    if (frame && graphUrl) {
      frame.style.display = "block";
      frame.src = graphUrl;
    }
    if (openLink && graphUrl) {
      openLink.style.display = "inline-flex";
      openLink.href = graphUrl;
      openLink.textContent = "Open selected Mixpanel graph";
    }
    if (text) text.textContent = `Mapped ${data.label || label} to ${(data.root_nodes || []).join(", ") || "the callgraph"}.`;
  } catch (err) {
    if (text) text.textContent = err.message || "Unable to create a callgraph map for this Mixpanel row.";
  }
}

async function loadMixpanelUserActivity() {
  const { owner, repo } = mixpanelCurrentRepo();
  if (!owner || !repo) {
    setMixpanelStatus("Analyze a repository before loading Mixpanel activity.");
    return;
  }
  const days = document.getElementById("mixpanelRangeSelect")?.value || "7";
  setMixpanelStatus(`Loading ${days} days of Mixpanel activity for ${owner}/${repo}...`);
  const loadButton = document.getElementById("mixpanelLoadActivityButton");
  if (loadButton) loadButton.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/mixpanel/load-user-activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_name: owner, repo_name: repo, days: Number(days) }),
    });
    const data = await parseJsonResponse(response);
    setMixpanelPreview(data);
    if (data.ok) {
      const mapped = (data.mapped_callgraph_nodes || []).length;
      setMixpanelStatus(
        `${data.message || `Loaded ${data.row_count || 0} Mixpanel events.`} ${mapped ? `Mapped ${mapped} callgraph node${mapped === 1 ? "" : "s"}.` : "No callgraph matches were found in the populated event fields."}`
      );
      renderMixpanelEventsTable(data.rows || []);
      const graphUrl = data.mixpanel_event_callgraph_map_url || data.mixpanel_analysis_graph_url || "";
      const block = document.getElementById("mixpanelSelectedEventGraphBlock");
      const frame = document.getElementById("mixpanelSelectedEventGraphFrame");
      const text = document.getElementById("mixpanelSelectedEventGraphText");
      const openLink = document.getElementById("mixpanelSelectedEventGraphOpenLink");
      if (graphUrl && block && frame) {
        const src = typeof cacheBustedUrl === "function" ? cacheBustedUrl(graphUrl) : graphUrl;
        block.style.display = "block";
        frame.style.display = "block";
        frame.src = src;
        if (openLink) {
          openLink.style.display = "inline-flex";
          openLink.href = src;
          openLink.textContent = "Open Mixpanel event-to-code map";
        }
        if (text) text.textContent = "Showing the latest mapped Mixpanel event. Use Create graph below to inspect another row.";
      }
    } else {
      setMixpanelStatus(data.detail || data.message || "Loading Mixpanel activity failed.");
    }
  } catch (err) {
    setMixpanelStatus(`Loading Mixpanel activity failed. ${err.message || err}`);
  } finally {
    if (loadButton) loadButton.disabled = false;
  }
}

async function restoreMixpanelConnectionStatus() {
  const { owner, repo } = mixpanelCurrentRepo();
  if (!owner || !repo) return;
  try {
    const url = new URL(`${API_BASE}/mixpanel/connection-status`);
    url.searchParams.set("owner_name", owner);
    url.searchParams.set("repo_name", repo);
    const response = await fetch(url.toString());
    const data = await parseJsonResponse(response);
    if (data.connected) {
      setMixpanelStatus(`Mixpanel is already connected for ${owner}/${repo} (project ${data.project_id}). Press Load User Activity to refresh.`);
      const projectIdInput = document.getElementById("mixpanelProjectId");
      if (projectIdInput && !projectIdInput.value) projectIdInput.value = data.project_id || "";
      const loadButton = document.getElementById("mixpanelLoadActivityButton");
      if (loadButton) loadButton.disabled = false;
    }
  } catch (err) {
    // Non-fatal: just leave the default "not connected" status in place.
  }
}

document.addEventListener("DOMContentLoaded", () => {
  restoreMixpanelConnectionStatus();
});
