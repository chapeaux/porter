/**
 * Compose area rendering — extracted from app.js
 */

import { sendMessage } from '../connection/bus-client.js';

export function populateTargetDropdown(agents) {
  const group = document.getElementById('compose-agents');
  const target = document.getElementById('compose-target');
  if (!group || !target) return;

  const previousValue = target.value;

  group.replaceChildren();

  let defaultValue = null;

  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = `task:${a.name}`;
    opt.textContent = `@${a.name} (${a.role})`;
    group.appendChild(opt);

    if (!defaultValue && (a.role === 'admin' || /lead|planner/i.test(a.name))) {
      defaultValue = opt.value;
    }
  }

  if (previousValue && target.querySelector(`option[value="${CSS.escape(previousValue)}"]`)) {
    target.value = previousValue;
  } else if (defaultValue) {
    target.value = defaultValue;
  }
}

export function setupCompose() {
  const targetSelect = document.getElementById('compose-target');
  const messageInput = document.getElementById('compose-message');
  const sendBtn = document.getElementById('compose-send');

  sendBtn.addEventListener('click', () => {
    const channel = targetSelect.value;
    const content = messageInput.value.trim();
    if (!content) return;

    sendMessage(channel, content);
    messageInput.value = '';
    messageInput.focus();
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      sendBtn.click();
    }
  });
}
