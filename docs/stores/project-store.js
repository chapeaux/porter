import { CPXStore } from '../cpx-store.js';
import { syncMemoryToPod } from '../sync/sync-helpers.js';

// =========================================================================
// ProjectStore — multi-project session management
// =========================================================================

export class ProjectStore extends CPXStore {
  constructor() {
    super({
      sessions: [],           // SessionRecord[] from registry API
      activeSession: null,    // currently connected session name
      loading: false,
    });
  }

  setState(patch) {
    for (const [key, val] of Object.entries(patch)) {
      this.state[key] = val;
    }
  }

  setSessions(list) { this.setState({ sessions: list }); }
  setActive(session) { this.setState({ activeSession: session }); }
  setLoading(v) { this.setState({ loading: v }); }

  async refresh() {
    this.setLoading(true);
    try {
      const resp = await fetch('/api/sessions');
      if (resp.ok) {
        const data = await resp.json();
        this.setSessions(data.sessions || []);
      }
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
    }
    this.setLoading(false);
  }

  async stopSession(name) {
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(name)}/stop`, { method: 'POST' });
      if (resp.ok) {
        syncMemoryToPod(name);
        await this.refresh();
      }
    } catch (e) {
      console.error('Failed to stop session:', e);
    }
  }
}

customElements.define('project-store', ProjectStore);
