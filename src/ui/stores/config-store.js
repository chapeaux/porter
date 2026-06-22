import { CPXStore } from '../cpx-store.js';

// =========================================================================
// ConfigStore — team creation wizard state
// =========================================================================

export const ALL_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'bash',
  'glob', 'grep', 'list_dir', 'send_message', 'read_messages', 'git',
  'memory_write', 'memory_query'
];

// Dynamic model list — fetched from /api/models/available (user-configured models)
export let MODELS = [];

/**
 * Update the MODELS array from outside this module.
 * Needed because ES module `let` exports cannot be reassigned by importers.
 */
export function setMODELS(newModels) {
  MODELS = newModels;
}

/**
 * Fetch the user's configured models from the ModelStore API.
 * Populates the MODELS array with model IDs for use in dropdowns.
 */
export async function fetchAvailableModels() {
  try {
    const resp = await fetch('/api/models/available');
    if (resp.ok) {
      const data = await resp.json();
      const models = data.models || [];
      MODELS = models.map(m => m.model_id);
    }
  } catch { /* start with empty list; ModelStore.refresh() will populate later */ }
}

export const ROLE_TOOL_DEFAULTS = {
  admin:    [1,0,0,0,1,1,1,1,1,0,1,1],
  worker:   [1,1,1,1,1,1,1,1,1,1,1,1],
  reviewer: [1,0,0,1,1,1,1,1,1,0,1,1],
};

export const ROLE_CHANNEL_DEFAULTS = {
  admin:    ['log'],
  worker:   ['task', 'control'],
  reviewer: ['review'],
};

export const ROLE_SECTION_DEFAULTS = {
  admin: [
    { id: 'job', title: 'Job Description', content: 'You are a PLANNER agent. Your ONLY job is to break down tasks and delegate them to worker agents. You do NOT write code, create files, clone repos, or run commands yourself. You ONLY plan and assign work to others.\n\nWhen you receive a task:\n1. Break it into clear, actionable steps\n2. Send each step to a worker using send_message\n3. Monitor progress by reading messages\n4. If a worker needs help, provide guidance — do NOT do the work yourself' },
    { id: 'comm', title: 'Communication', content: `You have 4 tools: send_message, read_messages, memory_write, memory_query.

Assign tasks to workers:
  send_message({channel:"task:worker-name", message:"Clone the repo using git clone https://oauth2:$GITLAB_TOKEN@example.com/repo.git"})

Check for updates:
  read_messages()

Report status:
  send_message({channel:"log", message:"All tasks assigned"})

Broadcast directives:
  send_message({channel:"control", message:"pause all work"})` },
    { id: 'memory', title: 'Memory', content: `Record decisions and query team knowledge:

Store a decision:
  memory_write({about:"architecture", finding:"We chose Deno because the team uses TypeScript"})

Query what the team knows:
  memory_query({sparql:"SELECT ?about ?finding WHERE { ?obs <https://porter.chapeaux.io/vocab#about> ?about ; <https://porter.chapeaux.io/vocab#finding> ?finding }"})` },
    { id: 'processing', title: 'Processing', content: 'RULES:\n1. NEVER write code, create files, or run commands. You only have send_message, read_messages, memory_write, and memory_query.\n2. ALWAYS delegate implementation to worker agents using send_message to their task channel.\n3. Include clear, specific instructions in each message so the worker knows exactly what to do.\n4. Do ONE thing per tool call. Send one message, store one fact.\n5. After assigning tasks, use read_messages periodically to monitor progress.' },
  ],
  worker: [
    { id: 'job', title: 'Job Description', content: 'You are a worker agent. Execute tasks assigned to you and report your progress. You have full access to bash, file operations, messaging, and memory.' },
    { id: 'comm', title: 'Communication', content: `You have tools: bash, read_file, write_file, edit_file, glob, grep, list_dir, git, send_message, read_messages, memory_write, memory_query.

Run commands (you have a full bash shell):
  bash({command:"git clone https://oauth2:$GITLAB_TOKEN@example.com/repo.git"})
  bash({command:"cd repo && deno test"})
  bash({command:"cd repo && git add -A && git commit -m 'done' && git push"})

Create/read files:
  write_file({path:"src/app.js", content:"export function hello() { return 'world'; }"})
  read_file({path:"src/app.js"})
  edit_file({path:"src/app.js", old_string:"world", new_string:"universe"})

Send messages:
  read_messages()
  send_message({channel:"log", message:"Task complete"})

Store knowledge:
  memory_write({about:"finding", finding:"deno test passes"})` },
    { id: 'memory', title: 'Memory', content: `Query shared knowledge before starting work:
  memory_query({sparql:"SELECT ?finding WHERE { ?obs <https://porter.chapeaux.io/vocab#about> ?about ; <https://porter.chapeaux.io/vocab#finding> ?finding }"})

Record what you learn:
  memory_write({about:"issue in auth module", finding:"Missing null check on line 42"})` },
    { id: 'processing', title: 'Processing', content: 'You have FULL capabilities. You CAN clone repos, create files, run any bash command, run tests, commit and push.\n\nRULES:\n1. NEVER say you cannot do something. You have bash, git, file creation, and messaging.\n2. Do ONE thing per tool call. Run one command, create one file, send one message.\n3. Use write_file for creating files — not bash echo/cat/heredoc.\n4. Environment variables like $GITLAB_TOKEN are available in bash and git commands. Use git({command:"push"}) for git operations — credentials are injected automatically.\n5. When done, announce to log: send_message({channel:"log", message:"Done"})' },
  ],
  reviewer: [
    { id: 'job', title: 'Job Description', content: 'You are a reviewer agent. Monitor completed work for quality and correctness.' },
    { id: 'comm', title: 'Communication', content: `You have tools: bash, read_file, write_file, edit_file, glob, grep, list_dir, git, send_message, read_messages, memory_write, memory_query.

Read files for review:
  read_file({path:"src/app.js"})

Run tests:
  bash({command:"cd repo && deno test"})

Search for issues:
  grep({pattern:"TODO", path:"src/"})

Report findings:
  send_message({channel:"log", message:"Review complete: LGTM"})

Request fixes:
  send_message({channel:"task", message:"Fix needed: missing error handling in auth.js"})` },
    { id: 'memory', title: 'Memory', content: `Check known issues before reviewing:
  memory_query({sparql:"SELECT ?about ?finding WHERE { ?obs <https://porter.chapeaux.io/vocab#about> ?about ; <https://porter.chapeaux.io/vocab#finding> ?finding }"})

Record findings:
  memory_write({about:"review of auth module", finding:"LGTM - clean implementation"})` },
    { id: 'processing', title: 'Processing', content: 'You CAN read files, run tests, search code, and report results. You have a full bash shell.\n\nRULES:\n1. NEVER say you cannot do something.\n2. Do ONE thing per tool call.\n3. Report all findings to log using send_message({channel:"log", message:"..."}).' },
  ],
};

