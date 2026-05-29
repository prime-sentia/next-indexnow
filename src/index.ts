export interface IndexNowOptions {
  /** The API key provided to the search engine */
  key: string;
  /**
   * The host of your website (e.g., 'www.example.com')
   * Required for batch notifications.
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
}

const DEFAULT_ENDPOINT = 'api.indexnow.org';

/**
 * IndexNow keys must be 8–128 characters long and contain only
 * a–z, A–Z, 0–9 and dashes (per the protocol spec).
 */
const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

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

/**
 * Notifies IndexNow about a single URL update or deletion.
 * @param url The exact URL that was updated or deleted.
 * @param options Configuration options including the API key.
 * @returns A promise that resolves when the request is successful.
 */
export async function notifyUrl(url: string, options: IndexNowOptions): Promise<void> {
  const { key, keyLocation, endpoint = DEFAULT_ENDPOINT } = options;
  assertValidKey(key);

  let apiUrl =
    `https://${endpoint}/indexnow?url=${encodeURIComponent(url)}` +
    `&key=${encodeURIComponent(key)}`;
  if (keyLocation) {
    apiUrl += `&keyLocation=${encodeURIComponent(keyLocation)}`;
  }

  const response = await fetch(apiUrl, {
    method: 'GET',
  });

  if (!response.ok) {
    throw new Error(`IndexNow API error: ${response.status} ${response.statusText}`);
  }
}

/**
 * Notifies IndexNow about multiple URL updates or deletions in a single batch.
 * Max 10,000 URLs per batch.
 * @param urls Array of exact URLs that were updated or deleted.
 * @param options Configuration options including the API key and host.
 * @returns A promise that resolves when the request is successful.
 */
export async function notifyBatch(urls: string[], options: IndexNowOptions): Promise<void> {
  if (urls.length === 0) return;
  if (urls.length > 10000) {
    throw new Error('IndexNow supports a maximum of 10,000 URLs per request.');
  }

  const { key, host, keyLocation, endpoint = DEFAULT_ENDPOINT } = options;
  assertValidKey(key);

  if (!host) {
    throw new Error('The "host" option is required for batch notifications.');
  }

  const apiUrl = `https://${endpoint}/indexnow`;

  const body = {
    host,
    key,
    keyLocation,
    urlList: urls,
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch (e) {}
    throw new Error(`IndexNow API error: ${response.status} ${response.statusText} - ${errorText}`);
  }
}

/**
 * Fetches an XML sitemap, extracts all URLs, and submits them to IndexNow in batches of 10,000.
 * @param sitemapUrl The full URL to your sitemap.xml
 * @param options Configuration options including the API key and host.
 * @returns A promise that resolves when all URLs have been submitted.
 */
export async function notifySitemap(sitemapUrl: string, options: IndexNowOptions): Promise<void> {
  const { host } = options;
  if (!host) {
    throw new Error('The "host" option is required for sitemap notifications.');
  }

  const response = await fetch(sitemapUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch sitemap: ${response.status} ${response.statusText}`);
  }

  const xmlText = await response.text();
  
  // Fast, zero-dependency regex extraction for <loc> tags
  const urls: string[] = [];
  const locRegex = /<loc>(.*?)<\/loc>/g;
  let match;

  while ((match = locRegex.exec(xmlText)) !== null) {
    if (match[1]) {
      // Decode XML entities (e.g., &amp;) if any
      const url = match[1].replace(/&amp;/g, '&')
                          .replace(/&lt;/g, '<')
                          .replace(/&gt;/g, '>')
                          .replace(/&quot;/g, '"')
                          .replace(/&apos;/g, "'");
      urls.push(url.trim());
    }
  }

  if (urls.length === 0) {
    return;
  }

  // IndexNow allows a maximum of 10,000 URLs per batch request
  const CHUNK_SIZE = 10000;
  for (let i = 0; i < urls.length; i += CHUNK_SIZE) {
    const chunk = urls.slice(i, i + CHUNK_SIZE);
    await notifyBatch(chunk, options);
  }
}

/**
 * Generates a compliant 32-character hexadecimal key for IndexNow.
 * Uses the Web Crypto API (available in Node 18+, the Edge runtime and browsers),
 * so the module stays free of Node-only built-ins and bundles on every runtime.
 * @returns A secure 32-character hexadecimal string.
 */
export function generateKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
