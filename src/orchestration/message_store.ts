/**
 * Persistent message store for session bus messages.
 *
 * Appends messages to a JSONL file per session under .porter/messages/.
 * Supports loading history when switching sessions in the UI.
 */

import { dirname } from "@std/path";
import { getGraphStore } from "../graph/store.ts";
import { busMessageToTriples } from "../graph/converters.ts";

export interface StoredMessage {
  channel: string;
  from: string;
  content: string;
  timestamp: number;
}

export class MessageStore {
  private path: string;
  private buffer: StoredMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushIntervalMs: number;

  constructor(session: string, flushIntervalMs = 2000) {
    const home = Deno.env.get("HOME") ?? Deno.cwd();
    this.path = `${home}/.porter/messages/${session}.jsonl`;
    this.flushIntervalMs = flushIntervalMs;
  }

  async init(): Promise<void> {
    await Deno.mkdir(dirname(this.path), { recursive: true });
  }

  append(msg: StoredMessage): void {
    this.buffer.push(msg);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }

    // Also write to RDF graph store (additive — JSONL remains primary)
    const store = getGraphStore();
    if (store) {
      const msgUri = `https://porter.chapeaux.io/vocab#msg/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      busMessageToTriples(msg, msgUri, store);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    const lines = this.buffer.map((m) => JSON.stringify(m)).join("\n") + "\n";
    this.buffer = [];

    try {
      await Deno.writeTextFile(this.path, lines, { append: true });
    } catch (err) {
      console.error(`[message-store] Write failed: ${(err as Error).message}`);
    }
  }

  async load(limit = 500): Promise<StoredMessage[]> {
    try {
      const text = await Deno.readTextFile(this.path);
      const lines = text.trim().split("\n").filter(Boolean);
      const messages: StoredMessage[] = [];
      for (const line of lines.slice(-limit)) {
        try {
          messages.push(JSON.parse(line));
        } catch { /* skip malformed lines */ }
      }
      return messages;
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }
}