export const ROLE_PROMPT_DEFAULTS = {};
for (const [role, sections] of Object.entries(ROLE_SECTION_DEFAULTS)) {
  ROLE_PROMPT_DEFAULTS[role] = sections.map(s => s.content).join('\n\n');
}

export function getDefaultSections(role) {
  return (ROLE_SECTION_DEFAULTS[role] || ROLE_SECTION_DEFAULTS.worker).map(s => ({
    ...s, default: s.content,
  }));
}

export function parsePromptSections(promptText, role) {
  if (!promptText) return getDefaultSections(role);
  const defaults = ROLE_SECTION_DEFAULTS[role] || ROLE_SECTION_DEFAULTS.worker;
  const isDefault = promptText.trim() === ROLE_PROMPT_DEFAULTS[role]?.trim();
  if (isDefault) return getDefaultSections(role);

  // Check if the text is a concatenation of the default sections (joined with \n\n)
  // If so, split on known section content boundaries
  const sectionContents = defaults.map(d => d.content.trim());
  let allFound = true;
  for (const sc of sectionContents) {
    if (!promptText.includes(sc.slice(0, 40))) { allFound = false; break; }
  }
  if (allFound && sectionContents.length > 1) {
    const sections = [];
    let remaining = promptText;
    for (let i = 0; i < defaults.length; i++) {
      const needle = sectionContents[i].slice(0, 40);
      const idx = remaining.indexOf(needle);
      if (idx >= 0) {
        const nextNeedle = i + 1 < sectionContents.length ? sectionContents[i + 1].slice(0, 40) : null;
        const endIdx = nextNeedle ? remaining.indexOf(nextNeedle, idx + 1) : remaining.length;
        const content = remaining.slice(idx, endIdx > idx ? endIdx : remaining.length).trim();
        sections.push({ id: defaults[i].id, title: defaults[i].title, content, default: defaults[i].content });
      }
    }
    if (sections.length === defaults.length) return sections;
  }

  // Try to split by known section markers (legacy format)
  const text = promptText.trim();
  const commIdx = text.search(/\n\s*Communication\s*(channels)?:/i);
  const memIdx = text.search(/\n\s*Shared\s*memory:/i);
  const importantIdx = text.search(/\n\s*IMPORTANT:/i);

  if (commIdx > 0 || memIdx > 0) {
    const sections = [];
    const jobEnd = commIdx > 0 ? commIdx : (memIdx > 0 ? memIdx : text.length);
    sections.push({ id: 'job', title: 'Job Description', content: text.slice(0, jobEnd).trim(), default: defaults.find(d => d.id === 'job')?.content || '' });

    if (commIdx > 0) {
      const commEnd = memIdx > commIdx ? memIdx : (importantIdx > commIdx ? importantIdx : text.length);
      sections.push({ id: 'comm', title: 'Communication', content: text.slice(commIdx + 1, commEnd).trim(), default: defaults.find(d => d.id === 'comm')?.content || '' });
    }

    if (memIdx > 0) {
      const memEnd = importantIdx > memIdx ? importantIdx : text.length;
      sections.push({ id: 'memory', title: 'Memory', content: text.slice(memIdx + 1, memEnd).trim(), default: defaults.find(d => d.id === 'memory')?.content || '' });
    }

    const lastSectionEnd = Math.max(commIdx, memIdx, 0);
    const processingStart = importantIdx > lastSectionEnd ? importantIdx : -1;
    if (processingStart > 0) {
      sections.push({ id: 'processing', title: 'Processing', content: text.slice(processingStart + 1).trim(), default: defaults.find(d => d.id === 'processing')?.content || '' });
    } else {
      // Check for trailing paragraph after the last known section
      const lastSection = sections[sections.length - 1];
      const remaining = text.slice(text.indexOf(lastSection.content) + lastSection.content.length).trim();
      if (remaining.length > 10) {
        sections.push({ id: 'processing', title: 'Processing', content: remaining, default: defaults.find(d => d.id === 'processing')?.content || '' });
      }
    }

    return sections;
  }

  // No known markers found — show as single section but still provide defaults via revert
  return [
    { id: 'job', title: 'Job Description', content: text, default: defaults.find(d => d.id === 'job')?.content || '' },
    { id: 'comm', title: 'Communication', content: '', default: defaults.find(d => d.id === 'comm')?.content || '' },
    { id: 'memory', title: 'Memory', content: '', default: defaults.find(d => d.id === 'memory')?.content || '' },
    { id: 'processing', title: 'Processing', content: '', default: defaults.find(d => d.id === 'processing')?.content || '' },
  ];
}

