/**
 * PorterPodSync — sync Porter config to a Solid Pod.
 *
 * Dependencies on app.js (resolved at runtime via callbacks):
 *   - updateSetupBar() — called after applying remote state
 *   - getIdentityHeaders() — used when posting models/teams/agents to server
 */

import { classifyMcpContext, classifyModelContext } from '../constants.js';
import { setMODELS } from '../stores/config-store.js';

/**
 * Callback registry — app.js injects these after import so the class
 * can call back into app-level functions without a circular import.
 */
let _updateSetupBar = () => {};
let _getIdentityHeaders = () => ({});

export function setPodSyncCallbacks({ updateSetupBar, getIdentityHeaders }) {
  if (updateSetupBar) _updateSetupBar = updateSetupBar;
  if (getIdentityHeaders) _getIdentityHeaders = getIdentityHeaders;
}

export class PorterPodSync {
  constructor(podRoot, authFetch) {
    this._podRoot = podRoot.endsWith('/') ? podRoot : podRoot + '/';
    this._fetch = authFetch;
    this._resourceUrl = `${this._podRoot}porter/config.json`;
    this._lastKnownState = null;
    this._pendingWrites = new Map();
    this._lastEtag = null;
    this._flushScheduled = false;
    this._eventSource = null;
    this._clientId = 'porter-' + Math.random().toString(36).slice(2, 10);
    this._retryDelay = 1000;
    this._connected = false;
  }

