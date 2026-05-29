export interface IndexNowOptions {
  /** The API key provided to the search engine */
  key: string;
  /**
   * The host of your website (e.g., 'www.example.com')
   * Required for batch and sitemap notifications.
   */
  host?: string;
  /**
   * The location of the key file on your server (e.g., 'https://www.example.com/my-key.txt')
   * Optional, but recommended if your key file is not at the root level or has a different name.
   */
  keyLocation?: string;
  /**
   * The search engine endpoint. Defaults to 'api.indexnow.org'
   */
  endpoint?: string;
  /**
   * Maximum number of retry attempts for transient failures (HTTP 429 and 5xx).
   * Defaults to 3. Set to 0 to disable retries.
   */
  maxRetries?: number;
  /**
   * Base delay (in ms) for exponential backoff between retries. Defaults to 1000.
   * The server's `Retry-After` header takes precedence when present.
   */
  retryDelayMs?: number;
  /**
   * How to handle URLs that don't belong to `host` (IndexNow rejects the whole
   * batch with 422 in that case) or that fail to parse:
   * - `'throw'` (default): throw before sending, naming the offending URLs.
   * - `'skip'`: drop them, warn, and report them in `result.skipped`.
   */
  onHostMismatch?: 'throw' | 'skip';
  /**
   * Per-request timeout in milliseconds, applied to every network call via an
   * `AbortController`. Defaults to 10000. Set to 0 to disable.
   */
  timeoutMs?: number;
  /**
   * Sitemap-only: when set, only submit URLs whose `<lastmod>` is at or after
   * this date. Child sitemaps (in an index) whose `<lastmod>` is older are
   * skipped without being fetched. URLs without a `<lastmod>` are always
   * included (we can't tell if they changed). Ideal for incremental cron runs.
   */
  since?: Date;
}

/** The outcome of a single HTTP request to the IndexNow endpoint. */
export interface IndexNowResponse {
  /** Always `true` on a resolved result (a 2xx — 200 OK or 202 Accepted); non-2xx throws {@link IndexNowError}. */
  ok: boolean;
  /** HTTP status code. */
  status: number;
  /** HTTP status text. */
  statusText: string;
  /** The URLs included in this request. */
  urls: string[];
  /** Number of attempts made (1 = succeeded on the first try). */
  attempts: number;
}

/** The aggregated result of a notify operation (which may span several requests). */
export interface IndexNowResult {
  /** Always `true` on a resolved result; any failed request throws {@link IndexNowError} instead. */
  ok: boolean;
  /** Number of URLs actually submitted. */
  submitted: number;
  /** Number of URLs skipped (duplicates, or off-host when `onHostMismatch: 'skip'`). */
  skipped: number;
  /** One entry per HTTP request made (single URL, or one per 10k-URL chunk). */
  responses: IndexNowResponse[];
}

const DEFAULT_ENDPOINT = 'api.indexnow.org';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10000;
// Cap on how long we'll block on backoff/Retry-After before failing fast, so a
// server can't force a multi-hour sleep that blows a serverless/Edge budget.
const MAX_RETRY_DELAY_MS = 30000;
const MAX_URLS_PER_REQUEST = 10000;
const MAX_SITEMAP_DEPTH = 5;

/**
 * IndexNow keys must be 8–128 characters long and contain only
 * a–z, A–Z, 0–9 and dashes (per the protocol spec).
 */
const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

const STATUS_REASONS: Record<number, string> = {
  400: 'Bad request — invalid URL format or malformed request body.',
  403: 'Forbidden — key not valid (the key file could not be found at its location, or its contents do not match the submitted key).',
  422: 'Unprocessable entity — URLs do not belong to the declared host, or the key does not match the expected schema.',
  429: 'Too many requests — you are being rate limited. Slow down or submit fewer URLs.',
};

/**
 * Error thrown when the IndexNow endpoint returns a non-2xx status that is not
 * (or can no longer be) retried. Carries the status, a human-readable reason,
 * whether the failure was retryable, and the raw response body when available.
 */
