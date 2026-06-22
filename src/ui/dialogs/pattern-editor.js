/**
 * Pattern Editor — visual SVG-based editor for designing collaboration patterns.
 *
 * Two-panel dialog:
 *   Left:  SVG canvas with draggable nodes and connectable edges
 *   Right: Properties panel for the selected node + pattern properties
 */

import { h, replaceContent } from '../dom.js';
import { getOverlayDlg, overlayDlgQuery } from './dialog-helpers.js';

/** @typedef {{ id: string, type: 'role'|'channel', x: number, y: number, data: object }} EditorNode */
/** @typedef {{ from: string, to: string }} EditorEdge */

const NODE_W = 120;
const NODE_H = 40;
const SNAP = 10;
let _nextId = 1;

/**
 * Open the pattern editor dialog.
 * @param {object} [pattern]  Existing PatternDefinition to edit, or null for new
 * @param {boolean} [readOnly] If true, disable editing
 */
export function openPatternEditor(pattern, readOnly = false) {
  const dlg = getOverlayDlg();
  dlg.openTemplate('tpl-pattern-editor', {
    title: readOnly ? `Pattern: ${pattern?.name || 'View'}` : (pattern ? `Edit: ${pattern.name}` : 'New Pattern'),
    id: 'pattern-editor-dialog',
    onOpen: () => initEditor(dlg, pattern, readOnly),
  });
}

