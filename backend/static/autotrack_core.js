// ===============================
// CodeVal AutoTrack Core
// Captures browser evidence once and lets provider adapters send it onward.
// ===============================

(function() {
  if (window.__codevalAutoTrackCoreInstalled) return;
  window.__codevalAutoTrackCoreInstalled = true;

  const currentScript = document.currentScript;
  const dataset = currentScript?.dataset || {};
  const config = {
    tag: dataset.tag || 'autotrack',
    maxTextLength: Number.parseInt(dataset.maxTextLength || '480', 10),
    repositoryOwner: dataset.repositoryOwner || '',
    repositoryName: dataset.repositoryName || '',
    pageLoadEventName: dataset.pageLoadEventName || 'page_loaded',
    clickEventName: dataset.clickEventName || 'cv_click',
    fetchEventName: dataset.fetchEventName || 'cv_fetch',
    frontendErrorEventName: dataset.frontendErrorEventName || 'cv_frontend_error',
    backendErrorEventName: dataset.backendErrorEventName || 'cv_backend_error',
    uiErrorEventName: dataset.uiErrorEventName || 'cv_ui_error'
  };

  const providers = [];
  const pendingEvents = [];

  function cleanText(value, maxLength = config.maxTextLength) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  function cleanProperties(properties = {}) {
    const clean = {};
    Object.entries(properties || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (typeof value === 'number' && Number.isNaN(value)) return;
      clean[key] = value;
    });
    return clean;
  }

  function urlInfo(value) {
    try {
      return new URL(String(value || ''), window.location.href);
    } catch (err) {
      return null;
    }
  }

  function endpointName(value) {
    const url = urlInfo(value);
    if (!url) return cleanText(value, 160);
    if (url.origin === window.location.origin) return url.pathname || '/';
    return `${url.origin}${url.pathname}`;
  }

  function safeRequestUrl(value) {
    const url = urlInfo(value);
    if (!url) return cleanText(value, 300);
    const sensitive = /token|secret|password|passwd|pwd|key|code|state|session|auth|credential/i;
    url.searchParams.forEach((paramValue, key) => {
      if (sensitive.test(key) || sensitive.test(paramValue)) {
        url.searchParams.set(key, '[redacted]');
      }
    });
    return cleanText(url.href, 300);
  }

  function shouldIgnoreFetch(value) {
    const url = urlInfo(value);
    if (!url) return false;
    const host = url.hostname.toLowerCase();
    return (
      host === 'analytics.google.com' ||
      host === 'www.google-analytics.com' ||
      host === 'google-analytics.com' ||
      host === 'www.googletagmanager.com' ||
      host === 'googletagmanager.com' ||
      host.endsWith('.google-analytics.com') ||
      host.endsWith('.googletagmanager.com') ||
      host === 'api-js.mixpanel.com' ||
      host === 'api.mixpanel.com' ||
      host.endsWith('.mixpanel.com') ||
      host.endsWith('.sentry.io') ||
      url.pathname === '/g/collect' ||
      url.pathname === '/collect'
    );
  }

  function repositoryContext() {
    try {
      const analysis = typeof window.currentAnalysis === 'function' ? window.currentAnalysis() : {};
      const params = new URLSearchParams(window.location.search || '');
      return {
        repository_owner: cleanText(config.repositoryOwner || analysis?.owner_name || analysis?.owner || params.get('owner_name') || params.get('owner') || '', 160),
        repository_name: cleanText(config.repositoryName || analysis?.repo_name || analysis?.repo || params.get('repo_name') || params.get('repo') || '', 160)
      };
    } catch (err) {
      return {
        repository_owner: cleanText(config.repositoryOwner, 160),
        repository_name: cleanText(config.repositoryName, 160)
      };
    }
  }

  function stackTopFrame(stack, source = '', lineno = '', colno = '') {
    const lines = String(stack || '')
      .split(/\r?\n/)
      .map(line => cleanText(line, 220))
      .filter(Boolean);
    const top = lines.find(line => !/^(error|exception)\b/i.test(line)) || lines[0] || '';
    if (top) return top;
    return cleanText([source, lineno, colno].filter(value => value !== undefined && value !== null && value !== '').join(':'), 220);
  }

  function stackHash(stack) {
    const text = String(stack || '').slice(0, 4000);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `stk_${(hash >>> 0).toString(16)}`;
  }

  function stackContextPayload(params = {}) {
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
      stack: params.stack || cleanText(stack, 480),
      top_frame: params.top_frame || stackTopFrame(stack)
    };
  }

  function recentClick(maxAgeMs = 5000) {
    const click = window.__codevalLastClick || {};
    return Date.now() - (click.ts || 0) < maxAgeMs ? click : {};
  }

  function clickContextPayload(endpoint = '') {
    const click = recentClick();
    const trigger = click.element_name || '';
    const functionName = cleanText(click.function_name || trigger, 160);
    const callgraphNode = cleanText(
      click.callgraph_node ||
      (functionName ? `js.${functionName}` : '') ||
      (endpoint ? `CALL ${endpoint}` : ''),
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

  function inputValue(element) {
    if (!(element instanceof Element)) return '';
    if (!/^(INPUT|SELECT|TEXTAREA)$/i.test(element.tagName)) return '';
    const type = String(element.getAttribute('type') || '').toLowerCase();
    if (/password|token|secret|key|credential/.test(type)) return '[redacted]';
    return cleanText(element.value || '', 160);
  }

  function inlineHandlerName(element) {
    if (!(element instanceof Element)) return '';
    const inlineHandler = element.getAttribute('onclick') || element.getAttribute('onchange') || element.getAttribute('onsubmit') || '';
    const match = inlineHandler.match(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/);
    return cleanText(match?.[1] || '', 160);
  }

  function elementName(element) {
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
    const cleanName = cleanText(directName, 160);
    if (cleanName) return cleanName;
    const className = typeof element.className === 'string' ? element.className : '';
    return cleanText(`${element.tagName.toLowerCase()}${className ? `.${className.replace(/\s+/g, '.')}` : ''}`, 160);
  }

  function elementFunctionName(element, fallbackName = '') {
    if (!(element instanceof Element)) return cleanText(fallbackName, 160);
    return cleanText(
      element.getAttribute('data-function-name') ||
      element.getAttribute('data-codeval-function') ||
      element.getAttribute('data-action') ||
      element.getAttribute('data-codeval-action') ||
      inlineHandlerName(element) ||
      fallbackName,
      160
    );
  }

  function domPath(element, maxDepth = 6) {
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
    return cleanText(parts.join(' > '), 200);
  }

  function sourceName(element) {
    if (!(element instanceof Element)) return cleanText(element, 160);
    return cleanText(
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

  function looksLikeUiError(text) {
    return /\b(error|failed|failure|unavailable|expired|invalid|denied|reconnect|unauthorized|unauthorised|forbidden|timeout|exception|unable|not signed in|not authorized|not authorised|cannot|can't|blocked|rejected|missing|required|crash|fatal)\b/i.test(text || '');
  }

  function emit(eventName, payload = {}) {
    const finalPayload = cleanProperties({
      platform: 'web',
      source: 'codeval_activity',
      ...repositoryContext(),
      page_path: window.location.pathname,
      url: window.location.href,
      tag: config.tag,
      ...payload
    });
    const event = { eventName, payload: finalPayload };
    pendingEvents.push(event);
    providers.forEach(provider => sendToProvider(provider, event));
    try {
      window.dispatchEvent(new CustomEvent('codeval:activity', { detail: event }));
    } catch (err) {
      // Older browsers can skip the local event.
    }
  }

  function sendToProvider(provider, event) {
    try {
      if (provider && typeof provider.track === 'function') {
        provider.track(event.eventName, event.payload);
      }
    } catch (err) {
      // Analytics must never break the product.
    }
  }

  function registerProvider(provider) {
    if (!provider || typeof provider.track !== 'function') return;
    providers.push(provider);
    pendingEvents.forEach(event => sendToProvider(provider, event));
  }

  function trackEvent(eventName, params = {}) {
    const stackContext = stackContextPayload(params);
    const endpoint = params.endpoint || params.end_point || '';
    const functionName = params.function_name || stackContext.function_name;
    const payload = {
      ...stackContext,
      ...params,
      endpoint,
      function_name: functionName,
      callgraph_node: params.callgraph_node || (endpoint ? `CALL ${endpoint}` : (functionName ? `js.${functionName}` : ''))
    };
    delete payload.end_point;
    delete payload.line_number;
    emit(eventName, payload);
  }

  function trackError(message, sourceElement = 'manual_test') {
    const errorMessage = cleanText(message || 'Manual frontend error test');
    const source = cleanText(sourceElement, 160);
    emit(config.frontendErrorEventName, {
      message: errorMessage,
      error_message: errorMessage,
      source_element: source,
      source: 'manual',
      top_frame: source,
      stack_hash: stackHash(`${source}:${errorMessage}`),
      severity: 'manual_test',
      trigger_element: recentClick().element_name || ''
    });
  }

  function trackUiError(message, sourceElement = 'manual_test') {
    const errorMessage = cleanText(message || 'Manual UI error test');
    emit(config.uiErrorEventName, {
      error_message: errorMessage,
      ui_message: errorMessage,
      source_element: cleanText(sourceElement, 120),
      severity: 'manual_test',
      trigger_element: recentClick().element_name || ''
    });
  }

  document.addEventListener('click', (event) => {
    try {
      const source = event.target instanceof Element ? event.target : event.target?.parentElement;
      const element = source?.closest?.('button, a, [role="button"], input, select, textarea, label, summary, [onclick], [data-codeval-name], [data-analytics-name], [data-testid]') || source;
      const name = elementName(element) || 'unknown_click';
      const previousClick = recentClick(1000);
      const matchingPreviousClick = previousClick.element_name === name ? previousClick : {};
      const functionName = matchingPreviousClick.function_name || elementFunctionName(element, name);
      const callgraphNode = cleanText(
        element?.getAttribute?.('data-callgraph-node') ||
        matchingPreviousClick.callgraph_node ||
        (functionName ? `js.${functionName}` : name),
        160
      );
      const payload = {
        element_name: name,
        button_name: name,
        dom_path: domPath(element),
        callgraph_node: callgraphNode,
        function_name: functionName,
        file_path: matchingPreviousClick.file_path || window.location.pathname,
        source_element: sourceName(element),
        trigger_element: name,
        input_value: inputValue(element)
      };
      window.__codevalLastClick = {
        ...payload,
        ts: Date.now()
      };
      emit(config.clickEventName, payload);
    } catch (err) {
      // Never break the user's site.
    }
  });

  window.addEventListener('error', (event) => {
    try {
      if (event.target !== window && event.target?.tagName) return;
      const message = cleanText(event.message || '');
      const stack = cleanText(event.error?.stack || '', 480);
      emit(config.frontendErrorEventName, {
        message,
        error_message: message,
        source: event.filename || '',
        lineno: event.lineno || '',
        colno: event.colno || '',
        stack,
        top_frame: stackTopFrame(stack, event.filename, event.lineno, event.colno),
        stack_hash: stackHash(stack || `${event.filename}:${event.lineno}:${event.colno}:${message}`),
        severity: 'error',
        trigger_element: recentClick().element_name || ''
      });
    } catch (err) {
      // Never break the user's site.
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason || {};
      const message = cleanText(reason.message || reason);
      const stack = cleanText(reason.stack || '', 480);
      emit(config.frontendErrorEventName, {
        message,
        error_message: message,
        source: 'unhandledrejection',
        stack,
        top_frame: stackTopFrame(stack, 'unhandledrejection'),
        stack_hash: stackHash(stack || message),
        severity: 'error',
        trigger_element: recentClick().element_name || ''
      });
    } catch (err) {
      // Never break the user's site.
    }
  });

  if (typeof window.fetch === 'function' && !window.__codevalAutoTrackFetchWrapped) {
    window.__codevalAutoTrackFetchWrapped = true;
    const originalFetch = window.fetch;
    window.fetch = function(input, options) {
      const endpoint = typeof input === 'string' ? input : input?.url || String(input);
      const method = options?.method || 'GET';
      if (shouldIgnoreFetch(endpoint)) {
        return originalFetch.apply(this, arguments);
      }
      const endpointLabel = endpointName(endpoint);
      const requestUrl = safeRequestUrl(endpoint);
      const context = clickContextPayload(endpointLabel);
      emit(config.fetchEventName, {
        ...context,
        endpoint: endpointLabel,
        endpoint_name: endpointLabel,
        request_url: requestUrl,
        method
      });
      return originalFetch.apply(this, arguments)
        .then(response => {
          if (!response.ok) {
            const basePayload = {
              ...context,
              endpoint: endpointLabel,
              endpoint_name: endpointLabel,
              request_url: requestUrl,
              method,
              status: response.status,
              status_text: response.statusText,
              severity: 'error'
            };
            try {
              response.clone().text().then(body => {
                emit(config.backendErrorEventName, {
                  ...basePayload,
                  error_message: cleanText(body || response.statusText),
                  response_body: cleanText(body, 480)
                });
              }).catch(() => emit(config.backendErrorEventName, basePayload));
            } catch (err) {
              emit(config.backendErrorEventName, basePayload);
            }
          }
          return response;
        })
        .catch(err => {
          emit(config.backendErrorEventName, {
            ...context,
            endpoint: endpointLabel,
            endpoint_name: endpointLabel,
            request_url: requestUrl,
            method,
            error_message: cleanText(err.message || err),
            severity: 'error'
          });
          throw err;
        });
    };
  }

  const recentUiMessages = new Map();
  function inspectUiMessageNode(node) {
    if (!(node instanceof Element)) return;
    const selector = [
      '[role="alert"]',
      '[aria-live]',
      '[data-error]',
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
      '[id*="message" i]'
    ].join(',');
    const targets = node.matches(selector) ? [node] : Array.from(node.querySelectorAll(selector));
    targets.forEach(target => {
      const message = cleanText(target.textContent || target.value || '');
      if (!message || !looksLikeUiError(message)) return;
      const source = sourceName(target);
      const key = `${source}:${message}`;
      const now = Date.now();
      if (now - (recentUiMessages.get(key) || 0) < 3000) return;
      recentUiMessages.set(key, now);
      emit(config.uiErrorEventName, {
        error_message: message,
        ui_message: message,
        source_element: source,
        severity: 'ui_status',
        trigger_element: recentClick().element_name || ''
      });
    });
  }

  if (typeof MutationObserver === 'function') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => inspectUiMessageNode(document.body));
    } else {
      inspectUiMessageNode(document.body);
    }
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.type === 'characterData') {
          inspectUiMessageNode(mutation.target.parentElement);
        } else {
          inspectUiMessageNode(mutation.target);
          mutation.addedNodes.forEach(inspectUiMessageNode);
        }
      });
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true
    });
  }

  const api = {
    version: '2026-06-26',
    config,
    registerProvider,
    trackEvent,
    trackError,
    trackUiError,
    emit,
    cleanText,
    domPath,
    recentClick
  };

  window.CodeValAutoTrack = window.CodeValAutoTrack || api;
  Object.assign(window.CodeValAutoTrack, api);
  window.AutoTrackErrors = window.CodeValAutoTrack;
  window.CodeValActivity = window.CodeValActivity || {
    track: trackEvent
  };

  try {
    window.dispatchEvent(new CustomEvent('codeval:autotrack-ready', {
      detail: {
        version: api.version
      }
    }));
  } catch (err) {
    // Older browsers can skip the local event.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => emit(config.pageLoadEventName));
  } else {
    emit(config.pageLoadEventName);
  }
})();
