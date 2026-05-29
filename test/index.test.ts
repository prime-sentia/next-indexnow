import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  generateKey,
  isValidIndexNowKey,
  notifyUrl,
  notifyBatch,
  notifySitemap,
  IndexNowError,
} from '../src/index';

function mockFetch() {
  const fn = vi.fn();
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A 2xx Response. */
function ok(status = 200) {
  return new Response('', { status });
}

function xmlResponse(xml: string) {
  return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
}

const KEY = 'a1b2c3d4e5f6';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isValidIndexNowKey', () => {
  it('accepts 8–128 char alphanumeric/dash keys', () => {
    expect(isValidIndexNowKey('a1b2c3d4')).toBe(true);
    expect(isValidIndexNowKey('ABCdef-123-456')).toBe(true);
    expect(isValidIndexNowKey('a'.repeat(128))).toBe(true);
  });

  it('rejects malformed keys', () => {
    expect(isValidIndexNowKey('')).toBe(false);
    expect(isValidIndexNowKey('short')).toBe(false);
    expect(isValidIndexNowKey('has space')).toBe(false);
    expect(isValidIndexNowKey('a'.repeat(129))).toBe(false);
    // @ts-expect-error runtime guard for non-string input
    expect(isValidIndexNowKey(undefined)).toBe(false);
  });
});

describe('generateKey', () => {
  it('returns a valid 32-char hex key', () => {
    const key = generateKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidIndexNowKey(key)).toBe(true);
  });

  it('returns unique keys', () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});

