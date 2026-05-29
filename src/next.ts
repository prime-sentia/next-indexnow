import { NextResponse } from 'next/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import { notifyBatch, notifyUrl, type IndexNowOptions } from './index';

/**
 * Creates a Next.js App Router API Route handler for serving the IndexNow key.
 *
 * Usage:
 * Create a file at `app/[key]/route.ts`
 *
 * ```ts
 * import { createIndexNowRouteHandler } from 'next-indexnow/next';
 *
 * const key = process.env.INDEXNOW_KEY || 'my-secret-key';
 * export const GET = createIndexNowRouteHandler(key);
 * ```
 *
 * @param expectedKey The API key that you have configured for IndexNow.
 * @returns A Next.js route handler function for GET requests.
 */
export function createIndexNowRouteHandler(expectedKey: string) {
  return async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
    // Next.js 15+ passes `params` as a Promise; Next 13/14 pass a plain object.
    // Awaiting a non-thenable is a no-op, so this works on every supported version.
    const { key } = await params;

    if (!key) {
      return new NextResponse('Not found', { status: 404 });
    }

    // The route will capture "my-key.txt" as the params.key
    // We need to extract the actual key by removing the .txt extension
    const requestKey = key.replace(/\.txt$/, '');

    if (requestKey === expectedKey) {
      return new NextResponse(expectedKey, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
        },
      });
    }

    // Return 404 if the key does not match
    return new NextResponse('Not found', { status: 404 });
  };
}

/**
 * Creates a Pages Router API handler for serving the IndexNow key.
 *
 * Usage — create a file at `pages/api/[key].ts`:
 *
 * ```ts
 * import { createIndexNowApiHandler } from 'next-indexnow/next';
 *
 * export default createIndexNowApiHandler(process.env.INDEXNOW_KEY!);
 * ```
 *
 * @param expectedKey The API key that you have configured for IndexNow.
 * @returns A Pages Router `(req, res)` handler.
 */
export function createIndexNowApiHandler(expectedKey: string) {
  return function handler(req: NextApiRequest, res: NextApiResponse): void {
    const raw = Array.isArray(req.query.key) ? req.query.key[0] : req.query.key;
    const requestKey = (raw ?? '').replace(/\.txt$/, '');

    if (requestKey === expectedKey) {
      res.setHeader('Content-Type', 'text/plain');
      res.status(200).send(expectedKey);
      return;
    }

    res.status(404).send('Not found');
  };
}

/**
 * Schedules an IndexNow notification to run *after* the response has been sent,
 * using Next.js's `after()` API. The request is never blocked on the IndexNow
 * round-trip, and indexing errors are logged rather than surfaced to the user.
 *
 * Ideal inside Server Actions / Route Handlers that mutate content:
 *
 * ```ts
 * import { notifyAfter } from 'next-indexnow/next';
 *
 * export async function publishPost(slug: string) {
 *   // ...persist changes...
 *   await notifyAfter(`https://example.com/blog/${slug}`, {
 *     key: process.env.INDEXNOW_KEY!,
 *   });
 * }
 * ```
 *
 * On Next.js versions without `after()`, it falls back to a detached,
 * non-blocking (best-effort) submission.
 *
 * @param urlOrUrls A single URL, or an array of URLs (sent as a batch — `host` required).
 * @param options Configuration options including the API key.
 */
export async function notifyAfter(
  urlOrUrls: string | string[],
  options: IndexNowOptions
): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      if (Array.isArray(urlOrUrls)) {
        await notifyBatch(urlOrUrls, options);
      } else {
        await notifyUrl(urlOrUrls, options);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[next-indexnow] notifyAfter submission failed:', error);
    }
  };

  const serverMod = (await import('next/server').catch(() => null)) as {
    after?: (cb: () => Promise<void> | void) => void;
    unstable_after?: (cb: () => Promise<void> | void) => void;
  } | null;
  const after = serverMod?.after ?? serverMod?.unstable_after;

  if (typeof after === 'function') {
    try {
      after(run);
    } catch {
      // after() throws synchronously when called outside an allowed request
      // scope. Fall back to a detached submission rather than surfacing it.
      void run();
    }
  } else {
    // Fallback for Next < 15: fire-and-forget without blocking the response.
    void run();
  }
}

/** Options for {@link revalidateAndNotify}. */
export interface RevalidateAndNotifyOptions extends IndexNowOptions {
  /** Absolute base URL of your site (e.g. 'https://example.com'), used to build the URL to notify. */
  baseUrl: string;
  /** Revalidate a cache tag instead of a path (calls `revalidateTag`). */
  tag?: string;
}

/**
 * Couples Next.js on-demand revalidation with an IndexNow notification: it
 * revalidates the given path (or tag) and then notifies IndexNow about the
 * absolute URL — the canonical "this content changed, re-index it" flow.
 *
 * ```ts
 * import { revalidateAndNotify } from 'next-indexnow/next';
 *
 * await revalidateAndNotify('/blog/my-post', {
 *   baseUrl: 'https://example.com',
 *   key: process.env.INDEXNOW_KEY!,
 * });
 * ```
 *
 * @param path The path to revalidate and (joined with `baseUrl`) to notify.
 * @param options Configuration including `baseUrl`, the IndexNow `key`, and an optional `tag`.
 */
export async function revalidateAndNotify(
  path: string,
  options: RevalidateAndNotifyOptions
): Promise<void> {
  const { baseUrl, tag, ...indexNowOptions } = options;

  const cacheMod = (await import('next/cache').catch(() => null)) as {
    revalidatePath?: (p: string) => void;
    revalidateTag?: (t: string) => void;
  } | null;

  if (tag) {
    cacheMod?.revalidateTag?.(tag);
  } else {
    cacheMod?.revalidatePath?.(path);
  }

  const url = new URL(path, baseUrl).toString();
  await notifyAfter(url, indexNowOptions);
}
