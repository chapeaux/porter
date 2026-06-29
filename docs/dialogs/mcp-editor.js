/**
 * MCP server editor and management dialogs.
 */

import { classifyMcpContext, isContextCompatible } from '../constants.js';
import { h, text, replaceContent } from '../dom.js';
import { getDlg, getOverlayDlg } from './dialog-helpers.js';
import { updateSetupBar } from '../features/flipboard-setup.js';
import { syncMcpToPod } from '../sync/sync-helpers.js';

/** Returns a DocumentFragment with mcp summary elements. */
export function formatMcpSummary(name, cfg) {
  const ctx = cfg._context || classifyMcpContext(cfg);
  const frag = document.createDocumentFragment();
  frag.append(
    h('span', { class: 'mcp-name' }, name),
    text(' '),
    h('span', { class: 'mcp-transport' }, cfg.transport),
  );
  if (ctx && ctx !== 'any') {
    frag.append(h('span', { class: `context-badge ${ctx}` }, ctx));
  }
  return frag;
}

export function renderMcpList(container, servers) {
  const list = container.querySelector('#mcp-servers-list');
  if (!list) return;
  const entries = Object.entries(servers || {});
  if (entries.length === 0) {
    replaceContent(list, h('p', { class: 'import-hint' }, 'No MCP servers configured. Add servers via the gear icon in the header.'));
    return;
  }
  const configStore = document.getElementById('config');
  const enabled = configStore.state.enabledMcpServers || [];

  const cards = entries.map(([name, cfg]) => {
    const ctx = cfg._context || classifyMcpContext(cfg);
    const compatible = isContextCompatible(ctx);

    const checkbox = h('input', { type: 'checkbox', class: 'mcp-enable-check', 'data-mcp-name': name, checked: enabled.includes(name), disabled: !compatible });
    const label = h('label', { class: 'mcp-enable-label' }, checkbox, formatMcpSummary(name, cfg));

    const cardChildren = [label];
    if (!compatible) {
      const remoteBtn = h('button', { class: 'team-btn secondary context-create-remote', 'data-mcp-name': name, style: 'font-size:0.7rem;padding:0.15rem 0.4rem;margin-left:auto' }, 'Create remote');
      cardChildren.push(remoteBtn);
    }

    return h('div', { class: `dialog-card ${compatible ? '' : 'context-incompatible'}` }, ...cardChildren);
  });

  replaceContent(list, ...cards);

  list.querySelectorAll('.mcp-enable-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const configStore = document.getElementById('config');
      const current = new Set(configStore.state.enabledMcpServers || []);
      if (cb.checked) current.add(cb.dataset.mcpName);
      else current.delete(cb.dataset.mcpName);
      configStore.setState({ enabledMcpServers: [...current] });
    });
  });
  list.querySelectorAll('.context-create-remote').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const name = btn.dataset.mcpName;
      const cfg = servers[name];
      openMcpEditorDialog(null, true);
      setTimeout(() => {
        const dlg = getOverlayDlg();
        const body = dlg.bodyEl;
        const nameInput = body?.querySelector('#mcp-name');
        if (nameInput) nameInput.value = name + '-remote';
        const httpRadio = body?.querySelector('input[name="mcp-transport"][value="http"]');
        if (httpRadio) { httpRadio.checked = true; httpRadio.dispatchEvent(new Event('change', { bubbles: true })); }
      }, 100);
    });
  });
}

