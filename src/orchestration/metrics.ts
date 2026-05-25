/**
 * Session metrics collection.
 *
 * Tracks per-session and per-agent operational metrics:
 * token usage, API calls, tool invocations, errors, retries,
 * rate limits, and timing.
 */

export interface AgentMetrics {
  input_tokens: number;
  output_tokens: number;
  api_calls: number;
  tool_calls: number;
  errors: number;
  retries: number;
  first_event_at: string | null;
  last_event_at: string | null;
}

export interface SessionMetrics {
  session: string;
  started_at: string;
  agents: Record<string, AgentMetrics>;
  total_messages: number;
  rate_limit_hits: number;
  messages_by_channel: Record<string, number>;
}

function emptyAgentMetrics(): AgentMetrics {
  return {
    input_tokens: 0,
    output_tokens: 0,
    api_calls: 0,
    tool_calls: 0,
    errors: 0,
    retries: 0,
    first_event_at: null,
    last_event_at: null,
  };
}

export class MetricsCollector {
  private metrics: SessionMetrics;

  constructor(session: string, startedAt: string) {
    this.metrics = {
      session,
      started_at: startedAt,
      agents: {},
      total_messages: 0,
      rate_limit_hits: 0,
      messages_by_channel: {},
    };
  }

  private agent(name: string): AgentMetrics {
    if (!this.metrics.agents[name]) {
      this.metrics.agents[name] = emptyAgentMetrics();
    }
    return this.metrics.agents[name];
  }

  recordMessage(channel: string): void {
    this.metrics.total_messages++;
    this.metrics.messages_by_channel[channel] =
      (this.metrics.messages_by_channel[channel] || 0) + 1;
  }

  recordActivity(agentName: string, event: Record<string, unknown>): void {
    const a = this.agent(agentName);
    const now = new Date().toISOString();
    if (!a.first_event_at) a.first_event_at = now;
    a.last_event_at = now;

    switch (event.event) {
      case "text":
        a.api_calls++;
        break;
      case "tool_call":
        a.tool_calls++;
        break;
      case "usage":
        a.input_tokens += (event.input_tokens as number) || 0;
        a.output_tokens += (event.output_tokens as number) || 0;
        break;
      case "retrying":
        a.retries++;
        break;
      case "error":
        a.errors++;
        break;
    }
  }

  recordTokens(agentName: string, input: number, output: number): void {
    const a = this.agent(agentName);
    a.input_tokens += input;
    a.output_tokens += output;
  }

  recordRateLimit(): void {
    this.metrics.rate_limit_hits++;
  }

  getMetrics(): SessionMetrics {
    return this.metrics;
  }

  toJSON(): string {
    return JSON.stringify(this.metrics, null, 2);
  }
}
