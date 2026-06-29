/**
 * Render a parsed bus_flow as a visual HTML flow diagram.
 */

import { h } from '../dom.js';
import { parseBusFlow } from './flow-parser.js';

/**
 * Render a bus_flow string as a visual flow diagram.
 * @param {string} flowString
 * @param {{ compact?: boolean }} options
 * @returns {HTMLElement}
 */
export function renderBusFlow(flowString, options = {}) {
  if (!flowString || typeof flowString !== 'string') {
    return h('span', { class: 'flow-node channel' }, flowString || '(no flow)');
  }

  const flows = parseBusFlow(flowString);

  // If parsing failed or empty, return plain text fallback
  if (!flows || flows.length === 0) {
    return h('span', { class: 'flow-node channel' }, flowString);
  }

  const container = h('div', { class: `flow-diagram${options.compact ? ' flow-compact' : ''}` });

  for (const flow of flows) {
    const flowEl = h('div', { class: 'flow-line' });
    for (let i = 0; i < flow.length; i++) {
      if (i > 0) flowEl.appendChild(h('span', { class: 'flow-arrow' }, '→'));
      flowEl.appendChild(renderNode(flow[i], options));
    }
    container.appendChild(flowEl);
  }

  return container;
}

/**
 * Render a single FlowNode as an HTML element.
 * @param {import('./flow-parser.js').FlowNode} node
 * @param {{ compact?: boolean }} options
 * @returns {HTMLElement}
 */
function renderNode(node, options) {
  switch (node.type) {
    case 'role': {
      const classes = `flow-node role${node.multi ? ' multi' : ''}`;
      return h('span', { class: classes, title: node.multi ? 'Multi-agent role' : 'Role' }, node.name);
    }

    case 'node': {
      const classes = `flow-node channel${node.multi ? ' multi' : ''}`;
      return h('span', { class: classes }, node.name);
    }

    case 'store': {
      const label = node.label ? `${node.name}(${node.label})` : node.name;
      return h('span', { class: 'flow-node store', title: 'Graph store' }, label);
    }

    case 'parallel': {
      const el = h('span', { class: 'flow-parallel' });
      if (node.children) {
        node.children.forEach(child => el.appendChild(renderNode(child, options)));
      }
      return el;
    }

    case 'branch': {
      const el = h('span', { class: 'flow-branch' });
      if (node.branches) {
        node.branches.forEach(b => {
          const branchEl = h('span', { class: 'flow-branch-path' });
          branchEl.appendChild(h('span', { class: 'flow-branch-label' }, b.label));
          b.nodes.forEach((n, i) => {
            if (i > 0) branchEl.appendChild(h('span', { class: 'flow-arrow' }, '→'));
            branchEl.appendChild(renderNode(n, options));
          });
          el.appendChild(branchEl);
        });
      }
      return el;
    }

    default:
      return h('span', { class: 'flow-node channel' }, node.name || '?');
  }
}
