/**
 * Pattern Manager dialog -- view, download, upload, and duplicate collaboration patterns.
 */

import { h, replaceContent } from '../dom.js';
import { getDlg, showDialog } from './dialog-helpers.js';
import { updateSetupBar } from '../features/flipboard-setup.js';
import { renderBusFlow } from '../render/flow-diagram.js';
import { openPatternEditor } from './pattern-editor.js';

/**
 * Build a human-readable role summary from a pattern definition.
 * Mirrors getCompositionSummary logic from the server.
 */
function compositionSummary(pattern) {
  return (pattern.roles || [])
    .map(r => {
      if (r.min === r.max) return `${r.min} ${r.name}${r.min > 1 ? 's' : ''}`;
      if (r.min === 0) return `up to ${r.max} ${r.name}${r.max > 1 ? 's' : ''} (optional)`;
      return `${r.min}-${r.max} ${r.name}${r.max > 1 ? 's' : ''}`;
    })
    .join(' + ');
}

/**
 * Render the pattern list cards into the body container.
 */
function renderPatternCards(body, patterns) {
  if (!patterns || patterns.length === 0) {
    replaceContent(body, h('p', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'No patterns available.'));
    return;
  }

  const cards = patterns.map(p => {
    const isBuiltin = p.builtin !== false;
    const badge = h('span', {
      class: 'context-badge',
      style: isBuiltin
        ? 'background:rgba(106,173,116,0.2);color:var(--status-ok)'
        : 'background:rgba(201,168,76,0.2);color:var(--accent-gold)',
    }, isBuiltin ? 'Built-in' : 'Custom');

    const summary = compositionSummary(p);

    // Action buttons
    const viewBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.75rem;padding:0.15rem 0.5rem' }, 'View');
    const downloadBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.75rem;padding:0.15rem 0.5rem' }, 'Download');

    viewBtn.addEventListener('click', () => {
      openPatternEditor(p, true);
    });

    downloadBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${p.id}.json`;
      a.click();
    });

    const actionBtns = [viewBtn, downloadBtn];

    if (isBuiltin) {
      const dupBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.75rem;padding:0.15rem 0.5rem' }, 'Duplicate');
      dupBtn.addEventListener('click', () => handleDuplicate(p, body));
      actionBtns.push(dupBtn);
    } else {
      const editBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.75rem;padding:0.15rem 0.5rem' }, 'Edit');
      editBtn.addEventListener('click', () => {
        openPatternEditor(p, false);
      });

      const deleteBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.75rem;padding:0.15rem 0.5rem;color:var(--status-error)' }, 'Delete');
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete custom pattern "${p.name}"?`)) return;
        deleteBtn.disabled = true;
        try {
          const resp = await fetch(`/api/patterns/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
          if (resp.ok) {
            await refreshPatterns(body);
            updateSetupBar();
          } else {
            deleteBtn.textContent = 'Failed';
            setTimeout(() => { deleteBtn.textContent = 'Delete'; deleteBtn.disabled = false; }, 2000);
          }
        } catch {
          deleteBtn.textContent = 'Error';
          setTimeout(() => { deleteBtn.textContent = 'Delete'; deleteBtn.disabled = false; }, 2000);
        }
      });

      actionBtns.push(editBtn, deleteBtn);
    }

    return h('div', { class: 'dialog-card' },
      h('div', { class: 'dialog-card-header' },
        h('strong', null, p.name),
        badge,
      ),
      h('div', { class: 'dialog-card-meta' }, p.description || ''),
      h('div', { class: 'dialog-card-summary' }, summary),
      p.bus_flow ? renderBusFlow(p.bus_flow, { compact: true }) : null,
      h('div', { class: 'dialog-card-actions' }, ...actionBtns),
    );
  });

  replaceContent(body, ...cards);
}

/**
 * Fetch patterns from the API and re-render.
 */
async function refreshPatterns(body) {
  try {
    const resp = await fetch('/api/patterns');
    if (resp.ok) {
      const data = await resp.json();
      renderPatternCards(body, data.patterns || []);
    } else {
      replaceContent(body, h('p', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'Failed to load patterns.'));
    }
  } catch {
    replaceContent(body, h('p', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'Could not connect to server.'));
  }
}

/**
 * Handle duplicating a built-in pattern.
 */
function handleDuplicate(pattern, body) {
  const newName = prompt('Name for the duplicated pattern:', `${pattern.name} (copy)`);
  if (!newName) return;
  const newId = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!newId) { alert('Invalid pattern name'); return; }

  const copy = { ...pattern, id: newId, name: newName, builtin: false };
  delete copy._original;

  fetch('/api/patterns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(copy),
  }).then(resp => {
    if (resp.ok) {
      refreshPatterns(body);
      updateSetupBar();
    } else {
      resp.json().then(d => alert(d.error || 'Failed to save pattern')).catch(() => alert('Failed to save pattern'));
    }
  }).catch(() => alert('Failed to save pattern'));
}

/**
 * Handle uploading a pattern JSON file.
 */
function handleUpload(body) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const pattern = JSON.parse(reader.result);
        // Validate required fields
        if (!pattern.id || !pattern.name || !Array.isArray(pattern.roles)) {
          alert('Invalid pattern: must have id, name, and roles array');
          return;
        }
        pattern.builtin = false;

        const resp = await fetch('/api/patterns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pattern),
        });
        if (resp.ok) {
          refreshPatterns(body);
          updateSetupBar();
        } else {
          const d = await resp.json().catch(() => ({}));
          alert(d.error || 'Failed to upload pattern');
        }
      } catch (e) {
        alert(`Failed to parse JSON: ${e.message}`);
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

/**
 * Open the Pattern Manager dialog.
 */
export function showPatternsDialog() {
  const dlg = getDlg();
  dlg.openTemplate('tpl-pattern-manager', {
    title: 'Patterns',
    id: 'pattern-manager-dialog',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#pattern-manager-body');
      const closeBtn = dlg.footerEl.querySelector('#pattern-manager-close');
      const uploadBtn = dlg.footerEl.querySelector('#pattern-manager-upload');

      closeBtn?.addEventListener('click', () => dlg.close());
      if (uploadBtn) uploadBtn.style.display = 'none';

      // Header buttons
      const newBtn = h('button', { class: 'dialog-header-add' }, '+ New Pattern');
      const uploadHeaderBtn = h('button', { class: 'dialog-header-add' }, 'Upload');
      newBtn.addEventListener('click', () => openPatternEditor(null, false));
      uploadHeaderBtn.addEventListener('click', () => handleUpload(body));
      dlg.headerExtra.replaceChildren(uploadHeaderBtn, newBtn);

      replaceContent(body, h('p', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'Loading patterns...'));
      refreshPatterns(body);
    },
  });
}
