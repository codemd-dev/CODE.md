// ===============================
// CodeVal AutoTrack Sentry Adapter
// Requires autotrack_core.js. Optionally initializes Sentry when data-dsn is provided.
// ===============================

(function() {
  const dataset = document.currentScript?.dataset || {};
  const dsn = dataset.dsn || '';
  const environment = dataset.environment || 'production';
  let installed = false;

  function initSentry() {
    try {
      if (!window.Sentry) return false;
      if (dsn && !window.__codevalAutoTrackSentryReady) {
        window.Sentry.init({
          dsn,
          environment,
          sendDefaultPii: dataset.sendDefaultPii === 'true',
          tracesSampleRate: Number.parseFloat(dataset.tracesSampleRate || '0')
        });
        window.__codevalAutoTrackSentryReady = true;
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function setContext(properties = {}) {
    if (!initSentry()) return;
    try {
      window.Sentry.setContext('codeval_activity', properties);
      if (properties.repository_owner || properties.repository_name) {
        window.Sentry.setTags({
          codeval_repository_owner: properties.repository_owner || '',
          codeval_repository_name: properties.repository_name || ''
        });
      }
      if (properties.trigger_element || properties.button_name) {
        window.Sentry.setTag('codeval_trigger', properties.trigger_element || properties.button_name);
      }
    } catch (err) {
      // Observability must never break the product.
    }
  }

  function track(eventName, properties = {}) {
    try {
      setContext({
        event_name: eventName,
        ...properties
      });
      if (!window.Sentry || !eventName) return;
      if (/error|exception|rejection|failure/i.test(eventName)) {
        const message = properties.error_message || properties.message || eventName;
        window.Sentry.captureMessage(String(message), properties.severity === 'error' ? 'error' : 'warning');
      } else {
        window.Sentry.addBreadcrumb({
          category: 'codeval.activity',
          message: eventName,
          level: 'info',
          data: properties
        });
      }
    } catch (err) {
      // Observability must never break the product.
    }
  }

  function install() {
    if (installed) return true;
    if (!window.CodeValAutoTrack || typeof window.CodeValAutoTrack.registerProvider !== 'function') return false;
    window.CodeValAutoTrack.registerProvider({
      name: 'sentry',
      track
    });
    installed = true;
    return true;
  }

  if (!install()) {
    window.addEventListener('codeval:autotrack-ready', install, { once: true });
    setTimeout(install, 0);
  }
})();
