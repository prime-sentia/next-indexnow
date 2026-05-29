#!/usr/bin/env node
import { notifyBatch, notifySitemap, notifyUrl, verifyKeyFile, isValidIndexNowKey } from './index';
import { hostFor, init, readEnv } from './cli-core';

/** Returns a validated INDEXNOW_KEY or exits with guidance. */
function requireKey(): string {
  const key = readEnv('INDEXNOW_KEY');
  if (!key || !isValidIndexNowKey(key)) {
    console.error(
      '❌ INDEXNOW_KEY is missing or invalid. Run `npx next-indexnow init` first, ' +
        'or set INDEXNOW_KEY in your environment / .env file.'
    );
    process.exit(1);
  }
  return key;
}

async function submit(urls: string[]): Promise<void> {
  if (urls.length === 0) {
    console.error('Usage: npx next-indexnow submit <url> [url2 ...]');
    process.exit(1);
  }
  const key = requireKey();
  if (urls.length === 1) {
    const result = await notifyUrl(urls[0], { key });
    console.log(`✅ Submitted 1 URL (HTTP ${result.responses[0].status}).`);
  } else {
    const host = hostFor(urls[0]);
    const result = await notifyBatch(urls, { key, host });
    console.log(
      `✅ Submitted ${result.submitted} URL(s), skipped ${result.skipped} (host: ${host}).`
    );
  }
}

async function sitemap(sitemapUrl: string | undefined): Promise<void> {
  if (!sitemapUrl) {
    console.error('Usage: npx next-indexnow sitemap <sitemap-url>');
    process.exit(1);
  }
  const key = requireKey();
  const host = hostFor(sitemapUrl);
  const result = await notifySitemap(sitemapUrl, { key, host });
  console.log(
    `✅ Submitted ${result.submitted} URL(s) from sitemap, skipped ${result.skipped} (host: ${host}).`
  );
}

async function verify(keyLocation: string | undefined): Promise<void> {
  const key = requireKey();
  const host = readEnv('INDEXNOW_HOST');
  if (!keyLocation && !host) {
    console.error(
      '❌ verify needs a target: set INDEXNOW_HOST, or pass the full key-file URL ' +
        '(`npx next-indexnow verify https://example.com/<key>.txt`).'
    );
    process.exit(1);
  }
  const result = await verifyKeyFile({ key, host, keyLocation });
  if (result.ok) {
    console.log(`✅ Key file verified at ${result.url}`);
  } else {
    console.error(`❌ Key file check failed at ${result.url}: ${result.reason}`);
    process.exit(1);
  }
}

const USAGE = `next-indexnow — IndexNow for Next.js

Usage:
  npx next-indexnow init                  Generate a key, write public/<key>.txt, update .env
  npx next-indexnow submit <url...>       Submit one or more URLs (reads INDEXNOW_KEY)
  npx next-indexnow sitemap <url>         Submit every URL in a sitemap (or sitemap index)
  npx next-indexnow verify [keyLocation]  Check the key file is live (reads INDEXNOW_HOST)
`;

const [command, ...rest] = process.argv.slice(2);

const commands: Record<string, () => Promise<void>> = {
  init: () => init(),
  submit: () => submit(rest),
  sitemap: () => sitemap(rest[0]),
  verify: () => verify(rest[0]),
};

const run = commands[command];
if (run) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  console.log(USAGE);
  if (command) process.exit(1);
}
