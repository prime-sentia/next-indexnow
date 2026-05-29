import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvValue, readEnv, hostFor, init } from '../src/cli-core';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nin-cli-'));
  delete process.env.INDEXNOW_KEY;
  delete process.env.INDEXNOW_HOST;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const KEY = 'a1b2c3d4e5f6';

function writeEnv(name: string, content: string) {
  fs.writeFileSync(path.join(tmp, name), content, 'utf8');
}
function readFile(name: string) {
  return fs.readFileSync(path.join(tmp, name), 'utf8');
}

describe('parseEnvValue', () => {
  it('reads a plain value', () => {
    expect(parseEnvValue('INDEXNOW_KEY', 'INDEXNOW_KEY=abc123def')).toBe('abc123def');
  });

  it('strips a matched pair of double or single quotes', () => {
    expect(parseEnvValue('INDEXNOW_KEY', 'INDEXNOW_KEY="abc123def"')).toBe('abc123def');
    expect(parseEnvValue('INDEXNOW_KEY', "INDEXNOW_KEY='abc123def'")).toBe('abc123def');
  });

  it('leaves an unbalanced quote intact', () => {
    expect(parseEnvValue('INDEXNOW_KEY', 'INDEXNOW_KEY="abc')).toBe('"abc');
  });

  it('does not match prefix/suffix collisions', () => {
    expect(parseEnvValue('INDEXNOW_KEY', 'MY_INDEXNOW_KEY=x')).toBeUndefined();
    expect(parseEnvValue('INDEXNOW_KEY', 'INDEXNOW_KEY_BACKUP=y')).toBeUndefined();
  });

  it('stops at end-of-line and handles CRLF', () => {
    expect(parseEnvValue('INDEXNOW_KEY', 'INDEXNOW_KEY=abc\r\nOTHER=2')).toBe('abc');
  });

  it('ignores commented lines', () => {
    expect(parseEnvValue('INDEXNOW_KEY', '# INDEXNOW_KEY=old')).toBeUndefined();
  });
});

describe('readEnv', () => {
  it('reads from .env.local under the root', () => {
    writeEnv('.env.local', `INDEXNOW_KEY=${KEY}\n`);
    expect(readEnv('INDEXNOW_KEY', tmp)).toBe(KEY);
  });

  it('falls back to .env when .env.local is absent', () => {
    writeEnv('.env', `INDEXNOW_KEY=${KEY}\n`);
    expect(readEnv('INDEXNOW_KEY', tmp)).toBe(KEY);
  });

  it('lets process.env win over the file', () => {
    writeEnv('.env.local', `INDEXNOW_KEY=fromfile\n`);
    process.env.INDEXNOW_KEY = 'fromenv';
    expect(readEnv('INDEXNOW_KEY', tmp)).toBe('fromenv');
  });

  it('returns undefined when not found', () => {
    expect(readEnv('INDEXNOW_KEY', tmp)).toBeUndefined();
  });
});

describe('hostFor', () => {
  it('honors INDEXNOW_HOST', () => {
    process.env.INDEXNOW_HOST = 'env-host.com';
    expect(hostFor('https://other.com/x', tmp)).toBe('env-host.com');
  });

  it('derives the host from a valid URL', () => {
    expect(hostFor('https://www.example.com/blog', tmp)).toBe('www.example.com');
  });

  it('returns the raw string on unparseable input', () => {
    expect(hostFor('not a url', tmp)).toBe('not a url');
  });
});

describe('init', () => {
  it('generates a key, writes public/<key>.txt, and creates .env.local', async () => {
    fs.mkdirSync(path.join(tmp, 'public'));
    await init(tmp);
    const env = readFile('.env.local');
    const match = env.match(/^INDEXNOW_KEY=([a-f0-9]{32})$/m);
    expect(match).not.toBeNull();
    const key = match![1];
    expect(fs.existsSync(path.join(tmp, 'public', `${key}.txt`))).toBe(true);
    expect(readFile(`public/${key}.txt`)).toBe(key);
  });

  it('reuses a valid existing key without orphaning files or changing the env', async () => {
    fs.mkdirSync(path.join(tmp, 'public'));
    writeEnv('.env.local', `INDEXNOW_KEY=${KEY}\n`);
    await init(tmp);
    expect(fs.existsSync(path.join(tmp, 'public', `${KEY}.txt`))).toBe(true);
    expect(readFile('.env.local')).toBe(`INDEXNOW_KEY=${KEY}\n`); // unchanged
  });

  it('regenerates and OVERWRITES an invalid existing key (no desync)', async () => {
    fs.mkdirSync(path.join(tmp, 'public'));
    writeEnv('.env.local', `INDEXNOW_KEY=bad key!\n`);
    await init(tmp);
    const env = readFile('.env.local');
    const match = env.match(/^INDEXNOW_KEY=([a-f0-9]{32})$/m);
    expect(match).not.toBeNull();
    const key = match![1];
    // The old invalid line is gone (overwritten in place, not duplicated).
    expect(env).not.toContain('bad key!');
    expect((env.match(/INDEXNOW_KEY=/g) || []).length).toBe(1);
    expect(readFile(`public/${key}.txt`)).toBe(key); // served file matches env
  });

  it('treats a commented key line as absent and appends a real key', async () => {
    fs.mkdirSync(path.join(tmp, 'public'));
    writeEnv('.env.local', `# INDEXNOW_KEY=old\nFOO=bar\n`);
    await init(tmp);
    const env = readFile('.env.local');
    expect(env).toContain('# INDEXNOW_KEY=old'); // comment preserved
    expect(env).toMatch(/^INDEXNOW_KEY=[a-f0-9]{32}$/m); // real key appended
  });
});
