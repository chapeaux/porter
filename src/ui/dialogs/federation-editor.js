/**
 * ActivityPub federation management dialog.
 *
 * Main view: card list of published teams with per-team toggles.
 * Configure overlay: server-level settings (domain, approval, allowlist).
 * Team detail overlay: followers for a single team.
 */

import { h, replaceContent } from '../dom.js';
import { getDlg, getOverlayDlg } from './dialog-helpers.js';
import { updateSetupBar } from '../features/flipboard-setup.js';
import { syncPublishedTeamsToPod } from '../sync/sync-helpers.js';

export function showFederationDialog() {
  const dlg = getDlg();
  dlg.openTemplate('tpl-federation-editor', {
    title: 'Federation',
    id: 'federation-dialog',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#federation-editor-body');
      const saveBtn = dlg.footerEl.querySelector('#federation-save');
      const cancelBtn = dlg.footerEl.querySelector('#federation-cancel');
      loadAndRender(body, saveBtn, cancelBtn, dlg);
    },
  });
}

async function loadAndRender(body, saveBtn, cancelBtn, dlg) {
  let config = {};
  try {
    const res = await fetch('/api/activitypub/config');
    if (res.ok) config = await res.json();
  } catch { /* defaults */ }

  // Footer: Close only (actions are immediate)
  saveBtn.style.display = 'none';
  cancelBtn.textContent = 'Close';
  cancelBtn.onclick = () => dlg.close();

  // Global toggle
  const enabledCheck = h('input', { type: 'checkbox', checked: config.enabled ?? false });
  enabledCheck.addEventListener('change', async () => {
    enabledCheck.disabled = true;
    config.enabled = enabledCheck.checked;
    await fetch('/api/activitypub/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    enabledCheck.disabled = false;
    updateSetupBar();
  });

  const configureBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.8rem;padding:0.2rem 0.6rem' }, 'Configure');
  configureBtn.addEventListener('click', () => {
    showServerConfigOverlay(config, (updated) => {
      config = updated;
      updateSetupBar();
    });
  });

  const headerRow = h('div', { style: 'display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem' },
    h('label', { class: 'inline-check', style: 'flex:1' }, enabledCheck, ' Federation Enabled'),
    configureBtn,
  );

  // Team cards container
  const teamsContainer = h('div');

  // Publish button
  const publishBtn = h('button', { class: 'team-btn primary', style: 'margin-top:0.75rem' }, '+ Publish Team');
  publishBtn.addEventListener('click', () => showPublishPicker(publishBtn, teamsContainer));

  replaceContent(body, headerRow, teamsContainer, publishBtn);

  await renderTeamCards(teamsContainer);
}

async function renderTeamCards(container) {
  let teams = [];
  try {
    const res = await fetch('/api/activitypub/teams?all=true');
    if (res.ok) { const data = await res.json(); teams = data.teams || []; }
  } catch { /* empty */ }

  if (teams.length === 0) {
    replaceContent(container, h('p', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'No published teams.'));
    return;
  }

  const cards = teams.map(team => {
    const slug = team.teamSlug || team.name;

    const toggle = h('input', { type: 'checkbox', checked: team.enabled !== false });
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      await fetch('/api/activitypub/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamSlug: slug, enabled: toggle.checked }),
      });
      toggle.disabled = false;
      syncPublishedTeamsToPod();
    });

    const editBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.75rem;padding:0.15rem 0.5rem' }, 'Followers');
    editBtn.addEventListener('click', () => showTeamDetailOverlay(slug));

    const unpubBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.75rem;padding:0.15rem 0.5rem' }, 'Unpublish');
    unpubBtn.addEventListener('click', async () => {
      unpubBtn.disabled = true;
      try {
        await fetch('/api/activitypub/unpublish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamSlug: slug }),
        });
      } catch { /* ignore */ }
      await renderTeamCards(container);
      syncPublishedTeamsToPod();
    });

    return h('div', { class: 'mcp-server-card', style: 'margin-bottom:0.5rem' },
      h('span', { class: 'mcp-name', style: 'flex:1' }, slug),
      h('label', { class: 'inline-check', style: 'font-size:0.8rem;margin-right:0.5rem' }, toggle, ' enabled'),
      editBtn,
      unpubBtn,
    );
  });

  replaceContent(container, ...cards);
}

