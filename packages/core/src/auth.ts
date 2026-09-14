/**
 * Accounts, sessions and read keys.
 *
 * Every read and write of auth state goes through this module — routes never
 * touch the tables directly. That boundary is the escape hatch: if this ever
 * needs a transactional database, one file changes instead of the whole app.
 *
 * Two credentials, two jobs:
 * - Write keys (`fk_…`, see projects.ts) let a machine send data IN. No account.
 * - Read keys (`fr_…`) and session cookies let a person or agent read data OUT.
 *
 * Sessions are signed tokens rather than rows, so logging in doesn't write to
 * ClickHouse. `token_version` on the account makes them revocable anyway.
 */
import { createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { getClient } from "./client";

function scrypt(password: string, salt: Buffer, keylen: number, N: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must be raised alongside N; the default ceiling rejects N = 16384.
    scryptCb(password, salt, keylen, { N, maxmem: 64 * 1024 * 1024 }, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

export const SESSION_COOKIE = "fourier_session";
/** Long enough that a dashboard left open overnight still works. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface Account {
  id: string;
  email: string;
  name: string;
  role: string;
  auth_provider: string;
  provider_user_id: string;
  token_version: number;
  last_login_at: string;
  created_at: string;
  updated_at: string;
}

interface AccountRow extends Account {
  password_hash: string;
  deleted: number;
}

function toAccount(row: AccountRow): Account {
  const { password_hash: _p, deleted: _d, ...account } = row;
  return { ...account, token_version: Number(account.token_version) };
}

const ACCOUNT_COLUMNS = `id, email, name, password_hash, role, auth_provider, provider_user_id, token_version, last_login_at, deleted, created_at, updated_at`;

// ---------- signing secret ----------

let secretCache: string | null = null;

/**
 * FOURIER_SECRET when set, otherwise a secret generated on first boot and kept
 * in `settings`. Generating it means a fresh install has working sessions with
 * no configuration; setting it explicitly is still better, because rotating the
 * environment variable is how you force every session to end.
 */
export async function getSigningSecret(): Promise<string> {
  if (secretCache) return secretCache;
  const fromEnv = process.env.FOURIER_SECRET?.trim();
  if (fromEnv) {
    secretCache = fromEnv;
    return fromEnv;
  }
  const existing = await getSetting("signing_secret");
  if (existing) {
    secretCache = existing;
    return existing;
  }
  const generated = randomBytes(32).toString("base64url");
  await setSetting("signing_secret", generated);
  // Another instance may have written first; re-read so every instance agrees.
  const settled = (await getSetting("signing_secret")) ?? generated;
  secretCache = settled;
  return settled;
}

export function clearSecretCache() {
  secretCache = null;
}

export async function getSetting(key: string): Promise<string | null> {
  const res = await getClient().query({
    query: `SELECT value FROM settings FINAL WHERE key = {k:String} LIMIT 1`,
    query_params: { k: key },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { value: string }[];
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getClient().insert({
    table: "settings",
    values: [{ key, value, updated_at: new Date().toISOString() }],
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 0 },
  });
}

// ---------- passwords ----------

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;

/** `scrypt$<N>$<saltHex>$<hashHex>`. scrypt is in Node core, so there is no native dependency to build. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_N);
  return `scrypt$${SCRYPT_N}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const salt = Buffer.from(parts[2], "hex");
  const expected = Buffer.from(parts[3], "hex");
  if (!Number.isFinite(n) || salt.length === 0 || expected.length === 0) return false;
  const derived = await scrypt(password, salt, expected.length, n);
  return timingSafeEqual(derived, expected);
}

// ---------- session tokens ----------

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

interface TokenPayload {
  sub: string;
  v: number;
  iat: number;
  exp: number;
}

export async function signSessionToken(account: Pick<Account, "id" | "token_version">): Promise<string> {
  const secret = await getSigningSecret();
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = { sub: account.id, v: account.token_version, iat: now, exp: now + SESSION_TTL_SECONDS };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** Verifies signature and expiry only — the caller still loads the account to check token_version. */
export function readSessionToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if (!payload.sub || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Full check: valid signature, unexpired, account still exists, token not revoked. */
export async function accountFromSessionToken(token: string): Promise<Account | null> {
  const secret = await getSigningSecret();
  const payload = readSessionToken(token, secret);
  if (!payload) return null;
  const account = await getAccountById(payload.sub);
  if (!account) return null;
  if (Number(payload.v) !== Number(account.token_version)) return null;
  return account;
}

export const SESSION_MAX_AGE = SESSION_TTL_SECONDS;

// ---------- accounts ----------

export async function countAccounts(): Promise<number> {
  const res = await getClient().query({
    query: `SELECT count() AS n FROM accounts FINAL WHERE deleted = 0`,
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { n: number | string }[];
  return Number(rows[0]?.n ?? 0);
}

/** True when nobody has claimed this instance yet. */
export async function needsSetup(): Promise<boolean> {
  return (await countAccounts()) === 0;
}

export async function getAccountById(id: string): Promise<Account | null> {
  const res = await getClient().query({
    query: `SELECT ${ACCOUNT_COLUMNS} FROM accounts FINAL WHERE id = {id:String} AND deleted = 0 LIMIT 1`,
    query_params: { id },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as AccountRow[];
  return rows[0] ? toAccount(rows[0]) : null;
}

async function getAccountRowByEmail(email: string): Promise<AccountRow | null> {
  const res = await getClient().query({
    // ClickHouse has no unique constraint, so a signup race can leave two rows.
    // Oldest wins, deterministically, rather than whichever merge part is read.
    query: `SELECT ${ACCOUNT_COLUMNS} FROM accounts FINAL WHERE lower(email) = {e:String} AND deleted = 0 ORDER BY created_at LIMIT 1`,
    query_params: { e: email.trim().toLowerCase() },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as AccountRow[];
  return rows[0] ?? null;
}

export async function getAccountByEmail(email: string): Promise<Account | null> {
  const row = await getAccountRowByEmail(email);
  return row ? toAccount(row) : null;
}

export async function listAccounts(): Promise<Account[]> {
  const res = await getClient().query({
    query: `SELECT ${ACCOUNT_COLUMNS} FROM accounts FINAL WHERE deleted = 0 ORDER BY created_at`,
    format: "JSONEachRow",
  });
  return ((await res.json()) as AccountRow[]).map(toAccount);
}

export interface CreateAccountInput {
  email: string;
  password?: string;
  name?: string;
  role?: string;
  authProvider?: string;
  providerUserId?: string;
}

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("A valid email is required");
  const provider = input.authProvider ?? "local";
  if (provider === "local" && (input.password?.length ?? 0) < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (await getAccountRowByEmail(email)) throw new Error("An account with that email already exists");

  const now = new Date().toISOString();
  const row: AccountRow & { password_hash: string } = {
    id: randomUUID(),
    email,
    name: input.name?.trim() || email.split("@")[0],
    password_hash: input.password ? await hashPassword(input.password) : "",
    role: input.role ?? "admin",
    auth_provider: provider,
    provider_user_id: input.providerUserId ?? "",
    token_version: 1,
    last_login_at: new Date(0).toISOString(),
    deleted: 0,
    created_at: now,
    updated_at: now,
  };
  await getClient().insert({ table: "accounts", values: [row], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
  return toAccount(row);
}

/** Returns the account on success, null on bad email or password. Same shape either way — callers must not leak which. */
export async function authenticate(email: string, password: string): Promise<Account | null> {
  const row = await getAccountRowByEmail(email);
  if (!row || !row.password_hash) return null;
  if (!(await verifyPassword(password, row.password_hash))) return null;
  const account = toAccount(row);
  await writeAccountRow({ ...row, last_login_at: new Date().toISOString() });
  return account;
}

async function writeAccountRow(row: AccountRow & { password_hash: string }): Promise<void> {
  await getClient().insert({
    table: "accounts",
    values: [{ ...row, updated_at: new Date().toISOString() }],
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 0 },
  });
}

export async function setPassword(accountId: string, password: string): Promise<void> {
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  const res = await getClient().query({
    query: `SELECT ${ACCOUNT_COLUMNS} FROM accounts FINAL WHERE id = {id:String} AND deleted = 0 LIMIT 1`,
    query_params: { id: accountId },
    format: "JSONEachRow",
  });
  const row = ((await res.json()) as AccountRow[])[0];
  if (!row) throw new Error("Account not found");
  // Bumping the version ends every existing session — a password change should.
  await writeAccountRow({ ...row, password_hash: await hashPassword(password), token_version: Number(row.token_version) + 1 });
}

// ---------- read keys ----------

export interface ApiKey {
  id: string;
  account_id: string;
  name: string;
  prefix: string;
  last_used_at: string;
  created_at: string;
}

const API_KEY_PREFIX = "fr_";

function hashApiKey(key: string, secret: string): string {
  return createHmac("sha256", secret).update(key).digest("hex");
}

/** The plaintext key is returned once and never stored. */
export async function createApiKey(accountId: string, name: string): Promise<{ key: ApiKey; plaintext: string }> {
  const secret = await getSigningSecret();
  const plaintext = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    account_id: accountId,
    name: name.trim() || "Untitled key",
    key_hash: hashApiKey(plaintext, secret),
    prefix: plaintext.slice(0, API_KEY_PREFIX.length + 6),
    last_used_at: new Date(0).toISOString(),
    deleted: 0,
    created_at: now,
    updated_at: now,
  };
  await getClient().insert({ table: "api_keys", values: [row], format: "JSONEachRow", clickhouse_settings: { async_insert: 0 } });
  const { key_hash: _h, deleted: _d, updated_at: _u, ...key } = row;
  return { key, plaintext };
}

export async function listApiKeys(accountId: string): Promise<ApiKey[]> {
  const res = await getClient().query({
    query: `SELECT id, account_id, name, prefix, last_used_at, created_at FROM api_keys FINAL WHERE account_id = {u:String} AND deleted = 0 ORDER BY created_at DESC`,
    query_params: { u: accountId },
    format: "JSONEachRow",
  });
  return (await res.json()) as ApiKey[];
}

export async function revokeApiKey(accountId: string, id: string): Promise<boolean> {
  const res = await getClient().query({
    query: `SELECT id, account_id, name, key_hash, prefix, last_used_at, created_at FROM api_keys FINAL WHERE id = {id:String} AND account_id = {u:String} AND deleted = 0 LIMIT 1`,
    query_params: { id, u: accountId },
    format: "JSONEachRow",
  });
  const row = ((await res.json()) as Record<string, unknown>[])[0];
  if (!row) return false;
  await getClient().insert({
    table: "api_keys",
    values: [{ ...row, deleted: 1, updated_at: new Date().toISOString() }],
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 0 },
  });
  return true;
}

export async function accountFromApiKey(plaintext: string): Promise<Account | null> {
  if (!plaintext.startsWith(API_KEY_PREFIX)) return null;
  const secret = await getSigningSecret();
  const res = await getClient().query({
    query: `SELECT account_id FROM api_keys FINAL WHERE key_hash = {h:String} AND deleted = 0 LIMIT 1`,
    query_params: { h: hashApiKey(plaintext, secret) },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as { account_id: string }[];
  if (!rows[0]) return null;
  return getAccountById(rows[0].account_id);
}

// ---------- access control ----------

/**
 * The single choke point for "may this user see this project".
 *
 * Today every signed-in user sees every project: one install is one team, which
 * is what self-hosting means. When tenancy arrives, this function grows an
 * organisation-membership lookup and nothing else has to change — which is the
 * entire reason it exists as a function rather than an inline `if`.
 */
export async function canAccessProject(account: Account | null, _projectId: string): Promise<boolean> {
  return account !== null;
}
