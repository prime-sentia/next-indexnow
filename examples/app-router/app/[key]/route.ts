import { createIndexNowRouteHandler } from 'next-indexnow/next';

/**
 * Optional: serve the IndexNow key file dynamically instead of from `public/`.
 *
 * Note: a root `app/[key]` segment matches every top-level path, so prefer the
 * static `public/<key>.txt` file (created by `npx next-indexnow init`) unless you
 * specifically need to serve the key from a route handler.
 */
export const GET = createIndexNowRouteHandler(process.env.INDEXNOW_KEY ?? '');