async function showPublishPicker(publishBtn, teamsContainer) {
  let allTeams = [];
  try {
    const res = await fetch('/api/teams');
    if (res.ok) { const data = await res.json(); allTeams = data.teams || []; }
  } catch { /* empty */ }

  if (allTeams.length === 0) return;

  const picker = h('select', { style: 'margin-left:0.5rem' },
    h('option', { value: '' }, '-- select team --'),
    ...allTeams.map(t => h('option', { value: t.slug || t.name }, t.name || t.slug)),
  );
  const confirmBtn = h('button', { class: 'team-btn primary', style: 'margin-left:0.5rem;font-size:0.75rem;padding:0.15rem 0.5rem' }, 'Confirm');
  const cancelPick = h('button', { class: 'team-btn secondary', style: 'margin-left:0.3rem;font-size:0.75rem;padding:0.15rem 0.5rem' }, 'Cancel');

  const row = h('div', { style: 'display:flex;align-items:center;margin-top:0.5rem' }, picker, confirmBtn, cancelPick);
  publishBtn.after(row);
  publishBtn.style.display = 'none';

  cancelPick.addEventListener('click', () => {
    row.remove();
    publishBtn.style.display = '';
  });

  confirmBtn.addEventListener('click', async () => {
    const val = picker.value;
    if (!val) return;
    confirmBtn.disabled = true;
    try {
      await fetch('/api/activitypub/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamSlug: val }),
      });
    } catch { /* ignore */ }
    row.remove();
    publishBtn.style.display = '';
    await renderTeamCards(teamsContainer);
    syncPublishedTeamsToPod();
  });
}

function showServerConfigOverlay(config, onSave) {
  const dlg = getOverlayDlg();
  dlg.openTemplate('tpl-federation-editor', {
    title: 'Federation Settings',
    id: 'federation-config-dialog',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#federation-editor-body');
      const saveBtn = dlg.footerEl.querySelector('#federation-save');
      const cancelBtn = dlg.footerEl.querySelector('#federation-cancel');

      const state = {
        enabled: config.enabled ?? false,
        domain: config.domain ?? '',
        approval_mode: config.approval_mode ?? 'manual',
        public_summaries: config.public_summaries ?? false,
        max_sessions_per_follower: config.max_sessions_per_follower ?? 1,
        allowlist: [...(config.allowlist || [])],
      };

      const domainInput = h('input', { type: 'text', value: state.domain, placeholder: 'porter.example.com' });
      domainInput.addEventListener('input', () => { state.domain = domainInput.value.trim(); });

      const approvalSelect = h('select', null,
        h('option', { value: 'open', selected: state.approval_mode === 'open' }, 'open'),
        h('option', { value: 'allowlist', selected: state.approval_mode === 'allowlist' }, 'allowlist'),
        h('option', { value: 'manual', selected: state.approval_mode === 'manual' }, 'manual'),
      );

      const publicSummariesCheck = h('input', { type: 'checkbox', checked: state.public_summaries });
      publicSummariesCheck.addEventListener('change', () => { state.public_summaries = publicSummariesCheck.checked; });

      const maxSessionsInput = h('input', { type: 'number', value: String(state.max_sessions_per_follower), min: '1' });
      maxSessionsInput.addEventListener('input', () => {
        state.max_sessions_per_follower = parseInt(maxSessionsInput.value, 10) || 1;
      });

      // Allowlist
      const allowlistContainer = h('div', { style: 'margin-bottom:0.5rem' });
      const allowlistInput = h('input', { type: 'text', placeholder: '@user@domain or domain.example' });
      const allowlistAddBtn = h('button', { class: 'team-btn primary', style: 'margin-left:0.5rem' }, 'Add');

      function renderAllowlist() {
        if (state.allowlist.length === 0) {
          replaceContent(allowlistContainer, h('p', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'No entries.'));
          return;
        }
        const items = state.allowlist.map((entry, i) => {
          const removeBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.75rem;padding:0.15rem 0.5rem;margin-left:auto' }, 'Remove');
          removeBtn.addEventListener('click', () => {
            state.allowlist.splice(i, 1);
            renderAllowlist();
          });
          return h('div', { class: 'mcp-server-card' },
            h('span', { style: 'flex:1' }, entry),
            removeBtn,
          );
        });
        replaceContent(allowlistContainer, ...items);
      }

      allowlistAddBtn.addEventListener('click', () => {
        const val = allowlistInput.value.trim();
        if (!val) return;
        if (!state.allowlist.includes(val)) {
          state.allowlist.push(val);
          renderAllowlist();
        }
        allowlistInput.value = '';
      });

      renderAllowlist();

      const allowlistSection = h('div', null,
        h('h3', { style: 'color:var(--accent-gold);font-size:0.95rem;margin-bottom:0.75rem;margin-top:1.25rem' }, 'Allowlist'),
        allowlistContainer,
        h('div', { style: 'display:flex;align-items:center' }, allowlistInput, allowlistAddBtn),
      );

      function updateAllowlistVisibility() {
        allowlistSection.style.display = approvalSelect.value === 'allowlist' ? '' : 'none';
      }
      approvalSelect.addEventListener('change', () => {
        state.approval_mode = approvalSelect.value;
        updateAllowlistVisibility();
      });
      updateAllowlistVisibility();

      replaceContent(body,
        h('div', { class: 'team-field' }, h('label', null, 'Domain'), domainInput),
        h('div', { class: 'team-field' }, h('label', null, 'Approval Mode'), approvalSelect),
        h('div', { class: 'team-field' }, h('label', { class: 'inline-check' }, publicSummariesCheck, ' Public Summaries')),
        h('div', { class: 'team-field' }, h('label', null, 'Max Sessions per Follower'), maxSessionsInput),
        allowlistSection,
      );

      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        const updated = {
          enabled: state.enabled,
          domain: state.domain,
          approval_mode: state.approval_mode,
          public_summaries: state.public_summaries,
          max_sessions_per_follower: state.max_sessions_per_follower,
          allowlist: state.allowlist,
        };
        await fetch('/api/activitypub/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updated),
        });
        onSave(updated);
        dlg.close();
      };

      cancelBtn.onclick = () => dlg.close();
    },
  });
}

