# Example: Next.js App Router + next-indexnow

A minimal, illustrative wiring of [`next-indexnow`](../../) into a Next.js App Router app. The files here are reference snippets (not a standalone installed project).

## 1. Configure the key file

From your project root:

```bash
npx next-indexnow init
```

This generates a key, writes `public/<key>.txt` (served at your domain root), and adds `INDEXNOW_KEY` to `.env.local`. Commit the `public/<key>.txt` file so it deploys with your site.

> Prefer serving the key dynamically? See [`app/[key]/route.ts`](app/%5Bkey%5D/route.ts) — but the static `public/` file is simpler and avoids a catch-all route.

After deploying, confirm it's reachable:

```bash
INDEXNOW_HOST=yoursite.com npx next-indexnow verify
```

## 2. Notify when content changes

[`app/actions.ts`](app/actions.ts) shows a Server Action that revalidates a page and pings IndexNow **after** the response, so the user never waits on the network round-trip:

```ts
await revalidateAndNotify(`/blog/${slug}`, { baseUrl: BASE_URL, key });
```

## 3. Submit your whole sitemap on every deploy

Define your sitemap in [`app/sitemap.ts`](app/sitemap.ts), then add a `postbuild` step (see [`package.json`](package.json)) so the full sitemap is submitted after each build:

```jsonc
{
  "scripts": {
    "postbuild": "next-indexnow sitemap \"$SITE_URL/sitemap.xml\""
  }
}
```

For incremental cron runs, submit only recently-changed URLs from code:

```ts
import { notifySitemap } from 'next-indexnow';

await notifySitemap('https://yoursite.com/sitemap.xml', {
  key: process.env.INDEXNOW_KEY!,
  host: 'yoursite.com',
  since: new Date(Date.now() - 24 * 60 * 60 * 1000), // last 24h
});
```

## Pages Router?

Serve the key from `pages/api/[key].ts` instead:

```ts
import { createIndexNowApiHandler } from 'next-indexnow/next';

export default createIndexNowApiHandler(process.env.INDEXNOW_KEY!);
```