  async connect() {
    // Ensure the porter/ container exists
    // Try LDP BasicContainer (standard Solid), fall back to LWS Container
    try {
      const containerTypes = [
        '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        '<https://www.w3.org/ns/lws#Container>; rel="type"',
      ];
      let created = false;
      for (const linkType of containerTypes) {
        const createResp = await this._fetch(this._podRoot, {
          method: 'POST',
          headers: { 'Slug': 'porter', 'Link': linkType, 'Content-Type': 'text/turtle' },
          body: '',
        });
        if (createResp.ok || createResp.status === 201 || createResp.status === 409) {
          created = true;
          break;
        }
      }
      if (!created) console.warn('[porter-pod] Could not create porter/ container');
    } catch (e) { console.error('[porter-pod] Container create failed:', e); }

    // Load current state, or create initial resource via POST to container
    try {
      const resp = await this._fetch(this._resourceUrl);
      if (resp.ok) {
        const data = await resp.json();
        this._lastEtag = resp.headers.get('etag');
        this._lastKnownState = data;
        this._applyRemoteState(data);
      } else if (resp.status === 404) {
        const initial = { _clientId: this._clientId, _timestamp: Date.now() };
        // Try POST to container first (LWS), then PUT directly (Solid CSS/NSS)
        const containerUrl = this._resourceUrl.replace(/[^/]+$/, '');
        const slug = this._resourceUrl.split('/').pop();
        let postResp = await this._fetch(containerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Slug': slug },
          body: JSON.stringify(initial),
        });
        if (!postResp.ok && postResp.status !== 201 && postResp.status !== 409) {
          // POST failed - try PUT directly (works on CSS, NSS)
          postResp = await this._fetch(this._resourceUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initial),
          });
        }
        if (postResp.ok || postResp.status === 201) {
          this._lastEtag = postResp.headers.get('etag');
          this._lastKnownState = initial;
        } else if (postResp.status === 409) {
          const retryResp = await this._fetch(this._resourceUrl);
          if (retryResp.ok) {
            const data = await retryResp.json();
            this._lastEtag = retryResp.headers.get('etag');
            this._lastKnownState = data;
            this._applyRemoteState(data);
          }
        }
      }
    } catch (e) { console.error('[porter-pod] Initial load failed:', e); }

    // If no JSON config but Turtle exists, note it for future sync
    if (!this._lastKnownState || Object.keys(this._lastKnownState).length <= 2) {
      try {
        const ttlUrl = this._resourceUrl.replace(/\.json$/, '.ttl');
        const ttlResp = await this._fetch(ttlUrl);
        if (ttlResp.ok) {
          console.log('[porter-pod] Found Turtle config at', ttlUrl);
        }
      } catch { /* Turtle fallback is optional */ }
    }

    // Subscribe to notifications
    this._subscribeNotifications();
    this._connected = true;
  }

  disconnect() {
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
    this._connected = false;
  }

  save(key, value) {
    this._pendingWrites.set(key, value);
    this._scheduleFlush();
  }

  async saveMemory(sessionName, turtle) {
    if (!turtle || !turtle.trim()) return;
    const memoryUrl = `${this._podRoot}porter/memory/${encodeURIComponent(sessionName)}.ttl`;
    try {
      let resp = await this._fetch(memoryUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle,
      });
      if (resp.status === 404) {
        const containerTypes = [
          '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
          '<https://www.w3.org/ns/lws#Container>; rel="type"',
        ];
        for (const linkType of containerTypes) {
          const cr = await this._fetch(`${this._podRoot}porter/`, {
            method: 'POST',
            headers: { 'Slug': 'memory', 'Link': linkType, 'Content-Type': 'text/turtle' },
            body: '',
          });
          if (cr.ok || cr.status === 201 || cr.status === 409) break;
        }
        resp = await this._fetch(memoryUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/turtle' },
          body: turtle,
        });
      }
      if (resp.ok) console.log('[porter-pod] Memory saved for session:', sessionName);
    } catch (e) {
      console.error('[porter-pod] Memory save failed:', e);
    }
  }

  async loadMemory(sessionName) {
    const memoryUrl = `${this._podRoot}porter/memory/${encodeURIComponent(sessionName)}.ttl`;
    try {
      const resp = await this._fetch(memoryUrl);
      if (resp.ok) return await resp.text();
    } catch (e) {
      console.error('[porter-pod] Memory load failed:', e);
    }
    return null;
  }

  _scheduleFlush() {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    queueMicrotask(() => this._flush());
  }

  async _flush() {
    this._flushScheduled = false;
    if (this._pendingWrites.size === 0) return;

    // Ensure we have a current ETag before writing
    if (!this._lastEtag) {
      try {
        const getResp = await this._fetch(this._resourceUrl);
        if (getResp.ok) {
          this._lastEtag = getResp.headers.get('etag');
          this._lastKnownState = await getResp.json();
        }
      } catch { /* will try PUT without If-Match */ }
    }

    let state = { ...(this._lastKnownState || {}), _clientId: this._clientId, _timestamp: Date.now() };
    for (const [k, v] of this._pendingWrites) {
      state[k] = v;
    }
    this._pendingWrites.clear();

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this._lastEtag) headers['If-Match'] = this._lastEtag;
      const resp = await this._fetch(this._resourceUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify(state),
      });
      if (resp.ok) {
        this._lastEtag = resp.headers.get('etag');
        this._lastKnownState = state;
        this._retryDelay = 1000;
        window.dispatchEvent(new CustomEvent('porter-pod-synced'));
      } else if (resp.status === 409 || resp.status === 412 || resp.status === 428) {
        // Missing or stale ETag — GET to refresh state and ETag, then retry
        const freshResp = await this._fetch(this._resourceUrl);
        if (freshResp.ok) {
          this._lastEtag = freshResp.headers.get('etag');
          this._lastKnownState = await freshResp.json();
          // Re-merge pending changes on top of fresh state
          for (const [k, v] of Object.entries(state)) {
            if (k !== '_clientId' && k !== '_timestamp') this._lastKnownState[k] = v;
          }
          state = { ...this._lastKnownState, _clientId: this._clientId, _timestamp: Date.now() };
        }
        if (this._lastEtag) {
          const retryResp = await this._fetch(this._resourceUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'If-Match': this._lastEtag },
            body: JSON.stringify(state),
          });
          if (retryResp.ok) {
            this._lastEtag = retryResp.headers.get('etag');
            this._lastKnownState = state;
            this._retryDelay = 1000;
            window.dispatchEvent(new CustomEvent('porter-pod-synced'));
          } else if (retryResp.status === 412) {
            // ETag changed — one more try with fresh GET
            const head2 = await this._fetch(this._resourceUrl);
            if (head2.ok) { this._lastEtag = head2.headers.get('etag'); await head2.json(); }
            if (this._lastEtag) {
              const retry2 = await this._fetch(this._resourceUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'If-Match': this._lastEtag },
                body: JSON.stringify(state),
              });
              if (retry2.ok) {
                this._lastEtag = retry2.headers.get('etag');
                this._lastKnownState = state;
                window.dispatchEvent(new CustomEvent('porter-pod-synced'));
              } else { console.error('[porter-pod] Write retry2 failed:', retry2.status); }
            }
          } else {
            console.error('[porter-pod] Write retry failed:', retryResp.status);
          }
        } else {
          console.error('[porter-pod] Could not obtain ETag for retry');
        }
      } else {
        console.error('[porter-pod] Write failed:', resp.status);
        this._retryDelay = Math.min(this._retryDelay * 2, 30000);
        window.dispatchEvent(new CustomEvent('porter-pod-write-failed', { detail: { status: resp.status } }));
      }
    } catch (e) {
      console.error('[porter-pod] Write error:', e);
      this._retryDelay = Math.min(this._retryDelay * 2, 30000);
    }

    // Also save as Turtle for linked data consumers
    try {
      const turtleUrl = this._resourceUrl.replace(/\.json$/, '.ttl');
      const turtle = this._stateToTurtle(state);
      if (turtle) {
        const ttlHeaders = { 'Content-Type': 'text/turtle' };
        if (this._ttlEtag) ttlHeaders['If-Match'] = this._ttlEtag;
        const ttlResp = await this._fetch(turtleUrl, { method: 'PUT', headers: ttlHeaders, body: turtle });
        if (ttlResp.ok) {
          this._ttlEtag = ttlResp.headers.get('etag');
        } else if (ttlResp.status === 404) {
          const containerUrl = turtleUrl.replace(/[^/]+$/, '');
          const slug = turtleUrl.split('/').pop();
          const createResp = await this._fetch(containerUrl, {
            method: 'POST', headers: { 'Content-Type': 'text/turtle', 'Slug': slug }, body: turtle,
          });
          if (createResp.ok || createResp.status === 201) this._ttlEtag = createResp.headers.get('etag');
        } else if (ttlResp.status === 409 || ttlResp.status === 428) {
          const headResp = await this._fetch(turtleUrl, { method: 'HEAD' });
          if (headResp.ok) this._ttlEtag = headResp.headers.get('etag');
          if (this._ttlEtag) {
            const retryResp = await this._fetch(turtleUrl, {
              method: 'PUT', headers: { 'Content-Type': 'text/turtle', 'If-Match': this._ttlEtag }, body: turtle,
            });
            if (retryResp.ok) this._ttlEtag = retryResp.headers.get('etag');
          }
        }
      }
    } catch { /* Turtle sync is optional */ }
  }

  _stateToTurtle(state) {
    const hasModels = state.models && Array.isArray(state.models) && state.models.length > 0;
    const hasMcp = state.mcp_servers && typeof state.mcp_servers === 'object' && Object.keys(state.mcp_servers).length > 0;
    if (!hasModels && !hasMcp) return null;

    const lines = [
      '@prefix porter: <https://porter.chapeaux.io/vocab#> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
      '',
    ];

    for (const m of state.models || []) {
      const uri = `porter:model/${encodeURIComponent(m.id || m.model_id)}`;
      lines.push(`${uri} a porter:Model ;`);
      lines.push(`  rdfs:label "${(m.display_name || m.id || '').replace(/"/g, '\\"')}" ;`);
      lines.push(`  porter:providerType "${m.provider_type || 'openai_compat'}" ;`);
      lines.push(`  porter:baseUrl "${(m.base_url || '').replace(/"/g, '\\"')}" ;`);
      lines.push(`  porter:authMethod "${m.auth || 'bearer'}" ;`);
      lines.push(`  porter:contextWindow ${m.context_window || 128000} ;`);
      lines.push(`  porter:maxTokens ${m.max_tokens || 4096} ;`);
      if (m.capabilities) {
        lines.push(`  porter:toolCalling ${!!m.capabilities.tool_calling} ;`);
        lines.push(`  porter:reasoning ${!!m.capabilities.reasoning} ;`);
        lines.push(`  porter:vision ${!!m.capabilities.vision} ;`);
        lines.push(`  porter:jsonMode ${!!m.capabilities.json_mode} ;`);
      }
      // Replace last ; with .
      lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, ' .');
      lines.push('');
    }

    if (state.mcp_servers && typeof state.mcp_servers === 'object') {
      for (const [name, cfg] of Object.entries(state.mcp_servers)) {
        const uri = `porter:mcp/${encodeURIComponent(name)}`;
        lines.push(`${uri} a porter:McpServer ;`);
        lines.push(`  rdfs:label "${name.replace(/"/g, '\\"')}" ;`);
        lines.push(`  porter:transport "${cfg.transport || 'stdio'}" ;`);
        if (cfg.url) lines.push(`  porter:url "${cfg.url.replace(/"/g, '\\"')}" ;`);
        if (cfg.command) lines.push(`  porter:command "${cfg.command.replace(/"/g, '\\"')}" ;`);
        lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, ' .');
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  async _subscribeNotifications() {
    try {
      const headResp = await this._fetch(this._resourceUrl, { method: 'HEAD' });
      const linkHeader = headResp.headers.get('link') || '';
      const match = linkHeader.match(/<([^>]+)>;\s*rel="[^"]*updates[^"]*"/i);
      if (!match) return;

      this._eventSource = new EventSource(match[1]);
      this._eventSource.onmessage = () => this._onNotification();
      this._eventSource.onerror = () => {
        setTimeout(() => this._subscribeNotifications(), this._retryDelay);
      };
    } catch (e) { console.error('[porter-pod] Notifications setup failed:', e); }
  }

  async _onNotification() {
    try {
      const resp = await this._fetch(this._resourceUrl);
      if (!resp.ok) return;
      this._lastEtag = resp.headers.get('etag');
      const data = await resp.json();

      // Echo prevention
      if (data._clientId === this._clientId) return;

      this._lastKnownState = data;
      this._applyRemoteState(data);
    } catch (e) { console.error('[porter-pod] Notification fetch failed:', e); }
  }

  _applyRemoteState(data) {
    // Apply models to ModelStore
    if (data.models && Array.isArray(data.models)) {
      const modelStore = document.getElementById('models');
      if (modelStore) {
        const normalized = data.models.map(m => ({
          model_id: m.model_id || m.id,
          base_url: m.base_url || '',
          status: 'valid',
          display_name: m.display_name || m.model_id || m.id,
          capabilities: m.capabilities || {},
          context_window: m.context_window || 0,
          max_tokens: m.max_tokens || 0,
          provider_type: m.provider_type || 'openai_compat',
        }));
        modelStore.setState({ configuredModels: normalized });
        setMODELS(normalized.map(m => m.model_id));
        _updateSetupBar();
      }
      // Also save to server (in ModelConfig format)
      fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._getIdentityHeaders() },
        body: JSON.stringify({ models: data.models }),
      }).catch(() => {});
    }

    // Apply teams if present — sync each to server so /api/teams serves them
    if (data.teams && Array.isArray(data.teams)) {
      localStorage.setItem('porter-pod-teams', JSON.stringify(data.teams));
      for (const t of data.teams) {
        if (t.name && t.config) {
          fetch('/api/teams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ..._getIdentityHeaders() },
            body: JSON.stringify({ name: t.name, config: t.config }),
          }).catch(() => {});
        }
      }
      _updateSetupBar();
    }

    // Apply MCP servers if present (merge: keep local env/secrets, update structure from Pod)
    if (data.mcp_servers && typeof data.mcp_servers === 'object') {
      const configStore = document.getElementById('config');
      if (configStore) {
        const local = configStore.state.mcpServers || {};
        const merged = {};
        for (const [name, remote] of Object.entries(data.mcp_servers)) {
          merged[name] = { ...remote, env: local[name]?.env || {}, auth: remote.auth || local[name]?.auth };
        }
        configStore.setState({ mcpServers: merged });
        _updateSetupBar();
      }
    }

    if (data.published_teams && Array.isArray(data.published_teams)) {
      for (const slug of data.published_teams) {
        fetch('/api/activitypub/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ..._getIdentityHeaders() },
          body: JSON.stringify({ teamSlug: slug }),
        }).catch(() => {});
      }
    }

    if (data.saved_agents && Array.isArray(data.saved_agents)) {
      localStorage.setItem('porter-pod-agents', JSON.stringify(data.saved_agents));
      for (const a of data.saved_agents) {
        if (a.name) {
          fetch('/api/agents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ..._getIdentityHeaders() },
            body: JSON.stringify(a),
          }).catch(() => {});
        }
      }
      _updateSetupBar();
    }
  }
}