function showTeamDetailOverlay(teamSlug) {
  const dlg = getOverlayDlg();
  dlg.openTemplate('tpl-federation-editor', {
    title: teamSlug,
    id: 'federation-team-dialog',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#federation-editor-body');
      const saveBtn = dlg.footerEl.querySelector('#federation-save');
      const cancelBtn = dlg.footerEl.querySelector('#federation-cancel');

      saveBtn.style.display = 'none';
      cancelBtn.textContent = 'Close';
      cancelBtn.onclick = () => dlg.close();

      renderFollowers(body, teamSlug);
    },
  });
}

async function renderFollowers(container, teamSlug) {
  let followers = [];
  try {
    const res = await fetch(`/api/activitypub/${encodeURIComponent(teamSlug)}/followers`);
    if (res.ok) {
      const data = await res.json();
      const approved = (data.followers || []).map(f => ({ ...f, status: 'approved' }));
      const pending = (data.pending || []).map(f => ({ ...f, status: 'pending', id: f.actorId }));
      followers = [...pending, ...approved];
    }
  } catch { /* empty */ }

  if (followers.length === 0) {
    replaceContent(container,
      h('h3', { style: 'color:var(--accent-gold);font-size:0.95rem;margin-bottom:0.75rem' }, 'Followers'),
      h('p', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'No followers.'),
    );
    return;
  }

  const cards = followers.map(f => {
    const acct = f.acct || f.id || 'unknown';
    const status = f.status || 'approved';
    const children = [h('span', { style: 'flex:1;font-size:0.85rem' }, acct)];

    if (status === 'pending') {
      const approveBtn = h('button', { class: 'team-btn primary', style: 'font-size:0.7rem;padding:0.15rem 0.4rem' }, 'Approve');
      const rejectBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.7rem;padding:0.15rem 0.4rem' }, 'Reject');
      approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        try {
          await fetch(`/api/activitypub/${encodeURIComponent(teamSlug)}/followers/${encodeURIComponent(f.id)}/approve`, { method: 'POST' });
        } catch { /* ignore */ }
        await renderFollowers(container, teamSlug);
      });
      rejectBtn.addEventListener('click', async () => {
        rejectBtn.disabled = true;
        try {
          await fetch(`/api/activitypub/${encodeURIComponent(teamSlug)}/followers/${encodeURIComponent(f.id)}/reject`, { method: 'POST' });
        } catch { /* ignore */ }
        await renderFollowers(container, teamSlug);
      });
      children.push(
        h('span', { style: 'font-size:0.7rem;color:var(--status-warn);margin-right:0.3rem' }, 'PENDING'),
        approveBtn, rejectBtn,
      );
    } else {
      const removeBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.7rem;padding:0.15rem 0.4rem' }, 'Remove');
      removeBtn.addEventListener('click', async () => {
        removeBtn.disabled = true;
        try {
          await fetch(`/api/activitypub/${encodeURIComponent(teamSlug)}/followers/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
        } catch { /* ignore */ }
        await renderFollowers(container, teamSlug);
      });
      children.push(removeBtn);
    }

    return h('div', { class: 'mcp-server-card' }, ...children);
  });

  replaceContent(container,
    h('h3', { style: 'color:var(--accent-gold);font-size:0.95rem;margin-bottom:0.75rem' }, 'Followers'),
    ...cards,
  );
}
