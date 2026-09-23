/**
 * Naming the values of a split goal.
 *
 * A split turns one event into a goal per value of a property. The property is whatever
 * the site sends — a form id, a plan, a product, a button label — so nothing here knows
 * any property by name. Every rule is about the shape of the data instead: whether a
 * value reads as words or as an identifier, which other property lines up with it
 * one-to-one, and what the title of the page it happens on says once the site's own
 * name is taken off.
 *
 * The ladder, first answer wins:
 *
 *  1. the operator's own name for it;
 *  2. the value itself, when it already reads as a name (`pro`, `Book a call`);
 *  3. the value of the split's label property for it (`form_name` beside `form_id`);
 *  4. the title of the page it is most often completed on, without the site's name;
 *  5. the value, shortened.
 *
 * Pure and dependency-free, so the browser can name an event row the same way the
 * server names a report row.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = /[-_.:/\s]+/;

/** A run of letters long enough to be a word: `form`, `Scan`, `iPhone`. */
function wordy(segment: string): boolean {
  return /^[A-Za-z][A-Za-z']{2,}$/.test(segment);
}

/**
 * Whether a value is an identifier rather than something a person would call it.
 *
 * Deliberately conservative in one direction: calling a name an id only costs a lookup
 * further down the ladder, which usually finds a name anyway, while calling an id a
 * name puts `c033b7f0` in a report as if someone had chosen it.
 */
export function looksLikeId(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (UUID.test(v)) return true;
  if (/^\d+$/.test(v)) return true;
  if (/^[0-9a-f]{8,}$/i.test(v) && /\d/.test(v)) return true;
  const segments = v.split(SEGMENT).filter(Boolean);
  const words = segments.filter(wordy);
  // No words at all: "v2" is a fine name, "a8f3k29x" is not.
  if (!words.length) return v.length > 6;
  // Words beside a long token with digits in it: `form_8shd83hs`, `prod_Nx9Kd82Jd`.
  return segments.some((s) => !wordy(s) && s.length > 4 && /\d/.test(s));
}

/**
 * `demo-request` → `Demo request`. Only slugs and snake_case, which are machine
 * spellings of words; anything with a capital or a space in it was already written for
 * a reader and is left alone, so `iPhone` and `Book a call` survive intact.
 */
export function humanize(value: string): string {
  const v = value.trim();
  if (/^[a-z0-9]+([-_][a-z0-9]+)*$/.test(v) && /[a-z]/.test(v)) {
    const spaced = v.replace(/[-_]+/g, " ");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }
  return v;
}

/** An identifier short enough to sit in a table cell and still be told apart from its neighbours. */
export function shortValue(value: string): string {
  const v = value.trim();
  if (UUID.test(v)) return `${v.slice(0, 8)}…`;
  return v.length > 18 ? `${v.slice(0, 14)}…` : v;
}

// ---------- page titles ----------

const SEPARATORS = [" | ", " – ", " — ", " - ", " · ", " • ", " :: ", " / "];

function splitTitle(title: string): string[] {
  for (const sep of SEPARATORS) {
    if (title.includes(sep)) return title.split(sep).map((s) => s.trim()).filter(Boolean);
  }
  return [title.trim()];
}

/**
 * The site's own name as its page titles carry it: "Get a demo | Acme" and "Pricing —
 * Acme" both end in Acme. Found rather than configured — it is whichever first or last
 * segment the most distinct titles share, provided enough of them share it that it is a
 * brand and not a coincidence.
 *
 * Counted over distinct titles, not page views, or the homepage alone would decide it.
 */
export function detectSiteName(titles: string[]): string | null {
  const distinct = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];
  if (distinct.length < 3) return null;
  const tally = new Map<string, number>();
  for (const t of distinct) {
    const parts = splitTitle(t);
    if (parts.length < 2) continue;
    const ends = new Set([parts[0].toLowerCase(), parts[parts.length - 1].toLowerCase()]);
    for (const e of ends) tally.set(e, (tally.get(e) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const entry of tally) if (!best || entry[1] > best[1]) best = entry;
  if (!best || best[1] < 3 || best[1] / distinct.length < 0.4) return null;
  return best[0];
}

/**
 * A page title with the site's name taken off either end: "Free FHIR Vulnerability
 * Scan | Acme" → "Free FHIR Vulnerability Scan". Null when nothing is left, which is
 * what a homepage titled with only the brand and a tagline tends to come to.
 */
export function titleWithoutSite(title: string, siteName: string | null): string | null {
  const parts = splitTitle(title);
  const kept = siteName ? parts.filter((p) => p.toLowerCase() !== siteName) : parts;
  // The page's own name is the first segment that is not the site's. Titles put it
  // first far more often than not, so "Contact Acme | Agentic security" is "Contact
  // Acme" and not the tagline after it.
  const name = kept[0]?.trim();
  return name ? name : null;
}

// ---------- the ladder ----------

export type SplitNameSource = "renamed" | "value" | "label" | "page" | "raw" | "unset";

export interface SplitNameInput {
  value: string;
  /** The split's property, used to name the "not set" row after what is missing. */
  key: string;
  renamed?: string | null;
  /** This value's label, from the split's label property, if it has one. */
  label?: string | null;
  labelKey?: string | null;
  /** The page title, already stripped of the site's name, and the path it came from. */
  page?: { path: string; title: string } | null;
}

export interface SplitName {
  name: string;
  source: SplitNameSource;
  /** What the name was read off, for the "named from …" hint. */
  evidence?: string;
}

export function nameSplitValue(i: SplitNameInput): SplitName {
  if (i.renamed?.trim()) return { name: i.renamed.trim(), source: "renamed" };
  if (i.value === "") return { name: `No ${i.key}`, source: "unset", evidence: `Completions that carried no ${i.key}` };
  if (!looksLikeId(i.value)) return { name: humanize(i.value), source: "value" };
  const label = i.label?.trim();
  if (label && !looksLikeId(label)) return { name: humanize(label), source: "label", evidence: `${i.labelKey ?? "label"}: ${label}` };
  if (i.page?.title) return { name: i.page.title, source: "page", evidence: `Title of ${i.page.path}` };
  return { name: shortValue(i.value), source: "raw" };
}

// ---------- which property names the values ----------

/**
 * Words a person would use for it. Paths and URLs are excluded even though they are
 * readable: a form on its own page makes the path line up one-to-one with the form, and
 * "/contact" would then beat the property that says "Contact inquiry". The page is used
 * further down the ladder anyway, through its title, which is the better name for it.
 */
function readsAsName(v: string): boolean {
  return !looksLikeId(v) && !/^(\/|https?:)/i.test(v) && v.length <= 80;
}

export interface LabelCandidate {
  key: string;
  /** For each split value that carries this property: how many distinct labels, and the latest one. */
  perValue: { value: string; labels: number; latest: string }[];
  /** Split values in the sample, with or without this property. */
  splitValues: number;
}

/**
 * The property that names a split's values, if one does.
 *
 * It has to behave like a name for them: one label per value (nine in ten, so one
 * rename across a dozen values is tolerated), different values getting different
 * labels, labels that read as words, and as many values covered as possible. On a site sending
 * `form_id` and `form_name` this is `form_name`; `form_variant` fails because two forms
 * share "default", and a page path fails because one form sits on two pages. No
 * property is special-cased — the same test finds `product_name` beside `sku`.
 */
export function pickLabelKey(candidates: LabelCandidate[]): string | null {
  let best: { key: string; score: number } | null = null;
  for (const c of candidates) {
    const covered = c.perValue.filter((p) => p.latest);
    if (covered.length < 2) continue;
    const single = covered.filter((p) => p.labels === 1).length / covered.length;
    const distinctLabels = new Set(covered.map((p) => p.latest.toLowerCase())).size;
    const injective = distinctLabels / covered.length;
    const readable = covered.filter((p) => readsAsName(p.latest)).length / covered.length;
    const coverage = covered.length / Math.max(c.splitValues, 1);
    // Strict on one-label-per-value. Loosening it lets placement properties through — a
    // form embedded in two sections has two section names, and would otherwise out-cover
    // the property that actually names it.
    if (single < 0.9 || injective < 0.9 || readable < 0.8) continue;
    // A key that calls itself a name wins a tie. Coverage decides everything else.
    const score = coverage + (/name|label|title/i.test(c.key) ? 0.1 : 0);
    if (!best || score > best.score) best = { key: c.key, score };
  }
  return best?.key ?? null;
}
