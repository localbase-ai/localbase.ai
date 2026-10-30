// Injected into every viz page the operator server serves (see app-server.js).
//
// Vizzes are served from the API origin (:9220), not the app's (:9221), so a
// viz — AI-written, rendering data outsiders can influence — cannot reach into
// the app's page. That also means the app can no longer reach into the viz to
// read its keystrokes or scroll it, which is how the vim keys used to work.
// This bridge restores both directions over postMessage:
//   viz → app   lb:key     a key the viz didn't claim, for the app's handler
//   app → viz   lb:scroll  scroll this document (j/k/d/u/gg/G)
//   viz → app   lb:theme?  ask for the app's light/dark theme on load
//   app → viz   lb:theme   the theme, on load and whenever it's toggled
// Keys go to window.top so a viz nested inside a presentation still reaches
// the app; the app replies to the exact window that sent the key.
//
// The theme lands as <html data-theme="light|dark">. A viz opts in by keying
// its colors off that attribute (with prefers-color-scheme as the fallback for
// when it's opened on its own); one that ignores it is unaffected.
(function () {
  if (window.top === window || window.__lbBridge) return;
  window.__lbBridge = true;

  // Only the app may frame vizzes (frame-ancestors), so window.top is the app.
  window.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key.length !== 1 && e.key !== 'Escape') return;
    window.top.postMessage({ type: 'lb:key', key: e.key, shiftKey: e.shiftKey }, '*');
  });

  window.addEventListener('message', function (e) {
    if (e.source !== window.top || !e.data) return;
    if (e.data.type === 'lb:theme') {
      if (e.data.theme !== 'light' && e.data.theme !== 'dark') return;
      document.documentElement.setAttribute('data-theme', e.data.theme);
      document.documentElement.style.colorScheme = e.data.theme;
      return;
    }
    if (e.data.type !== 'lb:scroll') return;
    var el = document.scrollingElement || document.documentElement;
    var behavior = 'smooth';
    if (e.data.to === 'top') el.scrollTo({ top: 0, behavior: behavior });
    else if (e.data.to === 'bottom') el.scrollTo({ top: el.scrollHeight, behavior: behavior });
    else if (typeof e.data.by === 'number') el.scrollBy({ top: e.data.by, behavior: behavior });
  });

  window.top.postMessage({ type: 'lb:theme?' }, '*');
})();
