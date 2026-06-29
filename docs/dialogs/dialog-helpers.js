/**
 * Dialog helpers — primary and overlay dialog accessors, query helpers.
 */

/** Primary dialog instance — team builder, model setup, session launcher, etc. */
export function getDlg() { return document.getElementById('porter-dlg'); }

/** Overlay dialog instance — agent editor, credentials, MCP editor (opens on top). */
export function getOverlayDlg() { return document.getElementById('porter-dlg-overlay'); }

/** Query across all shadow-DOM containers of the primary dialog. */
export function dlgQuery(selector) {
  const dlg = getDlg();
  return dlg.bodyEl.querySelector(selector)
    || dlg.footerEl.querySelector(selector)
    || dlg.headerExtra.querySelector(selector);
}

/** Query across all shadow-DOM containers of the overlay dialog. */
export function overlayDlgQuery(selector) {
  const dlg = getOverlayDlg();
  return dlg.bodyEl.querySelector(selector)
    || dlg.footerEl.querySelector(selector)
    || dlg.headerExtra.querySelector(selector);
}

export function showDialog(title, content) {
  const dlg = getDlg();
  dlg.openTemplate('tpl-detail', { title });
  const body = dlg.bodyEl.querySelector('#dialog-body');
  body.textContent = content;
}

export function setupDialog() {
  // porter-dialog handles close button and backdrop clicks internally
}