export class IndexNowError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly retryable: boolean;
  readonly responseBody?: string;
  readonly urls?: string[];

  constructor(
    status: number,
    statusText: string,
    options: { responseBody?: string; urls?: string[] } = {}
  ) {
    const reason = STATUS_REASONS[status] ?? `Unexpected status ${status}.`;
    super(`IndexNow API error ${status} ${statusText}: ${reason}`);
    this.name = 'IndexNowError';
    this.status = status;
    this.statusText = statusText;
    this.retryable = isRetryableStatus(status);
    this.responseBody = options.responseBody;
    this.urls = options.urls;
  }
}

/**
 * Validates a key against the IndexNow format rules.
 * @param key The key to validate.
 * @returns `true` if the key is a valid IndexNow key.
 */
export function isValidIndexNowKey(key: string): boolean {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function assertValidKey(key: string): void {
  if (!isValidIndexNowKey(key)) {
    throw new Error(
      `Invalid IndexNow key: expected 8–128 characters (a–z, A–Z, 0–9, -), ` +
        `received ${key ? `"${key}"` : 'an empty or undefined value'}. ` +
        `Did you forget to set process.env.INDEXNOW_KEY?`
    );
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses a `Retry-After` header (delta-seconds or HTTP date) into milliseconds. */
function parseRetryAfter(header: string | null): number | null {
  const value = header?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** `fetch` with an `AbortController` timeout (no timeout when `timeoutMs` <= 0). */
async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(input, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Performs a single IndexNow HTTP request with retry + exponential backoff for
 * transient failures (429/5xx), honoring the `Retry-After` header. Treats any
 * 2xx (including 202 "validation pending") as success.
 */
async function sendRequest(
  apiUrl: string,
  init: RequestInit,
  urls: string[],
  options: IndexNowOptions
): Promise<IndexNowResponse> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let attempt = 0;
  for (;;) {
    attempt++;

    let response: Response;
    try {
      response = await fetchWithTimeout(apiUrl, init, timeoutMs);
    } catch (error) {
      // A timeout (AbortError) is NOT retried: each retry would wait another full
      // timeoutMs and could blow a serverless/Edge budget. Other network errors
      // fail fast, so retrying them (like a 5xx) is cheap.
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      if (!isTimeout && attempt <= maxRetries) {
        await sleep(Math.min(baseDelay * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS));
        continue;
      }
      const reason = isTimeout
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(
        `IndexNow request to ${apiUrl} failed after ${attempt} attempt(s): ${reason}`
      );
    }

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        urls,
        attempts: attempt,
      };
    }

    const canRetry = isRetryableStatus(response.status) && attempt <= maxRetries;
    if (canRetry) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const delay = retryAfter ?? baseDelay * 2 ** (attempt - 1);
      // If the server asks us to wait longer than we're willing to block, fail
      // fast instead of stalling the runtime.
      if (delay <= MAX_RETRY_DELAY_MS) {
        await sleep(delay);
        continue;
      }
    }

    let body: string | undefined;
    try {
      body = await response.text();
    } catch {
      body = undefined;
    }
    throw new IndexNowError(response.status, response.statusText, { responseBody: body, urls });
  }
}

/**
 * Notifies IndexNow about a single URL update or deletion.
 * @param url The exact URL that was updated or deleted.
 * @param options Configuration options including the API key.
 * @returns A structured result describing the submission.
 * @throws {IndexNowError} On a non-retryable / retry-exhausted API error.
 */
export async function notifyUrl(url: string, options: IndexNowOptions): Promise<IndexNowResult> {
  const { key, keyLocation, endpoint = DEFAULT_ENDPOINT } = options;
  assertValidKey(key);

  let apiUrl =
    `https://${endpoint}/indexnow?url=${encodeURIComponent(url)}` +
    `&key=${encodeURIComponent(key)}`;
  if (keyLocation) {
    apiUrl += `&keyLocation=${encodeURIComponent(keyLocation)}`;
  }

  const response = await sendRequest(apiUrl, { method: 'GET' }, [url], options);
  return { ok: response.ok, submitted: 1, skipped: 0, responses: [response] };
}

/**
 * Notifies IndexNow about multiple URL updates or deletions.
 * URLs are de-duplicated and validated against `host`; submissions larger than
 * 10,000 URLs are automatically split into sequential requests.
 * @param urls Array of exact URLs that were updated or deleted.
 * @param options Configuration options including the API key and host.
 * @returns A structured result describing the submission.
 * @throws {IndexNowError} On a non-retryable / retry-exhausted API error.
 */
export async function notifyBatch(
  urls: string[],
  options: IndexNowOptions
): Promise<IndexNowResult> {
  return submitUrlList(urls, options);
}

/** Shared submission pipeline: validate, normalize (dedupe + host check), chunk, send. */
async function submitUrlList(urls: string[], options: IndexNowOptions): Promise<IndexNowResult> {
  const { key, host, keyLocation, endpoint = DEFAULT_ENDPOINT } = options;
  assertValidKey(key);

  if (!host) {
    throw new Error('The "host" option is required for batch and sitemap notifications.');
  }

  const onHostMismatch = options.onHostMismatch ?? 'throw';
  const { urls: cleanUrls, skipped } = normalizeUrls(urls, host, onHostMismatch);

  if (cleanUrls.length === 0) {
    return { ok: true, submitted: 0, skipped, responses: [] };
  }

  const apiUrl = `https://${endpoint}/indexnow`;
  const responses: IndexNowResponse[] = [];

  for (let i = 0; i < cleanUrls.length; i += MAX_URLS_PER_REQUEST) {
    const chunk = cleanUrls.slice(i, i + MAX_URLS_PER_REQUEST);
    const body = JSON.stringify({ host, key, keyLocation, urlList: chunk });
    const response = await sendRequest(
      apiUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
      },
      chunk,
      options
    );
    responses.push(response);
  }

  return {
    ok: responses.every((r) => r.ok),
    submitted: cleanUrls.length,
    skipped,
    responses,
  };
}

