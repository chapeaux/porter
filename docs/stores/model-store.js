import { CPXStore } from '../cpx-store.js';

// =========================================================================
// ModelStore — configured model credentials
// =========================================================================

export class ModelStore extends CPXStore {
  constructor() {
    super({
      configuredModels: [],   // [{ model_id, base_url, credential_name, status }]
      loading: false,
    });
  }

  setState(patch) {
    for (const [key, val] of Object.entries(patch)) {
      this.state[key] = val;
    }
  }

  async refresh() {
    this.setState({ loading: true });
    try {
      const resp = await fetch('/api/models/available');
      if (resp.ok) {
        const data = await resp.json();
        this.setState({ configuredModels: data.models || [] });
      }
    } catch (e) {
      console.error('Failed to fetch available models:', e);
    }
    this.setState({ loading: false });
  }

  getAvailable() {
    return this.state.configuredModels.filter(m => m.status === 'valid');
  }

  isAvailable(modelId) {
    return this.state.configuredModels.some(m => m.model_id === modelId && m.status === 'valid');
  }
}

customElements.define('model-store', ModelStore);
