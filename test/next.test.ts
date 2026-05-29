import { describe, it, expect, vi, beforeEach } from 'vitest';

// `after` is a spy that CAPTURES the scheduled callback instead of running it,
// so tests can prove scheduling happened and control when the work executes.
const { afterMock } = vi.hoisted(() => ({ afterMock: vi.fn() }));

// The factory is hoisted above all top-level code, so the mock class must be
// declared inside it. Tests read the returned object structurally.
vi.mock('next/server', () => {
  class MockNextResponse {
    body: unknown;
    status: number;
    headers: Record<string, string>;
    constructor(body?: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = init?.headers ?? {};
    }
  }
  return { NextResponse: MockNextResponse, after: afterMock };
});

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

import {
  createIndexNowApiHandler,
  createIndexNowRouteHandler,
  notifyAfter,
  revalidateAndNotify,
} from '../src/next';
import * as nextCache from 'next/cache';

type ResponseShape = { body: unknown; status: number; headers: Record<string, string> };

const KEY = 'a1b2c3d4e5f6';

/** Runs the most recently scheduled after() callback. */
async function runScheduled() {
  const cb = afterMock.mock.calls.at(-1)?.[0] as (() => Promise<void>) | undefined;
  await cb?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  afterMock.mockReset();
});

describe('createIndexNowRouteHandler', () => {
  const handler = createIndexNowRouteHandler('mykey123');

  it('serves the key when the request key matches (with .txt stripped)', async () => {
    const res = (await handler(new Request('https://x.com/mykey123.txt'), {
      params: Promise.resolve({ key: 'mykey123.txt' }),
    })) as unknown as ResponseShape;
    expect(res.status).toBe(200);
    expect(res.body).toBe('mykey123');
    expect(res.headers['Content-Type']).toBe('text/plain');
  });

  it('returns 404 when the key does not match', async () => {
    const res = (await handler(new Request('https://x.com/wrong.txt'), {
      params: Promise.resolve({ key: 'wrong.txt' }),
    })) as unknown as ResponseShape;
    expect(res.status).toBe(404);
  });

  it('returns 404 when the key param is missing', async () => {
    const res = (await handler(new Request('https://x.com/'), {
      params: Promise.resolve({ key: '' }),
    })) as unknown as ResponseShape;
    expect(res.status).toBe(404);
  });
});

describe('createIndexNowApiHandler (Pages Router)', () => {
  function mockRes() {
    return {
      statusCode: 0,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      send(b: unknown) {
        this.body = b;
        return this;
      },
    };
  }

  const handler = createIndexNowApiHandler('mykey123');

  it('serves the key when the query key matches (with .txt stripped)', () => {
    const res = mockRes();
    handler({ query: { key: 'mykey123.txt' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('mykey123');
    expect(res.headers['Content-Type']).toBe('text/plain');
  });

  it('returns 404 when the query key does not match', () => {
    const res = mockRes();
    handler({ query: { key: 'wrong' } } as any, res as any);
    expect(res.statusCode).toBe(404);
  });
});

describe('notifyAfter', () => {
  it('schedules the submission via after() without firing it inline', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);

    await notifyAfter('https://x.com/a', { key: KEY });

    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(afterMock.mock.calls[0][0]).toBeTypeOf('function');
    expect(fetchFn).not.toHaveBeenCalled(); // scheduled, not yet run

    await runScheduled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toContain('url=https%3A%2F%2Fx.com%2Fa');
  });

  it('sends a batch (single POST) when given an array of URLs', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);

    await notifyAfter(['https://x.com/a', 'https://x.com/b'], { key: KEY, host: 'x.com' });
    await runScheduled();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.urlList).toEqual(['https://x.com/a', 'https://x.com/b']);
  });

  it('swallows submission errors and never surfaces them to the caller', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 403 }));
    vi.stubGlobal('fetch', fetchFn);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notifyAfter('https://x.com/a', { key: KEY })).resolves.toBeUndefined();
    await expect(runScheduled()).resolves.toBeUndefined(); // does not throw

    expect(errSpy).toHaveBeenCalledWith(
      '[next-indexnow] notifyAfter submission failed:',
      expect.anything()
    );
    errSpy.mockRestore();
  });

  it('falls back to a detached submission if after() throws synchronously', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    afterMock.mockImplementationOnce(() => {
      throw new Error('after() called outside a request scope');
    });

    await expect(notifyAfter('https://x.com/a', { key: KEY })).resolves.toBeUndefined();
    await Promise.resolve(); // flush the detached run()
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('revalidateAndNotify', () => {
  it('revalidates the path and notifies the absolute URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);

    await revalidateAndNotify('/blog/post', { baseUrl: 'https://x.com', key: KEY });
    expect(nextCache.revalidatePath).toHaveBeenCalledWith('/blog/post');

    await runScheduled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toContain('url=https%3A%2F%2Fx.com%2Fblog%2Fpost');
  });

  it('revalidates a tag when provided', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);

    await revalidateAndNotify('/blog/post', { baseUrl: 'https://x.com', key: KEY, tag: 'posts' });
    expect(nextCache.revalidateTag).toHaveBeenCalledWith('posts');
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });
});
