export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Properties = Record<string, unknown>;
export type Traits = Record<string, unknown>;

export type MessageType = "track" | "page" | "screen" | "identify" | "group" | "alias";

/** Segment-spec message. This is exactly what hits the wire. */
export interface Message {
  type: MessageType;
  messageId: string;
  timestamp: string; // ISO 8601, when the event happened
  sentAt?: string;
  anonymousId?: string;
  userId?: string | null;
  /** track/screen name */
  event?: string;
  /** page */
  name?: string;
  category?: string;
  properties?: Properties;
  /** identify/group */
  traits?: Traits;
  /** group */
  groupId?: string;
  /** alias */
  previousId?: string;
  context?: Context;
  integrations?: Record<string, boolean | Record<string, unknown>>;
  writeKey?: string;
  _metadata?: Record<string, unknown>;
}

export interface Context {
  library?: { name: string; version: string };
  page?: { url?: string; path?: string; search?: string; title?: string; referrer?: string };
  userAgent?: string;
  userAgentData?: Record<string, unknown>;
  locale?: string;
  timezone?: string;
  screen?: { width: number; height: number; density?: number };
  campaign?: Record<string, string>;
  /** Client session: 30 minutes of inactivity starts a new one. isNew marks the first message of a session. */
  session?: { id: string; isNew: boolean };
  groupId?: string;
  ip?: string;
  traits?: Traits;
  [key: string]: unknown;
}

export interface BatchPayload {
  writeKey: string;
  batch: Message[];
  sentAt: string;
}

/** Per-call options, third argument in analytics.js. */
export interface Options {
  anonymousId?: string;
  timestamp?: string | Date;
  context?: Partial<Context>;
  integrations?: Record<string, boolean | Record<string, unknown>>;
  traits?: Traits;
  [key: string]: unknown;
}

export type Callback = (msg?: Message) => void;

export interface FourierOptions {
  /** Project write key from the Fourier dashboard. */
  writeKey: string;
  /**
   * Base URL of your Fourier server, e.g. https://analytics.example.com
   * Defaults to window.location.origin when the dashboard and app share a host.
   */
  host?: string;
  /** Max messages per network request. Default 20. */
  flushAt?: number;
  /** Max ms a message sits in the queue before a flush. Default 1000. */
  flushInterval?: number;
  /** Disable all network traffic (useful in tests). */
  disabled?: boolean;
  /** Log to console. */
  debug?: boolean;
  /** Cookie domain for identity cookies, e.g. ".example.com". */
  cookieDomain?: string;
  /** Persist identity in "cookie" (default), "localStorage" or "memory". */
  storage?: "cookie" | "localStorage" | "memory";
  /** Extra context merged into every message. */
  defaultContext?: Partial<Context>;
  /** Inactivity gap that starts a new session, in ms. Default 30 minutes. 0 disables sessions. */
  sessionTimeout?: number;
  /**
   * Measure how long each page actually held attention and report it as `$page_leave`.
   * Default true. Only foreground time with recent interaction is counted, so the number
   * means something; turn it off and Fourier's engagement reports say the measurement is
   * missing rather than showing a zero.
   */
  engagement?: boolean;
  /** Visible-but-untouched time after which the engagement clock stops, in ms. Default 5 minutes. */
  engagementIdleTimeout?: number;
  /**
   * Domains that share this user's identity but can't share cookies, e.g. ["app.example.io", "example.io"].
   * Links to them get `ajs_aid` (and `ajs_uid` when identified) appended so the visitor stays one person
   * across sites. Matches the domain and its subdomains. On arrival, those parameters are read and removed.
   *
   * The list gates both directions, so set it on every site in the group and name the others in it:
   * ids are only appended to a listed host, and only accepted when the visitor arrived from one.
   * Unset (the default), incoming `ajs_aid` / `ajs_uid` are ignored — an id in a URL is an assertion
   * about who the visitor is, and anyone can put one in a link.
   */
  crossDomain?: string[];
  /** Override the fetch implementation. */
  fetch?: typeof fetch;
}
