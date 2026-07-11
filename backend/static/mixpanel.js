// Mixpanel Quick Start tracking for CodeVal.
// Keep event names and identity behavior centralized so future tracking stays consistent.
(function() {
  const PROJECT_TOKEN = "668110ec31de410f5a1a14d96d056020";
  const SIGNUP_PREFIX = "codeval:mixpanelSignUpCompleted:";
  const USER_PREFIX = "github:";

  function cleanValue(value) {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number" && Number.isNaN(value)) return undefined;
    return value;
  }

  function cleanProperties(properties = {}) {
    const clean = {};
    Object.entries(properties || {}).forEach(([key, value]) => {
      const cleaned = cleanValue(value);
      if (cleaned !== undefined) clean[key] = cleaned;
    });
    return clean;
  }

  function userId(user = {}) {
    const id = user.github_user_id || user.id || "";
    return id ? `${USER_PREFIX}${id}` : "";
  }

  function init() {
    if (!window.mixpanel || window.__codevalMixpanelReady) return Boolean(window.__codevalMixpanelReady);
    window.mixpanel.init(PROJECT_TOKEN, {
      debug: Boolean(window.CODEVAL_MIXPANEL_DEBUG),
      persistence: "localStorage",
      autocapture: true,
      record_sessions_percent: 100
    });
    window.__codevalMixpanelReady = true;
    return true;
  }

  function track(eventName, properties = {}) {
    try {
      if (!init() || !eventName) return;
      window.mixpanel.track(eventName, cleanProperties({
        platform: "web",
        app_name: "CodeVal",
        page_path: window.location.pathname,
        ...properties
      }));
    } catch (err) {
      // Analytics must never break the product.
    }
  }

  function identifyGitHubUser(user = {}) {
    try {
      if (!init()) return "";
      const distinctId = userId(user);
      if (!distinctId) return "";
      window.mixpanel.identify(distinctId);
      window.mixpanel.people.set(cleanProperties({
        $name: user.name || user.login || "",
        github_login: user.login || "",
        github_profile_url: user.html_url || "",
        account_auth_method: "github"
      }));
      window.mixpanel.register(cleanProperties({
        auth_method: "github",
        github_login: user.login || ""
      }));
      return distinctId;
    } catch (err) {
      return "";
    }
  }

  function trackSignUpCompleted(user = {}) {
    const distinctId = identifyGitHubUser(user);
    if (!distinctId) return;
    try {
      const key = `${SIGNUP_PREFIX}${distinctId}`;
      if (localStorage.getItem(key) === "1") return;
      window.mixpanel.people.set_once(cleanProperties({
        first_sign_up_date: new Date().toISOString(),
        first_sign_up_method: "github"
      }));
      track("sign_up_completed", {
        sign_up_method: "github",
        signup_surface: "github_oauth",
        is_first_time: true
      });
      localStorage.setItem(key, "1");
    } catch (err) {
      // localStorage may be unavailable; identity remains wired even if dedupe fails.
    }
  }

  function trackSearchAnswerGenerated(properties = {}) {
    track("search_answer_generated", cleanProperties({
      value_moment: true,
      generation_surface: properties.generation_surface || "dashboard_search",
      query_length: properties.query_length,
      answer_length: properties.answer_length,
      prompt_chars: properties.prompt_chars,
      result_count: properties.result_count,
      text_result_count: properties.text_result_count,
      repository_owner: properties.repository_owner,
      repository_name: properties.repository_name,
      has_answer: properties.has_answer
    }));
  }

  function reset() {
    try {
      if (init()) window.mixpanel.reset();
    } catch (err) {
      // Ignore analytics reset failures.
    }
  }

  function urlPath(input) {
    try {
      const raw = typeof input === "string" ? input : input?.url || "";
      return new URL(raw, window.location.href).pathname;
    } catch (err) {
      return "";
    }
  }

  function installLogoutReset() {
    if (window.__codevalMixpanelFetchWrapped || typeof window.fetch !== "function") return;
    window.__codevalMixpanelFetchWrapped = true;
    const originalFetch = window.fetch;
    window.fetch = function(input, options) {
      const path = urlPath(input);
      return originalFetch.apply(this, arguments).then(response => {
        if (response?.ok && path === "/github/logout") reset();
        return response;
      });
    };
  }

  window.CodeValAnalytics = {
    init,
    track,
    identifyGitHubUser,
    trackSignUpCompleted,
    trackSearchAnswerGenerated,
    reset
  };

  init();
  installLogoutReset();
})();
