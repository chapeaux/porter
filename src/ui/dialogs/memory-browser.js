/**
 * Memory Browser dialog — view, search, and edit a running session's
 * memory (local + durable) in real time.
 */

import { h, replaceContent } from '../dom.js';
import { getDlg } from './dialog-helpers.js';

const MEMORY_TYPES = ['semantic', 'episodic', 'procedural'];
const REFRESH_MS = 6000;

function escapeSparqlLiteral(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Build the structured-filter SPARQL query for the browse (non-search) view. */
function buildBrowseQuery(filters) {
  const graph = filters.scope === 'durable'
    ? 'https://porter.chapeaux.io/vocab#graph/durable'
    : 'https://porter.chapeaux.io/vocab#graph/memory';

  const clauses = [];
  if (filters.type) clauses.push(`FILTER(?memoryType = "${escapeSparqlLiteral(filters.type)}")`);
  if (filters.agent) clauses.push(`FILTER(CONTAINS(LCASE(STR(?discoveredBy)), "${escapeSparqlLiteral(filters.agent.toLowerCase())}"))`);
  if (filters.about) clauses.push(`FILTER(CONTAINS(LCASE(?about), "${escapeSparqlLiteral(filters.about.toLowerCase())}"))`);

  return `SELECT ?id ?about ?finding ?memoryType ?discoveredBy ?time ?validUntil WHERE {
  GRAPH <${graph}> {
    ?id porter:about ?about ;
        porter:finding ?finding .
    BIND(REPLACE(STR(?id), "^.*[/#]", "") AS ?idShort)
    OPTIONAL { ?id porter:memoryType ?memoryType }
    OPTIONAL { ?id porter:discoveredBy ?discoveredBy }
    OPTIONAL { ?id porter:validUntil ?validUntil }
    OPTIONAL { ?id <http://www.w3.org/ns/prov#generatedAtTime> ?time }
    ${clauses.join('\n    ')}
  }
} ORDER BY DESC(?time) LIMIT 100`;
}

function shortId(uri) {
  return uri.split(/[/#]/).pop();
}

function agentName(uri) {
  if (!uri) return '';
  return decodeURIComponent(shortId(uri));
}

async function fetchBrowse(session, filters) {
  const query = buildBrowseQuery(filters);
  const resp = await fetch(`/api/sessions/${encodeURIComponent(session)}/sparql?query=${encodeURIComponent(query)}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.results || []).map((r) => ({
    id: shortId(r.id),
    about: r.about,
    finding: r.finding,
    memoryType: r.memoryType || '',
    discoveredBy: agentName(r.discoveredBy),
    time: r.time || '',
    superseded: !!r.validUntil,
  }));
}

async function fetchSearch(session, q, filters) {
  const params = new URLSearchParams({ q, limit: '25' });
  if (filters.type) params.set('type', filters.type);
  if (filters.scope) params.set('scope', filters.scope);
  const resp = await fetch(`/api/sessions/${encodeURIComponent(session)}/memory/search?${params}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.results || []).map((r) => ({
    id: null, // vector results aren't directly editable by id today
    about: r.payload?.about || '',
    finding: r.payload?.finding ?? r.payload?.issue ?? '',
    memoryType: r.payload?.memoryType || '',
    discoveredBy: r.payload?.discoveredBy || '',
    score: r.score,
  }));
}

function renderRow(entry, session, filters, onChange) {
  const cellStyle = 'padding:0.4rem;vertical-align:top';
  const typeBadge = entry.memoryType
    ? h('span', { class: 'context-badge', style: 'font-size:0.65rem' }, entry.memoryType)
    : '';
  const supersededBadge = entry.superseded
    ? h('span', { style: 'color:var(--text-dim);font-size:0.7rem;margin-left:0.3rem' }, '(superseded)')
    : '';

  const actions = [];
  if (entry.id) {
    const editBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.7rem;padding:0.1rem 0.4rem' }, 'Edit');
    editBtn.addEventListener('click', async () => {
      const next = prompt('New text for this memory:', entry.finding);
      if (next === null || next === entry.finding) return;
      const resp = await fetch(
        `/api/sessions/${encodeURIComponent(session)}/memory/entries/${encodeURIComponent(entry.id)}?scope=${filters.scope}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: next, scope: filters.scope }) },
      );
      if (resp.ok) onChange();
      else alert('Failed to update entry');
    });
    actions.push(editBtn);

    const deleteBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.7rem;padding:0.1rem 0.4rem;color:var(--status-error)' }, 'Delete');
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete this ${filters.scope} memory entry?`)) return;
      const resp = await fetch(
        `/api/sessions/${encodeURIComponent(session)}/memory/entries/${encodeURIComponent(entry.id)}?scope=${filters.scope}`,
        { method: 'DELETE' },
      );
      if (resp.ok) onChange();
      else alert('Failed to delete entry');
    });
    actions.push(deleteBtn);

    if (filters.scope === 'durable' && entry.memoryType === 'semantic') {
      const supersedeBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.7rem;padding:0.1rem 0.4rem' }, 'Supersede');
      supersedeBtn.addEventListener('click', async () => {
        const next = prompt(`Replacement text for "${entry.about}":`, entry.finding);
        if (!next) return;
        const createResp = await fetch(`/api/sessions/${encodeURIComponent(session)}/memory/entries`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ about: entry.about, finding: next, memoryType: 'semantic', scope: 'durable' }),
        });
        if (createResp.ok) {
          await fetch(
            `/api/sessions/${encodeURIComponent(session)}/memory/entries/${encodeURIComponent(entry.id)}?scope=durable`,
            { method: 'DELETE' },
          );
          onChange();
        } else {
          alert('Failed to supersede entry');
        }
      });
      actions.push(supersedeBtn);
    }
  }

  return h('tr', { style: 'border-bottom:1px solid var(--border)' },
    h('td', { style: cellStyle }, entry.about, supersededBadge),
    h('td', { style: cellStyle }, entry.finding, ' ', typeBadge),
    h('td', { style: cellStyle }, entry.discoveredBy || (entry.score !== undefined ? `score ${entry.score.toFixed(2)}` : '')),
    h('td', { style: cellStyle }, ...actions),
  );
}

