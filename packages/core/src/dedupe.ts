import { getDataClient } from "./client";
import type { Environment } from "./environments";
import { DEDUPE_WINDOW_DAYS } from "./schema";

/**
 * Store each message id at most once.
 *
 * A retry is often a copy of something already stored. The browser SDK re-queues a batch
 * whose request failed, and requests fail after arriving: the connection drops before the
 * answer, or the page unloads with the request in flight. The copy then rides in the next
 * batch, usually the page-leave beacon, under a new sentAt. Browsers and proxies also
 * replay a request outright, same body and all. Both happen in production, and every copy
 * shares the original's messageId, which is what analytics.js clients send it for.
 *
 * Two layers, because neither is enough alone:
 *
 * - `message_ids`, a point lookup by (project, id) against every id stored in the last
 *   DEDUPE_WINDOW_DAYS. This catches a copy from any process, however late it arrives, once
 *   the first copy is readable.
 * - Claims in this process, for a copy that arrives while the first is still being written.
 *   That is the usual shape of a resend: the page-leave beacon lands a second or so after
 *   the request it repeats. It waits for the first copy and gives way if that stored, or goes
 *   ahead if that failed. It never drops a message just because another copy was attempted.
 *
 * What gets through is a copy racing the first one on a different instance before the
 * first is readable. That is one extra row, the same as before any of this existed.
 */

interface Claim {
  at: number;
  /** Resolves true once the message is stored, false if storing it failed. */
  stored: Promise<boolean>;
}

/**
 * Long enough to cover the gap between an insert returning and every replica reading it,
 * after which `message_ids` answers instead. The limit only bounds memory. A claim dropped
 * early loses nothing, since the lookup still stands behind it.
 */
const CLAIM_RETAIN_MS = 60_000;
const CLAIM_LIMIT = 50_000;
const claims = new Map<string, Claim>();

function hold(key: string, claim: Claim) {
  // Re-inserted, not overwritten, so the map stays ordered by age for forget().
  claims.delete(key);
  claims.set(key, claim);
}

function forget(now: number) {
  for (const [key, claim] of claims) {
    if (now - claim.at < CLAIM_RETAIN_MS && claims.size <= CLAIM_LIMIT) return;
    claims.delete(key);
  }
}

/**
 * Drop every claim this process holds, as a fresh instance would start. For tests that need
 * to show `message_ids` catching a copy on its own; nothing in the request path calls it.
 */
export function forgetClaims(): void {
  claims.clear();
}

export interface Deduped<T> {
  /** The messages to store, in their original order: first sightings, and those without an id. */
  fresh: T[];
  /** How many were copies of a message already stored, being stored, or earlier in the batch. */
  duplicates: number;
  /** Say whether storing `fresh` worked, so a copy waiting on it knows whether to give way. */
  settle(stored: boolean): void;
}

/**
 * Split a batch into what to store and what is a copy. The caller must `settle()` the
 * result once the insert has finished, whichever way it went.
 */
export async function dedupe<T extends { messageId?: string }>(
  environment: Environment,
  projectId: string,
  messages: T[],
): Promise<Deduped<T>> {
  const now = Date.now();
  forget(now);
  const keyOf = (id: string) => `${environment}\u0000${projectId}\u0000${id}`;

  let resolve!: (stored: boolean) => void;
  const mine: Claim = { at: now, stored: new Promise<boolean>((r) => (resolve = r)) };
  const held: string[] = [];
  const take = (id: string) => {
    hold(keyOf(id), mine);
    held.push(id);
  };

  const duplicate = new Set<number>();
  const firstIndex = new Map<string, number>();
  const waits: Promise<void>[] = [];

  // Synchronous from here to the first await, so two batches in this process can never both
  // find an id unclaimed. Whichever runs first holds it; the other waits for the outcome.
  messages.forEach((m, i) => {
    const id = m.messageId;
    if (!id) return; // normalize() gives these a fresh uuid, so they cannot be copies.
    if (firstIndex.has(id)) {
      duplicate.add(i);
      return;
    }
    firstIndex.set(id, i);
    const other = claims.get(keyOf(id));
    if (!other) return take(id);
    // One wait, never a second: a request only ever waits on claims made before its own,
    // so no two requests can end up waiting on each other.
    waits.push(
      other.stored.then((stored) => {
        if (stored) duplicate.add(i);
        else take(id);
      }),
    );
  });

  const release = (stored: boolean) => {
    resolve(stored);
    if (stored) return;
    // A failed attempt holds nothing, so a retry goes straight ahead instead of waiting on it.
    for (const id of held) if (claims.get(keyOf(id)) === mine) claims.delete(keyOf(id));
  };

  try {
    await Promise.all(waits);
    if (held.length > 0) {
      const res = await getDataClient(environment).query({
        query: `SELECT DISTINCT message_id FROM message_ids
          WHERE project_id = {p:String}
            AND message_id IN ({ids:Array(String)})
            AND received_at >= now() - INTERVAL ${DEDUPE_WINDOW_DAYS} DAY`,
        query_params: { p: projectId, ids: held },
        format: "JSONEachRow",
      });
      const stored: Claim = { at: now, stored: Promise.resolve(true) };
      for (const { message_id } of (await res.json()) as { message_id: string }[]) {
        const i = firstIndex.get(message_id);
        if (i === undefined) continue;
        duplicate.add(i);
        // Already stored, whatever happens to the rest of this batch.
        hold(keyOf(message_id), stored);
      }
    }
  } catch (err) {
    release(false);
    throw err;
  }

  return {
    fresh: messages.filter((_, i) => !duplicate.has(i)),
    duplicates: duplicate.size,
    settle: release,
  };
}
