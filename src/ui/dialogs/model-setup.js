/**
 * Model setup dialog — configure AI model providers.
 */

import { h, replaceContent } from '../dom.js';
import { getDlg, getOverlayDlg } from './dialog-helpers.js';
import { setMODELS } from '../stores/config-store.js';
import { updateSetupBar } from '../features/flipboard-setup.js';
import { syncModelsToPod } from '../sync/sync-helpers.js';

export function renderModelSetup(useOverlay = false) {
  const dlg = useOverlay ? getOverlayDlg() : getDlg();
  const modelStore = document.getElementById('models');

  dlg.openTemplate('tpl-model-setup', {
    title: 'Model Setup',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#model-dialog-body');
      const closeBtn = dlg.footerEl.querySelector('#model-dialog-close');
      closeBtn?.addEventListener('click', () => dlg.close());

      // Fetch full ModelConfig[] from /api/models
      fetch('/api/models')
        .then(r => r.json())
        .then(data => {
          const models = data.models || [];

          const editor = h('cpx-model-config', { id: 'model-config-editor' });
          replaceContent(body, editor);
          editor.models = models;

          // Handle model changes -- save to server
          editor.addEventListener('models-change', async (e) => {
            try {
              await fetch('/api/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ models: e.detail.models }),
              });
              // Refresh the ModelStore and setup bar
              await modelStore?.refresh();
              const available = modelStore?.getAvailable() || [];
              setMODELS(available.map(m => m.model_id));
              updateSetupBar();
              syncModelsToPod(e.detail.models);
            } catch (err) {
              console.error('Failed to save models:', err);
            }
          });

          // Handle validation requests
          editor.addEventListener('model-validate', async (e) => {
            const model = e.detail.model;
            try {
              const resp = await fetch('/api/models/validate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model_id: model.id,
                  base_url: model.base_url,
                  provider_type: model.provider_type,
                  auth: model.auth,
                  api_key: model.api_key_env || '',
                  chat_endpoint: model.chat_endpoint || undefined,
                }),
                signal: AbortSignal.timeout(30000),
              });
              const result = await resp.json();
              editor.setValidationResult({
                model_id: model.id,
                success: result.ok === true,
                error: result.error,
              });
            } catch (err) {
              editor.setValidationResult({
                model_id: model.id,
                success: false,
                error: err.message || 'Connection failed',
              });
            }
          });
        })
        .catch(() => {
          replaceContent(body, h('p', null, 'Failed to load models.'));
        });
    },
  });
}
