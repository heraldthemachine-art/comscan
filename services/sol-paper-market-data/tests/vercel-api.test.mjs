import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../api/market-data.js';

test('Vercel endpoint rejects unknown view before any upstream fetch', async () => {
  const response = await GET(new Request('https://example.invalid/api/market-data?view=invalid'));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const body = await response.json();
  assert.equal(body.error, 'INVALID_VIEW');
});