function renderTable(entries, session, filters, onChange) {
  if (entries.length === 0) {
    return h('p', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'No memory entries found.');
  }
  return h('table', { style: 'width:100%;border-collapse:collapse;font-size:0.8rem' },
    h('thead', null,
      h('tr', { style: 'border-bottom:1px solid var(--border);color:var(--accent-gold);text-align:left' },
        h('th', { style: 'padding:0.4rem' }, 'About'),
        h('th', { style: 'padding:0.4rem' }, 'Finding'),
        h('th', { style: 'padding:0.4rem' }, 'By'),
        h('th', { style: 'padding:0.4rem' }, 'Actions'),
      ),
    ),
    h('tbody', null, ...entries.map((e) => renderRow(e, session, filters, onChange))),
  );
}

export function showMemoryBrowser() {
  const projectStore = document.getElementById('projects');
  const session = projectStore?.state?.activeSession;
  if (!session) {
    alert('No active session. Launch a team first.');
    return;
  }

  const filters = { scope: 'local', type: '', agent: '', about: '', searchQuery: '' };
  let pollHandle = null;

  const dlg = getDlg();
  dlg.openTemplate('tpl-detail', {
    title: `Memory: ${session}`,
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#dialog-body');

      const scopeSelect = h('select', {},
        h('option', { value: 'local', selected: true }, 'Local (this session)'),
        h('option', { value: 'durable' }, 'Durable (cross-session)'),
      );
      const typeSelect = h('select', {},
        h('option', { value: '' }, 'All types'),
        ...MEMORY_TYPES.map((t) => h('option', { value: t }, t)),
      );
      const agentInput = h('input', { type: 'text', placeholder: 'Filter by agent...', style: 'width:8rem' });
      const searchInput = h('input', { type: 'text', placeholder: 'Semantic search...', style: 'width:10rem' });
      const advancedToggle = h('input', { type: 'checkbox', id: 'mem-advanced-toggle' });
      const addBtn = h('button', { class: 'team-btn primary', style: 'font-size:0.75rem' }, '+ New Entry');

      const controls = h('div', { style: 'display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem' },
        scopeSelect, typeSelect, agentInput, searchInput,
        h('label', { style: 'font-size:0.75rem;display:flex;align-items:center;gap:0.25rem' }, advancedToggle, 'Advanced SPARQL'),
        addBtn,
      );

      const advancedBox = h('div', { style: 'display:none;margin-bottom:0.75rem' },
        h('textarea', {
          id: 'mem-advanced-query', rows: '4', style: 'width:100%;font-family:monospace;font-size:0.75rem',
          placeholder: 'SELECT ?id ?about ?finding WHERE { GRAPH <https://porter.chapeaux.io/vocab#graph/memory> { ?id porter:about ?about ; porter:finding ?finding } }',
        }),
      );
      const runAdvancedBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.75rem;margin-top:0.3rem' }, 'Run Query');
      advancedBox.appendChild(runAdvancedBtn);

      const resultsEl = h('div', {}, h('p', { style: 'color:var(--text-dim)' }, 'Loading...'));

      replaceContent(body, controls, advancedBox, resultsEl);

      async function refresh() {
        try {
          let entries;
          if (filters.searchQuery) {
            entries = await fetchSearch(session, filters.searchQuery, filters);
          } else {
            entries = await fetchBrowse(session, filters);
          }
          replaceContent(resultsEl, renderTable(entries, session, filters, refresh));
        } catch {
          replaceContent(resultsEl, h('p', { style: 'color:var(--status-error)' }, 'Failed to load memory — is the session still running?'));
        }
      }

      scopeSelect.addEventListener('change', () => { filters.scope = scopeSelect.value; refresh(); });
      typeSelect.addEventListener('change', () => { filters.type = typeSelect.value; refresh(); });
      agentInput.addEventListener('input', () => { filters.agent = agentInput.value.trim(); refresh(); });
      searchInput.addEventListener('input', () => { filters.searchQuery = searchInput.value.trim(); refresh(); });
      advancedToggle.addEventListener('change', () => {
        advancedBox.style.display = advancedToggle.checked ? '' : 'none';
      });
      runAdvancedBtn.addEventListener('click', async () => {
        const query = advancedBox.querySelector('#mem-advanced-query').value.trim();
        if (!query) return;
        try {
          const resp = await fetch(`/api/sessions/${encodeURIComponent(session)}/sparql?query=${encodeURIComponent(query)}`);
          const data = await resp.json();
          if (!resp.ok) { replaceContent(resultsEl, h('p', { style: 'color:var(--status-error)' }, data.error || 'Query failed')); return; }
          const rows = data.results || [];
          if (rows.length === 0) { replaceContent(resultsEl, h('p', { style: 'color:var(--text-dim)' }, 'No results.')); return; }
          const headers = Object.keys(rows[0]);
          replaceContent(resultsEl, h('table', { style: 'width:100%;border-collapse:collapse;font-size:0.8rem' },
            h('thead', null, h('tr', null, ...headers.map((k) => h('th', { style: 'text-align:left;padding:0.3rem' }, k)))),
            h('tbody', null, ...rows.map((r) => h('tr', { style: 'border-bottom:1px solid var(--border)' },
              ...headers.map((k) => h('td', { style: 'padding:0.3rem' }, String(r[k] ?? '')))
            ))),
          ));
        } catch {
          replaceContent(resultsEl, h('p', { style: 'color:var(--status-error)' }, 'Query failed'));
        }
      });

      addBtn.addEventListener('click', async () => {
        const about = prompt('What is this memory about?');
        if (!about) return;
        const finding = prompt('What should be remembered?');
        if (!finding) return;
        const type = prompt(`Type (${MEMORY_TYPES.join('/')}):`, 'semantic');
        const resp = await fetch(`/api/sessions/${encodeURIComponent(session)}/memory/entries`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ about, finding, memoryType: type, scope: filters.scope }),
        });
        if (resp.ok) refresh();
        else alert('Failed to save entry');
      });

      refresh();
      pollHandle = setInterval(refresh, REFRESH_MS);
    },
    onClose: () => {
      if (pollHandle) clearInterval(pollHandle);
    },
  });
}