describe('notifyUrl', () => {
  it('throws on an invalid key before any request', async () => {
    const fetchFn = mockFetch();
    await expect(notifyUrl('https://x.com/a', { key: '' })).rejects.toThrow(/Invalid IndexNow key/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('url-encodes the key and includes keyLocation', async () => {
    const fetchFn = mockFetch().mockResolvedValue(ok());
    await notifyUrl('https://x.com/a b', { key: KEY, keyLocation: 'https://x.com/my key.txt' });
    const calledUrl = fetchFn.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`key=${KEY}`);
    expect(calledUrl).toContain('url=https%3A%2F%2Fx.com%2Fa%20b');
    expect(calledUrl).toContain('keyLocation=https%3A%2F%2Fx.com%2Fmy%20key.txt');
  });

  it('treats 202 as success and returns a structured result', async () => {
    mockFetch().mockResolvedValue(ok(202));
    const res = await notifyUrl('https://x.com/a', { key: KEY });
    expect(res.ok).toBe(true);
    expect(res.submitted).toBe(1);
    expect(res.responses[0].status).toBe(202);
  });

  it('retries on 429 then succeeds', async () => {
    const fetchFn = mockFetch()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(ok(200));
    const res = await notifyUrl('https://x.com/a', { key: KEY, retryDelayMs: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    expect(res.responses[0].attempts).toBe(2);
  });

  it('throws a typed IndexNowError on 403 (non-retryable)', async () => {
    const fetchFn = mockFetch().mockResolvedValue(new Response('nope', { status: 403 }));
    await expect(notifyUrl('https://x.com/a', { key: KEY })).rejects.toBeInstanceOf(IndexNowError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('exposes status/retryable/body on the thrown error', async () => {
    mockFetch().mockResolvedValue(new Response('nope', { status: 403 }));
    const err = await notifyUrl('https://x.com/a', { key: KEY }).catch((e) => e as IndexNowError);
    expect(err).toBeInstanceOf(IndexNowError);
    expect(err.status).toBe(403);
    expect(err.retryable).toBe(false);
    expect(err.responseBody).toBe('nope');
  });

  it('stops retrying after maxRetries on 5xx and reports the error', async () => {
    const fetchFn = mockFetch().mockResolvedValue(new Response('upstream boom', { status: 500 }));
    const err = await notifyUrl('https://x.com/a', {
      key: KEY,
      maxRetries: 1,
      retryDelayMs: 0,
    }).catch((e) => e as IndexNowError);
    expect(err).toBeInstanceOf(IndexNowError);
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(true);
    expect(err.responseBody).toBe('upstream boom');
    expect(fetchFn).toHaveBeenCalledTimes(2); // initial attempt + 1 retry
  });

  it('throws status-429 IndexNowError after exhausting retries', async () => {
    const fetchFn = mockFetch().mockResolvedValue(
      new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
    );
    const err = await notifyUrl('https://x.com/a', {
      key: KEY,
      maxRetries: 2,
      retryDelayMs: 0,
    }).catch((e) => e as IndexNowError);
    expect(err).toBeInstanceOf(IndexNowError);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('honors a Retry-After HTTP-date header (past date clamps to 0)', async () => {
    const fetchFn = mockFetch()
      .mockResolvedValueOnce(
        new Response('', { status: 503, headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' } })
      )
      .mockResolvedValueOnce(ok(200));
    const res = await notifyUrl('https://x.com/a', { key: KEY });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(res.responses[0].attempts).toBe(2);
  });

  it('uses exponential backoff between retries (1000ms then 2000ms)', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = mockFetch()
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(ok(200));
      const promise = notifyUrl('https://x.com/a', { key: KEY, retryDelayMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      await expect(promise).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast instead of blocking when Retry-After exceeds the cap', async () => {
    const fetchFn = mockFetch().mockResolvedValue(
      new Response('', { status: 503, headers: { 'retry-after': '99999' } })
    );
    const err = await notifyUrl('https://x.com/a', { key: KEY }).catch((e) => e as IndexNowError);
    expect(err).toBeInstanceOf(IndexNowError);
    expect(err.status).toBe(503);
    expect(fetchFn).toHaveBeenCalledTimes(1); // did not sleep/retry
  });
});

describe('notifyBatch', () => {
  it('requires host', async () => {
    mockFetch();
    await expect(notifyBatch(['https://x.com/a'], { key: KEY })).rejects.toThrow(/host/);
  });

  it('returns early for an empty list without fetching', async () => {
    const fetchFn = mockFetch();
    const res = await notifyBatch([], { key: KEY, host: 'x.com' });
    expect(res.submitted).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('de-duplicates URLs', async () => {
    const fetchFn = mockFetch().mockResolvedValue(ok());
    const res = await notifyBatch(
      ['https://x.com/a', 'https://x.com/a', 'https://x.com/b'],
      { key: KEY, host: 'x.com' }
    );
    expect(res.submitted).toBe(2);
    expect(res.skipped).toBe(1);
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.urlList).toEqual(['https://x.com/a', 'https://x.com/b']);
  });

  it('throws on a host mismatch by default', async () => {
    mockFetch().mockResolvedValue(ok());
    await expect(
      notifyBatch(['https://x.com/a', 'https://other.com/b'], { key: KEY, host: 'x.com' })
    ).rejects.toThrow(/do not belong to host/);
  });

  it('skips off-host URLs with onHostMismatch: "skip"', async () => {
    const fetchFn = mockFetch().mockResolvedValue(ok());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await notifyBatch(['https://x.com/a', 'https://other.com/b'], {
      key: KEY,
      host: 'x.com',
      onHostMismatch: 'skip',
    });
    expect(res.submitted).toBe(1);
    expect(res.skipped).toBe(1);
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.urlList).toEqual(['https://x.com/a']);
    warn.mockRestore();
  });

  it('auto-chunks more than 10,000 URLs into multiple requests', async () => {
    const fetchFn = mockFetch().mockResolvedValue(ok());
    const urls = Array.from({ length: 10001 }, (_, i) => `https://x.com/p/${i}`);
    const res = await notifyBatch(urls, { key: KEY, host: 'x.com' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(res.submitted).toBe(10001);
    expect(res.responses).toHaveLength(2);
  });

  it('throws on an unparseable URL by default', async () => {
    mockFetch().mockResolvedValue(ok());
    await expect(
      notifyBatch(['https://x.com/a', 'not a url'], { key: KEY, host: 'x.com' })
    ).rejects.toThrow(/invalid or do not belong to host/);
  });

  it('skips an unparseable URL under onHostMismatch: "skip"', async () => {
    const fetchFn = mockFetch().mockResolvedValue(ok());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await notifyBatch(['https://x.com/a', 'not a url'], {
      key: KEY,
      host: 'x.com',
      onHostMismatch: 'skip',
    });
    expect(res.submitted).toBe(1);
    expect(res.skipped).toBe(1);
    warn.mockRestore();
  });

  it('includes keyLocation in the POST body when provided', async () => {
    const fetchFn = mockFetch().mockResolvedValue(ok());
    await notifyBatch(['https://x.com/a'], {
      key: KEY,
      host: 'x.com',
      keyLocation: 'https://x.com/my-key.txt',
    });
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.keyLocation).toBe('https://x.com/my-key.txt');
  });
});

describe('notifySitemap', () => {
  it('parses a urlset, decoding entities and CDATA and handling multi-line locs', async () => {
    const sitemap = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://x.com/a?b=1&amp;c=2</loc></url>
        <url><loc><![CDATA[https://x.com/b]]></loc></url>
        <url><loc>
          https://x.com/c
        </loc></url>
      </urlset>`;
    const fetchFn = mockFetch().mockResolvedValueOnce(xmlResponse(sitemap)).mockResolvedValue(ok());
    const res = await notifySitemap('https://x.com/sitemap.xml', { key: KEY, host: 'x.com' });
    expect(res.submitted).toBe(3);
    const body = JSON.parse((fetchFn.mock.calls[1][1] as RequestInit).body as string);
    expect(body.urlList).toEqual(['https://x.com/a?b=1&c=2', 'https://x.com/b', 'https://x.com/c']);
  });

  it('recurses into a sitemap index', async () => {
    const index = `<sitemapindex>
      <sitemap><loc>https://x.com/sitemap-1.xml</loc></sitemap>
      <sitemap><loc>https://x.com/sitemap-2.xml</loc></sitemap>
    </sitemapindex>`;
    const child1 = `<urlset><url><loc>https://x.com/a</loc></url></urlset>`;
    const child2 = `<urlset><url><loc>https://x.com/b</loc></url></urlset>`;
    const fetchFn = mockFetch()
      .mockResolvedValueOnce(xmlResponse(index))
      .mockResolvedValueOnce(xmlResponse(child1))
      .mockResolvedValueOnce(xmlResponse(child2))
      .mockResolvedValue(ok());
    const res = await notifySitemap('https://x.com/sitemap_index.xml', { key: KEY, host: 'x.com' });
    expect(res.submitted).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(4); // 3 sitemap fetches + 1 submit
  });

  it('transparently decompresses gzipped sitemaps', async () => {
    const sitemap = `<urlset><url><loc>https://x.com/gz</loc></url></urlset>`;
    const gz = gzipSync(Buffer.from(sitemap));
    const fetchFn = mockFetch()
      .mockResolvedValueOnce(new Response(gz, { status: 200 }))
      .mockResolvedValue(ok());
    const res = await notifySitemap('https://x.com/sitemap.xml.gz', { key: KEY, host: 'x.com' });
    expect(res.submitted).toBe(1);
    const body = JSON.parse((fetchFn.mock.calls[1][1] as RequestInit).body as string);
    expect(body.urlList).toEqual(['https://x.com/gz']);
  });

  it('returns ok with zero submitted for an empty sitemap', async () => {
    mockFetch().mockResolvedValueOnce(xmlResponse('<urlset></urlset>'));
    const res = await notifySitemap('https://x.com/sitemap.xml', { key: KEY, host: 'x.com' });
    expect(res.ok).toBe(true);
    expect(res.submitted).toBe(0);
  });

  it('skips a failing child sitemap and still submits the others', async () => {
    const index = `<sitemapindex>
      <sitemap><loc>https://x.com/s1.xml</loc></sitemap>
      <sitemap><loc>https://x.com/s2.xml</loc></sitemap>
    </sitemapindex>`;
    const child2 = `<urlset><url><loc>https://x.com/b</loc></url></urlset>`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = mockFetch()
      .mockResolvedValueOnce(xmlResponse(index))
      .mockResolvedValueOnce(new Response('not found', { status: 404 })) // s1 fails
      .mockResolvedValueOnce(xmlResponse(child2))
      .mockResolvedValue(ok());
    const res = await notifySitemap('https://x.com/index.xml', { key: KEY, host: 'x.com' });
    expect(res.submitted).toBe(1);
    const body = JSON.parse((fetchFn.mock.calls[3][1] as RequestInit).body as string);
    expect(body.urlList).toEqual(['https://x.com/b']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('bounds recursion on a self-referential sitemap index (no infinite loop)', async () => {
    const selfRef = `<sitemapindex><sitemap><loc>https://x.com/loop.xml</loc></sitemap></sitemapindex>`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = mockFetch().mockResolvedValue(xmlResponse(selfRef));
    const res = await notifySitemap('https://x.com/loop.xml', { key: KEY, host: 'x.com' });
    expect(res.submitted).toBe(0);
    expect(res.ok).toBe(true);
    // Depth guard permits depths 0..5 (6 fetches) then stops — never unbounded.
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(7);
    warn.mockRestore();
  });
});

describe('generateKey runtime guard', () => {
  it('throws a clear error when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => generateKey()).toThrow(/Web Crypto/);
  });
});
