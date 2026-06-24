/**
 * Sync helper functions — Pod synchronisation utilities.
 *
 * Dependencies on app.js (resolved at runtime via callbacks):
 *   - getDlg() — used by showReloginPrompt()
 *   - updateSetupBar() — used by initPodSync()
 *
 * Note: injectMcpTokens lives in ../stores/config-store.js (already extracted).
 */

import { classifyMcpContext, classifyModelContext } from '../constants.js';
import { h, replaceContent } from '../dom.js';
import { PorterPodSync } from './pod-sync.js';

/**
 * Callback registry — app.js injects these after import so the helpers
 * can call back into app-level functions without a circular import.
 */
let _getDlg = () => document.getElementById('porter-dlg');
let _updateSetupBar = () => {};

export function setSyncHelpersCallbacks({ getDlg, updateSetupBar }) {
  if (getDlg) _getDlg = getDlg;
  if (updateSetupBar) _updateSetupBar = updateSetupBar;
}

export function syncToPod(key, value) {
  if (!window._podSync) return;
  window._podSync.save(key, value);
}

export async function syncAgentsToPod(agents) {
  if (!window._podSync) {
    // Pod sync not initialized — skip silently
    return;
  }
  const podRoot = window._podSync._podRoot;
  const authFetch = window._podSync._fetch;

  // Ensure agents/ container exists
  const containerUrl = `${podRoot}porter/agents/`;
  await ensureContainer(authFetch, containerUrl);

  // Write each agent as a Turtle file
  for (const agent of agents) {
    const name = agent.name;
    if (!name) continue;
    const url = `${podRoot}porter/agents/${encodeURIComponent(name)}.ttl`;
    const turtle = agentToTurtle(agent, url);
    try {
      const resp = await authFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`[porter-pod] PUT failed: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error(`[porter-pod] PUT error:`, err);
    }
  }

  // Don't delete orphans here — the server may not have all agents yet
  // (e.g., fresh pod hasn't loaded from Pod yet). Deletion only happens
  // via explicit deleteAgentFromPod().
}

export async function deleteAgentFromPod(agentName) {
  if (!window._podSync) return;
  const podRoot = window._podSync._podRoot;
  const authFetch = window._podSync._fetch;
  const url = `${podRoot}porter/agents/${encodeURIComponent(agentName)}.ttl`;
  await authFetch(url, { method: 'DELETE' }).catch(() => {});
}

export async function syncTeamsToPod() {
  if (!window._podSync) return;
  const podRoot = window._podSync._podRoot;
  const authFetch = window._podSync._fetch;

  try {
    const resp = await fetch('/api/teams');
    if (!resp.ok) return;
    const data = await resp.json();
    const teams = data.teams || [];

    // Ensure teams/ container exists
    await ensureContainer(authFetch, `${podRoot}porter/teams/`);

    // Get existing team files on Pod
    const existingFiles = await listContainer(authFetch, `${podRoot}porter/teams/`);
    const teamNames = new Set(teams.map(t => t.name).filter(Boolean));

    // Write each team as a Turtle file
    for (const team of teams) {
      if (!team.name) continue;
      const url = `${podRoot}porter/teams/${encodeURIComponent(team.name)}.ttl`;
      const turtle = teamToTurtle(team, url);
      await authFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle,
      });
    }

    // Don't delete orphans — same reason as agents
  } catch { /* best-effort */ }
}

export function syncModelsToPod(models) {
  const tagged = (models || []).map(m => ({ ...m, _context: classifyModelContext(m) }));
  syncToPod('models', tagged);
}

export async function syncPublishedTeamsToPod() {
  if (!window._podSync) return;
  try {
    const resp = await fetch('/api/activitypub/teams');
    if (resp.ok) {
      const data = await resp.json();
      const slugs = (data.teams || []).map(t => t.teamSlug || t.slug || t.name);
      syncToPod('published_teams', slugs);
    }
  } catch { /* best-effort */ }
}

export function syncMcpToPod() {
  if (!window._podSync) return;
  const configStore = document.getElementById('config');
  const servers = configStore?.state?.mcpServers ?? {};
  const safe = {};
  for (const [name, cfg] of Object.entries(servers)) {
    safe[name] = { name: cfg.name, transport: cfg.transport, url: cfg.url, command: cfg.command, args: cfg.args, auth: cfg.auth, _context: classifyMcpContext(cfg) };
  }
  syncToPod('mcp_servers', safe);
}

export function showReloginPrompt() {
  const lastIdp = localStorage.getItem('porter-solid-last-idp');
  if (!lastIdp) return;

  const dlg = _getDlg();
  dlg.openTemplate('tpl-onboarding', {
    title: 'Session Expired',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#onboarding-body');

      const issuerInput = h('input', { type: 'url', id: 'relogin-issuer', class: 'auth-input', value: lastIdp, style: 'flex:1' });
      const loginBtn = h('button', { id: 'relogin-btn', class: 'team-btn primary' }, 'Login');
      const dismissBtn = h('button', { id: 'relogin-dismiss', class: 'team-btn secondary' }, 'Continue without Pod sync');

      replaceContent(body,
        h('div', { class: 'team-explanation' },
          h('strong', null, 'Session Expired'),
          h('p', null, 'Your Solid session has expired. Log in again to continue syncing to your Pod.')
        ),
        h('div', { class: 'onboarding-options' },
          h('div', { class: 'onboarding-option' },
            h('div', { style: 'display:flex;gap:0.4rem' },
              issuerInput,
              loginBtn
            )
          ),
          h('div', { class: 'onboarding-option', style: 'margin-top:0.5rem' },
            dismissBtn
          )
        )
      );

      loginBtn.addEventListener('click', () => {
        const issuer = issuerInput.value.trim();
        if (issuer && issuer.startsWith('http')) {
          localStorage.setItem('porter-solid-last-idp', issuer);
          window.solidAuth.solidLogin(issuer, window.location.href);
        }
      });
      dismissBtn.addEventListener('click', () => {
        dlg.close();
      });
    },
  });
}

export async function initPodSync(webId) {
  if (window._podSync) return;
  const lastWebId = localStorage.getItem('porter-last-webid');
  if (lastWebId && lastWebId !== webId) {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
    localStorage.removeItem('porter-pod-teams');
    localStorage.removeItem('porter-pod-agents');
  }
  localStorage.setItem('porter-last-webid', webId);
  try {
    const podRoot = await window.solidAuth.discoverPodStorage(webId);
    if (!podRoot) { console.error('[porter-pod] Could not discover Pod storage for', webId); return; }
    const authFetch = window.solidAuth.getAuthFetch();
    const sync = new PorterPodSync(podRoot, authFetch);
    window._podSync = sync;
    await sync.connect();
    await document.getElementById('models')?.refresh();
    _updateSetupBar();
    // Full sync of agents and teams to Pod on connect
    _syncAllToPod();
  } catch (e) { console.error('[porter-pod] Sync init failed:', e); }
}

export async function initSsoPodSync(podUrl, tokenEndpoint) {
  if (window._podSync) return;
  if (!tokenEndpoint) {
    console.error('[porter-pod] SSO Pod sync requires tokenEndpoint');
    return;
  }
  try {
    let accessToken = await exchangeLwsToken(tokenEndpoint);
    let tokenExpiry = Date.now() + 3500_000;

    const authFetch = async (url, opts = {}) => {
      if (Date.now() > tokenExpiry) {
        accessToken = await exchangeLwsToken(tokenEndpoint);
        tokenExpiry = Date.now() + 3500_000;
      }
      return fetch(url, {
        ...opts,
        headers: {
          ...(opts.headers || {}),
          'Authorization': `Bearer ${accessToken}`,
        },
      });
    };

    const sync = new PorterPodSync(podUrl, authFetch);
    window._podSync = sync;
    await sync.connect();
    await document.getElementById('models')?.refresh();
    _updateSetupBar();
    // Full sync of agents and teams to Pod on connect
    _syncAllToPod();
  } catch (e) { console.error('[porter-pod] SSO Pod sync init failed:', e); }
}

async function _syncAllToPod() {
  try {
    const agentsResp = await fetch('/api/agents');
    if (agentsResp.ok) {
      const data = await agentsResp.json();
      if (data.agents?.length) {
        await syncAgentsToPod(data.agents);
      }
    }
    await syncTeamsToPod();
  } catch (e) {
    console.error('[porter-pod] Full sync on connect failed:', e);
  }
}

async function exchangeLwsToken(tokenEndpoint) {
  const resp = await fetch(tokenEndpoint, { method: 'POST' });
  if (resp.status === 401) {
    throw new Error('LWS token exchange returned 401');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LWS token exchange failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return data.access_token;
}

export async function syncMemoryToPod(sessionName) {
  if (!window._podSync) return;
  try {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/memory`);
    if (resp.ok) {
      const turtle = await resp.text();
      if (turtle.trim()) {
        await window._podSync.saveMemory(sessionName, turtle);
      }
    }
  } catch (e) { console.error('[porter-pod] Memory sync to pod failed:', e); }
}

