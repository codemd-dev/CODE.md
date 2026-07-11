// ===============================
// Generic AutoTrack
// Captures: clicks, JS errors, backend failures
// ===============================

const codevalAutoTrackConfig = (() => {
  const dataset = document.currentScript?.dataset || {};
  return {
    mirrorEventName: dataset.mirrorEventName || dataset.eventName || 'cv_click',
    tag: dataset.tag || 'autotrack',
    maxTextLength: Number.parseInt(dataset.maxTextLength || '480', 10)
  };
})();

function codevalGtagEvent(name, payload) {
  try {
    window.dataLayer = window.dataLayer || [];
    const sendEvent = typeof window.gtag === 'function'
      ? window.gtag
      : function() {
          window.dataLayer.push(arguments);
        };
    sendEvent('event', name, payload);
  } catch (err) {
    // Never break the user's site
  }
}

function codevalMixpanelEvent(name, payload) {
  try {
    if (!name) return;
    if (window.CodeValAnalytics && typeof window.CodeValAnalytics.track === 'function') {
      window.CodeValAnalytics.track(name, payload);
      return;
    }
    if (window.mixpanel && typeof window.mixpanel.track === 'function') {
      window.mixpanel.track(name, payload);
    }
  } catch (err) {
    // Never break the user's site
  }
}

function codevalUrlInfo(value) {
  try {
    return new URL(String(value || ''), window.location.href);
  } catch (err) {
    return null;
  }
}

function codevalEndpointName(value) {
  const url = codevalUrlInfo(value);
  if (!url) return codevalCleanText(value, 160);
  if (url.origin === window.location.origin) return url.pathname || '/';
  return `${url.origin}${url.pathname}`;
}

function codevalSafeRequestUrl(value) {
  const url = codevalUrlInfo(value);
  if (!url) return codevalCleanText(value, 300);
  const sensitive = /token|secret|password|passwd|pwd|key|code|state|session|auth|credential/i;
  url.searchParams.forEach((paramValue, key) => {
    if (sensitive.test(key) || sensitive.test(paramValue)) {
      url.searchParams.set(key, '[redacted]');
    }
  });
  return codevalCleanText(url.href, 300);
}

function codevalRepositoryContext() {
  try {
    const analysis = typeof window.currentAnalysis === 'function' ? window.currentAnalysis() : {};
    const params = new URLSearchParams(window.location.search || '');
    const owner = analysis?.owner_name || analysis?.owner || params.get('owner_name') || params.get('owner') || '';
    const repo = analysis?.repo_name || analysis?.repo || params.get('repo_name') || params.get('repo') || '';
    return {
      repository_owner: codevalCleanText(owner, 160),
      repository_name: codevalCleanText(repo, 160)
    };
  } catch (err) {
    return {
      repository_owner: '',
      repository_name: ''
    };
  }
}