export function sectionsToPrompt(sections) {
  return sections.map(s => s.content).filter(Boolean).join('\n\n');
}

export class ConfigStore extends CPXStore {
  constructor() {
    super({
      step: 1,
      teamName: '',
      workingDir: '.',
      model: MODELS[0] || '',
      agents: [],
      editingAgent: null,
      errors: {},
      saving: false,
      editingSession: null,
      providers: [],
      mcpServers: {},
      enabledMcpServers: [],
      sessionEnv: {},
      sandbox: false,
      runtimeTools: [],
      repo: null,
      pattern: 'sequential',
      maxDeliberationRounds: 3,
    });
  }

  connectedCallback() {
    super.connectedCallback();
    try {
      const saved = localStorage.getItem('porter-mcp-servers');
      if (saved) {
        this._isInternalChange = true;
        this.state.mcpServers = JSON.parse(saved);
        this._isInternalChange = false;
      }
    } catch { /* ignore */ }
  }

  setState(patch) {
    for (const [key, val] of Object.entries(patch)) {
      this.state[key] = val;
    }
    if ('mcpServers' in patch) {
      try { localStorage.setItem('porter-mcp-servers', JSON.stringify(this.state.mcpServers)); } catch { /* ignore */ }
    }
  }

  setStep(n) { this.setState({ step: n }); }
  setTeamName(s) { this.setState({ teamName: s, errors: { ...this.state.errors, teamName: null } }); }
  setWorkingDir(d) { this.setState({ workingDir: d, errors: { ...this.state.errors, workingDir: null } }); }
  setModel(m) { this.setState({ model: m }); }
  setPattern(p) { this.setState({ pattern: p }); }

