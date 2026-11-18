'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseArgs, measureOnce, runSequential, summarize } = require('../speedtest.js');

// Local HTTP server, so the tests need no internet.
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('measureOnce counts every byte of the body', async () => {
  const size = 300_000;
  await withServer((req, res) => res.end(Buffer.alloc(size)), async (url) => {
    const r = await measureOnce(url, 5000);
    assert.equal(r.bytes, size);
    assert.ok(r.seconds > 0);
  });
});

test('runSequential makes N requests, never two at once', async () => {
  let active = 0, maxActive = 0, hits = 0;
  const handler = (req, res) => {
    hits++;
    maxActive = Math.max(maxActive, ++active);
    setTimeout(() => { active--; res.end('x'.repeat(1000)); }, 20);
  };
  await withServer(handler, async (url) => {
    const results = await runSequential(url, 10, 5000);
    assert.equal(hits, 10);
    assert.equal(maxActive, 1);
    assert.equal(summarize(results).totalBytes, 10_000);
  });
});

test('HTTP errors are reported and left out of the totals', async () => {
  let n = 0;
  const handler = (req, res) => {
    if (++n === 2) { res.statusCode = 404; return res.end('nope'); }
    res.end(Buffer.alloc(500));
  };
  await withServer(handler, async (url) => {
    const results = await runSequential(url, 3, 5000);
    assert.match(results[1].error, /HTTP 404/);
    const s = summarize(results);
    assert.equal(s.succeeded, 2);
    assert.equal(s.totalBytes, 1000);
  });
});

test('a request slower than the timeout fails with a timeout error', async () => {
  await withServer(() => { /* never answers */ }, async (url) => {
    await assert.rejects(measureOnce(url, 100), /timeout/);
  });
});

test('summarize: speed is total bytes over total time', () => {
  const s = summarize([
    { ok: true, bytes: 1_000_000, seconds: 1 },
    { ok: true, bytes: 3_000_000, seconds: 3 },
    { ok: false, error: 'boom' },
  ]);
  assert.equal(s.requested, 3);
  assert.equal(s.succeeded, 2);
  assert.equal(s.totalBytes, 4_000_000);
  assert.equal(s.avgSeconds, 2);
  assert.equal(s.mbitPerSec, 8); // 4 MB in 4 s = 1 MB/s = 8 Mbit/s
});

test('parseArgs: defaults and validation', () => {
  assert.deepEqual(parseArgs(['https://example.com/a.jpg']),
    { url: 'https://example.com/a.jpg', count: 10, timeoutMs: 60_000, help: false });
  assert.equal(parseArgs(['http://a.b', '--count', '3', '--timeout', '5']).timeoutMs, 5000);
  assert.throws(() => parseArgs([]), /URL is required/);
  assert.throws(() => parseArgs(['notaurl']), /Invalid URL/);
  assert.throws(() => parseArgs(['ftp://a.b/c']), /http\/https/);
  assert.throws(() => parseArgs(['http://a.b', '--count', '0']), /positive integer/);
});