function codevalShouldIgnoreFetch(value) {
  const url = codevalUrlInfo(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const expectedSessionProbePaths = new Set([
    '/github/me',
    '/google-analytics/me'
  ]);
  return (
    host === 'analytics.google.com' ||
    host === 'www.google-analytics.com' ||
    host === 'google-analytics.com' ||
    host === 'www.googletagmanager.com' ||
    host === 'googletagmanager.com' ||
    host.endsWith('.google-analytics.com') ||
    host.endsWith('.googletagmanager.com') ||
    (url.origin === window.location.origin && expectedSessionProbePaths.has(url.pathname)) ||
    url.pathname === '/g/collect' ||
    url.pathname === '/collect'
  );
}

function codevalErrorNode(basePayload) {
  return codevalCleanText(
    basePayload.source_element ||
    basePayload.trigger_element ||
    basePayload.top_frame ||
    basePayload.source ||
    basePayload.function_name ||
    basePayload.endpoint_name ||
    'autotracked_error',
    160
  );
}

function codevalTrackErrorEvent(name, label, payload) {
  const basePayload = {
    ...payload,
    ...codevalRepositoryContext(),
    page_path: window.location.pathname,
    tag: codevalAutoTrackConfig.tag
  };
  const node = codevalErrorNode(basePayload);
  const mirrorPayload = {
    button_name: label,
    function_name: node,
    callgraph_node: node,
    file_path: window.location.pathname,
    ...basePayload
  };
  codevalGtagEvent(name, basePayload);
  codevalMixpanelEvent(name, basePayload);
  codevalGtagEvent(codevalAutoTrackConfig.mirrorEventName, mirrorPayload);
  codevalMixpanelEvent(codevalAutoTrackConfig.mirrorEventName, mirrorPayload);
}

function codevalCleanText(value, maxLength = codevalAutoTrackConfig.maxTextLength) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function codevalStackTopFrame(stack, source = '', lineno = '', colno = '') {
  const lines = String(stack || '')
    .split(/\r?\n/)
    .map(line => codevalCleanText(line, 220))
    .filter(Boolean);
  const top = lines.find(line => !/^(error|exception)\b/i.test(line)) || lines[0] || '';
  if (top) return top;
  return codevalCleanText([source, lineno, colno].filter(value => value !== undefined && value !== null && value !== '').join(':'), 220);
}

function codevalStackHash(stack) {
  const text = String(stack || '').slice(0, 4000);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `stk_${(hash >>> 0).toString(16)}`;
}

function codevalStackContextPayload(params = {}) {
  const stack = new Error().stack || '';
  const lines = stack.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const caller = lines[2] || lines[1] || '';
  const match = caller.match(/\(?([^()]+):(\d+):(\d+)\)?$/) || [];
  const inferredFunction = (caller.match(/^at\s+([^\s(]+)/) || [])[1] || '';
  return {
    file_path: params.file_path || match[1] || window.location.pathname,
    lineno: params.lineno || match[2] || '',
    colno: params.colno || match[3] || '',
    function_name: params.function_name || inferredFunction || '',
    stack: params.stack || codevalCleanText(stack, 480),
    top_frame: params.top_frame || codevalStackTopFrame(stack)
  };
}

function codevalRecentClick(maxAgeMs = 5000) {
  const click = window.__codevalLastClick || {};
  return Date.now() - (click.ts || 0) < maxAgeMs ? click : {};
}

function codevalLastTrigger() {
  return codevalRecentClick().element_name || '';
}

function codevalClickContextPayload(endpointName = '') {
  const click = codevalRecentClick();
  const trigger = click.element_name || '';
  const functionName = codevalCleanText(click.function_name || trigger, 160);
  const callgraphNode = codevalCleanText(
    click.callgraph_node ||
    (functionName ? `js.${functionName}` : '') ||
    (endpointName ? `CALL ${endpointName}` : ''),
    160
  );
  return {
    button_name: trigger,
    trigger_element: trigger,
    input_value: click.input_value || '',
    function_name: functionName,
    callgraph_node: callgraphNode,
    file_path: click.file_path || window.location.pathname,
    source_element: click.source_element || '',
    dom_path: click.dom_path || ''
  };
}

function codevalInputValue(element) {
  if (!(element instanceof Element)) return '';
  if (!/^(INPUT|SELECT|TEXTAREA)$/i.test(element.tagName)) return '';
  const type = String(element.getAttribute('type') || '').toLowerCase();
  if (/password|token|secret|key|credential/.test(type)) return '[redacted]';
  return codevalCleanText(element.value || '', 160);
}

function codevalInlineHandlerName(element) {
  if (!(element instanceof Element)) return '';
  const inlineHandler = element.getAttribute('onclick') || element.getAttribute('onchange') || element.getAttribute('onsubmit') || '';
  const match = inlineHandler.match(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/);
  return codevalCleanText(match?.[1] || '', 160);
}

function codevalElementFunctionName(element, fallbackName = '') {
  if (!(element instanceof Element)) return codevalCleanText(fallbackName, 160);
  return codevalCleanText(
    element.getAttribute('data-function-name') ||
    element.getAttribute('data-codeval-function') ||
    element.getAttribute('data-action') ||
    element.getAttribute('data-codeval-action') ||
    codevalInlineHandlerName(element) ||
    fallbackName,
    160
  );
}

function codevalLooksLikeUiError(text) {
  return /\b(error|failed|failure|unavailable|expired|invalid|denied|reconnect|unauthorized|unauthorised|forbidden|timeout|exception|unable|not signed in|not authorized|not authorised|cannot|can't|blocked|rejected|missing|required|crash|fatal)\b/i.test(text || '');
}

function codevalElementName(element) {
  if (!(element instanceof Element)) return '';
  const directName =
    element.getAttribute('data-codeval-name') ||
    element.getAttribute('data-analytics-name') ||
    element.getAttribute('data-testid') ||
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.id ||
    element.name ||
    element.value ||
    element.textContent;
  const cleanName = codevalCleanText(directName, 160);
  if (cleanName) return cleanName;
  const className = typeof element.className === 'string' ? element.className : '';
  return codevalCleanText(`${element.tagName.toLowerCase()}${className ? `.${className.replace(/\s+/g, '.')}` : ''}`, 160);
}

function codevalDomPath(element, maxDepth = 6) {
  if (!(element instanceof Element)) return '';
  const parts = [];
  let node = element;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < maxDepth) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${node.id}`);
      break;
    }
    const firstClass = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : '';
    if (firstClass) part += `.${firstClass}`;
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === node.tagName);
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    node = parent;
    depth += 1;
  }
  return codevalCleanText(parts.join(' > '), 200);
}

function codevalSourceName(element) {
  if (!(element instanceof Element)) return codevalCleanText(element, 160);
  return codevalCleanText(
    element.getAttribute('data-codeval-name') ||
    element.getAttribute('data-analytics-name') ||
    element.getAttribute('data-testid') ||
    element.getAttribute('aria-label') ||
    element.id ||
    element.name ||
    element.getAttribute('role') ||
    element.getAttribute('class') ||
    element.tagName,
    160
  );
}

const codevalRecentUiMessages = new Map();
function codevalTrackUiMessage(message, sourceElement, severity = 'error') {
  const errorMessage = codevalCleanText(message);
  if (!errorMessage || !codevalLooksLikeUiError(errorMessage)) return;
  const source = codevalCleanText(sourceElement, 120);
  const dedupeKey = `${source}:${errorMessage}`;
  const now = Date.now();
  if (now - (codevalRecentUiMessages.get(dedupeKey) || 0) < 3000) return;
  codevalRecentUiMessages.set(dedupeKey, now);
  codevalTrackErrorEvent('cv_ui_error', 'UI error', {
    error_message: errorMessage,
    ui_message: errorMessage,
    source_element: source,
    severity,
    trigger_element: codevalLastTrigger()
  });
}

// ---------- 1. CLICK TRACKING ----------
document.addEventListener('click', (e) => {
  try {
    const source = e.target instanceof Element ? e.target : e.target?.parentElement;
    const el = source?.closest?.('button, a, [role="button"], input, select, textarea, label, summary, [onclick], [data-codeval-name], [data-analytics-name], [data-testid]') || source;
    const name = codevalElementName(el) || 'unknown_click';
    const previousClick = codevalRecentClick(1000);
    const matchingPreviousClick = previousClick.element_name === name ? previousClick : {};
    const explicitFunctionName = codevalCleanText(el?.getAttribute?.('data-function-name') || el?.getAttribute?.('data-codeval-function') || '', 160);
    const functionName = explicitFunctionName || matchingPreviousClick.function_name || codevalElementFunctionName(el, name);
    const callgraphNode = codevalCleanText(
      el?.getAttribute?.('data-callgraph-node') ||
      matchingPreviousClick.callgraph_node ||
      (functionName ? `js.${functionName}` : name),
      160
    );
    const sourceElement = codevalSourceName(el);
    const inputValue = codevalInputValue(el);
    const domPath = codevalDomPath(el);
    const clickPayload = {
      ...codevalRepositoryContext(),
      element_name: name,
      button_name: name,
      dom_path: domPath,
      callgraph_node: callgraphNode,
      function_name: functionName,
      file_path: matchingPreviousClick.file_path || window.location.pathname,
      source_element: sourceElement,
      trigger_element: name,
      input_value: inputValue,
      page_path: window.location.pathname,
      url: window.location.href,
      tag: codevalAutoTrackConfig.tag
    };

    window.__codevalLastClick = {
      element_name: name,
      function_name: functionName,
      callgraph_node: callgraphNode,
      file_path: clickPayload.file_path,
      source_element: sourceElement,
      input_value: inputValue,
      dom_path: domPath,
      ts: Date.now()
    };

    codevalGtagEvent('cv_click', clickPayload);
    codevalMixpanelEvent('cv_click', clickPayload);
    if (codevalAutoTrackConfig.mirrorEventName !== 'cv_click') {
      codevalGtagEvent(codevalAutoTrackConfig.mirrorEventName, clickPayload);
      codevalMixpanelEvent(codevalAutoTrackConfig.mirrorEventName, clickPayload);
    }
  } catch (err) {
    // Fail silently - never break the user's site
  }
});

// ---------- 2. FRONTEND ERROR TRACKING ----------
window.onerror = function(message, source, lineno, colno, error) {
  try {
    const errorMessage = codevalCleanText(message);
    const stack = codevalCleanText(error?.stack || '', 480);
    codevalTrackErrorEvent('cv_frontend_error', 'Frontend error', {
      message: errorMessage,
      error_message: errorMessage,
      source,
      lineno,
      colno,
      stack,
      top_frame: codevalStackTopFrame(stack, source, lineno, colno),
      stack_hash: codevalStackHash(stack || `${source}:${lineno}:${colno}:${errorMessage}`),
      severity: 'error',
      trigger_element: codevalLastTrigger()
    });
  } catch (err) {
    // Never break the user's site
  }
};

window.addEventListener('error', (e) => {
  if (e.target !== window && e.target?.tagName) {
    // script/img/link failed to load
  }
}, true); // capture phase required

const origError = console.error;
console.error = (...args) => {
  // send to GA/Mixpanel
  origError.apply(console, args);
};

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason || {};
  const errorMessage = codevalCleanText(reason.message || reason);
  const stack = codevalCleanText(reason.stack || '', 480);
  codevalTrackErrorEvent('cv_frontend_error', 'Frontend error', {
    message: errorMessage,
    error_message: errorMessage,
    source: 'unhandledrejection',
    stack,
    top_frame: codevalStackTopFrame(stack, 'unhandledrejection'),
    stack_hash: codevalStackHash(stack || errorMessage),
    severity: 'error',
    trigger_element: codevalLastTrigger()
  });
});

// ---------- 2B. UI STATUS / ERROR MESSAGE TRACKING ----------
(function() {
  const selector = [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live]',
    '[data-error]',
    '[data-status]',
    '[data-message]',
    '.error',
    '.alert',
    '.danger',
    '.warning',
    '.toast',
    '.notification',
    '.message',
    '.flash',
    '.banner',
    '.status',
    '.setup-status',
    '[class*="error" i]',
    '[class*="status" i]',
    '[class*="alert" i]',
    '[class*="warning" i]',
    '[class*="toast" i]',
    '[class*="notification" i]',
    '[id*="error" i]',
    '[id*="status" i]',
    '[id*="alert" i]',
    '[id*="message" i]',
    '[id*="Status"]',
    '[id="status"]'
  ].join(',');

  function inspectNode(node) {
    if (!(node instanceof Element)) return;
    const targets = node.matches(selector) ? [node] : Array.from(node.querySelectorAll(selector));
    targets.forEach((target) => {
      const text = codevalCleanText(target.textContent || target.value || '');
      const source = codevalSourceName(target);
      codevalTrackUiMessage(text, source, 'ui_status');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => inspectNode(document.body));
  } else {
    inspectNode(document.body);
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'characterData') {
        inspectNode(mutation.target.parentElement);
      } else {
        inspectNode(mutation.target);
        mutation.addedNodes.forEach(inspectNode);
      }
    });
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true
  });
})();

// ---------- 3. BACKEND ERROR TRACKING (fetch wrapper) ----------
(function() {
  const originalFetch = window.fetch;

  window.fetch = function(url, options) {
    const endpoint = typeof url === 'string' ? url : url?.url || String(url);
    const method = options?.method || 'GET';
    if (codevalShouldIgnoreFetch(endpoint)) {
      return originalFetch(url, options);
    }
    const endpointName = codevalEndpointName(endpoint);
    const requestUrl = codevalSafeRequestUrl(endpoint);
    const clickContext = codevalClickContextPayload(endpointName);
    try {
      const fetchPayload = {
        ...codevalRepositoryContext(),
        ...clickContext,
        endpoint: endpointName,
        endpoint_name: endpointName,
        request_url: requestUrl,
        method,
        page_path: window.location.pathname,
        url: window.location.href,
        tag: codevalAutoTrackConfig.tag
      };
      codevalGtagEvent('cv_fetch', fetchPayload);
      codevalMixpanelEvent('cv_fetch', fetchPayload);
    } catch (err) {
      // Never break the user's site
    }
    return originalFetch(url, options)
      .then(res => {
        if (!res.ok) {
          const basePayload = {
            endpoint: endpointName,
            endpoint_name: endpointName,
            request_url: requestUrl,
            method,
            status: res.status,
            status_text: res.statusText,
            ...clickContext,
            page_path: window.location.pathname,
            url: window.location.href,
            severity: 'error',
            tag: codevalAutoTrackConfig.tag
          };
          try {
            res.clone().text().then((body) => {
              codevalTrackErrorEvent('cv_backend_error', 'Backend error', {
                ...basePayload,
                error_message: codevalCleanText(body || res.statusText),
                response_body: codevalCleanText(body, 480)
              });
            }).catch(() => {
              codevalTrackErrorEvent('cv_backend_error', 'Backend error', basePayload);
            });
          } catch (err) {
            codevalTrackErrorEvent('cv_backend_error', 'Backend error', basePayload);
          }
        }
        return res;
      })
      .catch(err => {
        codevalTrackErrorEvent('cv_backend_error', 'Backend error', {
          endpoint: endpointName,
          endpoint_name: endpointName,
          request_url: requestUrl,
          method,
          error_message: err.message,
          ...clickContext,
          page_path: window.location.pathname,
          url: window.location.href,
          severity: 'error'
        });
        throw err;
      });
  };
})();

const codevalAutoTrackApi = {
  version: '2026-05-23',
  trackEvent(eventName, params = {}) {
    const stackContext = codevalStackContextPayload(params);
    const endpoint = params.endpoint || params.end_point || '';
    const functionName = params.function_name || stackContext.function_name;
    const payload = {
      ...codevalRepositoryContext(),
      ...stackContext,
      ...params,
      endpoint,
      function_name: functionName,
      callgraph_node: params.callgraph_node || (endpoint ? `CALL ${endpoint}` : (functionName ? `js.${functionName}` : '')),
      page_path: params.page_path || window.location.pathname,
      tag: params.tag || codevalAutoTrackConfig.tag
    };
    delete payload.end_point;
    delete payload.line_number;
    codevalGtagEvent(eventName, payload);
    codevalMixpanelEvent(eventName, payload);
  },
  trackUiError(message, sourceElement = 'manual_test') {
    codevalTrackUiMessage(message || 'Manual UI error test', sourceElement, 'manual_test');
  },
  trackError(message, sourceElement = 'manual_test') {
    const errorMessage = codevalCleanText(message || 'Manual frontend error test');
    const source = codevalCleanText(sourceElement, 160);
    codevalTrackErrorEvent('cv_frontend_error', 'Frontend error', {
      message: errorMessage,
      error_message: errorMessage,
      source_element: source,
      source: 'manual',
      top_frame: source,
      stack_hash: codevalStackHash(`${source}:${errorMessage}`),
      severity: 'manual_test',
      trigger_element: codevalLastTrigger()
    });
  }
};

window.AutoTrackErrors = codevalAutoTrackApi;
window.CodeValAutoTrack = codevalAutoTrackApi;
