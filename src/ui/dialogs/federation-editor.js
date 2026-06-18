/**
 * ActivityPub federation settings dialog.
 */

import { h, text, replaceContent } from '../dom.js';
import { getDlg } from './dialog-helpers.js';
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
  } catch (_) { /* use defaults */ }

  const state = {
    enabled: config.enabled ?? false,
    domain: config.domain ?? '',
    approval_mode: config.approval_mode ?? 'manual',
    public_summaries: config.public_summaries ?? false,
    max_sessions_per_follower: config.max_sessions_per_follower ?? 1,
    allowlist: [...(config.allowlist || [])],
  };

  // --- Section 1: Federation Settings ---
  const enabledCheck = h('input', { type: 'checkbox', checked: state.enabled });
  enabledCheck.addEventListener('change', () => { state.enabled = enabledCheck.checked; });

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

  const settingsSection = h('div', null,
    h('h3', { style: 'color:var(--accent-gold);font-size:0.95rem;margin-bottom:0.75rem' }, 'Federation Settings'),
    h('div', { class: 'team-field' },
      h('label', { class: 'inline-check' }, enabledCheck, ' Enabled'),
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'Domain'),
      domainInput,
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'Approval Mode'),
      approvalSelect,
    ),
    h('div', { class: 'team-field' },
      h('label', { class: 'inline-check' }, publicSummariesCheck, ' Public Summaries'),
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'Max Sessions per Follower'),
      maxSessionsInput,
    ),
  );

  // --- Section 2: Allowlist ---
  const allowlistContainer = h('div', { style: 'margin-bottom:0.5rem' });
  const allowlistInput = h('input', { type: 'text', placeholder: '@user@domain or domain.example' });
  const allowlistAddBtn = h('button', { class: 'team-btn primary', style: 'margin-left:0.5rem' }, 'Add');

  const allowlistSection = h('div', null,
    h('h3', { style: 'color:var(--accent-gold);font-size:0.95rem;margin-bottom:0.75rem;margin-top:1.25rem' }, 'Allowlist'),
    allowlistContainer,
    h('div', { style: 'display:flex;align-items:center' },
      allowlistInput,
      allowlistAddBtn,
    ),
  );

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

  function updateAllowlistVisibility() {
    allowlistSection.style.display = approvalSelect.value === 'allowlist' ? '' : 'none';
  }
  approvalSelect.addEventListener('change', () => {
    state.approval_mode = approvalSelect.value;
    updateAllowlistVisibility();
  });
  updateAllowlistVisibility();

  // --- Section 3: Published Teams ---
  const publishedContainer = h('div', { style: 'margin-bottom:0.5rem' });
  const publishTeamBtn = h('button', { class: 'team-btn primary', style: 'margin-top:0.5rem' }, 'Publish Team');

  const teamsSection = h('div', null,
    h('h3', { style: 'color:var(--accent-gold);font-size:0.95rem;margin-bottom:0.75rem;margin-top:1.25rem' }, 'Published Teams'),
    publishedContainer,
    publishTeamBtn,
  );

  async function renderPublishedTeams() {
    let published = [];
    try {
      const res = await fetch('/api/activitypub/teams');
      if (res.ok) { const data = await res.json(); published = data.teams || []; }
    } catch (_) { /* empty */ }

    if (published.length === 0) {
      replaceContent(publishedContainer, h('p', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'No published teams.'));
    } else {
      const cards = published.map(team => {
        const unpubBtn = h('button', { class: 'team-btn secondary', style: 'font-size:0.75rem;padding:0.15rem 0.5rem;margin-left:auto' }, 'Unpublish');
        unpubBtn.addEventListener('click', async () => {
          unpubBtn.disabled = true;
          try {
            await fetch('/api/activitypub/unpublish', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ teamSlug: team.teamSlug || team.slug || team.name }),
            });
          } catch (_) { /* ignore */ }
          await renderPublishedTeams();
          await renderFollowers();
          syncPublishedTeamsToPod();
        });
        return h('div', { class: 'mcp-server-card' },
          h('span', { class: 'mcp-name' }, team.teamSlug || team.name || team.slug),
          unpubBtn,
        );
      });
      replaceContent(publishedContainer, ...cards);
    }
    return published;
  }

  publishTeamBtn.addEventListener('click', async () => {
    let allTeams = [];
    try {
      const res = await fetch('/api/teams');
      if (res.ok) { const data = await res.json(); allTeams = data.teams || []; }
    } catch (_) { /* empty */ }

    if (allTeams.length === 0) return;

    const picker = h('select', { style: 'margin-left:0.5rem' },
      h('option', { value: '' }, '-- select team --'),
      ...allTeams.map(t => h('option', { value: t.slug || t.name }, t.name || t.slug)),
    );
    const confirmBtn = h('button', { class: 'team-btn primary', style: 'margin-left:0.5rem;font-size:0.75rem;padding:0.15rem 0.5rem' }, 'Confirm');
    const cancelPick = h('button', { class: 'team-btn secondary', style: 'margin-left:0.3rem;font-size:0.75rem;padding:0.15rem 0.5rem' }, 'Cancel');

    const row = h('div', { style: 'display:flex;align-items:center;margin-top:0.5rem' }, picker, confirmBtn, cancelPick);
    publishTeamBtn.after(row);
    publishTeamBtn.style.display = 'none';

    cancelPick.addEventListener('click', () => {
      row.remove();
      publishTeamBtn.style.display = '';
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
      } catch (_) { /* ignore */ }
      row.remove();
      publishTeamBtn.style.display = '';
      await renderPublishedTeams();
      await renderFollowers();
      syncPublishedTeamsToPod();
    });
  });

  await renderPublishedTeams();

  // --- Section 4: Followers ---
  const followersContainer = h('div');

  const followersSection = h('div', null,
    h('h3', { style: 'color:var(--accent-gold);font-size:0.95rem;margin-bottom:0.75rem;margin-top:1.25rem' }, 'Followers'),
    followersContainer,
  );

  async function renderFollowers() {
    let published = [];
    try {
      const res = await fetch('/api/activitypub/teams');
      if (res.ok) { const data = await res.json(); published = data.teams || []; }
    } catch (_) { /* empty */ }

    if (published.length === 0) {
      replaceContent(followersContainer, h('p', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'No published teams.'));
      return;
    }

    const sections = [];
    for (const team of published) {
      const slug = team.slug || team.name;
      let followers = [];
      try {
        const res = await fetch(`/api/activitypub/${encodeURIComponent(slug)}/followers`);
        if (res.ok) { const data = await res.json(); followers = data.followers || []; }
      } catch (_) { /* empty */ }

      const heading = h('h4', { style: 'color:var(--text-secondary);font-size:0.85rem;margin:0.5rem 0 0.3rem' }, team.name || slug);

      if (followers.length === 0) {
        sections.push(heading, h('p', { style: 'color:var(--text-dim);font-size:0.8rem;margin-bottom:0.5rem' }, 'No followers.'));
        continue;
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
              await fetch(`/api/activitypub/${encodeURIComponent(slug)}/followers/${encodeURIComponent(f.id)}/approve`, { method: 'POST' });
            } catch (_) { /* ignore */ }
            await renderFollowers();
          });
          rejectBtn.addEventListener('click', async () => {
            rejectBtn.disabled = true;
            try {
              await fetch(`/api/activitypub/${encodeURIComponent(slug)}/followers/${encodeURIComponent(f.id)}/reject`, { method: 'POST' });
            } catch (_) { /* ignore */ }
            await renderFollowers();
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
              await fetch(`/api/activitypub/${encodeURIComponent(slug)}/followers/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
            } catch (_) { /* ignore */ }
            await renderFollowers();
          });
          children.push(removeBtn);
        }

        return h('div', { class: 'mcp-server-card' }, ...children);
      });

      sections.push(heading, ...cards);
    }

    replaceContent(followersContainer, ...sections);
  }

  await renderFollowers();

  // --- Assemble body ---
  replaceContent(body, settingsSection, allowlistSection, teamsSection, followersSection);

  // --- Footer wiring ---
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await fetch('/api/activitypub/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: state.enabled,
          domain: state.domain,
          approval_mode: state.approval_mode,
          public_summaries: state.public_summaries,
          max_sessions_per_follower: state.max_sessions_per_follower,
          allowlist: state.allowlist,
        }),
      });
    } catch (_) { /* ignore */ }
    dlg.close();
    updateSetupBar();
  };

  cancelBtn.onclick = () => dlg.close();
}
