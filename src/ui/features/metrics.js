/**
 * Metrics — token usage, API call counts, error tracking.
 */

import { getDlg } from '../dialogs/dialog-helpers.js';
import { h } from '../dom.js';

let _metricsTimer = null;

export function startMetricsPolling() {
  stopMetricsPolling();
  document.getElementById('metrics-bar')?.classList.remove('hidden');
  updateMetrics();
  _metricsTimer = setInterval(updateMetrics, 10000);
}

export function stopMetricsPolling() {
  if (_metricsTimer) { clearInterval(_metricsTimer); _metricsTimer = null; }
}

export async function updateMetrics() {
  const projectStore = document.getElementById('projects');
  const session = projectStore?.state?.activeSession;
  if (!session) {
    document.getElementById('m-tokens-in').textContent = 'IN: --';
    document.getElementById('m-tokens-out').textContent = 'OUT: --';
    document.getElementById('m-api-calls').textContent = 'API: --';
    document.getElementById('m-errors').textContent = 'ERR: --';
    document.getElementById('m-rate-limits').textContent = 'LIMITS: --';
    return;
  }
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
    document.getElementById('m-tokens-in').textContent = `IN: ${formatTokenCount(totalIn)}`;
    document.getElementById('m-tokens-out').textContent = `OUT: ${formatTokenCount(totalOut)}`;
    document.getElementById('m-api-calls').textContent = `API: ${totalApi}`;
    document.getElementById('m-errors').textContent = `ERR: ${totalErr}`;
    document.getElementById('m-rate-limits').textContent = `LIMITS: ${data.rate_limit_hits || 0}`;
  } catch { /* metrics are best-effort */ }
}

export function formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

export function showMetricsDetail() {
  const projectStore = document.getElementById('projects');
  const session = projectStore?.state?.activeSession;
  if (!session) return;

  const dlg = getDlg();
  dlg.openTemplate('tpl-detail', {
    title: `Metrics: ${session}`,
    onOpen: async () => {
      const body = dlg.bodyEl.querySelector('#dialog-body');
      body.replaceChildren(h('p', { style: 'color:var(--text-dim)' }, 'Loading...'));
      try {
        const resp = await fetch(`/api/sessions/${encodeURIComponent(session)}/metrics`);
        if (!resp.ok) { body.replaceChildren(h('p', null, 'Failed to load metrics')); return; }
        const data = await resp.json();
        const agents = Object.entries(data.agents || {});
        if (agents.length === 0) { body.replaceChildren(h('p', { style: 'color:var(--text-dim)' }, 'No agent data yet')); return; }

        const cellStyle = 'padding:0.4rem';
        const rowStyle = 'border-bottom:1px solid var(--border)';
        const rows = agents.map(([name, m]) =>
          h('tr', { style: rowStyle },
            h('td', { style: cellStyle }, name),
            h('td', { style: cellStyle }, formatTokenCount(m.input_tokens || 0)),
            h('td', { style: cellStyle }, formatTokenCount(m.output_tokens || 0)),
            h('td', { style: cellStyle }, String(m.api_calls || 0)),
            h('td', { style: cellStyle }, String(m.tool_calls || 0)),
            h('td', { style: cellStyle }, String(m.errors || 0))
          )
        );

        const table = h('table', { style: 'width:100%;border-collapse:collapse;font-size:0.8rem' },
          h('thead', null,
            h('tr', { style: 'border-bottom:1px solid var(--border);color:var(--accent-gold);text-align:left' },
              h('th', { style: cellStyle }, 'Agent'),
              h('th', { style: cellStyle }, 'In'),
              h('th', { style: cellStyle }, 'Out'),
              h('th', { style: cellStyle }, 'API'),
              h('th', { style: cellStyle }, 'Tools'),
              h('th', { style: cellStyle }, 'Errors')
            )
          ),
          h('tbody', null, ...rows)
        );

        const summary = h('p', { style: 'margin-top:0.75rem;font-size:0.75rem;color:var(--text-dim)' },
          `Total messages: ${data.total_messages || 0} · Rate limits: ${data.rate_limit_hits || 0}`
        );

        body.replaceChildren(table, summary);
      } catch (e) { body.replaceChildren(h('p', null, `Error: ${e.message}`)); }
    },
  });
}