export async function restoreMemoryFromPod(sessionName) {
  if (!window._podSync) return;
  try {
    const turtle = await window._podSync.loadMemory(sessionName);
    if (turtle && turtle.trim()) {
      await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle,
      });
    }
  } catch (e) { console.error('[porter-pod] Memory restore from pod failed:', e); }
}

// --- Solid Pod container helpers ---

export async function ensureContainer(authFetch, url) {
  const containerTypes = [
    '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    '<https://www.w3.org/ns/lws#Container>; rel="type"',
  ];
  for (const linkType of containerTypes) {
    try {
      const resp = await authFetch(url, {
        method: 'PUT',
        headers: { 'Link': linkType, 'Content-Type': 'text/turtle' },
        body: '',
      });
      if (resp.ok || resp.status === 201 || resp.status === 409) return;
    } catch (err) {
      console.error(`[porter-pod] ensureContainer error:`, err);
    }
  }
}

export async function listContainer(authFetch, url) {
  try {
    const resp = await authFetch(url, { headers: { 'Accept': 'text/turtle' } });
    if (!resp.ok) return [];
    const text = await resp.text();
    // Extract all URIs from ldp:contains — handles both single and comma-separated lists
    // Match everything from ldp:contains until " ." (space-dot) which ends the Turtle statement
    // Can't use [^.]+ because URLs contain dots
    const containsMatch = text.match(/ldp:contains\s+([\s\S]+?)\s+\./m);
    if (!containsMatch) {
      return [];
    }
    const uriMatches = [...containsMatch[1].matchAll(/<([^>]+)>/g)];
    const files = uriMatches.map(m => decodeURIComponent(m[1].split('/').pop())).filter(Boolean);
    return files;
  } catch (err) {
    console.error(`[porter-pod] listContainer error:`, err);
    return [];
  }
}

