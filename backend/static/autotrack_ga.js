// ===============================
// CodeVal AutoTrack GA4 Adapter
// Requires autotrack_core.js and either an existing gtag or data-measurement-id.
// ===============================

(function() {
  const dataset = document.currentScript?.dataset || {};
  const measurementId = dataset.measurementId || dataset.gaMeasurementId || '';
  let installed = false;

  function ensureGtag() {
    try {
      window.dataLayer = window.dataLayer || [];
      if (typeof window.gtag !== 'function') {
        window.gtag = function() {
          window.dataLayer.push(arguments);
        };
      }
      if (measurementId && !window.__codevalAutoTrackGaScriptLoaded) {
        const script = document.createElement('script');
        script.async = true;
        script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
        document.head.appendChild(script);
        window.__codevalAutoTrackGaScriptLoaded = true;
      }
      if (measurementId && !window.__codevalAutoTrackGaConfigured) {
        window.gtag('js', new Date());
        window.gtag('config', measurementId, window.CODEVAL_GA_DEBUG ? { debug_mode: true } : {});
        window.__codevalAutoTrackGaConfigured = true;
      }
      return typeof window.gtag === 'function';
    } catch (err) {
      return false;
    }
  }

  function track(eventName, properties = {}) {
    try {
      if (!ensureGtag() || !eventName) return;
      window.gtag('event', eventName, properties);
    } catch (err) {
      // Analytics must never break the product.
    }
  }

  function install() {
    if (installed) return true;
    if (!window.CodeValAutoTrack || typeof window.CodeValAutoTrack.registerProvider !== 'function') return false;
    window.CodeValAutoTrack.registerProvider({
      name: 'ga4',
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
