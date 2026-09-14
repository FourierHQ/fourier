/**
 * Server-side client for Node / edge runtimes (API routes, server actions, cron jobs).
 * Shaped like @segment/analytics-node: every call requires a userId or anonymousId.
 */
import type { BatchPayload, Context, Message, MessageType, Options, Properties, Traits } from "./types";
import { SDK_NAME, SDK_VERSION, uuid } from "./index";

export type { Message, Properties, Traits, Options } from "./types";

export interface FourierServerOptions {
  writeKey: string;
  host: string;
  /** Default 100. */
  flushAt?: number;
  /** Default 10000 ms. */
  flushInterval?: number;
  disabled?: boolean;
  fetch?: typeof fetch;
  onError?: (err: unknown) => void;
}

interface Identity {
  userId?: string;
  anonymousId?: string;
}

type ServerParams<T> = Identity & T & { context?: Partial<Context>; timestamp?: Date | string; integrations?: Options["integrations"] };

export class FourierServer {
  private queue: Message[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Set<Promise<void>>();
  private opts: Required<Omit<FourierServerOptions, "onError" | "fetch">> & FourierServerOptions;

  constructor(opts: FourierServerOptions) {
    if (!opts.writeKey) throw new Error("[fourier] writeKey is required");
    if (!opts.host) throw new Error("[fourier] host is required");
    this.opts = { flushAt: 100, flushInterval: 10_000, disabled: false, ...opts, host: opts.host.replace(/\/+$/, "") };
  }

  identify(p: ServerParams<{ traits?: Traits }>) {
    return this.enqueue("identify", p, { traits: p.traits ?? {} });
  }
  track(p: ServerParams<{ event: string; properties?: Properties }>) {
    return this.enqueue("track", p, { event: p.event, properties: p.properties ?? {} });
  }
  page(p: ServerParams<{ name?: string; category?: string; properties?: Properties }>) {
    return this.enqueue("page", p, { name: p.name, category: p.category, properties: p.properties ?? {} });
  }
  screen(p: ServerParams<{ name: string; properties?: Properties }>) {
    return this.enqueue("screen", p, { name: p.name, properties: p.properties ?? {} });
  }
  group(p: ServerParams<{ groupId: string; traits?: Traits }>) {
    return this.enqueue("group", p, { groupId: p.groupId, traits: p.traits ?? {} });
  }
  alias(p: { userId: string; previousId: string; context?: Partial<Context>; timestamp?: Date | string }) {
    return this.enqueue("alias", p, { previousId: p.previousId });
  }

  private enqueue(type: MessageType, p: ServerParams<Record<string, unknown>> | { userId?: string; anonymousId?: string; context?: Partial<Context>; timestamp?: Date | string }, body: Partial<Message>) {
    if (!p.userId && !p.anonymousId) throw new Error(`[fourier] ${type} requires userId or anonymousId`);
    const msg: Message = {
      type,
      messageId: `node-${Date.now()}-${uuid()}`,
      timestamp: (p.timestamp ? new Date(p.timestamp) : new Date()).toISOString(),
      userId: p.userId,
      anonymousId: p.anonymousId,
      context: { library: { name: `${SDK_NAME}-server`, version: SDK_VERSION }, ...(p.context ?? {}) },
      integrations: ("integrations" in p ? p.integrations : undefined) ?? {},
      ...body,
    };
    if (body.groupId && msg.context) msg.context.groupId = body.groupId;
    if (this.opts.disabled) return msg;
    this.queue.push(msg);
    if (this.queue.length >= this.opts.flushAt) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.opts.flushInterval);
      // don't keep the node process alive just for the timer
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
    return msg;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const payload: BatchPayload = { writeKey: this.opts.writeKey, batch, sentAt: new Date().toISOString() };
    const f = this.opts.fetch ?? fetch;
    const p = f(`${this.opts.host}/v1/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${this.opts.writeKey}:`)}` },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`[fourier] flush failed: ${res.status}`);
      })
      .catch((err) => this.opts.onError?.(err) ?? console.error(err))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    await p;
  }

  /** Flush and wait for all in-flight requests. Call before the process exits. */
  async closeAndFlush(): Promise<void> {
    await this.flush();
    await Promise.all(this.pending);
  }
}

/** analytics-node style alias */
export const Analytics = FourierServer;
export default FourierServer;