  addAgent(agent) {
    this.setState({ agents: [...this.state.agents, agent] });
  }

  updateAgent(idx, agent) {
    const agents = [...this.state.agents];
    agents[idx] = agent;
    this.setState({ agents });
  }

  removeAgent(idx) {
    const agents = this.state.agents.filter((_, i) => i !== idx);
    this.setState({ agents, editingAgent: null });
  }

  editAgent(idx) { this.setState({ editingAgent: idx }); }
  closeEditor() { this.setState({ editingAgent: null }); }

  validate(step) {
    const errors = {};
    const s = step ?? this.state.step;

    if (s <= 1) {
      if (!this.state.teamName.trim()) errors.teamName = 'Team name is required';
    }

    if (s >= 2) {
      if (this.state.agents.length === 0) errors.agents = 'At least one agent is required';
      const names = this.state.agents.map(a => a.name);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      if (dupes.length > 0) errors.agents = `Duplicate agent name: ${dupes[0]}`;
    }

    this.setState({ errors });
    return Object.keys(errors).length === 0;
  }

  toJSON() {
    const config = {
      session: this.state.teamName,
      pattern: this.state.pattern !== 'sequential' ? this.state.pattern : undefined,
      max_deliberation_rounds: this.state.pattern === 'deliberation' && this.state.maxDeliberationRounds !== 3 ? this.state.maxDeliberationRounds : undefined,
      model: this.state.model,
      working_dir: this.state.workingDir || '.',
      api_key_env: 'ANTHROPIC_API_KEY',
      repo: this.state.repo || undefined,
      sandbox: this.state.sandbox ? true : undefined,
      runtime_tools: this.state.runtimeTools?.length > 0 ? this.state.runtimeTools : undefined,
      env: Object.keys(this.state.sessionEnv || {}).length > 0 ? this.state.sessionEnv : undefined,
      providers: this.state.providers.length > 0 ? this.state.providers : undefined,
      mcp_servers: this.state.enabledMcpServers.length > 0
        ? injectMcpTokens(Object.fromEntries(
            this.state.enabledMcpServers
              .filter(n => this.state.mcpServers[n])
              .map(n => [n, this.state.mcpServers[n]])
          ))
        : undefined,
      agents: this.state.agents.map(a => {
        const agent = {
          name: a.name,
          role: a.role,
          model: a.model || undefined,
          system_prompt: a.systemPrompt,
          tools: a.tools,
          subscribe: a.channels,
          max_tokens: a.maxTokens || undefined,
          max_turns: a.maxTurns || undefined,
          max_context_tokens: a.maxContextTokens || undefined,
        };
        if (a.reasoning) agent.reasoning = true;
        if (a.mcpTools?.length) agent.mcp_tools = a.mcpTools;
        return agent;
      }),
    };
    return JSON.stringify(config, null, 2);
  }

  fromJSON(json) {
    try {
      const config = typeof json === 'string' ? JSON.parse(json) : json;
      // Validate the model against available models; fall back if not found
      let model = config.model || '';
      const available = getAvailableModels();
      if (available.length > 0) {
        const ids = available.map(m => m.model_id || m.id);
        if (!ids.includes(model)) model = ids[0];
      }
      this.setState({
        teamName: config.session || '',
        workingDir: config.working_dir || '',
        model,
        pattern: config.pattern || 'sequential',
        maxDeliberationRounds: config.max_deliberation_rounds ?? 3,
        repo: config.repo || null,
        providers: config.providers || [],
        mcpServers: { ...this.state.mcpServers, ...(config.mcp_servers || {}) },
        enabledMcpServers: Object.keys(config.mcp_servers || {}),
        sessionEnv: config.env || {},
        sandbox: !!config.sandbox,
        runtimeTools: config.runtime_tools || [],
        agents: (config.agents || []).map(a => ({
          name: a.name,
          role: a.role || 'worker',
          model: a.model || '',
          systemPrompt: a.system_prompt || '',
          promptSections: a.prompt_sections || parsePromptSections(a.system_prompt || '', a.role || 'worker'),
          tools: a.tools || [],
          channels: a.subscribe || [],
          maxTokens: a.max_tokens || 8192,
          maxTurns: a.max_turns || undefined,
          maxContextTokens: a.max_context_tokens || undefined,
          reasoning: a.reasoning || false,
          mcpTools: a.mcp_tools || [],
        })),
        step: 2,
        errors: {},
      });
    } catch (e) {
      console.error('Failed to parse config:', e);
    }
  }

