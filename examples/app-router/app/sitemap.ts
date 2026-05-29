import type { MetadataRoute } from 'next';

const BASE_URL = process.env.SITE_URL ?? 'https://yoursite.com';

/**
 * Your sitemap is the source of truth for `next-indexnow sitemap` (run as a
 * postbuild step) — see package.json.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${BASE_URL}/`, lastModified: new Date() },
    { url: `${BASE_URL}/blog/hello-world`, lastModified: new Date() },
  ];
}
