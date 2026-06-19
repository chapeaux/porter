const CACHE_NAME = 'porter-v8';
const PRECACHE_URLS = [
  '/',
  '/app.js',
  '/porter.css',
  '/porter.svg',
  '/manifest.json',
  '/cpx-store.js',
  '/cpx-model-config.js',
  '/solid-auth.js',
  '/porter-dialog.js',
  '/flipboard.js',
  '/constants.js',
  '/dom.js',
  '/porter-192.png',
  '/porter-512.png',
  '/stores/runtime-stores.js',
  '/stores/project-store.js',
  '/stores/config-store.js',
  '/stores/model-store.js',
  '/sync/pod-sync.js',
  '/sync/sync-helpers.js',
  '/connection/bus-client.js',
  '/render/connection-status.js',
  '/render/agent-deck.js',
  '/render/timeline.js',
  '/render/filters.js',
  '/render/compose.js',
  '/dialogs/dialog-helpers.js',
  '/dialogs/team-builder.js',
  '/dialogs/agent-editor.js',
  '/dialogs/agent-library.js',
  '/dialogs/model-setup.js',
  '/dialogs/mcp-editor.js',
  '/dialogs/session-launcher.js',
  '/features/empty-state.js',
  '/features/auth-state.js',
  '/features/flipboard-setup.js',
  '/features/metrics.js',
  '/features/project-switcher.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('porter-') && k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (event.request.headers.get('upgrade') === 'websocket') return;

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(event.request).then(r => r || new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } })))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        fetch(event.request).then(resp => {
          if (resp.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, resp));
        }).catch(() => {});
        return cached;
      }
      return fetch(event.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

let metricsTimer = null;
let sessionsTimer = null;

self.addEventListener('message', (event) => {
  const { type, session } = event.data || {};

  switch (type) {
    case 'start-metrics':
      if (metricsTimer) clearInterval(metricsTimer);
      metricsTimer = setInterval(() => pollMetrics(session), 10000);
      pollMetrics(session);
      break;
    case 'stop-metrics':
      if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
      break;
    case 'start-sessions':
      if (sessionsTimer) clearInterval(sessionsTimer);
      sessionsTimer = setInterval(pollSessions, 15000);
      break;
    case 'stop-sessions':
      if (sessionsTimer) { clearInterval(sessionsTimer); sessionsTimer = null; }
      break;
    case 'skip-waiting':
      self.skipWaiting();
      break;
  }
});

async function pollMetrics(session) {
  if (!session) return;
  try {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(session)}/metrics`);
    if (!resp.ok) return;
    const data = await resp.json();
    let totalIn = 0, totalOut = 0, totalApi = 0, totalErr = 0;
    for (const a of Object.values(data.agents || {})) {
      totalIn += a.input_tokens || 0;
      totalOut += a.output_tokens || 0;
      totalApi += a.api_calls || 0;
      totalErr += a.errors || 0;
    }
    broadcast({ type: 'metrics', data: { totalIn, totalOut, totalApi, totalErr, rateLimits: data.rate_limit_hits || 0, agents: data.agents } });
  } catch { /* best-effort */ }
}

async function pollSessions() {
  try {
    const resp = await fetch('/api/sessions');
    if (!resp.ok) return;
    const data = await resp.json();
    broadcast({ type: 'sessions', data });
  } catch { /* best-effort */ }
}

function broadcast(msg) {
  self.clients.matchAll().then(clients => {
    for (const client of clients) {
      client.postMessage(msg);
    }
  });
}
