'use server';

import { notifyAfter, revalidateAndNotify } from 'next-indexnow/next';

const BASE_URL = process.env.SITE_URL ?? 'https://yoursite.com';
const key = process.env.INDEXNOW_KEY!;

/**
 * Publish a post: revalidate its page, then ping IndexNow about the absolute URL.
 * The notification is scheduled via Next's `after()`, so the response is not
 * blocked on the IndexNow round-trip.
 */
export async function publishPost(slug: string) {
  // ...persist the post to your database...

  await revalidateAndNotify(`/blog/${slug}`, { baseUrl: BASE_URL, key });
}

/**
 * Notify several URLs at once (e.g. after a bulk import) without blocking the
 * response. An array is sent as a single batch request, so `host` is required.
 */
export async function syncPosts(slugs: string[]) {
  await notifyAfter(
    slugs.map((slug) => `${BASE_URL}/blog/${slug}`),
    { key, host: new URL(BASE_URL).host }
  );
}