function initEditor(dlg, pattern, readOnly) {
  const body = dlg.bodyEl.querySelector('#pattern-editor-body');
  if (!body) return;

  /** @type {EditorNode[]} */
  const nodes = [];
  /** @type {EditorEdge[]} */
  const edges = [];

  // Pattern-level properties
  const patternProps = {
    name: pattern?.name || '',
    description: pattern?.description || '',
    max_rounds: pattern?.max_rounds ?? '',
    id: pattern?.id || '',
  };

  // Import existing pattern roles/channels as nodes
  if (pattern?.roles) {
    pattern.roles.forEach((role, i) => {
      nodes.push({
        id: `r${_nextId++}`,
        type: 'role',
        x: 60 + i * 160,
        y: 100,
        data: { ...role },
      });
    });
  }

  // If there are roles, create edges between them in order and auto-layout
  if (nodes.length > 0) {
    autoLayoutNodes(nodes, edges);
    // Create sequential edges for initial display
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: nodes[i].id, to: nodes[i + 1].id });
    }
  }

  // State
  let selectedId = null;
  let connectMode = false;
  let connectFrom = null;
  let dragState = null;

  // Build UI
  const toolbar = h('div', { class: 'pattern-editor-toolbar' });
  const canvas = h('div', { class: 'pattern-editor-canvas' });
  const propsPanel = h('div', { class: 'pattern-editor-props' });

  if (!readOnly) {
    const addRoleBtn = h('button', { class: 'team-btn secondary' }, 'Add Role');
    const addChannelBtn = h('button', { class: 'team-btn secondary' }, 'Add Channel');
    const connectBtn = h('button', { class: 'team-btn secondary', id: 'pe-connect' }, 'Connect');
    const deleteBtn = h('button', { class: 'team-btn secondary' }, 'Delete');
    const layoutBtn = h('button', { class: 'team-btn secondary' }, 'Auto Layout');

    addRoleBtn.addEventListener('click', () => {
      const id = `r${_nextId++}`;
      nodes.push({
        id,
        type: 'role',
        x: 200,
        y: 150,
        data: {
          id: `role_${nodes.length + 1}`,
          name: `Role ${nodes.length + 1}`,
          description: '',
          min: 1,
          max: 1,
          system_prompt_suffix: '',
          auto_tools: [],
          subscribe: [],
          default_tools: [],
        },
      });
      render();
    });

    addChannelBtn.addEventListener('click', () => {
      const id = `c${_nextId++}`;
      nodes.push({
        id,
        type: 'channel',
        x: 200,
        y: 200,
        data: { name: `channel_${nodes.length + 1}` },
      });
      render();
    });

    connectBtn.addEventListener('click', () => {
      connectMode = !connectMode;
      connectFrom = null;
      connectBtn.classList.toggle('active', connectMode);
      connectBtn.textContent = connectMode ? 'Connecting...' : 'Connect';
    });

    deleteBtn.addEventListener('click', () => {
      if (!selectedId) return;
      const idx = nodes.findIndex(n => n.id === selectedId);
      if (idx !== -1) {
        nodes.splice(idx, 1);
        // Remove related edges
        for (let i = edges.length - 1; i >= 0; i--) {
          if (edges[i].from === selectedId || edges[i].to === selectedId) edges.splice(i, 1);
        }
      } else {
        // Check if selectedId is an edge
        const eIdx = edges.findIndex(e => `${e.from}-${e.to}` === selectedId);
        if (eIdx !== -1) edges.splice(eIdx, 1);
      }
      selectedId = null;
      render();
    });

    layoutBtn.addEventListener('click', () => {
      autoLayoutNodes(nodes, edges);
      render();
    });

    toolbar.append(addRoleBtn, addChannelBtn, connectBtn, deleteBtn, layoutBtn);
  }

  const leftPanel = h('div', { style: 'flex:1;display:flex;flex-direction:column;min-width:0' },
    toolbar,
    canvas,
  );

  replaceContent(body, leftPanel, propsPanel);

  // SVG setup
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');

  // Arrowhead marker
  const defs = document.createElementNS(svgNS, 'defs');
  const marker = document.createElementNS(svgNS, 'marker');
  marker.setAttribute('id', 'arrowhead');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  const arrow = document.createElementNS(svgNS, 'polygon');
  arrow.setAttribute('points', '0 0, 8 3, 0 6');
  arrow.setAttribute('fill', 'rgba(255,255,255,0.4)');
  marker.appendChild(arrow);
  defs.appendChild(marker);
  svg.appendChild(defs);

  canvas.appendChild(svg);

  // SVG interaction handlers
  if (!readOnly) {
    svg.addEventListener('mousedown', (e) => {
      const target = e.target.closest('[data-node-id]');
      if (target) {
        const nodeId = target.dataset.nodeId;

        if (connectMode) {
          if (!connectFrom) {
            connectFrom = nodeId;
            target.querySelector('rect')?.setAttribute('stroke', '#c9a84c');
          } else if (connectFrom !== nodeId) {
            // Check for duplicate edge
            const exists = edges.some(ed => ed.from === connectFrom && ed.to === nodeId);
            if (!exists) {
              edges.push({ from: connectFrom, to: nodeId });
            }
            connectFrom = null;
            connectMode = false;
            const btn = toolbar.querySelector('#pe-connect');
            if (btn) { btn.classList.remove('active'); btn.textContent = 'Connect'; }
            render();
          }
          return;
        }

        selectedId = nodeId;
        const node = nodes.find(n => n.id === nodeId);
        if (node) {
          const rect = svg.getBoundingClientRect();
          dragState = {
            nodeId,
            startX: e.clientX,
            startY: e.clientY,
            origX: node.x,
            origY: node.y,
          };
        }
        render();
      } else {
        // Click on empty canvas — deselect
        if (!e.target.closest('[data-edge-id]')) {
          selectedId = null;
          connectFrom = null;
          render();
        }
      }
    });

    svg.addEventListener('mousemove', (e) => {
      if (!dragState) return;
      const node = nodes.find(n => n.id === dragState.nodeId);
      if (!node) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      node.x = Math.max(10, Math.round((dragState.origX + dx) / SNAP) * SNAP);
      node.y = Math.max(10, Math.round((dragState.origY + dy) / SNAP) * SNAP);
      renderSvg();
    });

    svg.addEventListener('mouseup', () => {
      dragState = null;
    });

    svg.addEventListener('mouseleave', () => {
      dragState = null;
    });

    // Edge click
    svg.addEventListener('click', (e) => {
      const edgeEl = e.target.closest('[data-edge-id]');
      if (edgeEl) {
        selectedId = edgeEl.dataset.edgeId;
        render();
      }
    });
  }

  // Wire footer buttons
  const cancelBtn = dlg.footerEl.querySelector('#pattern-editor-cancel');
  const saveBtn = dlg.footerEl.querySelector('#pattern-editor-save');
  cancelBtn?.addEventListener('click', () => dlg.close());
  if (readOnly && saveBtn) saveBtn.style.display = 'none';
  saveBtn?.addEventListener('click', async () => {
    const patternDef = buildPatternDefinition(nodes, edges, patternProps);
    if (!patternDef.id || !patternDef.name) {
      alert('Pattern must have a name.');
      return;
    }
    if (patternDef.roles.length === 0) {
      alert('Pattern must have at least one role.');
      return;
    }
    saveBtn.textContent = 'Saving...';
    saveBtn.disabled = true;
    try {
      const resp = await fetch('/api/patterns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patternDef),
      });
      if (resp.ok) {
        dlg.close();
      } else {
        const data = await resp.json().catch(() => ({}));
        alert(data.error || 'Failed to save pattern');
        saveBtn.textContent = 'Save Pattern';
        saveBtn.disabled = false;
      }
    } catch {
      alert('Failed to save pattern');
      saveBtn.textContent = 'Save Pattern';
      saveBtn.disabled = false;
    }
  });

  function render() {
    renderSvg();
    renderProps();
  }

  function renderSvg() {
    // Remove existing node/edge groups (keep defs)
    svg.querySelectorAll('.edge-group, .node-group').forEach(el => el.remove());

    // Render edges
    for (const edge of edges) {
      const fromNode = nodes.find(n => n.id === edge.from);
      const toNode = nodes.find(n => n.id === edge.to);
      if (!fromNode || !toNode) continue;

      const edgeId = `${edge.from}-${edge.to}`;
      const isSelected = selectedId === edgeId;
      const x1 = fromNode.x + NODE_W;
      const y1 = fromNode.y + NODE_H / 2;
      const x2 = toNode.x;
      const y2 = toNode.y + NODE_H / 2;

      const g = document.createElementNS(svgNS, 'g');
      g.classList.add('edge-group');
      g.dataset.edgeId = edgeId;
      g.style.cursor = 'pointer';

      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      line.setAttribute('stroke', isSelected ? '#c9a84c' : 'rgba(255,255,255,0.3)');
      line.setAttribute('stroke-width', isSelected ? '3' : '2');
      line.setAttribute('marker-end', 'url(#arrowhead)');
      g.appendChild(line);

      // Wider invisible hit area
      const hitLine = document.createElementNS(svgNS, 'line');
      hitLine.setAttribute('x1', x1);
      hitLine.setAttribute('y1', y1);
      hitLine.setAttribute('x2', x2);
      hitLine.setAttribute('y2', y2);
      hitLine.setAttribute('stroke', 'transparent');
      hitLine.setAttribute('stroke-width', '10');
      g.appendChild(hitLine);

      svg.appendChild(g);
    }

    // Render nodes
    for (const node of nodes) {
      const isSelected = selectedId === node.id;
      const g = document.createElementNS(svgNS, 'g');
      g.classList.add('node-group');
      g.dataset.nodeId = node.id;
      g.style.cursor = readOnly ? 'default' : 'grab';

      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', node.x);
      rect.setAttribute('y', node.y);
      rect.setAttribute('width', NODE_W);
      rect.setAttribute('height', NODE_H);
      rect.setAttribute('rx', node.type === 'channel' ? '20' : '4');
      rect.setAttribute('ry', node.type === 'channel' ? '20' : '4');

      if (node.type === 'role') {
        rect.setAttribute('fill', 'rgba(201,168,76,0.1)');
        rect.setAttribute('stroke', isSelected ? '#c9a84c' : 'rgba(201,168,76,0.6)');
        rect.setAttribute('stroke-width', isSelected ? '3' : '2');
      } else {
        rect.setAttribute('fill', 'rgba(255,255,255,0.05)');
        rect.setAttribute('stroke', isSelected ? '#c9a84c' : 'rgba(255,255,255,0.2)');
        rect.setAttribute('stroke-width', isSelected ? '3' : '1');
      }

      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', node.x + NODE_W / 2);
      label.setAttribute('y', node.y + NODE_H / 2 + 4);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', node.type === 'role' ? '#c9a84c' : '#f0e6d2');
      label.setAttribute('font-size', '12');
      label.setAttribute('font-family', 'Courier New, monospace');
      label.setAttribute('font-weight', node.type === 'role' ? 'bold' : 'normal');
      label.textContent = (node.data.name || node.data.id || '').slice(0, 14);

      g.appendChild(rect);
      g.appendChild(label);
      svg.appendChild(g);
    }
  }

  function renderProps() {
    const selected = nodes.find(n => n.id === selectedId);

    const patternFields = [
      h('div', { class: 'team-field' },
        h('label', null, 'Pattern Name'),
        readOnly
          ? h('div', { style: 'font-size:0.85rem' }, patternProps.name)
          : createInput('text', patternProps.name, v => { patternProps.name = v; patternProps.id = v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }),
      ),
      h('div', { class: 'team-field' },
        h('label', null, 'Description'),
        readOnly
          ? h('div', { style: 'font-size:0.85rem;color:var(--text-secondary)' }, patternProps.description)
          : createInput('text', patternProps.description, v => { patternProps.description = v; }),
      ),
      h('div', { class: 'team-field' },
        h('label', null, 'Max Rounds'),
        readOnly
          ? h('div', { style: 'font-size:0.85rem' }, String(patternProps.max_rounds || 'N/A'))
          : createInput('number', patternProps.max_rounds, v => { patternProps.max_rounds = v ? parseInt(v) : ''; }),
      ),
    ];

    if (!selected) {
      replaceContent(propsPanel,
        h('div', { style: 'margin-bottom:1rem' },
          h('h4', { style: 'color:var(--accent-gold);margin-bottom:0.5rem;font-size:0.85rem' }, 'Pattern Properties'),
          ...patternFields,
        ),
        h('div', { style: 'color:var(--text-dim);font-size:0.8rem;margin-top:1rem' },
          readOnly ? 'Click a node to view its properties.' : 'Click a node to edit its properties.'),
      );
      return;
    }

    const nodeFields = [];
    if (selected.type === 'role') {
      const d = selected.data;
      nodeFields.push(
        h('h4', { style: 'color:var(--accent-gold);margin-bottom:0.5rem;font-size:0.85rem' }, 'Role Properties'),
        mkField('Name', 'text', d.name, v => { d.name = v; d.id = v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); renderSvg(); }),
        mkField('Description', 'text', d.description, v => { d.description = v; }),
        mkField('Min Agents', 'number', d.min, v => { d.min = parseInt(v) || 0; }),
        mkField('Max Agents', 'number', d.max, v => { d.max = parseInt(v) || 1; }),
        mkTextarea('System Prompt Suffix', d.system_prompt_suffix, v => { d.system_prompt_suffix = v; }),
        mkField('Auto Tools (comma-separated)', 'text', (d.auto_tools || []).join(', '), v => { d.auto_tools = v.split(',').map(s => s.trim()).filter(Boolean); }),
        mkField('Subscribe Channels (comma-separated)', 'text', (d.subscribe || []).join(', '), v => { d.subscribe = v.split(',').map(s => s.trim()).filter(Boolean); }),
        mkField('Default Tools (comma-separated)', 'text', (d.default_tools || []).join(', '), v => { d.default_tools = v.split(',').map(s => s.trim()).filter(Boolean); }),
      );
    } else {
      nodeFields.push(
        h('h4', { style: 'color:var(--accent-gold);margin-bottom:0.5rem;font-size:0.85rem' }, 'Channel Properties'),
        mkField('Name', 'text', selected.data.name, v => { selected.data.name = v; renderSvg(); }),
      );
    }

    replaceContent(propsPanel,
      h('div', { style: 'margin-bottom:1rem' },
        h('h4', { style: 'color:var(--accent-gold);margin-bottom:0.5rem;font-size:0.85rem' }, 'Pattern Properties'),
        ...patternFields,
      ),
      h('hr', { style: 'border:none;border-top:1px solid rgba(255,255,255,0.1);margin:0.75rem 0' }),
      ...nodeFields,
    );
  }

  function mkField(label, type, value, onChange) {
    return h('div', { class: 'team-field' },
      h('label', null, label),
      readOnly
        ? h('div', { style: 'font-size:0.85rem' }, String(value ?? ''))
        : createInput(type, value, onChange),
    );
  }

  function mkTextarea(label, value, onChange) {
    const ta = h('textarea', {
      style: 'width:100%;min-height:4rem;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;padding:0.4rem;font-family:var(--font-mono);font-size:0.8rem;resize:vertical',
      readOnly: readOnly,
    });
    ta.value = value || '';
    if (!readOnly) ta.addEventListener('input', () => onChange(ta.value));
    return h('div', { class: 'team-field' }, h('label', null, label), ta);
  }

  // Initial render
  render();
}

