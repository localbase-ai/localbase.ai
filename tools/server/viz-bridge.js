// Injected into every viz page the operator server serves (see app-server.js).
//
// Vizzes are served from the API origin (:9220), not the app's (:9221), so a
// viz — AI-written, rendering data outsiders can influence — cannot reach into
// the app's page. That also means the app can no longer reach into the viz to
// read its keystrokes or scroll it, which is how the vim keys used to work.
// This bridge restores both directions over postMessage:
//   viz → app   lb:key     a key the viz didn't claim, for the app's handler
//   app → viz   lb:scroll  scroll this document (j/k/d/u/gg/G)
// Keys go to window.top so a viz nested inside a presentation still reaches
// the app; the app replies to the exact window that sent the key.
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
    if (e.source !== window.top || !e.data || e.data.type !== 'lb:scroll') return;
    var el = document.scrollingElement || document.documentElement;
    var behavior = 'smooth';
    if (e.data.to === 'top') el.scrollTo({ top: 0, behavior: behavior });
    else if (e.data.to === 'bottom') el.scrollTo({ top: el.scrollHeight, behavior: behavior });
    else if (typeof e.data.by === 'number') el.scrollBy({ top: e.data.by, behavior: behavior });
  });
})();
