/**
 * Filter button setup — extracted from app.js
 */

import { renderTimeline } from './timeline.js';

export function setupFilters() {
  document.querySelectorAll('.channel-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      const channel = btn.dataset.channel;
      const store = document.getElementById('messages');
      if (channel === 'all') {
        document.querySelectorAll('.channel-filter').forEach(b => b.classList.add('active'));
        store.toggleFilter('all');
      } else {
        btn.classList.toggle('active');
        document.querySelector('.channel-filter[data-channel="all"]')?.classList.remove('active');
        store.toggleFilter(channel);
      }
    });
  });

  document.getElementById('feed-limit')?.addEventListener('change', () => {
    renderTimeline();
  });
}
