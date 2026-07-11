// ===============================
// CodeVal AutoTrack Mixpanel Adapter
// Requires autotrack_core.js. Optionally initializes Mixpanel when data-project-token is provided.
// ===============================

(function() {
  const dataset = document.currentScript?.dataset || {};
  const projectToken = dataset.projectToken || dataset.token || '';
  const source = dataset.source || 'codeval_activity';
  let installed = false;

  function cleanProperties(properties = {}) {
    const clean = {};
    Object.entries(properties || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (typeof value === 'number' && Number.isNaN(value)) return;
      clean[key] = value;
    });
    return clean;
  }

  function initMixpanel() {
    try {
      if (!window.mixpanel) return false;
      if (projectToken && !window.__codevalAutoTrackMixpanelReady) {
        window.mixpanel.init(projectToken, {
          debug: dataset.debug === 'true',
          autocapture: dataset.autocapture !== 'false',
          record_sessions_percent: Number.parseFloat(dataset.recordSessionsPercent || '5'),
          persistence: dataset.persistence || 'localStorage'
        });
        window.__codevalAutoTrackMixpanelReady = true;
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function track(eventName, properties = {}) {
    try {
      if (!initMixpanel() || !eventName) return;
      window.mixpanel.track(eventName, cleanProperties({
        platform: 'web',
        source,
        ...properties
      }));
    } catch (err) {
      // Analytics must never break the product.
    }
  }

  function install() {
    if (installed) return true;
    if (!window.CodeValAutoTrack || typeof window.CodeValAutoTrack.registerProvider !== 'function') return false;
    window.CodeValAutoTrack.registerProvider({
      name: 'mixpanel',
      track
    });
    installed = true;
    window.CodeValActivity = window.CodeValActivity || {
      track
    };
    return true;
  }

  if (!install()) {
    window.addEventListener('codeval:autotrack-ready', install, { once: true });
    setTimeout(install, 0);
  }
})();
