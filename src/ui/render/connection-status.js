/**
 * Connection status rendering — extracted from app.js
 */

export function renderConnectionStatus() {
  const conn = document.getElementById('connection');
  const cell = document.getElementById('fb-status');
  const val = document.getElementById('fb-status-val');
  if (!cell || !val) return;

  const { status, reconnectAttempts } = conn.state;

  if (status === 'connected') {
    val.textContent = 'YES';
    cell.setAttribute('status', 'ok');
  } else if (status === 'connecting') {
    val.textContent = 'CONNECTING';
    cell.setAttribute('status', 'warn');
  } else {
    val.textContent = reconnectAttempts > 0 ? `RETRY ${reconnectAttempts}` : 'NO';
    cell.setAttribute('status', 'error');
  }
}