function createInput(type, value, onChange) {
  const input = h('input', { type, value: value ?? '' });
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

/**
 * Auto-layout nodes left-to-right based on edge topology.
 */
function autoLayoutNodes(nodes, edges) {
  if (nodes.length === 0) return;

  // Build adjacency for topological ordering
  const inDeg = {};
  const adj = {};
  for (const n of nodes) {
    inDeg[n.id] = 0;
    adj[n.id] = [];
  }
  for (const e of edges) {
    if (adj[e.from]) adj[e.from].push(e.to);
    if (inDeg[e.to] !== undefined) inDeg[e.to]++;
  }

  // Kahn's algorithm for topological sort
  const queue = nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
  const order = [];
  const level = {};
  for (const id of queue) level[id] = 0;

  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of (adj[id] || [])) {
      inDeg[next]--;
      level[next] = Math.max(level[next] || 0, (level[id] || 0) + 1);
      if (inDeg[next] === 0) queue.push(next);
    }
  }

  // Place remaining nodes (cycles or disconnected)
  for (const n of nodes) {
    if (!order.includes(n.id)) {
      level[n.id] = order.length;
      order.push(n.id);
    }
  }

  // Group by level and position
  const levels = {};
  for (const id of order) {
    const lv = level[id] || 0;
    if (!levels[lv]) levels[lv] = [];
    levels[lv].push(id);
  }

  const xGap = 180;
  const yGap = 70;
  for (const [lv, ids] of Object.entries(levels)) {
    const x = 40 + parseInt(lv) * xGap;
    ids.forEach((id, i) => {
      const node = nodes.find(n => n.id === id);
      if (node) {
        node.x = x;
        node.y = 40 + i * yGap;
      }
    });
  }
}

