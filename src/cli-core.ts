import fs from 'fs';
import path from 'path';
import { generateKey, isValidIndexNowKey } from './index';

/** Strips a single matched pair of surrounding quotes (leaves unbalanced quotes intact). */
function stripQuotes(value: string): string {
  const t = value.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Parses the value of `name` from the contents of an .env file. The match is
 * anchored (so `MY_INDEXNOW_KEY` / `INDEXNOW_KEY_BACKUP` don't collide) and stops
 * at end-of-line (`.` doesn't cross newlines), then a matched quote pair is stripped.
 */
export function parseEnvValue(name: string, content: string): string | undefined {
  const match = content.match(new RegExp(`^\\s*${name}\\s*=(.*)$`, 'm'));
  if (!match) return undefined;
  return stripQuotes(match[1]);
}

/** Reads a variable from process.env, falling back to .env.local then .env under `root`. */
export function readEnv(name: string, root: string = process.cwd()): string | undefined {
  if (process.env[name]) return process.env[name];
  for (const file of ['.env.local', '.env']) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) continue;
    const value = parseEnvValue(name, fs.readFileSync(filePath, 'utf8'));
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Derives the host from INDEXNOW_HOST, otherwise from the given URL. */
export function hostFor(url: string, root: string = process.cwd()): string {
  const envHost = readEnv('INDEXNOW_HOST', root);
  if (envHost) return envHost;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface EnvFileInfo {
  path: string;
  name: string;
  /** File contents, or undefined if the file doesn't exist yet. */
  content: string | undefined;
}

/** Picks the target env file (.env.local preferred; .env if only it exists) and reads it. */
function resolveEnvFile(root: string): EnvFileInfo {
  const envLocal = path.join(root, '.env.local');
  const env = path.join(root, '.env');
  let target = envLocal;
  let name = '.env.local';
  if (!fs.existsSync(envLocal) && fs.existsSync(env)) {
    target = env;
    name = '.env';
  }
  const content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
  return { path: target, name, content };
}

const ASSIGN_LINE = /^(\s*INDEXNOW_KEY\s*=).*$/m;

/**
 * Generates (or reuses) a key, writes `public/<key>.txt`, and reconciles the
 * INDEXNOW_KEY in the target env file so the served key file and the env the app
 * loads always agree. Idempotent: re-running with a valid key reuses it.
 */
export async function init(root: string = process.cwd()): Promise<void> {
  console.log('\n🚀 Starting IndexNow automatic setup by Prime Sentia AI...\n');

  // Reuse an existing valid key from the target env FILE (not process.env) so the
  // written key file and the persisted env stay in sync.
  const envInfo = resolveEnvFile(root);
  const fileKey = envInfo.content ? parseEnvValue('INDEXNOW_KEY', envInfo.content) : undefined;
  const reused = Boolean(fileKey && isValidIndexNowKey(fileKey));
  const key = reused ? (fileKey as string) : generateKey();
  console.log(`🔑 ${reused ? 'Reusing existing' : 'Generated secure'} IndexNow Key: ${key}`);

  // 1. Write public/<key>.txt
  const publicDir = path.join(root, 'public');
  if (fs.existsSync(publicDir)) {
    try {
      fs.writeFileSync(path.join(publicDir, `${key}.txt`), key, 'utf8');
      console.log(`✅ Created verification file at: public/${key}.txt`);
    } catch (err) {
      console.error(`❌ Failed to write file to public directory: ${err}`);
    }
  } else {
    console.log(
      `⚠️  Could not find 'public/' directory. You are likely not at the root of a Next.js project.`
    );
    console.log(
      `   Please create a file named '${key}.txt' in your public folder with the content: ${key}`
    );
  }

  // 2. Reconcile the env file (create / update-if-different / append)
  const { path: envPath, name: envName, content } = envInfo;
  const line = `INDEXNOW_KEY=${key}`;
  try {
    if (content === undefined) {
      fs.writeFileSync(envPath, `# Added by next-indexnow\n${line}\n`, 'utf8');
      console.log(`✅ Created ${envName} and added INDEXNOW_KEY`);
    } else if (ASSIGN_LINE.test(content)) {
      if (parseEnvValue('INDEXNOW_KEY', content) === key) {
        console.log(`✓ INDEXNOW_KEY already up to date in ${envName}.`);
      } else {
        fs.writeFileSync(envPath, content.replace(ASSIGN_LINE, `$1${key}`), 'utf8');
        console.log(`✅ Updated INDEXNOW_KEY in ${envName}`);
      }
    } else {
      fs.appendFileSync(
        envPath,
        `${content.endsWith('\n') ? '' : '\n'}# Added by next-indexnow\n${line}\n`
      );
      console.log(`✅ Added INDEXNOW_KEY to ${envName}`);
    }
  } catch (err) {
    console.error(`❌ Failed to update ${envName}: ${err}`);
  }

  console.log('\n🎉 Setup complete! You are ready to notify search engines instantly.');
  console.log(`   ℹ️  Commit public/${key}.txt so it deploys with your site, then run`);
  console.log('      `npx next-indexnow verify` after deploying to confirm it is reachable.');
}