  createDefaultAgent(isFirst = false, forRole = null) {
    let role = forRole;
    if (!role) {
      // Determine role from the current pattern
      const pattern = this.state.pattern || 'sequential';
      const agents = this.state.agents;
      if (pattern === 'mixture') {
        // Last agent is synthesizer; all others are specialists
        const hasSynthesizer = agents.some(a => a.role === 'synthesizer');
        role = hasSynthesizer ? 'specialist' : (isFirst ? 'specialist' : 'specialist');
        // If adding the last agent and we need a synthesizer, suggest synthesizer
        // Otherwise default to specialist
        if (!isFirst && agents.length >= 2 && !hasSynthesizer) {
          role = 'synthesizer';
        } else {
          role = 'specialist';
        }
      } else if (pattern === 'deliberation') {
        const hasWorker = agents.some(a => a.role === 'worker');
        role = hasWorker ? 'reflector' : 'worker';
      } else if (pattern === 'distillation') {
        const hasExpert = agents.some(a => a.role === 'expert');
        role = hasExpert ? 'learner' : 'expert';
      } else {
        // sequential: first → admin, rest → worker
        role = isFirst ? 'admin' : 'worker';
      }
    }

    const idx = this.state.agents.length;
    // Generate a name based on role
    const existingWithRole = this.state.agents.filter(a => a.role === role).length;
    let name;
    if (role === 'admin' || role === 'synthesizer' || role === 'reflector' || role === 'expert') {
      name = existingWithRole > 0 ? `${role}-${existingWithRole + 1}` : role;
    } else {
      name = `${role}-${existingWithRole + 1}`;
    }

    // Fall back to sequential defaults for roles not in ROLE_TOOL_DEFAULTS
    const toolRole = ROLE_TOOL_DEFAULTS[role] ? role : 'worker';
    const toolBits = ROLE_TOOL_DEFAULTS[toolRole];
    const tools = ALL_TOOLS.filter((_, i) => toolBits[i]);
    const promptRole = ROLE_SECTION_DEFAULTS[role] ? role : toolRole;
    return {
      name,
      role,
      model: '',
      systemPrompt: ROLE_PROMPT_DEFAULTS[promptRole] || ROLE_PROMPT_DEFAULTS.worker,
      promptSections: getDefaultSections(promptRole),
      tools,
      channels: [...(ROLE_CHANNEL_DEFAULTS[role] || ROLE_CHANNEL_DEFAULTS.worker)],
      maxTokens: 8192,
      reasoning: false,
      mcpTools: [],
    };
  }
}

// Register the custom element
customElements.define('config-store', ConfigStore);

// ---------------------------------------------------------------------------
// Helper functions used by ConfigStore and app.js
// ---------------------------------------------------------------------------

export function injectMcpTokens(servers) {
  const result = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const stored = localStorage.getItem('porter-mcp-token-' + name);
    if (stored && cfg.auth?.type === 'oidc') {
      try {
        const { access_token } = JSON.parse(stored);
        result[name] = { ...cfg, access_token };
        continue;
      } catch { /* fall through */ }
    }
    result[name] = cfg;
  }
  return result;
}

/** Return models the user has configured and validated. */
export function getAvailableModels() {
  const modelStore = document.getElementById('models');
  if (!modelStore) return [];
  const available = modelStore.getAvailable();
  if (available.length === 0) return [];
  return available.map(m => ({ ...m, id: m.model_id }));
}

export function generateSessionName(baseName) {
  const sessions = document.getElementById('projects')?.state?.sessions || [];
  const names = new Set(sessions.map(s => s.name));
  let n = 1;
  let name = `${baseName}-${n}`;
  while (names.has(name)) {
    n++;
    name = `${baseName}-${n}`;
  }
  return name;
}

export function formatModelOption(m) {
  const parts = [m.model_id || m.id];
  const info = [];
  if (m.criticality) info.push(m.criticality);
  if (m.context_window) info.push(m.context_window >= 1000 ? Math.round(m.context_window / 1000) + 'K' : m.context_window);
  if (m.capabilities?.tool_calling) info.push('tools');
  if (m.capabilities?.reasoning) info.push('reasoning');
  if (info.length) parts.push(`(${info.join(', ')})`);
  return parts.join(' ');
}
