# next-indexnow

[![npm version](https://img.shields.io/npm/v/next-indexnow.svg)](https://www.npmjs.com/package/next-indexnow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A simple, lightweight, and modern package to integrate the [IndexNow](https://www.indexnow.org/) protocol into your Next.js applications. Notify search engines (like Bing, Yandex, Seznam, etc.) instantly when your content changes. Fast indexing is the foundational step for **[Generative Engine Optimization (GEO)](https://geo.primesentia.ai/)**.

**Developed and maintained by [Prime Sentia](https://primesentia.ai).**

## What is IndexNow?

[IndexNow](https://www.indexnow.org/) is an open protocol created by Microsoft and Yandex that allows websites to easily notify search engines whenever their website content is created, updated, or deleted. 

Without IndexNow, search engines can take days or weeks to discover that your content has changed because they rely on slow, scheduled web crawling. With IndexNow, you instantly "ping" search engines to let them know a URL has changed, prompting them to quickly index the fresh content.

### Supported Search Engines

IndexNow shares submitted URLs across all participating search engines simultaneously. Submitting to one endpoint automatically notifies all of the following engines:

- **Microsoft Bing** (and by extension, Bing Chat, Copilot, and Yahoo)
- **Yandex**
- **Seznam.cz**
- **Naver**
- **Yep**

*(Note: Google is not currently participating in the IndexNow protocol, but fast indexing on Bing/Copilot is crucial for modern AI-driven search visibility).*

## Why IndexNow is Critical for GEO

In the era of AI Search, **[Generative Engine Optimization (GEO)](https://geo.primesentia.ai/)** dictates that being discovered instantly by AI bots (like Bing Chat, Copilot, and ChatGPT search features) is more important than ever. 

Traditional crawling can take days or weeks, meaning AI models might generate answers using outdated information from your competitors. By using `next-indexnow`, you guarantee that your brand's fresh content is instantly pinged to search engines, ensuring you are always cited correctly in AI-generated answers.

Learn more about how to dominate AI search results and automate your SEO at **[Prime Sentia](https://primesentia.ai)**.

## Installation

```bash
npm install next-indexnow
# or
yarn add next-indexnow
# or
pnpm add next-indexnow
```

## Automatic Setup (Recommended)

IndexNow requires you to prove ownership of your site by serving a text file containing your API key at the root of your domain. We've completely automated this process.

Just run the following command at the root of your Next.js project:

```bash
npx next-indexnow init
```

**What this does:**
1. Generates a secure, 32-character API key.
2. Creates the verification file automatically in your `public/` folder (e.g. `public/a1b2c3d4...txt`). Next.js will naturally serve this at your root domain.
3. Injects `INDEXNOW_KEY=...` into your `.env.local` or `.env` file so you can access it in your code.

That's it! You are fully configured and ready to notify search engines.

*(If you prefer to configure everything manually, you can generate a key using `import { generateKey } from 'next-indexnow'`, save it to your `.env` manually, and serve the `.txt` file using Next.js Route Handlers.)*

## Usage

You can trigger IndexNow notifications whenever your content changes (e.g., in a webhook from your CMS, in a Server Action, or a custom API route).

### Single URL Notification

```typescript
import { notifyUrl } from 'next-indexnow';

async function publishArticle(slug) {
  // ... your database logic ...
  
  // Notify IndexNow
  const articleUrl = `https://yoursite.com/blog/${slug}`;
  
  await notifyUrl(articleUrl, {
    key: process.env.INDEXNOW_KEY
  });
  
  console.log('IndexNow notified!');
}
```

### Batch URLs Notification

If you update multiple pages at once, or want to send your entire sitemap, you can batch up to 10,000 URLs in a single request.

```typescript
import { notifyBatch } from 'next-indexnow';

async function syncAllPages() {
  const urls = [
    'https://yoursite.com/page-1',
    'https://yoursite.com/page-2',
    // ... up to 10,000 URLs
  ];
  
  await notifyBatch(urls, {
    key: process.env.INDEXNOW_KEY,
    host: 'yoursite.com', // Required for batch notifications
  });
}
```

### Automatic Sitemap Submission (Killer Feature 🚀)

Instead of manually keeping track of URLs, you can point `next-indexnow` directly to your XML sitemap. It will automatically fetch the sitemap, extract all URLs (with zero heavy XML dependencies), de-duplicate them, split them into chunks of 10,000 (IndexNow's limit), and submit everything at once.

It transparently handles **sitemap-index files** (recursing into child sitemaps), **gzip-compressed sitemaps** (`.xml.gz`), CDATA-wrapped entries and multi-line `<loc>` values — so it works with the output of `next-sitemap` and the App Router's `generateSitemaps()`.

```typescript
import { notifySitemap } from 'next-indexnow';

async function syncEntireWebsite() {
  const result = await notifySitemap('https://yoursite.com/sitemap.xml', {
    key: process.env.INDEXNOW_KEY,
    host: 'yoursite.com' // Required
  });

  console.log(`Submitted ${result.submitted} URLs (skipped ${result.skipped}).`);
}
```

### The result object

`notifyUrl`, `notifyBatch` and `notifySitemap` all resolve to a structured `IndexNowResult`:

```typescript
interface IndexNowResult {
  ok: boolean;        // every request returned 2xx
  submitted: number;  // URLs actually sent
  skipped: number;    // duplicates / off-host URLs
  responses: { ok: boolean; status: number; statusText: string; urls: string[]; attempts: number }[];
}
```

Note that IndexNow returns `202 Accepted` ("validation pending") for valid submissions — this is treated as success. On a non-retryable failure (e.g. `403` invalid key, `422` host mismatch) a typed `IndexNowError` is thrown, carrying `status`, `statusText`, `retryable` and the raw `responseBody`.

## Next.js helpers (`next-indexnow/next`)

### Fire-and-forget after the response: `notifyAfter`

Calling `await notifyUrl(...)` inside a Server Action blocks the response on a network round-trip. `notifyAfter` schedules the ping with Next.js's [`after()`](https://nextjs.org/docs/app/api-reference/functions/after) so it runs *after* the response is sent, and never surfaces indexing errors to the user.

```typescript
import { notifyAfter } from 'next-indexnow/next';

export async function publishPost(slug: string) {
  // ...persist your changes...
  await notifyAfter(`https://yoursite.com/blog/${slug}`, {
    key: process.env.INDEXNOW_KEY!,
  });
}
```

### Revalidate + notify in one call: `revalidateAndNotify`

On-demand revalidation is the canonical "this content changed, re-index it" signal. `revalidateAndNotify` revalidates the path (or tag) and then notifies IndexNow about the absolute URL.

```typescript
import { revalidateAndNotify } from 'next-indexnow/next';

await revalidateAndNotify('/blog/my-post', {
  baseUrl: 'https://yoursite.com',
  key: process.env.INDEXNOW_KEY!,
  // tag: 'posts', // optionally revalidate a cache tag instead of a path
});
```

## Options

All notify functions accept an options object:

- `key` (string, **required**): Your IndexNow API key. Validated locally before any request.
- `host` (string, required for batch/sitemap): Your website's host (e.g., `www.example.com`). `www` and non-`www` count as different hosts.
- `keyLocation` (string, optional): Full URL to your key file if it's not hosted at the exact root with the exact key name.
- `endpoint` (string, optional): The IndexNow endpoint to ping. Defaults to `api.indexnow.org`.
- `maxRetries` (number, optional): Retry attempts for transient failures (`429`/`5xx`). Defaults to `3`; honors the `Retry-After` header.
- `retryDelayMs` (number, optional): Base delay for exponential backoff between retries. Defaults to `1000`.
- `onHostMismatch` (`'throw' | 'skip'`, optional): What to do with URLs that don't belong to `host`. Defaults to `'throw'`; use `'skip'` to drop them and count them in `result.skipped`.

## Contributing

This is an open-source project by [Prime Sentia](https://primesentia.ai), and we welcome contributions from the community!

If you'd like to help improve `next-indexnow`:
1. Fork the repository.
2. Create a new branch (`git checkout -b feature/my-amazing-feature`).
3. Make your changes and commit them (`git commit -m 'feat: add my amazing feature'`).
4. Push to the branch (`git push origin feature/my-amazing-feature`).
5. Open a Pull Request.

If you find a bug or have a feature request, please [open an issue](https://github.com/prime-sentia/next-indexnow/issues).

## License
MIT

---

<div align="center">
  <h3>Powered by <a href="https://primesentia.ai">Prime Sentia AI</a></h3>
  <p>Leading the future of <a href="https://geo.primesentia.ai/">Generative Engine Optimization (GEO)</a> and AI-driven SEO automation.</p>
</div>