// --- Turtle serializers (client-side, matching porter: vocabulary) ---

function escapeTtl(s) {
  return (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function agentToTurtle(agent, uri) {
  // Normalize field names (accept both camelCase and snake_case)
  const name = agent.name || '';
  const expertise = agent.systemPrompt || agent.system_prompt || '';
  const tools = agent.tools || [];
  const mcpTools = agent.mcpTools || agent.mcp_tools || [];
  const model = agent.model || '';
  const maxTokens = agent.maxTokens || agent.max_tokens || 0;
  const reasoning = agent.reasoning || false;
  const role = agent.role || 'worker';
  const visibility = agent.visibility || 'private';
  const channels = agent.channels || agent.subscribe || [];

  const lines = [
    '@prefix porter: <https://porter.chapeaux.io/vocab#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `<${uri}> a porter:Agent ;`,
    `  porter:name "${escapeTtl(name)}" ;`,
    `  porter:assignedRole "${escapeTtl(role)}" ;`,
  ];

  if (expertise) {
    lines.push(`  porter:agentExpertise """${escapeTtl(expertise)}""" ;`);
  }

  for (const t of tools) {
    lines.push(`  porter:hasTool "${escapeTtl(t)}" ;`);
  }
  for (const t of mcpTools) {
    lines.push(`  porter:hasMcpTool "${escapeTtl(t)}" ;`);
  }
  for (const ch of channels) {
    lines.push(`  porter:subscribesTo "${escapeTtl(ch)}" ;`);
  }

  if (model) lines.push(`  porter:usesModel "${escapeTtl(model)}" ;`);
  if (maxTokens) lines.push(`  porter:maxTokens "${maxTokens}"^^xsd:integer ;`);
  if (reasoning) lines.push(`  porter:reasoning "true"^^xsd:boolean ;`);
  if (visibility !== 'private') lines.push(`  porter:visibility "${escapeTtl(visibility)}" ;`);

  // Replace last ; with .
  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = lastLine.replace(/\s;$/, ' .');

  return lines.join('\n') + '\n';
}

export function teamToTurtle(team, uri) {
  const name = team.name || '';
  const config = team.config || {};
  const pattern = config.pattern || '';
  const agents = config.agents || [];
  const mcpServers = config.mcp_servers || {};

  const lines = [
    '@prefix porter: <https://porter.chapeaux.io/vocab#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `<${uri}> a porter:Team ;`,
    `  porter:name "${escapeTtl(name)}" ;`,
  ];

  if (pattern) {
    lines.push(`  porter:teamPattern "${escapeTtl(pattern)}" ;`);
  }

  for (const a of agents) {
    const ref = a.ref || a.name || '';
    const role = a.role || 'worker';
    const model = a.model || '';
    let bnode = `[ porter:agentRef "${escapeTtl(ref)}" ; porter:assignedRole "${escapeTtl(role)}"`;
    if (model) bnode += ` ; porter:usesModel "${escapeTtl(model)}"`;
    bnode += ' ]';
    lines.push(`  porter:hasAgentRef ${bnode} ;`);
  }

  // Embed MCP server config as JSON for round-tripping
  if (Object.keys(mcpServers).length > 0) {
    const mcpJson = JSON.stringify(mcpServers);
    lines.push(`  porter:mcpServersJson """${escapeTtl(mcpJson)}""" ;`);
  }

  // Include full config JSON for lossless round-trip
  const configJson = JSON.stringify(config);
  lines.push(`  porter:configJson """${escapeTtl(configJson)}""" ;`);

  // Replace trailing ; with .
  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = lastLine.replace(/\s;$/, ' .');

  return lines.join('\n') + '\n';
}

// --- Turtle parsers (simple regex-based, no full RDF parser) ---

export function parseTurtleAgent(turtle) {
  if (!turtle) return null;
  // Normalize full IRIs to prefixed form for simpler regex matching
  const NS = 'https://porter.chapeaux.io/vocab#';
  const norm = turtle.replace(new RegExp(`<${NS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^>]+)>`, 'g'), 'porter:$1');
  if (!norm.includes('porter:Agent')) return null;

  const extractLiteral = (predicate) => {
    // Handle triple-quoted strings
    const longMatch = norm.match(new RegExp(`${predicate}\\s+"""((?:[^"]|"(?!""))*?)"""`, 's'));
    if (longMatch) return longMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    // Handle single-quoted strings
    const shortMatch = norm.match(new RegExp(`${predicate}\\s+"([^"]*?)"`));
    if (shortMatch) return shortMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return '';
  };

  const extractAll = (predicate) => {
    const results = [];
    // Find all blocks starting with the predicate and ending with ; or .
    // Handles both repeated predicates and comma-separated values:
    //   porter:hasTool "a" ;        (separate lines)
    //   porter:hasTool "a", "b" ;   (comma-separated)
    const blockRe = new RegExp(`${predicate}\\s+([^;.]+)[;.]`, 'gs');
    let blockMatch;
    while ((blockMatch = blockRe.exec(norm)) !== null) {
      const valRe = /"([^"]*?)"/g;
      let m;
      while ((m = valRe.exec(blockMatch[1])) !== null) {
        const val = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (!results.includes(val)) results.push(val);
      }
    }
    return results;
  };

  const name = extractLiteral('porter:name');
  if (!name) return null;

  const agent = {
    name,
    role: extractLiteral('porter:assignedRole') || 'worker',
    systemPrompt: extractLiteral('porter:agentExpertise'),
    tools: extractAll('porter:hasTool'),
    mcpTools: extractAll('porter:hasMcpTool'),
    channels: extractAll('porter:subscribesTo'),
    model: extractLiteral('porter:usesModel'),
    maxTokens: parseInt(extractLiteral('porter:maxTokens'), 10) || 8192,
    reasoning: extractLiteral('porter:reasoning') === 'true',
    visibility: extractLiteral('porter:visibility') || 'private',
  };

  return agent;
}

