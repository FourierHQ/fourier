import type {
  BatchPayload,
  Callback,
  Context,
  FourierOptions,
  Message,
  MessageType,
  Options,
  Properties,
  Traits,
} from "./types";

export type {
  BatchPayload,
  Callback,
  Context,
  FourierOptions,
  Message,
  MessageType,
  Options,
  Properties,
  Traits,
} from "./types";

export const SDK_NAME = "fourier";
export const SDK_VERSION = "0.1.0";

// Same keys analytics.js uses, so migrating apps keep their anonymous ids.
const ANON_KEY = "ajs_anonymous_id";
const USER_KEY = "ajs_user_id";
const USER_TRAITS_KEY = "ajs_user_traits";
const GROUP_KEY = "ajs_group_id";
const GROUP_TRAITS_KEY = "ajs_group_properties";
const SESSION_KEY = "fourier_session";
const DEFAULT_SESSION_TIMEOUT = 30 * 60 * 1000;

/**
 * Engagement measurement. The event name matches the one Fourier's schema sums into a
 * session and then excludes from every report — see PAGE_LEAVE in @fourierhq/core.
 */
const PAGE_LEAVE_EVENT = "$page_leave";
const ENGAGEMENT_TICK_MS = 1000;
/**
 * Visible but untouched for this long and the clock stops. Long enough not to punish
 * someone reading a screenful without scrolling; short enough that a tab abandoned on a
 * second monitor does not report an afternoon of rapt attention.
 */
const DEFAULT_ENGAGEMENT_IDLE = 5 * 60 * 1000;
/** Below this, a page view is a bounce off the wrong link and not worth a beacon. */
const ENGAGEMENT_MIN_MS = 1000;

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------- storage ----------

interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Older analytics.js JSON-encoded cookie values ("\"abc\""). Accept both. */
function unwrap(v: string | null): string | null {
  if (v == null) return null;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {}
  }
  return v;
}

