/**
 * Mira dashboard data layer — vanilla JS, no dependencies.
 *
 * window.mira  is the single entry-point:
 *   .base        base URL of the local mira API
 *   .live        true once the API has been confirmed reachable
 *   .fetchJSON(path, fallback)  — fetch with 600 ms timeout, returns fallback on any error
 *
 * On DOMContentLoaded the layer pings /status.  If the API responds it sets
 * mira.live = true, unhides #mira-live in the header, and fires a
 * 'mira:live' CustomEvent on document (detail = /status payload) so screens
 * can react without polling.  If the API is down nothing changes and the
 * dashboard continues to show its hardcoded fixtures.
 */
(function () {
  'use strict';

  var BASE = 'http://127.0.0.1:8770';

  window.mira = {
    base: BASE,
    live: false,

    fetchJSON: async function (path, fallback) {
      try {
        var ctrl  = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 600);
        var r = await fetch(BASE + path, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) throw 0;
        return await r.json();
      } catch (e) {
        return fallback;
      }
    },

    // POST an action (e.g. engine start/stop). Longer timeout: spawning is slow.
    postJSON: async function (path, timeoutMs) {
      try {
        var ctrl  = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 35000);
        var r = await fetch(BASE + path, { method: 'POST', signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) throw 0;
        return await r.json();
      } catch (e) {
        return { ok: false, reason: 'unreachable' };
      }
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    mira.fetchJSON('/status', null).then(function (data) {
      if (!data) return;          // API unreachable — stay on fixtures silently
      mira.live = true;
      var badge = document.getElementById('mira-live');
      if (badge) badge.removeAttribute('hidden');
      document.dispatchEvent(new CustomEvent('mira:live', { detail: data }));
    });
  });
}());