export function parseTurtleTeam(turtle) {
  if (!turtle) return null;
  const NS = 'https://porter.chapeaux.io/vocab#';
  const norm = turtle.replace(new RegExp(`<${NS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^>]+)>`, 'g'), 'porter:$1');
  if (!norm.includes('porter:Team')) return null;

  const extractLiteral = (predicate) => {
    const longMatch = norm.match(new RegExp(`${predicate}\\s+"""((?:[^"]|"(?!""))*?)"""`, 's'));
    if (longMatch) return longMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const shortMatch = norm.match(new RegExp(`${predicate}\\s+"([^"]*?)"`));
    if (shortMatch) return shortMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return '';
  };

  const name = extractLiteral('porter:name');
  if (!name) return null;

  // Try to restore full config from configJson if present
  const configJson = extractLiteral('porter:configJson');
  if (configJson) {
    try {
      const config = JSON.parse(configJson);
      return { name, config };
    } catch { /* fall through to field-by-field parsing */ }
  }

  // Field-by-field parsing fallback
  const pattern = extractLiteral('porter:teamPattern');
  const agents = [];
  const agentRefRe = /porter:hasAgentRef\s+\[\s*porter:agentRef\s+"([^"]*?)"\s*;\s*porter:assignedRole\s+"([^"]*?)"(?:\s*;\s*porter:usesModel\s+"([^"]*?)")?\s*\]/g;
  let m;
  while ((m = agentRefRe.exec(turtle)) !== null) {
    const entry = { name: m[1], ref: m[1], role: m[2] };
    if (m[3]) entry.model = m[3];
    agents.push(entry);
  }

  let mcpServers = {};
  const mcpJson = extractLiteral('porter:mcpServersJson');
  if (mcpJson) {
    try { mcpServers = JSON.parse(mcpJson); } catch { /* ignore */ }
  }

  return {
    name,
    config: { pattern, agents, mcp_servers: mcpServers },
  };
}

