/**
 * WebSocket bus client — connection management, message handling, reconnect logic.
 *
 * Dependencies on app.js (resolved at runtime via callbacks):
 *   - populateTargetDropdown() — called when roster is first received
 */

import { RECONNECT_DELAYS, summarizeParams } from '../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUS_URL_RAW = document.querySelector('meta[name="bus-url"]')?.content || 'ws://localhost:8787';
// Resolve relative paths (e.g. "/ws" injected by the server proxy) to full WebSocket URLs.
// Relative paths mean: same host, same port, but ws: for http: origins and wss: for https:.
const BUS_URL = BUS_URL_RAW.startsWith('/')
  ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${BUS_URL_RAW}`
  : BUS_URL_RAW;
const SUBSCRIBER_ID = 'porter-ui-' + Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------

export let ws = null;
export let heartbeatTimer = null;
export let reconnectTimer = null;
export let rosterReceived = false;
export let activeBusUrl = BUS_URL;

/** Reset mutable state — used by app.js when switching sessions. */
export function resetBusState() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    ws.onclose = () => {};
    ws.close();
    ws = null;
  }
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  rosterReceived = false;
}

// ---------------------------------------------------------------------------
// Callback registry — app.js injects populateTargetDropdown after import
// ---------------------------------------------------------------------------

let _populateTargetDropdown = () => {};

export function setBusClientCallbacks({ populateTargetDropdown }) {
  if (populateTargetDropdown) _populateTargetDropdown = populateTargetDropdown;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export function connectWebSocket(url) {
  // Close previous connection cleanly — prevents the lobby's empty roster
  // from blocking the real session's roster via the rosterReceived flag,
  // and prevents orphan WebSockets from triggering spurious reconnects.
  if (ws) {
    ws.onclose = () => {};  // suppress auto-reconnect from old WS closing
    ws.close();
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearInterval(heartbeatTimer);
  rosterReceived = false;  // CRITICAL: reset so new session's roster triggers populateTargetDropdown

  activeBusUrl = url || activeBusUrl;
  const conn = document.getElementById('connection');
  conn.setConnecting(activeBusUrl);

  ws = new WebSocket(activeBusUrl);

  ws.onopen = () => {
    conn.setConnected();
    // Subscribe to all channels including activity
    ws.send(JSON.stringify({
      type: 'subscribe',
      subscriberId: SUBSCRIBER_ID,
      channels: ['task', 'log', 'control', 'activity'],
    }));
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
      }
    }, 30000);
  };

  ws.onmessage = (event) => {
    try {
      const wire = JSON.parse(event.data);
      handleWireMessage(wire);
    } catch { /* malformed */ }
  };

  ws.onclose = () => {
    conn.setDisconnected();
    clearInterval(heartbeatTimer);
    rosterReceived = false;
    scheduleReconnect();
  };

  ws.onerror = () => { /* onclose fires after */ };
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleWireMessage(wire) {
  if (wire.type !== 'publish' || !wire.channel) return;

  if (wire.channel === 'activity') {
    handleActivityMessage(wire.content);
    return;
  }

  // Filter out internal control messages (tool injection)
  if (wire.channel === 'control' && wire.content) {
    try {
      const cmd = JSON.parse(wire.content);
      if (cmd.action === 'add_tool' || cmd.action === 'remove_tool') return;
    } catch { /* not JSON, show it */ }
  }

  if (wire.content) {
    let from = wire.from || 'unknown';
    if (typeof from === 'object') from = from.name || from.id || JSON.stringify(from);
    const msg = {
      channel: wire.channel,
      from,
      content: wire.content,
      timestamp: wire.timestamp || Date.now(),
    };
    document.getElementById('messages').add(msg);

    if (msg.from && msg.from !== 'porter-cli' && msg.from !== SUBSCRIBER_ID) {
      document.getElementById('agents').register(msg.from, {});
    }
  }

  if (wire.type === 'heartbeat') {
    document.getElementById('connection').heartbeat();
  }
}

function handleActivityMessage(content) {
  if (!content) return;
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return;
  }

  const agentStore = document.getElementById('agents');
  const msgStore = document.getElementById('messages');
  const now = Date.now();

  switch (data.event) {
    case 'roster':
      // Register all agents with their full info
      for (const a of data.agents || []) {
        agentStore.register(a.name, {
          role: a.role,
          model: a.model || '',
          tools: a.tools || [],
          status: 'active',
        });
      }
      // Only populate dropdown and resubscribe once per connection
      // to avoid resetting user's selection and creating a feedback loop
      if (!rosterReceived) {
        rosterReceived = true;
        _populateTargetDropdown(data.agents || []);
        resubscribeWithAgents(data.agents || []);
      }
      break;

    case 'text':
      agentStore.addActivity(data.agent, {
        type: 'text', text: data.text, time: now,
      });
      // Also add to the message feed
      msgStore.add({
        channel: 'activity',
        from: data.agent,
        content: data.text,
        timestamp: now,
      });
      break;

    case 'tool_call':
      agentStore.addActivity(data.agent, {
        type: 'tool_call', tool: data.tool, params: data.params, time: now,
      });
      msgStore.add({
        channel: 'activity',
        from: data.agent,
        content: `> ${data.tool}(${summarizeParams(data.params)})`,
        timestamp: now,
      });
      break;

    case 'tool_result':
      agentStore.addActivity(data.agent, {
        type: 'tool_result', tool: data.tool, ok: data.ok, output: data.output, time: now,
      });
      break;

    case 'retrying':
      agentStore.addActivity(data.agent, {
        type: 'retrying', message: data.message,
        attempt: data.attempt, delay: data.delay, time: now,
      });
      agentStore.markRetrying(data.agent);
      msgStore.add({
        channel: 'activity',
        from: data.agent,
        content: `RETRYING (${data.attempt}): ${data.message} -- waiting ${Math.round(data.delay / 1000)}s`,
        timestamp: now,
      });
      break;

    case 'error':
      agentStore.addActivity(data.agent, {
        type: 'error', message: data.message, time: now,
      });
      agentStore.markError(data.agent);
      msgStore.add({
        channel: 'activity',
        from: data.agent,
        content: `ERROR: ${data.message}`,
        timestamp: now,
      });
      break;

    case 'done':
      agentStore.addActivity(data.agent, {
        type: 'done', time: now,
      });
      agentStore.markDone(data.agent);
      break;
  }
}

export function resubscribeWithAgents(agents) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const channels = ['task', 'log', 'control', 'activity'];
  for (const a of agents) {
    channels.push(`task:${a.name}`);
  }
  ws.send(JSON.stringify({
    type: 'subscribe',
    subscriberId: SUBSCRIBER_ID,
    channels,
  }));
}

export function scheduleReconnect() {
  const conn = document.getElementById('connection');
  const attempt = conn.state.reconnectAttempts;
  const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
  conn.incrementRetry();
  reconnectTimer = setTimeout(connectWebSocket, delay);
}

export function sendMessage(channel, content) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'publish',
    channel,
    content,
    from: 'porter-ui',
  }));
}
