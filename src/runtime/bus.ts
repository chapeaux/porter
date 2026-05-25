/**
 * Message bus for inter-agent communication.
 *
 * Supports two modes:
 * - **Local**: In-process async channels (agents share memory).
 * - **Remote**: WebSocket server on the orchestrator side, WebSocket
 *   client on the worker side. Messages are JSON-serialized over the wire.
 */

import { getCoordinator } from "./rate_limiter.ts";

/** A message on the bus. */
export interface BusMessage {
  channel: string;
  from: string;
  content: string;
  timestamp: number;
}

/** Wire protocol for WebSocket bus messages. */
export interface WireMessage {
  type: "publish" | "subscribe" | "drain" | "drain_response" | "heartbeat" | "rate_limit";
  subscriberId?: string;
  channel?: string;
  channels?: string[];
  from?: string;
  content?: string;
  messages?: BusMessage[];
  timestamp?: number;
  /** Milliseconds remaining in a global rate-limit cooldown (rate_limit messages). */
  cooldownRemainingMs?: number;
}

/** Per-subscriber mailbox: a queue of messages per channel. */
interface Mailbox {
  /** Channels this subscriber listens to. */
  channels: Set<string>;
  /** Buffered messages awaiting drain. */
  queue: BusMessage[];
}

/**
 * In-process message bus. All agents in the same Deno process share
 * this instance. Messages are delivered by reference -- no serialization.
 */
export class MessageBus {
  private mailboxes = new Map<string, Mailbox>();

  /** Register a subscriber with the channels it listens to. */
  subscribe(subscriberId: string, channels: string[]): void {
    this.mailboxes.set(subscriberId, {
      channels: new Set(channels),
      queue: [],
    });
  }

  /** Remove a subscriber. */
  unsubscribe(subscriberId: string): void {
    this.mailboxes.delete(subscriberId);
  }

  /** Publish a message to a channel. Delivered to all subscribers of that channel. */
  async publish(
    channel: string,
    content: string,
    from: string = "system",
  ): Promise<void> {
    const msg: BusMessage = {
      channel,
      from,
      content,
      timestamp: Date.now(),
    };

    for (const [_id, mailbox] of this.mailboxes) {
      if (mailbox.channels.has(channel)) {
        mailbox.queue.push(msg);
      }
    }

    // Also forward to remote subscribers
    for (const relay of this.relays) {
      await relay.forward(msg);
    }

    await Promise.resolve();
  }

  /**
   * Drain all pending messages for a subscriber.
   * Optionally filter by channel.
   * Returns messages and clears them from the queue.
   */
  async drain(
    subscriberId?: string,
    channel?: string,
  ): Promise<BusMessage[]> {
    if (!subscriberId) {
      return await Promise.resolve([]);
    }

    const mailbox = this.mailboxes.get(subscriberId);
    if (!mailbox) return await Promise.resolve([]);

    let messages: BusMessage[];
    if (channel) {
      messages = mailbox.queue.filter((m) => m.channel === channel);
      mailbox.queue = mailbox.queue.filter((m) => m.channel !== channel);
    } else {
      messages = [...mailbox.queue];
      mailbox.queue = [];
    }

    return messages;
  }

  /** Check how many pending messages a subscriber has. */
  pending(subscriberId: string): number {
    return this.mailboxes.get(subscriberId)?.queue.length ?? 0;
  }

  // -----------------------------------------------------------------------
  // WebSocket relay support
  // -----------------------------------------------------------------------

  private relays: BusRelay[] = [];

  /** Add a relay for forwarding messages to remote buses. */
  addRelay(relay: BusRelay): void {
    this.relays.push(relay);
  }

  /** Remove a relay. */
  removeRelay(relay: BusRelay): void {
    this.relays = this.relays.filter((r) => r !== relay);
  }
}

