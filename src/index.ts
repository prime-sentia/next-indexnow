import crypto from 'crypto';

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
 * Notifies IndexNow about a single URL update or deletion.
 * @param url The exact URL that was updated or deleted.
 * @param options Configuration options including the API key.
 * @returns A promise that resolves when the request is successful.
 */
export async function notifyUrl(url: string, options: IndexNowOptions): Promise<void> {
  const { key, endpoint = DEFAULT_ENDPOINT } = options;
  const apiUrl = `https://${endpoint}/indexnow?url=${encodeURIComponent(url)}&key=${key}`;

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
 * Generates a compliant 32-character hexadecimal key for IndexNow.
 * @returns A secure 32-character hexadecimal string.
 */
export function generateKey(): string {
  return crypto.randomBytes(16).toString('hex');
}