/**
 * Convert editor nodes/edges into a PatternDefinition object.
 */
function buildPatternDefinition(nodes, edges, patternProps) {
  const roles = nodes
    .filter(n => n.type === 'role')
    .map(n => ({
      id: n.data.id || n.data.name?.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'role',
      name: n.data.name || 'Role',
      description: n.data.description || '',
      min: parseInt(n.data.min) || 0,
      max: parseInt(n.data.max) || 1,
      system_prompt_suffix: n.data.system_prompt_suffix || '',
      auto_tools: n.data.auto_tools || [],
      subscribe: n.data.subscribe || [],
      default_tools: n.data.default_tools || [],
    }));

  const busFlow = generateBusFlow(nodes, edges);

  const def = {
    id: patternProps.id || patternProps.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom',
    name: patternProps.name || 'Custom Pattern',
    description: patternProps.description || '',
    bus_flow: busFlow,
    builtin: false,
    roles,
  };

  if (patternProps.max_rounds) {
    def.max_rounds = parseInt(patternProps.max_rounds);
  }

  return def;
}

/**
 * Generate a bus_flow string from the editor's node/edge topology.
 */
function generateBusFlow(nodes, edges) {
  if (nodes.length === 0) return '';

  // Build adjacency
  const adj = {};
  const inDeg = {};
  for (const n of nodes) {
    adj[n.id] = [];
    inDeg[n.id] = 0;
  }
  for (const e of edges) {
    if (adj[e.from]) adj[e.from].push(e.to);
    if (inDeg[e.to] !== undefined) inDeg[e.to]++;
  }

  // Find start nodes (no incoming edges)
  const starts = nodes.filter(n => inDeg[n.id] === 0);
  if (starts.length === 0) {
    // Fallback: use first node
    starts.push(nodes[0]);
  }

  const visited = new Set();
  const flowParts = [];

  function nodeLabel(node) {
    if (node.type === 'role') {
      const suffix = (node.data.max || 1) > 1 ? '*' : '';
      return `${node.data.id || node.data.name}${suffix}`;
    }
    return node.data.name || 'unknown';
  }

  function walk(nodeId) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    flowParts.push(nodeLabel(node));

    const children = adj[nodeId] || [];
    if (children.length === 0) {
      // Leaf — nothing more
    } else if (children.length === 1) {
      flowParts.push('→');
      walk(children[0]);
    } else {
      // Parallel paths
      flowParts.push('→');
      const parallelLabels = children.map(cid => {
        const child = nodes.find(n => n.id === cid);
        visited.add(cid);
        return child ? nodeLabel(child) : '?';
      });
      flowParts.push(`[${parallelLabels.join(', ')}]`);

      // Continue from children's children
      for (const cid of children) {
        const nextChildren = adj[cid] || [];
        for (const nc of nextChildren) {
          if (!visited.has(nc)) {
            flowParts.push('→');
            walk(nc);
          }
        }
      }
    }
  }

  for (const start of starts) {
    if (!visited.has(start.id)) {
      if (flowParts.length > 0) flowParts.push(';');
      walk(start.id);
    }
  }

  return flowParts.join(' ');
}
