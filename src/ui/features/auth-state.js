/**
 * Auth state — login/logout/email identity UI and fetch wrapper.
 */

import { h, replaceContent } from '../dom.js';

export let _authChecked = null; // Promise<boolean> -- resolves true if SSO-authenticated
export let oidcAvailable = false; // Whether the server has OIDC/SSO configured

/** Get identity headers to include in API calls. */
export function getIdentityHeaders() {
  const headers = {};
  const solidSession = window.solidAuth?.getSessionInfo?.();
  if (solidSession?.isLoggedIn && solidSession.webId) {
    headers['X-Porter-WebID'] = solidSession.webId;
    return headers;
  }
  const email = localStorage.getItem('porter-user-email');
  if (email) headers['X-Porter-Email'] = email;
  return headers;
}

/** Patch fetch to always include identity headers on same-origin API calls. */
const _originalFetch = window.fetch;
window.fetch = function(input, init) {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('/api/') || url.startsWith('/auth/') || url.startsWith('/mcp')) {
    init = init || {};
    init.headers = { ...getIdentityHeaders(), ...(init.headers || {}) };
  }
  return _originalFetch.call(this, input, init);
};

export function checkAuthState() {
  _authChecked = _checkAuthStateInner();
  return _authChecked;
}

async function _checkAuthStateInner() {
  const authArea = document.getElementById('auth-area');
  if (!authArea) return false;

  try {
    const resp = await fetch('/auth/me');
    if (resp.ok) {
      const data = await resp.json();
      oidcAvailable = data.oidc_configured ?? false;
      if (data.authenticated) {
        renderUserProfile(authArea, data.user);
        return true;
      }
    }
  } catch { /* OIDC not configured — fall through */ }

  // Check Solid session
  const solidSession = window.solidAuth?.getSessionInfo?.();
  if (solidSession?.isLoggedIn) {
    renderSolidIdentity(authArea, solidSession.webId);
    return false;
  }

  // Check for stored email identity
  const email = localStorage.getItem('porter-user-email');
  if (email) {
    renderEmailIdentity(authArea, email);
  } else {
    renderAuthSelector(authArea);
  }
  return false;
}

export function renderAuthSelector(container) {
  const selectOptions = [
    h('option', { value: '', disabled: true, selected: true }, 'Sign in...'),
    h('option', { value: 'email' }, 'Email'),
  ];
  if (oidcAvailable) selectOptions.push(h('option', { value: 'sso' }, 'SSO'));
  selectOptions.push(h('option', { value: 'solid' }, 'Solid / LWS'));

  const select = h('select', { id: 'auth-method-select', class: 'auth-select' }, ...selectOptions);
  const formDiv = h('div', { id: 'auth-method-form' });

  replaceContent(container,
    h('div', { class: 'auth-selector' }, select, formDiv)
  );

  select.addEventListener('change', (e) => {
    switch (e.target.value) {
      case 'email': {
        const emailInput = h('input', { id: 'auth-email-input', type: 'email', placeholder: 'you@example.com', class: 'auth-input' });
        const emailBtn = h('button', { id: 'auth-email-btn', class: 'auth-btn' }, 'Set');
        replaceContent(formDiv, emailInput, emailBtn);
        emailBtn.addEventListener('click', () => {
          const email = emailInput.value.trim();
          if (email && email.includes('@')) {
            localStorage.setItem('porter-user-email', email);
            document.getElementById('models')?.refresh();
            checkAuthState();
          }
        });
        emailInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') emailBtn.click();
        });
        break;
      }
      case 'sso':
        window.location.href = '/auth/login';
        break;
      case 'solid': {
        const lastIdp = localStorage.getItem('porter-solid-last-idp') || '';
        const issuerInput = h('input', { id: 'auth-solid-issuer', type: 'url', placeholder: 'https://login.inrupt.com', value: lastIdp, class: 'auth-input' });
        const solidBtn = h('button', { id: 'auth-solid-btn', class: 'auth-btn' }, 'Login');
        replaceContent(formDiv, issuerInput, solidBtn);
        solidBtn.addEventListener('click', () => {
          const issuer = issuerInput.value.trim();
          if (issuer && issuer.startsWith('http')) {
            localStorage.setItem('porter-solid-last-idp', issuer);
            window.solidAuth.solidLogin(issuer, window.location.href);
          }
        });
        issuerInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') solidBtn.click();
        });
        break;
      }
    }
  });
}

export function renderEmailIdentity(container, email) {
  const changeBtn = h('button', { class: 'auth-logout-btn', id: 'auth-change-email' }, 'Change');
  replaceContent(container,
    h('span', { class: 'auth-user', title: email }, email),
    changeBtn
  );
  changeBtn.addEventListener('click', () => {
    localStorage.removeItem('porter-user-email');
    renderAuthSelector(container);
  });
}

export function renderSolidIdentity(container, webId) {
  const host = webId.replace(/^https?:\/\//, '').split('/')[0];
  const statusEl = h('span', { id: 'pod-sync-status', class: 'pod-sync-indicator', title: 'Pod sync status' }, '✓');
  const logoutBtn = h('button', { id: 'auth-solid-logout', class: 'auth-btn' }, 'Logout');
  replaceContent(container,
    h('span', { class: 'auth-identity', title: webId },
      h('span', { class: 'auth-icon' }, '\u{1F310}'),
      ' ' + host
    ),
    statusEl,
    logoutBtn
  );
  logoutBtn.addEventListener('click', () => {
    if (window._podSync) {
      window._podSync.disconnect();
      window._podSync = null;
    }
    window.solidAuth.solidLogoutUser();
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
    localStorage.removeItem('porter-pod-teams');
    localStorage.removeItem('porter-pod-agents');
    checkAuthState();
  });
  const updateSyncStatus = (text, color, title) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = color;
    statusEl.title = title;
  };

  window.addEventListener('porter-pod-synced', () =>
    updateSyncStatus('✓', 'var(--status-ok)', 'Pod synced'));
  window.addEventListener('porter-pod-write-failed', (e) =>
    updateSyncStatus('✗', 'var(--status-error)', `Pod write failed (${e.detail?.status || 'error'})`));
  window.addEventListener('porter-auth-refreshed', () =>
    updateSyncStatus('✓', 'var(--status-ok)', 'Session refreshed'));
  window.addEventListener('porter-auth-expired', () =>
    updateSyncStatus('⚠', 'var(--status-warn)', 'Session expired — re-login needed'));
}

function renderUserProfile(container, user) {
  replaceContent(container,
    h('span', { class: 'auth-user' }, user.username || user.name || user.email || 'User'),
    h('a', { href: '/auth/logout', class: 'auth-logout-btn' }, 'Logout')
  );
}