// --- ACL helpers for sharing individual resources ---

export async function setResourcePublic(authFetch, resourceUrl) {
  const aclUrl = resourceUrl + '.acl';
  // Determine owner WebID from Pod sync context
  const ownerWebId = window._podSyncWebId || '';
  const acl = [
    '@prefix acl: <http://www.w3.org/ns/auth/acl#> .',
    '@prefix foaf: <http://xmlns.com/foaf/0.1/> .',
    '',
    '<#public>',
    '  a acl:Authorization ;',
    '  acl:agentClass foaf:Agent ;',
    `  acl:accessTo <${resourceUrl}> ;`,
    '  acl:mode acl:Read .',
    '',
    '<#owner>',
    '  a acl:Authorization ;',
    ...(ownerWebId ? [`  acl:agent <${ownerWebId}> ;`] : ['  acl:agentClass foaf:Agent ;']),
    `  acl:accessTo <${resourceUrl}> ;`,
    '  acl:mode acl:Read, acl:Write, acl:Control .',
  ].join('\n') + '\n';

  await authFetch(aclUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body: acl,
  });
}

export async function setResourcePrivate(authFetch, resourceUrl) {
  const aclUrl = resourceUrl + '.acl';
  await authFetch(aclUrl, { method: 'DELETE' }).catch(() => {});
}
