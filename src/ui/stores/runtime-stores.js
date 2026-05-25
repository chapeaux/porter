import { CPXStore } from '../cpx-store.js';

// ---------------------------------------------------------------------------
// Runtime Stores — ConnectionStore, AgentStore, MessageStore
// ---------------------------------------------------------------------------

export class ConnectionStore extends CPXStore {
  constructor() {
    super({
      status: 'disconnected',
      url: '',
      lastHeartbeat: null,
      reconnectAttempts: 0,
    });
  }
  setConnecting(url) { this.state.status = 'connecting'; this.state.url = url; }
  setConnected()     { this.state.status = 'connected'; this.state.reconnectAttempts = 0; }
  setDisconnected()  { this.state.status = 'disconnected'; }
  heartbeat()        { this.state.lastHeartbeat = Date.now(); }
  incrementRetry()   { this.state.reconnectAttempts = this.state.reconnectAttempts + 1; }
}
customElements.define('connection-store', ConnectionStore);

export class AgentStore extends CPXStore {
  constructor() {
    super({ agents: {} });
  }
  connectedCallback() {
    super.connectedCallback();
    const key = this.getAttribute('persist');
    if (key) {
      try {
        const saved = localStorage.getItem(key);
        if (saved) {
          const data = JSON.parse(saved);
          if (data.agents) {
            this._isInternalChange = true;
            this.state.agents = data.agents;
            this._isInternalChange = false;
          }
        }
      } catch { /* corrupt data, start fresh */ }
    }
  }
  /** Register an agent from the roster (with role, model, tools). */
  register(name, info) {
    const current = this.state.agents[name] || {
      role: 'unknown', status: 'active', lastActivity: null,
      messageCount: 0, model: '', tools: [], activity: [],
    };
    this._isInternalChange = true;
    this.state.agents = {
      ...this.state.agents,
      [name]: { ...current, ...info },
    };
    this._isInternalChange = false;
  }
  /** Record agent activity (tool call, text, result, etc). */
  addActivity(name, entry) {
    const current = this.state.agents[name] || {
      role: 'unknown', status: 'active', lastActivity: null,
      messageCount: 0, model: '', tools: [], activity: [],
    };
    const activity = [...current.activity, entry].slice(-50);
    // Clear transient 'retrying' status when normal activity resumes
    const status = (current.status === 'retrying' && entry.type !== 'retrying')
      ? 'active'
      : current.status;
    this._isInternalChange = true;
    this.state.agents = {
      ...this.state.agents,
      [name]: {
        ...current,
        status,
        lastActivity: Date.now(),
        messageCount: current.messageCount + 1,
        activity,
      },
    };
    this._isInternalChange = false;
  }
  /** Mark an agent as done. */
  markDone(name) {
    const current = this.state.agents[name];
    if (!current) return;
    this._isInternalChange = true;
    this.state.agents = {
      ...this.state.agents,
      [name]: { ...current, status: 'done' },
    };
    this._isInternalChange = false;
  }
  /** Mark an agent as retrying (transient error, will recover). */
  markRetrying(name) {
    const current = this.state.agents[name];
    if (!current) return;
    this._isInternalChange = true;
    this.state.agents = {
      ...this.state.agents,
      [name]: { ...current, status: 'retrying' },
    };
    this._isInternalChange = false;
  }
  /** Mark an agent as errored. */
  markError(name) {
    const current = this.state.agents[name];
    if (!current) return;
    this._isInternalChange = true;
    this.state.agents = {
      ...this.state.agents,
      [name]: { ...current, status: 'error' },
    };
    this._isInternalChange = false;
  }
}
customElements.define('agent-store', AgentStore);

export class MessageStore extends CPXStore {
  constructor() {
    super({ messages: [], filter: 'all', maxMessages: 500 });
  }
  connectedCallback() {
    super.connectedCallback();
    const key = this.getAttribute('persist');
    if (key) {
      try {
        const saved = localStorage.getItem(key);
        if (saved) {
          const data = JSON.parse(saved);
          if (data.messages) {
            this._isInternalChange = true;
            this.state.messages = data.messages;
            this._isInternalChange = false;
          }
          // Don't restore filter -- always start on 'all'
        }
      } catch { /* corrupt data, start fresh */ }
    }
  }
  add(msg) {
    const msgs = [...this.state.messages, msg];
    if (msgs.length > this.state.maxMessages) msgs.shift();
    this._isInternalChange = true;
    this.state.messages = msgs;
    this._isInternalChange = false;
  }
  setFilter(channel) {
    this.state.filter = channel;
  }
  toggleFilter(channel) {
    const current = this.state.activeFilters || new Set(['log', 'task', 'control', 'activity']);
    if (channel === 'all') {
      this.state.activeFilters = new Set(['log', 'task', 'control', 'activity']);
    } else if (current.has(channel)) {
      current.delete(channel);
      this.state.activeFilters = new Set(current);
    } else {
      current.add(channel);
      this.state.activeFilters = new Set(current);
    }
    this.state.filter = 'toggle';
  }
}
customElements.define('message-store', MessageStore);