interface NormalizeResult {
  urls: string[];
  skipped: number;
}

/**
 * De-duplicates URLs and validates that each belongs to `host`. IndexNow rejects
 * an entire batch (422) if any URL's host differs from the declared host, so we
 * catch that locally. `www.example.com` and `example.com` are different hosts.
 */
function normalizeUrls(
  urls: string[],
  host: string,
  onHostMismatch: 'throw' | 'skip'
): NormalizeResult {
  const normalizedHost = host.toLowerCase();
  const seen = new Set<string>();
  const valid: string[] = [];
  const offenders: string[] = [];
  let duplicates = 0;

  for (const raw of urls) {
    const url = (raw ?? '').trim();
    if (!url) continue;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      offenders.push(url);
      continue;
    }

    if (parsed.host.toLowerCase() !== normalizedHost) {
      offenders.push(url);
      continue;
    }

    if (seen.has(url)) {
      duplicates++;
      continue;
    }
    seen.add(url);
    valid.push(url);
  }

  if (offenders.length > 0) {
    if (onHostMismatch === 'throw') {
      const sample = offenders.slice(0, 5).join(', ');
      throw new Error(
        `IndexNow: ${offenders.length} URL(s) are invalid or do not belong to host "${host}" ` +
          `(IndexNow rejects the whole batch with 422 in that case). ` +
          `Offending URL(s): ${sample}${offenders.length > 5 ? ', …' : ''}. ` +
          `Pass onHostMismatch: 'skip' to drop them instead.`
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[next-indexnow] Skipped ${offenders.length} URL(s) that are invalid or not on host "${host}".`
    );
  }

  return { urls: valid, skipped: duplicates + (onHostMismatch === 'skip' ? offenders.length : 0) };
}

/**
 * Fetches an XML sitemap (or sitemap index), recursively extracts every page
 * URL, de-duplicates and host-validates them, and submits them to IndexNow in
 * batches of 10,000.
 *
 * Handles sitemap-index files (recursing into child sitemaps), gzip-compressed
 * sitemaps (`.xml.gz`), CDATA-wrapped `<loc>` values and multi-line entries.
 * Pass `options.since` to only submit URLs changed at or after a given date.
 * @param sitemapUrl The full URL to your sitemap.xml (or sitemap index).
 * @param options Configuration options including the API key and host.
 * @returns A structured result describing the submission.
 * @throws {IndexNowError} On a non-retryable / retry-exhausted API error.
 *   A failed *child* sitemap (within an index) is skipped with a warning, not thrown.
 */
export async function notifySitemap(
  sitemapUrl: string,
  options: IndexNowOptions
): Promise<IndexNowResult> {
  if (!options.host) {
    throw new Error('The "host" option is required for sitemap notifications.');
  }

  const urls = await collectSitemapUrls(sitemapUrl, 0, options);
  if (urls.length === 0) {
    return { ok: true, submitted: 0, skipped: 0, responses: [] };
  }

  return submitUrlList(urls, options);
}

/** True if an entry passes the `since` filter (kept if no date or not older than `since`). */
function isNewerThanSince(lastmod: Date | undefined, since: Date | undefined): boolean {
  if (!since || !lastmod) return true;
  return lastmod.getTime() >= since.getTime();
}

/** Recursively collects page URLs from a sitemap or sitemap-index document. */
async function collectSitemapUrls(
  sitemapUrl: string,
  depth: number,
  options: IndexNowOptions
): Promise<string[]> {
  if (depth > MAX_SITEMAP_DEPTH) {
    throw new Error(
      `IndexNow: sitemap nesting exceeded ${MAX_SITEMAP_DEPTH} levels at "${sitemapUrl}" ` +
        `(possible circular reference).`
    );
  }

  const xml = await fetchSitemapText(sitemapUrl, options);
  const entries = extractEntries(xml);
  const { since } = options;

  if (isSitemapIndex(xml)) {
    // Skip children whose <lastmod> predates `since` (no need to fetch them),
    // then isolate the rest: one unreachable/404 child must not abort the whole
    // submission. Collect from the children that succeed and warn on the rest.
    const children = entries.filter((e) => isNewerThanSince(e.lastmod, since));
    const settled = await Promise.allSettled(
      children.map((child) => collectSitemapUrls(child.loc, depth + 1, options))
    );
    const urls: string[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') {
        urls.push(...outcome.value);
      } else {
        const reason =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        // eslint-disable-next-line no-console
        console.warn(`[next-indexnow] Skipped child sitemap "${children[i].loc}": ${reason}`);
      }
    });
    return urls;
  }

  return entries.filter((e) => isNewerThanSince(e.lastmod, since)).map((e) => e.loc);
}

/** Fetches a sitemap, transparently decompressing gzip-encoded responses/files. */
async function fetchSitemapText(sitemapUrl: string, options: IndexNowOptions): Promise<string> {
  const response = await fetchWithTimeout(sitemapUrl, {}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch sitemap: ${response.status} ${response.statusText} (${sitemapUrl})`
    );
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // gzip magic number (0x1f 0x8b). Covers `.xml.gz` files that fetch does not
  // auto-decompress (they arrive as application/gzip, not Content-Encoding).
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (isGzip) {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }

  return new TextDecoder().decode(buffer);
}

/** True if the document is a `<sitemapindex>` (a list of child sitemaps). */
function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

interface SitemapEntry {
  loc: string;
  lastmod?: Date;
}

/**
 * Extracts `{ loc, lastmod }` entries from a urlset or sitemap-index document.
 * Parses each `<url>`/`<sitemap>` block so a `<loc>` is paired with its sibling
 * `<lastmod>`; falls back to a flat `<loc>` scan for malformed documents.
 */
function extractEntries(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  // \b after the tag name avoids matching <urlset>/<sitemapindex> wrappers.
  const blockRegex = /<(url|sitemap)\b[\s\S]*?<\/\1>/gi;
  let block: RegExpExecArray | null;

  while ((block = blockRegex.exec(xml)) !== null) {
    const loc = decodeFirstLoc(block[0]);
    if (loc) {
      entries.push({ loc, lastmod: parseLastmod(block[0]) });
    }
  }

  if (entries.length === 0) {
    // Blockless / malformed document — fall back to a flat <loc> scan.
    for (const loc of extractLocs(xml)) {
      entries.push({ loc });
    }
  }

  return entries;
}

/** Returns the first decoded `<loc>` value within a fragment, or undefined. */
function decodeFirstLoc(fragment: string): string | undefined {
  const match = /<loc>([\s\S]*?)<\/loc>/.exec(fragment);
  return match ? decodeLoc(match[1]) : undefined;
}

/**
 * Parses a `<lastmod>` value into a Date, or undefined if missing/invalid.
 *
 * To keep `since` filtering deterministic across deployments:
 * - a date-only value (`YYYY-MM-DD`) resolves to the **end** of that UTC day, so an
 *   "at or after `since`" filter keeps a page touched anywhere on its lastmod day;
 * - a datetime without a timezone designator is interpreted as **UTC** (not the
 *   host's local time).
 */
function parseLastmod(fragment: string): Date | undefined {
  const match = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(fragment);
  if (!match) return undefined;
  const raw = match[1].trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const day = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(day.getTime())) return undefined;
    return new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1);
  }

  const hasTimezone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  const date = new Date(hasTimezone ? raw : `${raw}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Extracts and decodes all `<loc>` values (flat scan, CDATA + multi-line aware). */
function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  // [\s\S] matches across newlines (equivalent to the dotAll flag).
  const locRegex = /<loc>([\s\S]*?)<\/loc>/g;
  let match: RegExpExecArray | null;

  while ((match = locRegex.exec(xml)) !== null) {
    const value = decodeLoc(match[1]);
    if (value) {
      locs.push(value);
    }
  }

  return locs;
}

/** Trims, unwraps CDATA (literal — no entity decode) and entity-decodes a `<loc>` value. */
function decodeLoc(raw: string): string {
  const value = raw.trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) {
    // CDATA content is literal — it must NOT be entity-decoded.
    return cdata[1].trim();
  }
  return decodeXmlEntities(value);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // decode &amp; last to avoid double-decoding
}

/**
 * Generates a compliant 32-character hexadecimal key for IndexNow.
 * Uses the Web Crypto API (available in Node 20+, the Edge runtime and browsers),
 * so the module stays free of Node-only built-ins and bundles on every runtime.
 * @returns A secure 32-character hexadecimal string.
 * @throws If the Web Crypto API is unavailable (e.g. Node 18 without the
 *   `--experimental-global-webcrypto` flag).
 */
export function generateKey(): string {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!webCrypto?.getRandomValues) {
    throw new Error(
      'next-indexnow: the Web Crypto API (globalThis.crypto) is not available in this runtime. ' +
        'Use Node 20+, the Edge runtime, or a browser ' +
        '(on Node 18 it requires the --experimental-global-webcrypto flag).'
    );
  }
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Options for {@link verifyKeyFile}. */
export interface VerifyKeyFileOptions {
  /** The key your app expects to be served. */
  key: string;
  /** The host serving the key file (e.g. 'www.example.com'). Used to derive the URL. */
  host?: string;
  /** Full URL to the key file. Overrides the host-derived `https://<host>/<key>.txt`. */
  keyLocation?: string;
  /** Per-request timeout in ms. Defaults to 10000. */
  timeoutMs?: number;
}

