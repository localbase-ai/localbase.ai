import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { BaseConnector } from '../connectors/APIClient.js';

// Serve canned pages by page number; a page mapped to null fails at the network.
function mockFetch(pages) {
  return async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (pages[page] === null) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(pages[page] || []), { status: 200 });
  };
}

describe('BaseConnector.makeAllRequests', () => {
  const realFetch = globalThis.fetch;
  let client;

  beforeEach(() => {
    client = new BaseConnector({ name: 'Test', baseURL: 'https://example.test', retryAttempts: 0 });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns every page when all succeed', async () => {
    globalThis.fetch = mockFetch({ 1: [1, 2], 2: [3, 4], 3: [5] });
    const rows = await client.makeAllRequests('/items', { pageSize: 2 });
    assert.deepStrictEqual(rows, [1, 2, 3, 4, 5]);
  });

  it('throws instead of returning a partial list when a page fails', async () => {
    globalThis.fetch = mockFetch({ 1: [1, 2], 2: null });
    await assert.rejects(
      client.makeAllRequests('/items', { pageSize: 2 }),
      /pagination failed on page 2 after 2 records.*fetch failed/
    );
  });

  it('throws when the very first page fails', async () => {
    globalThis.fetch = mockFetch({ 1: null });
    await assert.rejects(client.makeAllRequests('/items'), /page 1 after 0 records/);
  });
});