function cookieStore(domain?: string): Store {
  const secure = isBrowser && location.protocol === "https:" ? "; Secure" : "";
  const dom = domain ? `; domain=${domain}` : "";
  return {
    get(key) {
      const m = document.cookie.match(new RegExp(`(?:^|; )${key}=([^;]*)`));
      return m ? unwrap(decodeURIComponent(m[1])) : null;
    },
    set(key, value) {
      document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax${dom}${secure}`;
    },
    remove(key) {
      document.cookie = `${key}=; path=/; max-age=0${dom}`;
    },
  };
}

function localStore(): Store {
  return {
    get(key) {
      try {
        return unwrap(localStorage.getItem(key));
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {}
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {}
    },
  };
}

function memoryStore(): Store {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

function layeredStore(mode: FourierOptions["storage"], domain?: string): Store {
  if (!isBrowser || mode === "memory") return memoryStore();
  const layers = mode === "localStorage" ? [localStore()] : [cookieStore(domain), localStore()];
  return {
    get(key) {
      for (const l of layers) {
        const v = l.get(key);
        if (v) {
          for (const other of layers) if (other !== l && !other.get(key)) other.set(key, v);
          return v;
        }
      }
      return null;
    },
    set(key, value) {
      for (const l of layers) l.set(key, value);
    },
    remove(key) {
      for (const l of layers) l.remove(key);
    },
  };
}

// ---------- context ----------

function pageContext(): NonNullable<Context["page"]> {
  if (!isBrowser) return {};
  return {
    url: location.href,
    path: location.pathname,
    search: location.search,
    title: document.title,
    referrer: document.referrer,
  };
}

function campaignContext(): Record<string, string> | undefined {
  if (!isBrowser) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(location.search)) {
    if (k.startsWith("utm_")) out[k.slice(4)] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function baseContext(): Context {
  const ctx: Context = { library: { name: SDK_NAME, version: SDK_VERSION } };
  if (isBrowser) {
    ctx.page = pageContext();
    ctx.userAgent = navigator.userAgent;
    ctx.locale = navigator.language;
    try {
      ctx.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {}
    ctx.screen = { width: window.screen.width, height: window.screen.height, density: window.devicePixelRatio };
    const campaign = campaignContext();
    if (campaign) ctx.campaign = campaign;
  }
  return ctx;
}

function deepMerge<T extends Record<string, unknown>>(a: T, b?: Partial<T>): T {
  if (!b) return a;
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ---------- cross-domain identity ----------

export const CROSS_DOMAIN_ANON_PARAM = "ajs_aid";
export const CROSS_DOMAIN_USER_PARAM = "ajs_uid";

/** Pull analytics.js-style identity params out of a query string. */
export function readCrossDomainIds(search: string): { anonymousId?: string; userId?: string } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: { anonymousId?: string; userId?: string } = {};
  const aid = params.get(CROSS_DOMAIN_ANON_PARAM);
  const uid = params.get(CROSS_DOMAIN_USER_PARAM);
  if (aid) out.anonymousId = aid;
  if (uid) out.userId = uid;
  return out;
}

export function hostMatches(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return domains.some((d) => {
    const dd = d.toLowerCase().replace(/^\./, "");
    return h === dd || h.endsWith(`.${dd}`);
  });
}

// ---------- emitter ----------

type EventName = MessageType | "ready" | "flush" | "error" | "reset";
type Listener = (...args: unknown[]) => void;

class Emitter {
  private listeners = new Map<string, Set<Listener>>();
  on(event: EventName, fn: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }
  once(event: EventName, fn: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }
  off(event: EventName, fn?: Listener): this {
    if (!fn) this.listeners.delete(event);
    else this.listeners.get(event)?.delete(fn);
    return this;
  }
  protected emit(event: EventName, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {
        console.error("[fourier] listener error", e);
      }
    });
  }
}

// ---------- user / group handles (analytics.user(), analytics.group()) ----------

export interface UserHandle {
  id(): string | null;
  anonymousId(id?: string): string;
  traits(): Traits;
}

export interface GroupHandle {
  id(): string | null;
  traits(): Traits;
}

// ---------- client ----------

type Middleware = (payload: { payload: Message; next: (payload: Message | null) => void }) => void;

export class Fourier extends Emitter {
  readonly options: FourierOptions & { host: string; flushAt: number; flushInterval: number };
  /** analytics.js compat: ms to wait before unload flush. */
  timeout = 300;
  private store: Store;
  private queue: Message[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fetchImpl: typeof fetch;
  private middlewares: Middleware[] = [];
  private readyPromise: Promise<Fourier>;

  constructor(options: FourierOptions) {
    super();
    if (!options.writeKey) throw new Error("[fourier] writeKey is required");
    const host = (options.host ?? (isBrowser ? location.origin : "")).replace(/\/+$/, "");
    if (!host) throw new Error("[fourier] host is required outside the browser");
    this.options = { flushAt: 20, flushInterval: 1000, ...options, host };
    this.store = layeredStore(options.storage, options.cookieDomain);
    this.fetchImpl = options.fetch ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : (undefined as never));
    this.adoptCrossDomainIds();
    this.bindCrossDomainLinks();
    this.bindUnload();
    this.readyPromise = Promise.resolve(this);
    queueMicrotask(() => this.emit("ready"));
  }

  // ---- analytics.js: load / ready / debug ----

  /** analytics.js compat: `analytics.load(writeKey, options)`. */
  static load(writeKey: string, options: Omit<FourierOptions, "writeKey"> = {}): Fourier {
    return init({ writeKey, ...options });
  }

  ready(cb?: () => void): Promise<Fourier> {
    if (cb) this.readyPromise.then(() => cb());
    return this.readyPromise;
  }

  debug(enabled = true): void {
    this.options.debug = enabled;
  }

  /** analytics.js compat: source middleware that can mutate or drop messages. */
  addSourceMiddleware(mw: Middleware): this {
    this.middlewares.push(mw);
    return this;
  }

  // ---- cross-domain ----

  /**
   * On arrival from a decorated link, adopt the ids and clean the URL.
   *
   * Both ends of this handshake are gated, because `ajs_uid` in a URL is an
   * assertion about who the visitor is and anyone can write one. `decorateUrl`
   * only hands ids to a host in `crossDomain`; this only accepts them back from
   * one. Without the second check, `?ajs_uid=someone@else.com` on any link into
   * the site re-identifies whoever clicks it, persistently, on every install —
   * including installs that never turned cross-domain identity on.
   *
   * The referrer is what tells us which site handed over. Under the default
   * `strict-origin-when-cross-origin` policy a cross-site navigation still
   * carries its origin, so the supported flow works; a sending site that sets
   * `no-referrer` or `rel="noreferrer"` deliberately withholds it, and there we
   * drop the ids rather than trust an unattributable claim.
   */
  private adoptCrossDomainIds() {
    if (!isBrowser) return;
    const domains = this.options.crossDomain ?? [];
    if (domains.length === 0) return;
    const ids = readCrossDomainIds(location.search);
    if (!ids.anonymousId && !ids.userId) return;
    if (this.referrerIsTrusted(domains)) {
      if (ids.anonymousId) this.store.set(ANON_KEY, ids.anonymousId);
      if (ids.userId) this.store.set(USER_KEY, ids.userId);
    }
    // Strip the parameters either way: adopted they are spent, rejected they are
    // noise we don't want leaking onward in referrers or shared links.
    try {
      const url = new URL(location.href);
      url.searchParams.delete(CROSS_DOMAIN_ANON_PARAM);
      url.searchParams.delete(CROSS_DOMAIN_USER_PARAM);
      history.replaceState(history.state, "", url.toString());
    } catch {}
  }

  /** Did this navigation come from a site we were told shares an identity with us? */
  private referrerIsTrusted(domains: string[]): boolean {
    try {
      const host = new URL(document.referrer).host;
      return !!host && hostMatches(host, domains);
    } catch {
      return false;
    }
  }

  /** Append identity params to a URL that points at one of the crossDomain hosts. */
  decorateUrl(href: string): string {
    const domains = this.options.crossDomain ?? [];
    if (domains.length === 0) return href;
    try {
      const url = new URL(href, isBrowser ? location.href : undefined);
      if (isBrowser && url.host === location.host) return href;
      if (!hostMatches(url.host, domains)) return href;
      url.searchParams.set(CROSS_DOMAIN_ANON_PARAM, this.anonymousId());
      const uid = this.userId();
      if (uid) url.searchParams.set(CROSS_DOMAIN_USER_PARAM, uid);
      return url.toString();
    } catch {
      return href;
    }
  }

  /** Decorate outbound links at click time so the id is current. */
  private bindCrossDomainLinks() {
    if (!isBrowser || !(this.options.crossDomain?.length)) return;
    const handler = (e: Event) => {
      const target = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!target || !target.href) return;
      const decorated = this.decorateUrl(target.href);
      if (decorated !== target.href) target.href = decorated;
    };
    document.addEventListener("click", handler, true);
    document.addEventListener("auxclick", handler, true);
  }

  // ---- sessions ----

  /**
   * Returns the current session and whether this call started a new one.
   * Sessions end after `sessionTimeout` ms of inactivity. Used for attribution: the first
   * message of a session is an "arrival" even without UTMs or a referrer.
   */
  private touchSession(): { id: string; isNew: boolean } | null {
    const timeout = this.options.sessionTimeout ?? DEFAULT_SESSION_TIMEOUT;
    if (timeout <= 0) return null;
    const now = Date.now();
    let id: string | null = null;
    let last = 0;
    try {
      const raw = this.store.get(SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { id?: string; last?: number };
        id = parsed.id ?? null;
        last = parsed.last ?? 0;
      }
    } catch {}
    const isNew = !id || now - last > timeout;
    if (isNew) id = uuid();
    this.store.set(SESSION_KEY, JSON.stringify({ id, last: now }));
    return { id: id!, isNew };
  }

  /** End the current session so the next message starts a new one (a new attribution touch). */
  newSession(): void {
    this.store.remove(SESSION_KEY);
  }

  // ---- engagement ----

  /**
   * Time a page actually held someone's attention.
   *
   * Only foreground time counts, and only while there has been recent interaction: the
   * clock runs when the tab is visible and stops when it is hidden or when nobody has
   * touched anything for `engagementIdleTimeout`. That restraint is the point. Elapsed
   * wall-clock between two events is trivial to compute and describes a tab left open
   * over lunch as fifty minutes of reading, and a report that says so is worse than a
   * report with no engagement column at all.
   *
   * The total is sent as `$page_leave` when the page goes away — a route change, a tab
   * close, a navigation — carrying the page context of the page being left. Fourier
   * sums it into the session and then excludes the event from every other report.
   */
  private engagement: { ms: number; lastTick: number; lastActivity: number; page: NonNullable<Context["page"]> } | null = null;
  private engagementTimer: ReturnType<typeof setInterval> | null = null;
  private engagementBound = false;

  private startEngagement(): void {
    if (!isBrowser || this.options.engagement === false) return;
    const now = Date.now();
    this.engagement = { ms: 0, lastTick: now, lastActivity: now, page: pageContext() };
    this.bindEngagement();
    this.startTicking();
  }

  /**
   * The clock only runs while there is something to measure. Hidden tabs stop it
   * entirely rather than ticking into a counter that discards every tick, which keeps
   * a backgrounded tab genuinely idle instead of merely pointless.
   */
  private startTicking(): void {
    if (!this.engagementTimer) this.engagementTimer = setInterval(() => this.tickEngagement(), ENGAGEMENT_TICK_MS);
  }

  private stopTicking(): void {
    if (this.engagementTimer) {
      clearInterval(this.engagementTimer);
      this.engagementTimer = null;
    }
  }

  private tickEngagement(): void {
    const e = this.engagement;
    if (!e) return;
    const now = Date.now();
    const since = now - e.lastTick;
    e.lastTick = now;
    const idleAfter = this.options.engagementIdleTimeout ?? DEFAULT_ENGAGEMENT_IDLE;
    const active = document.visibilityState === "visible" && now - e.lastActivity < idleAfter;
    // Background tabs have their timers throttled to once a minute or worse, so a tick
    // can arrive long after the one before it. Crediting the whole gap would hand a
    // buried tab minutes of "engagement" on the strength of one late callback, so a
    // tick can only ever add a little more than its own interval.
    if (active) e.ms += Math.min(since, ENGAGEMENT_TICK_MS * 2);
  }

  private bindEngagement(): void {
    if (this.engagementBound) return;
    this.engagementBound = true;
    const seen = () => {
      if (this.engagement) this.engagement.lastActivity = Date.now();
    };
    for (const type of ["pointerdown", "keydown", "scroll", "wheel", "touchstart"]) {
      window.addEventListener(type, seen, { passive: true, capture: true });
    }
    // Mouse movement counts as attention, but it fires a hundred times a second and
    // this is a listener the host page did not ask for on its hottest event. Recording
    // it at most once a second is indistinguishable at the resolution anything here
    // measures, and keeps Fourier out of their performance profile.
    let lastMove = 0;
    window.addEventListener(
      "mousemove",
      () => {
        const now = Date.now();
        if (now - lastMove < ENGAGEMENT_TICK_MS) return;
        lastMove = now;
        seen();
      },
      { passive: true, capture: true },
    );
    // A tab coming back to the front is attention, and it also resets the tick clock so
    // the hidden stretch is never credited retroactively. Going away stops the clock;
    // banking the time is bindUnload's handler, which runs first and also flushes.
    document.addEventListener("visibilitychange", () => {
      if (!this.engagement) return;
      this.engagement.lastTick = Date.now();
      if (document.visibilityState === "visible") {
        seen();
        this.startTicking();
      } else {
        this.stopTicking();
      }
    });
  }

  /**
   * Close out the current page's measurement and report it. `keepOpen` is for the tab
   * being hidden, where the page has not been left — the time so far is banked and a
   * fresh measurement starts if the reader comes back.
   */
  private endEngagement(opts: { keepOpen?: boolean } = {}): void {
    const e = this.engagement;
    if (!e) return;
    this.tickEngagement();
    const ms = Math.round(e.ms);
    // Below the reporting minimum the time is carried into the next stretch rather than
    // thrown away. Someone alt-tabbing every few seconds banks 800ms each time, and
    // discarding it would report nothing at all for a page they spent a minute on.
    const carried = ms < ENGAGEMENT_MIN_MS ? e.ms : 0;
    this.engagement = opts.keepOpen ? { ...e, ms: carried, lastTick: Date.now() } : null;
    // Closing the page for good stops the clock; keepOpen leaves it to the
    // visibilitychange handler, which stops it on the way out and restarts it on return.
    if (!opts.keepOpen) this.stopTicking();
    // Nothing measured is nothing to report. An empty beacon would still cost a request
    // and would land in the table as a page view that engaged nobody for zero seconds,
    // which is indistinguishable from one the SDK never measured.
    if (ms < ENGAGEMENT_MIN_MS) return;
    void this.dispatch(
      { type: "track", event: PAGE_LEAVE_EVENT, properties: { engaged_ms: ms, path: e.page.path ?? "", url: e.page.url ?? "" } },
      // The page being left, not wherever the router has already moved to.
      { context: { page: e.page } },
    );
  }

  sessionId(): string | null {
    try {
      const raw = this.store.get(SESSION_KEY);
      return raw ? ((JSON.parse(raw) as { id?: string }).id ?? null) : null;
    } catch {
      return null;
    }
  }

  // ---- identity ----

  user(): UserHandle {
    return {
      id: () => this.userId(),
      anonymousId: (id?: string) => (id ? this.setAnonymousId(id) : this.anonymousId()),
      traits: () => this.userTraits(),
    };
  }

  anonymousId(): string {
    let id = this.store.get(ANON_KEY);
    if (!id) {
      id = uuid();
      this.store.set(ANON_KEY, id);
    }
    return id;
  }

  setAnonymousId(id: string): string {
    this.store.set(ANON_KEY, id);
    return id;
  }

  userId(): string | null {
    return this.store.get(USER_KEY);
  }

  userTraits(): Traits {
    return this.readJson(USER_TRAITS_KEY);
  }

  groupId(): string | null {
    return this.store.get(GROUP_KEY);
  }

  groupTraits(): Traits {
    return this.readJson(GROUP_TRAITS_KEY);
  }

  private readJson(key: string): Traits {
    try {
      const raw = this.store.get(key);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  // ---- public api: identical argument handling to analytics.js ----

  /**
   * identify([userId], [traits], [options], [callback])
   */
  identify(
    userId?: string | number | Traits | null,
    traits?: Traits | Options | Callback,
    options?: Options | Callback,
    callback?: Callback,
  ): Promise<Message | null> {
    // shift arguments left when userId is omitted
    if (isObj(userId)) {
      callback = options as Callback;
      options = traits as Options;
      traits = userId;
      userId = undefined;
    }
    if (typeof traits === "function") {
      callback = traits;
      traits = undefined;
      options = undefined;
    }
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    const id = userId == null ? this.userId() : String(userId);
    if (id) this.store.set(USER_KEY, id);
    const merged = { ...this.userTraits(), ...((traits as Traits) ?? {}) };
    this.store.set(USER_TRAITS_KEY, JSON.stringify(merged));
    return this.dispatch({ type: "identify", userId: id, traits: merged }, options as Options, callback);
  }

  /**
   * track(event, [properties], [options], [callback])
   */
  track(
    event: string,
    properties?: Properties | Callback,
    options?: Options | Callback,
    callback?: Callback,
  ): Promise<Message | null> {
    if (typeof properties === "function") {
      callback = properties;
      properties = undefined;
      options = undefined;
    }
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (!event) {
      this.log("track called without an event name");
      return Promise.resolve(null);
    }
    return this.dispatch({ type: "track", event, properties: (properties as Properties) ?? {} }, options as Options, callback);
  }

  /**
   * page([category], [name], [properties], [options], [callback])
   */
  page(
    category?: string | Properties | Callback | null,
    name?: string | Properties | Options | Callback | null,
    properties?: Properties | Options | Callback | null,
    options?: Options | Callback,
    callback?: Callback,
  ): Promise<Message | null> {
    // analytics.js argument resolution
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (typeof properties === "function") {
      callback = properties;
      properties = undefined;
    }
    if (typeof name === "function") {
      callback = name;
      name = undefined;
    }
    if (typeof category === "function") {
      callback = category;
      category = undefined;
    }
    if (isObj(category)) {
      // page(properties, [options])
      options = name as Options;
      properties = category;
      category = undefined;
      name = undefined;
    } else if (isObj(name)) {
      // page(name, properties, [options])
      options = properties as Options;
      properties = name;
      name = category as string;
      category = undefined;
    } else if (typeof category === "string" && name === undefined) {
      // page(name)
      name = category;
      category = undefined;
    }
    const props: Properties = { ...pageContext(), ...((properties as Properties) ?? {}) };
    if (name) props.name = name;
    if (category) props.category = category;
    // The page being left is closed out before the new one opens, so a single-page app's
    // route change reports the time spent on the route it is leaving rather than rolling
    // it into the next one.
    this.endEngagement();
    const sent = this.dispatch(
      {
        type: "page",
        name: (name as string) ?? undefined,
        category: (category as string) ?? undefined,
        properties: props,
      },
      options as Options,
      callback,
    );
    this.startEngagement();
    return sent;
  }

  screen(
    name: string,
    properties?: Properties | Callback,
    options?: Options | Callback,
    callback?: Callback,
  ): Promise<Message | null> {
    if (typeof properties === "function") {
      callback = properties;
      properties = undefined;
      options = undefined;
    }
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    return this.dispatch(
      { type: "screen", name, properties: (properties as Properties) ?? {} },
      options as Options,
      callback,
    );
  }

  /**
   * group(groupId, [traits], [options], [callback]) associates the user with a
   * company / workspace / organisation. `group()` with no args returns the handle.
   */
  group(): GroupHandle;
  group(groupId: string | number, traits?: Traits | Callback, options?: Options | Callback, callback?: Callback): Promise<Message | null>;
  group(
    groupId?: string | number,
    traits?: Traits | Callback,
    options?: Options | Callback,
    callback?: Callback,
  ): GroupHandle | Promise<Message | null> {
    if (groupId === undefined) {
      return { id: () => this.groupId(), traits: () => this.groupTraits() };
    }
    if (typeof traits === "function") {
      callback = traits;
      traits = undefined;
      options = undefined;
    }
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    const id = String(groupId);
    const merged = { ...(this.groupId() === id ? this.groupTraits() : {}), ...((traits as Traits) ?? {}) };
    this.store.set(GROUP_KEY, id);
    this.store.set(GROUP_TRAITS_KEY, JSON.stringify(merged));
    return this.dispatch({ type: "group", groupId: id, traits: merged }, options as Options, callback);
  }

  /**
   * alias(userId, [previousId], [options], [callback])
   */
  alias(
    userId: string | number,
    previousId?: string | number | Options | Callback,
    options?: Options | Callback,
    callback?: Callback,
  ): Promise<Message | null> {
    if (isObj(previousId)) {
      callback = options as Callback;
      options = previousId as Options;
      previousId = undefined;
    }
    if (typeof previousId === "function") {
      callback = previousId;
      previousId = undefined;
      options = undefined;
    }
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    const to = String(userId);
    const from = previousId != null ? String(previousId) : this.userId() ?? this.anonymousId();
    this.store.set(USER_KEY, to);
    return this.dispatch({ type: "alias", userId: to, previousId: from }, options as Options, callback);
  }

  /** Clear user + group + traits, rotate the anonymous id. Call on logout. */
  reset(): void {
    this.store.remove(USER_KEY);
    this.store.remove(USER_TRAITS_KEY);
    this.store.remove(GROUP_KEY);
    this.store.remove(GROUP_TRAITS_KEY);
    this.store.set(ANON_KEY, uuid());
    this.store.remove(SESSION_KEY);
    this.emit("reset");
  }

  // ---- DOM helpers from analytics.js ----

  trackLink(
    links: Element | Element[] | NodeListOf<Element> | null,
    event: string | ((el: Element) => string),
    properties?: Properties | ((el: Element) => Properties),
  ): this {
    if (!isBrowser || !links) return this;
    const list = links instanceof Element ? [links] : Array.from(links);
    for (const el of list) {
      el.addEventListener("click", (e) => {
        const ev = typeof event === "function" ? event(el) : event;
        const props = typeof properties === "function" ? properties(el) : properties;
        void this.track(ev, props);
        const href = (el as HTMLAnchorElement).href;
        const target = (el as HTMLAnchorElement).target;
        if (href && !target && !(e as MouseEvent).metaKey && !(e as MouseEvent).ctrlKey) {
          e.preventDefault();
          setTimeout(() => (location.href = href), this.timeout);
        }
      });
    }
    return this;
  }

  trackForm(
    forms: HTMLFormElement | HTMLFormElement[] | NodeListOf<HTMLFormElement> | null,
    event: string | ((el: HTMLFormElement) => string),
    properties?: Properties | ((el: HTMLFormElement) => Properties),
  ): this {
    if (!isBrowser || !forms) return this;
    const list = forms instanceof HTMLFormElement ? [forms] : Array.from(forms);
    for (const el of list) {
      el.addEventListener("submit", (e) => {
        const ev = typeof event === "function" ? event(el) : event;
        const props = typeof properties === "function" ? properties(el) : properties;
        void this.track(ev, props);
        e.preventDefault();
        setTimeout(() => el.submit(), this.timeout);
      });
    }
    return this;
  }

  // ---- queue ----

  private dispatch(partial: Partial<Message> & { type: MessageType }, options?: Options, callback?: Callback) {
    const opts = options ?? {};
    let context = deepMerge(baseContext(), this.options.defaultContext);
    if (opts.context) context = deepMerge(context, opts.context);
    const groupId = partial.groupId ?? this.groupId();
    if (groupId && !context.groupId) context.groupId = groupId;
    if (opts.traits) context.traits = opts.traits;
    const session = this.touchSession();
    if (session && !context.session) context.session = session;

    const ts = opts.timestamp ? new Date(opts.timestamp) : new Date();
    const msg: Message = {
      messageId: `ajs-next-${Date.now()}-${uuid()}`,
      timestamp: ts.toISOString(),
      anonymousId: opts.anonymousId ?? this.anonymousId(),
      userId: this.userId(),
      context,
      integrations: opts.integrations ?? {},
      ...partial,
    };
    if (opts.anonymousId) this.setAnonymousId(opts.anonymousId);

    return new Promise<Message | null>((resolve) => {
      this.runMiddleware(msg, (finalMsg) => {
        if (!finalMsg) {
          callback?.(undefined);
          return resolve(null);
        }
        this.log(finalMsg.type, finalMsg.event ?? finalMsg.name ?? "", finalMsg);
        this.emit(finalMsg.type, finalMsg.event ?? finalMsg.name, finalMsg.properties ?? finalMsg.traits, finalMsg);
        if (!this.options.disabled) this.enqueue(finalMsg);
        // analytics.js fires callbacks after the event is queued, before delivery.
        setTimeout(() => callback?.(finalMsg), 0);
        resolve(finalMsg);
      });
    });
  }

  private runMiddleware(msg: Message, done: (m: Message | null) => void) {
    const chain = [...this.middlewares];
    const step = (m: Message | null) => {
      if (!m) return done(null);
      const mw = chain.shift();
      if (!mw) return done(m);
      mw({ payload: m, next: step });
    };
    step(msg);
  }

  private enqueue(msg: Message) {
    this.queue.push(msg);
    if (this.queue.length >= this.options.flushAt) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.options.flushInterval);
  }

  async flush(useBeacon = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const payload: BatchPayload = { writeKey: this.options.writeKey, batch, sentAt: new Date().toISOString() };
    const body = JSON.stringify(payload);
    const url = `${this.options.host}/v1/batch`;

    if (useBeacon && isBrowser && "sendBeacon" in navigator) {
      // sendBeacon can't set a JSON content-type; the server accepts text/plain.
      if (navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) {
        this.emit("flush", batch);
        return;
      }
    }
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
        keepalive: true,
      });
      if (!res.ok) {
        this.log(`flush failed: ${res.status}`);
        this.emit("error", new Error(`flush failed: ${res.status}`));
        if (res.status >= 500) this.queue.unshift(...batch.slice(0, 100));
      } else this.emit("flush", batch);
    } catch (err) {
      this.log("flush error", err);
      this.emit("error", err);
      this.queue.unshift(...batch.slice(0, 100));
    }
  }

  private bindUnload() {
    if (!isBrowser) return;
    document.addEventListener("visibilitychange", () => {
      // endEngagement() enqueues before flush(true) sends, so the last page of a visit
      // reports its time. Without this the page someone actually left on — usually the
      // most interesting one — would be the only page never measured.
      if (document.visibilityState === "hidden") {
        this.endEngagement({ keepOpen: true });
        void this.flush(true);
      }
    });
    window.addEventListener("pagehide", () => {
      this.endEngagement();
      void this.flush(true);
    });
  }

  private log(...args: unknown[]) {
    if (this.options.debug) console.log("[fourier]", ...args);
  }
}

/** Alias so `import { AnalyticsBrowser } from "@fourierhq/sdk"` reads like analytics-next. */
export const AnalyticsBrowser = Fourier;
export type Analytics = Fourier;

// ---------- singleton convenience ----------

let singleton: Fourier | null = null;

export function init(options: FourierOptions): Fourier {
  singleton = new Fourier(options);
  if (isBrowser) {
    const w = window as unknown as { fourier?: Fourier; analytics?: Fourier };
    w.fourier = singleton;
    if (!w.analytics) w.analytics = singleton;
  }
  return singleton;
}

export function getFourier(): Fourier | null {
  return singleton;
}

function must(): Fourier {
  if (!singleton) throw new Error("[fourier] call init() first");
  return singleton;
}

// Module-level functions mirroring the analytics.js global.
export const identify: Fourier["identify"] = (...args) => must().identify(...args);
export const track: Fourier["track"] = (...args) => must().track(...args);
export const page: Fourier["page"] = (...args) => must().page(...args);
export const screen: Fourier["screen"] = (...args) => must().screen(...args);
export const group = ((...args: Parameters<Fourier["group"]>) =>
  (must().group as (...a: unknown[]) => unknown)(...args)) as Fourier["group"];
export const alias: Fourier["alias"] = (...args) => must().alias(...args);
export const reset = (): void => must().reset();
export const flush = (): Promise<void> => must().flush();
export const ready: Fourier["ready"] = (cb) => must().ready(cb);
export const user = (): UserHandle => must().user();

const fourier = { init, load: Fourier.load, identify, track, page, screen, group, alias, reset, flush, ready, user, getFourier, Fourier };
export default fourier;