/** The result of a {@link verifyKeyFile} check. */
export interface VerifyKeyFileResult {
  /** Whether the key file is reachable and its contents match the key. */
  ok: boolean;
  /** The URL that was checked. */
  url: string;
  /** HTTP status of the check, if a response was received. */
  status?: number;
  /** A human-readable explanation when `ok` is false. */
  reason?: string;
}

/**
 * Confirms that your IndexNow key file is live and correct before submitting —
 * the #1 cause of 403/422 rejections is a missing or mismatched key file. GETs
 * the resolved key URL and asserts it returns 200 with the exact key as its body.
 *
 * Returns a diagnostic result (it does not throw on a failed check).
 * @param options The key plus either `host` or an explicit `keyLocation`.
 */
export async function verifyKeyFile(options: VerifyKeyFileOptions): Promise<VerifyKeyFileResult> {
  const { key, host, keyLocation } = options;
  const url = keyLocation ?? (host ? `https://${host}/${key}.txt` : undefined);
  if (!url) {
    throw new Error('verifyKeyFile requires either "keyLocation" or "host".');
  }

  try {
    const response = await fetchWithTimeout(
      url,
      { method: 'GET' },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    if (!response.ok) {
      return {
        ok: false,
        url,
        status: response.status,
        reason: `Key file not reachable (HTTP ${response.status}).`,
      };
    }
    const body = (await response.text()).trim();
    if (body !== key) {
      return {
        ok: false,
        url,
        status: response.status,
        reason: 'Key file contents do not match the expected key.',
      };
    }
    return { ok: true, url, status: response.status };
  } catch (error) {
    return { ok: false, url, reason: error instanceof Error ? error.message : String(error) };
  }
}
