/**
 * Parse the formal bus_flow syntax into a node tree.
 *
 * Syntax:
 *   word           — plain node (channel or operation)
 *   role:word      — role node
 *   role:word*     — multi-agent role node
 *   [node, node]   — parallel execution
 *   (a -> b | c -> d) — conditional branch
 *   ->  or  →      — flow direction
 *   ;              — separate flows
 *   graph  or graph(label) — store node
 */

/**
 * @typedef {{
 *   type: 'node'|'role'|'parallel'|'branch'|'store',
 *   name: string,
 *   label?: string,
 *   multi?: boolean,
 *   children?: FlowNode[],
 *   branches?: { label: string, nodes: FlowNode[] }[]
 * }} FlowNode
 *
 * @typedef {FlowNode[]} Flow
 */

/**
 * Parse a bus_flow string into an array of flows.
 * @param {string} flowString
 * @returns {Flow[]}
 */
export function parseBusFlow(flowString) {
  if (!flowString || typeof flowString !== 'string') return [];

  try {
    // Split on ';' for multiple flows
    const rawFlows = flowString.split(';').map(s => s.trim()).filter(Boolean);
    return rawFlows.map(parseFlow);
  } catch {
    // If parsing fails, return a single text node with the raw string
    return [[{ type: 'node', name: flowString.trim() }]];
  }
}

/**
 * Parse a single flow string (no semicolons) into an array of FlowNodes.
 * @param {string} flowStr
 * @returns {Flow}
 */
function parseFlow(flowStr) {
  const tokens = tokenize(flowStr);
  if (tokens.length === 0) return [{ type: 'node', name: flowStr.trim() }];

  const nodes = [];
  for (const token of tokens) {
    const node = parseToken(token);
    if (node) nodes.push(node);
  }

  return nodes.length > 0 ? nodes : [{ type: 'node', name: flowStr.trim() }];
}

/**
 * Tokenize a flow string by splitting on -> / → arrows,
 * while respecting bracket and paren nesting.
 * @param {string} str
 * @returns {string[]}
 */
function tokenize(str) {
  const tokens = [];
  let current = '';
  let depth = 0; // bracket/paren nesting depth
  let i = 0;

  while (i < str.length) {
    const ch = str[i];

    if (ch === '[' || ch === '(') {
      depth++;
      current += ch;
      i++;
    } else if (ch === ']' || ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
      i++;
    } else if (depth === 0 && ch === '-' && str[i + 1] === '>') {
      // Arrow separator ->
      const trimmed = current.trim();
      if (trimmed) tokens.push(trimmed);
      current = '';
      i += 2;
    } else if (depth === 0 && str.charCodeAt(i) === 0x2192) {
      // Unicode arrow →
      const trimmed = current.trim();
      if (trimmed) tokens.push(trimmed);
      current = '';
      i++;
    } else {
      current += ch;
      i++;
    }
  }

  const trimmed = current.trim();
  if (trimmed) tokens.push(trimmed);

  return tokens;
}

/**
 * Parse a single token into a FlowNode.
 * @param {string} token
 * @returns {FlowNode|null}
 */
function parseToken(token) {
  token = token.trim();
  if (!token) return null;

  // Parallel: [a, b, c]
  if (token.startsWith('[') && token.endsWith(']')) {
    const inner = token.slice(1, -1).trim();
    const parts = splitTopLevel(inner, ',');
    const children = parts
      .map(p => parseToken(p.trim()))
      .filter(Boolean);
    return { type: 'parallel', name: 'parallel', children };
  }

  // Branch: (a -> b | c -> d)
  if (token.startsWith('(') && token.endsWith(')')) {
    const inner = token.slice(1, -1).trim();
    const branches = splitTopLevel(inner, '|').map(branch => {
      const branchTokens = tokenize(branch.trim());
      if (branchTokens.length === 0) {
        return { label: branch.trim(), nodes: [] };
      }
      const label = branchTokens[0];
      const nodes = branchTokens.slice(1)
        .map(t => parseToken(t))
        .filter(Boolean);
      return { label, nodes };
    });
    return { type: 'branch', name: 'branch', branches };
  }

  // Store: graph or graph(label)
  const graphMatch = token.match(/^graph(?:\(([^)]*)\))?$/i);
  if (graphMatch) {
    return { type: 'store', name: 'graph', label: graphMatch[1] || undefined };
  }

  // Role with multi: role:name*
  const roleMultiMatch = token.match(/^([a-zA-Z_][\w]*):([a-zA-Z_][\w{}]*)\*$/);
  if (roleMultiMatch) {
    return { type: 'role', name: roleMultiMatch[2], multi: true };
  }

  // Role: role:name
  const roleMatch = token.match(/^([a-zA-Z_][\w]*):([a-zA-Z_][\w{}]*)$/);
  if (roleMatch) {
    return { type: 'role', name: roleMatch[2] };
  }

  // Plain node with multi: name*
  if (token.endsWith('*') && token.length > 1) {
    return { type: 'node', name: token.slice(0, -1), multi: true };
  }

  // Plain node
  return { type: 'node', name: token };
}

/**
 * Split a string on a delimiter, respecting bracket/paren nesting.
 * @param {string} str
 * @param {string} delimiter
 * @returns {string[]}
 */
function splitTopLevel(str, delimiter) {
  const parts = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '[' || ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ']' || ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (depth === 0 && str.startsWith(delimiter, i)) {
      parts.push(current);
      current = '';
      i += delimiter.length - 1;
    } else {
      current += ch;
    }
  }

  if (current) parts.push(current);
  return parts;
}