export function openMcpEditorDialog(editName = null, useOverlay = false) {
  const dlg = useOverlay ? getOverlayDlg() : getDlg();
  const configStore = document.getElementById('config');
  const existing = editName ? (configStore.state.mcpServers[editName] || {}) : {};
  const isEdit = !!editName;

  dlg.openTemplate('tpl-mcp-editor', {
    title: isEdit ? `Edit MCP Server: ${editName}` : 'Add MCP Server',
    id: 'mcp-editor-dialog',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#mcp-editor-body');
      const saveBtn = dlg.footerEl.querySelector('#mcp-editor-save');
      const cancelBtn = dlg.footerEl.querySelector('#mcp-editor-cancel');

      const nameInput = h('input', { type: 'text', id: 'mcp-name', value: editName || '', placeholder: 'e.g. github, filesystem' });
      if (isEdit) nameInput.readOnly = true;

      const stdioRadio = h('input', { type: 'radio', name: 'mcp-transport', value: 'stdio', checked: (existing.transport || 'stdio') === 'stdio' });
      const httpRadio = h('input', { type: 'radio', name: 'mcp-transport', value: 'http', checked: existing.transport === 'http' });

      const argsTextarea = h('textarea', { id: 'mcp-args', rows: '3', placeholder: '-y\n@modelcontextprotocol/server-filesystem\n/workspace' });
      argsTextarea.value = (existing.args || []).join('\n');

      const envTextarea = h('textarea', { id: 'mcp-env', rows: '2', placeholder: 'GITHUB_TOKEN=ghp_xxx' });
      envTextarea.value = Object.entries(existing.env || {}).map(([k,v]) => k+'='+v).join('\n');

      const stdioFields = h('div', { id: 'mcp-stdio-fields', class: 'team-field' },
        h('label', null, 'Command'),
        h('input', { type: 'text', id: 'mcp-command', value: existing.command || '', placeholder: 'e.g. npx' }),
        h('label', { style: 'margin-top:0.4rem' }, 'Arguments (one per line)'),
        argsTextarea
      );
      if (existing.transport === 'http') stdioFields.style.display = 'none';

      const httpFields = h('div', { id: 'mcp-http-fields', class: 'team-field' },
        h('label', null, 'URL'),
        h('input', { type: 'text', id: 'mcp-url', value: existing.url || '', placeholder: 'http://localhost:3001/mcp' })
      );
      if (existing.transport !== 'http') httpFields.style.display = 'none';

      const authStatus = h('span', { id: 'mcp-auth-status', style: 'font-size:0.8rem;color:var(--text-dim)' },
        localStorage.getItem('porter-mcp-token-' + (editName || '')) ? '✓ Authenticated' : 'Not authenticated'
      );

      const oidcFields = h('div', { id: 'mcp-oidc-fields' },
        h('label', { style: 'margin-top:0.4rem' }, 'Issuer URL (leave blank to use Porter default)'),
        h('input', { type: 'text', id: 'mcp-auth-issuer', value: existing.auth?.issuer_url || '', placeholder: 'https://auth.example.com/realms/my-realm' }),
        h('div', { style: 'margin-top:0.5rem;display:flex;align-items:center;gap:0.5rem' },
          h('button', { type: 'button', class: 'team-btn primary', id: 'mcp-auth-login' }, 'Login'),
          authStatus
        )
      );
      if (existing.auth?.type !== 'oidc') oidcFields.style.display = 'none';

      const authSection = h('div', { id: 'mcp-auth-section', class: 'team-field' },
        h('label', null, 'Authentication'),
        h('div', { class: 'role-group' },
          h('label', null, h('input', { type: 'radio', name: 'mcp-auth', value: 'none', checked: !existing.auth }), ' None'),
          h('label', null, h('input', { type: 'radio', name: 'mcp-auth', value: 'oidc', checked: existing.auth?.type === 'oidc' }), ' OIDC')
        ),
        oidcFields
      );
      if ((existing.transport || 'stdio') === 'stdio') authSection.style.display = 'none';

      replaceContent(body,
        h('div', { class: 'team-field' },
          h('label', null, 'Server Name'),
          nameInput
        ),
        h('div', { class: 'team-field' },
          h('label', null, 'Transport'),
          h('div', { class: 'role-group' },
            h('label', null, stdioRadio, ' stdio (local process)'),
            h('label', null, httpRadio, ' http (remote endpoint)')
          )
        ),
        stdioFields,
        httpFields,
        h('div', { class: 'team-field' },
          h('label', null, 'Environment Variables (KEY=VALUE, one per line)'),
          envTextarea
        ),
        authSection
      );

      // Toggle stdio/http fields + auth section
      body.querySelectorAll('input[name="mcp-transport"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
          body.querySelector('#mcp-stdio-fields').style.display = e.target.value === 'stdio' ? '' : 'none';
          body.querySelector('#mcp-http-fields').style.display = e.target.value === 'http' ? '' : 'none';
          body.querySelector('#mcp-auth-section').style.display = e.target.value === 'http' ? '' : 'none';
        });
      });

      // Toggle OIDC fields
      body.querySelectorAll('input[name="mcp-auth"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
          body.querySelector('#mcp-oidc-fields').style.display = e.target.value === 'oidc' ? '' : 'none';
        });
      });

      // OIDC login popup
      body.querySelector('#mcp-auth-login')?.addEventListener('click', () => {
        const name = body.querySelector('#mcp-name').value.trim();
        if (!name) return;
        const issuer = body.querySelector('#mcp-auth-issuer').value.trim();
        const loginUrl = '/api/mcp-auth/login?server=' + encodeURIComponent(name) + (issuer ? '&issuer=' + encodeURIComponent(issuer) : '');
        const popup = window.open(loginUrl, 'mcp-auth', 'width=600,height=700');
        const handler = (e) => {
          if (e.data?.type !== 'mcp-auth-result') return;
          window.removeEventListener('message', handler);
          if (e.data.error) {
            body.querySelector('#mcp-auth-status').textContent = 'Failed: ' + e.data.error;
            body.querySelector('#mcp-auth-status').style.color = 'var(--status-error)';
          } else {
            body.querySelector('#mcp-auth-status').textContent = '✓ Authenticated';
            body.querySelector('#mcp-auth-status').style.color = 'var(--status-ok)';
          }
        };
        window.addEventListener('message', handler);
        // Fallback: poll localStorage in case postMessage doesn't fire (cross-origin popup)
        const pollKey = 'porter-mcp-token-' + name;
        const pollBefore = localStorage.getItem(pollKey);
        const poll = setInterval(() => {
          const current = localStorage.getItem(pollKey);
          if (current && current !== pollBefore) {
            clearInterval(poll);
            window.removeEventListener('message', handler);
            body.querySelector('#mcp-auth-status').textContent = '✓ Authenticated';
            body.querySelector('#mcp-auth-status').style.color = 'var(--status-ok)';
          }
        }, 500);
      });

      saveBtn.onclick = () => {
        const name = body.querySelector('#mcp-name').value.trim();
        if (!name) { body.querySelector('#mcp-name').style.borderColor = 'var(--status-error)'; return; }
        const transport = body.querySelector('input[name="mcp-transport"]:checked').value;
        const config = { name, transport };
        if (transport === 'stdio') {
          config.command = body.querySelector('#mcp-command').value.trim();
          config.args = body.querySelector('#mcp-args').value.split('\n').map(s => s.trim()).filter(Boolean);
        } else {
          config.url = body.querySelector('#mcp-url').value.trim();
          const authType = body.querySelector('input[name="mcp-auth"]:checked')?.value;
          if (authType === 'oidc') {
            config.auth = { type: 'oidc' };
            const issuer = body.querySelector('#mcp-auth-issuer').value.trim();
            if (issuer) config.auth.issuer_url = issuer;
          }
        }
        const envText = body.querySelector('#mcp-env').value.trim();
        if (envText) {
          config.env = {};
          for (const line of envText.split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0) config.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
        }
        const servers = { ...configStore.state.mcpServers, [name]: config };
        configStore.setState({ mcpServers: servers });
        dlg.close();
        updateSetupBar();
        if (document.querySelector('.empty-state-prompt')) {
          import('../features/empty-state.js').then(m => m.renderEmptyState());
        }
        syncMcpToPod();
      };

      cancelBtn.onclick = () => dlg.close();
    },
  });
}