/** Interface for relaying messages to remote buses. */
export interface BusRelay {
  forward(msg: BusMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// WebSocket Bus Server (runs on orchestrator)
// ---------------------------------------------------------------------------

/**
 * WebSocket server that bridges remote workers into the local MessageBus.
 *
 * Remote workers connect, subscribe to channels, and exchange messages
 * over the WebSocket.
 */
export class BusServer {
  private server: Deno.HttpServer | null = null;
  private sockets = new Map<string, WebSocket>();
  private stickyMessages: WireMessage[] = [];

  constructor(private bus: MessageBus) {}

  /** Store a message that will be replayed to every new subscriber. */
  addStickyMessage(channel: string, content: string, from: string): void {
    this.stickyMessages.push({
      type: "publish",
      channel,
      content,
      from,
      timestamp: Date.now(),
    });
  }

  /** Start listening on the given port. */
  start(port: number): void {
    this.server = Deno.serve({ port, onListen: () => {} }, (req) => {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 400 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      this.handleSocket(socket);
      return response;
    });

    // Register as a relay so local publishes reach remote subscribers
    this.bus.addRelay({
      forward: async (msg) => {
        const wire: WireMessage = {
          type: "publish",
          channel: msg.channel,
          from: msg.from,
          content: msg.content,
          timestamp: msg.timestamp,
        };
        const data = JSON.stringify(wire);
        for (const [_id, ws] of this.sockets) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        }
        await Promise.resolve();
      },
    });
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    for (const [_id, ws] of this.sockets) {
      try { ws.close(); } catch { /* already closed */ }
    }
    this.sockets.clear();
    if (this.server) {
      await this.server.shutdown();
      this.server = null;
    }
  }

  /** Number of connected workers. */
  get connectionCount(): number {
    return this.sockets.size;
  }

  /** Send a wire message to all connected remote workers. */
  broadcast(wire: WireMessage): void {
    const data = JSON.stringify(wire);
    for (const [_id, ws] of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  private handleSocket(ws: WebSocket): void {
    let subscriberId: string | null = null;

    ws.onmessage = async (event) => {
      try {
        const wire = JSON.parse(event.data as string) as WireMessage;

        switch (wire.type) {
          case "subscribe":
            subscriberId = wire.subscriberId ?? null;
            if (subscriberId && wire.channels) {
              this.sockets.set(subscriberId, ws);
              this.bus.subscribe(subscriberId, wire.channels);
              // Replay sticky messages to the new subscriber
              const channelSet = new Set(wire.channels);
              for (const sticky of this.stickyMessages) {
                if (sticky.channel && channelSet.has(sticky.channel)) {
                  ws.send(JSON.stringify(sticky));
                }
              }
            }
            break;

          case "publish":
            if (wire.channel && wire.content) {
              await this.bus.publish(
                wire.channel,
                wire.content,
                wire.from ?? "remote",
              );
            }
            break;

          case "drain": {
            const messages = await this.bus.drain(
              wire.subscriberId,
              wire.channel,
            );
            const resp: WireMessage = {
              type: "drain_response",
              messages,
            };
            ws.send(JSON.stringify(resp));
            break;
          }

          case "heartbeat":
            // Echo back as acknowledgment
            ws.send(JSON.stringify({ type: "heartbeat", timestamp: Date.now() }));
            break;

          case "rate_limit":
            // A remote worker reported a rate limit -- broadcast to all others
            this.broadcast(wire);
            break;
        }
      } catch {
        // Malformed message -- ignore
      }
    };

    ws.onclose = () => {
      if (subscriberId) {
        this.bus.unsubscribe(subscriberId);
        this.sockets.delete(subscriberId);
      }
    };

    ws.onerror = () => {
      if (subscriberId) {
        this.bus.unsubscribe(subscriberId);
        this.sockets.delete(subscriberId);
      }
    };
  }
}

// ---------------------------------------------------------------------------
// WebSocket Bus Client (runs on remote workers)
// ---------------------------------------------------------------------------

/**
 * WebSocket client that connects a remote worker to the orchestrator's
 * message bus.
 */
export class BusClient {
  private ws: WebSocket | null = null;
  private pendingDrains = new Map<number, (messages: BusMessage[]) => void>();
  private drainCounter = 0;
  private incomingQueue: BusMessage[] = [];

  constructor(
    private subscriberId: string,
    private channels: string[],
  ) {}

  /** Connect to the bus server. */
  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        // Subscribe immediately
        const wire: WireMessage = {
          type: "subscribe",
          subscriberId: this.subscriberId,
          channels: this.channels,
        };
        this.ws!.send(JSON.stringify(wire));
        resolve();
      };

      this.ws.onerror = () => {
        reject(new Error(`Failed to connect to bus at ${url}`));
      };

      this.ws.onmessage = (event) => {
        try {
          const wire = JSON.parse(event.data as string) as WireMessage;
          if (wire.type === "publish" && wire.channel && wire.content) {
            this.incomingQueue.push({
              channel: wire.channel,
              from: wire.from ?? "remote",
              content: wire.content,
              timestamp: wire.timestamp ?? Date.now(),
            });
          } else if (wire.type === "rate_limit" && wire.cooldownRemainingMs) {
            // Apply rate-limit cooldown from the orchestrator
            getCoordinator().applyRemoteState(wire.cooldownRemainingMs);
          } else if (wire.type === "drain_response" && wire.messages) {
            // Resolve any waiting drain
            for (const [_id, resolver] of this.pendingDrains) {
              resolver(wire.messages);
            }
            this.pendingDrains.clear();
          }
        } catch {
          // Ignore malformed messages
        }
      };
    });
  }

  /** Disconnect from the bus server. */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  /** Publish a message via the remote bus. */
  async publish(channel: string, content: string, from?: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to bus");
    }
    const wire: WireMessage = {
      type: "publish",
      channel,
      content,
      from: from ?? this.subscriberId,
    };
    this.ws.send(JSON.stringify(wire));
    await Promise.resolve();
  }

  /** Drain messages -- returns locally buffered messages from push delivery. */
  async drain(channel?: string): Promise<BusMessage[]> {
    let messages: BusMessage[];
    if (channel) {
      messages = this.incomingQueue.filter((m) => m.channel === channel);
      this.incomingQueue = this.incomingQueue.filter((m) => m.channel !== channel);
    } else {
      messages = [...this.incomingQueue];
      this.incomingQueue = [];
    }
    return await Promise.resolve(messages);
  }

  /** Send a heartbeat ping to the server. */
  sendHeartbeat(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const wire: WireMessage = { type: "heartbeat", timestamp: Date.now() };
      this.ws.send(JSON.stringify(wire));
    }
  }

  /** Whether the WebSocket is connected. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// ---------------------------------------------------------------------------
// Singleton bus instance
// ---------------------------------------------------------------------------

let _bus: MessageBus | null = null;

/** Get or create the global message bus. */
export function getBus(): MessageBus {
  if (!_bus) {
    _bus = new MessageBus();
  }
  return _bus;
}

/**
 * Override the global bus singleton.
 * Used by isolate workers to inject a BusProxy.
 */
export function setBus(bus: MessageBus): void {
  _bus = bus;
}

/** Reset the global bus (for testing). */
export function resetBus(): void {
  _bus = null;
}
