import { NextResponse } from 'next/server';

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
  return async function GET(
    request: Request,
    { params }: { params: { key: string } }
  ) {
    const { key } = params;

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