// MCP management dialog showing all servers with edit/remove
export function showMcpManageDialog() {
  const configStore = document.getElementById('config');
  const servers = configStore.state.mcpServers || {};
  const entries = Object.entries(servers);

  if (entries.length === 0) {
    openMcpEditorDialog();
    return;
  }

  const dlg = getDlg();
  dlg.openTemplate('tpl-mcp-editor', {
    title: 'MCP Servers',
    id: 'mcp-manage-dialog',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#mcp-editor-body');
      const saveBtn = dlg.footerEl.querySelector('#mcp-editor-save');
      const cancelBtn = dlg.footerEl.querySelector('#mcp-editor-cancel');

      const serverCards = entries.map(([name, cfg]) => {
        const editBtn = h('button', { class: 'mcp-action-btn mcp-manage-edit', 'data-name': name, style: 'margin-left:auto' }, 'Edit');
        const removeBtn = h('button', { class: 'mcp-action-btn mcp-manage-remove', 'data-name': name, style: 'background:var(--status-error)' }, 'Remove');
        return h('div', { class: 'dialog-card', style: 'margin-bottom:0.5rem' },
          formatMcpSummary(name, cfg),
          editBtn,
          removeBtn
        );
      });
      replaceContent(body, ...serverCards);

      // + Add Server in dialog header
      const addBtn = h('button', { class: 'dialog-header-add' }, '+ Add Server');
      addBtn.addEventListener('click', () => { dlg.close(); openMcpEditorDialog(); });
      dlg.headerExtra.replaceChildren(addBtn);

      saveBtn.style.display = 'none';
      cancelBtn.textContent = 'Close';
      cancelBtn.onclick = () => dlg.close();

      body.querySelectorAll('.mcp-manage-edit').forEach(btn => {
        btn.addEventListener('click', () => { dlg.close(); openMcpEditorDialog(btn.dataset.name); });
      });
      body.querySelectorAll('.mcp-manage-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const s = { ...configStore.state.mcpServers };
          delete s[btn.dataset.name];
          configStore.setState({ mcpServers: s });
          btn.closest('.dialog-card').remove();
          updateSetupBar();
          if (document.querySelector('.empty-state-prompt')) {
            import('../features/empty-state.js').then(m => m.renderEmptyState());
          }
          syncMcpToPod();
          if (Object.keys(s).length === 0) dlg.close();
        });
      });
    },
  });
}
