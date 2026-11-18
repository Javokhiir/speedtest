'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseArgs, measureOnce, runRequests, summarize } = require('../speedtest.js');

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

// Handler that answers after 20 ms and records how many requests were open at once.
function trackingHandler(stats) {
  let active = 0;
  return (req, res) => {
    stats.hits++;
    stats.maxActive = Math.max(stats.maxActive, ++active);
    setTimeout(() => { active--; res.end('x'.repeat(1000)); }, 20);
  };
}

test('measureOnce counts every byte of the body', async () => {
  const size = 300_000;
  await withServer((req, res) => res.end(Buffer.alloc(size)), async (url) => {
    const r = await measureOnce(url, 5000);
    assert.equal(r.bytes, size);
    assert.ok(r.seconds > 0);
  });
});

test('measureOnce separates the wait for the response (TTFB) from the body download', async () => {
  // headers after 150 ms, body 150 ms later
  const handler = (req, res) => {
    setTimeout(() => {
      res.flushHeaders();
      setTimeout(() => res.end(Buffer.alloc(1000)), 150);
    }, 150);
  };
  await withServer(handler, async (url) => {
    const r = await measureOnce(url, 5000);
    assert.ok(r.ttfbSeconds >= 0.14, `ttfb ${r.ttfbSeconds}`);
    assert.ok(r.seconds - r.ttfbSeconds >= 0.14, `body ${r.seconds - r.ttfbSeconds}`);
  });
});

test('by default requests go one at a time', async () => {
  const stats = { hits: 0, maxActive: 0 };
  await withServer(trackingHandler(stats), async (url) => {
    const { results } = await runRequests(url, 10, 5000);
    assert.equal(stats.hits, 10);
    assert.equal(stats.maxActive, 1);
    assert.equal(summarize(results).totalBytes, 10_000);
  });
});

test('--parallel 3 keeps exactly 3 requests in flight and still makes 10', async () => {
  const stats = { hits: 0, maxActive: 0 };
  await withServer(trackingHandler(stats), async (url) => {
    const { results, wallSeconds } = await runRequests(url, 10, 5000, 3);
    assert.equal(stats.hits, 10);
    assert.equal(stats.maxActive, 3);
    assert.equal(results.filter((r) => r.ok).length, 10);
    assert.ok(wallSeconds > 0);
  });
});

test('HTTP errors are reported and left out of the totals', async () => {
  let n = 0;
  const handler = (req, res) => {
    if (++n === 2) { res.statusCode = 404; return res.end('nope'); }
    res.end(Buffer.alloc(500));
  };
  await withServer(handler, async (url) => {
    const { results } = await runRequests(url, 3, 5000);
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

test('summarize: sequential speed is total bytes over the sum of request times', () => {
  const s = summarize([
    { ok: true, bytes: 1_000_000, seconds: 1, ttfbSeconds: 0.5 },
    { ok: true, bytes: 3_000_000, seconds: 3, ttfbSeconds: 1.5 },
    { ok: false, error: 'boom' },
  ]);
  assert.equal(s.requested, 3);
  assert.equal(s.succeeded, 2);
  assert.equal(s.totalBytes, 4_000_000);
  assert.equal(s.avgSeconds, 2);
  assert.equal(s.avgTtfbSeconds, 1);
  assert.equal(s.mbitPerSec, 8);      // 4 MB in 4 s = 1 MB/s = 8 Mbit/s
  assert.equal(s.bodyMbitPerSec, 16); // the same 4 MB in 2 s of pure transfer
});

test('summarize: parallel speed uses wall-clock time, not the sum of overlapping requests', () => {
  const results = [
    { ok: true, bytes: 1_000_000, seconds: 2, ttfbSeconds: 0.1 },
    { ok: true, bytes: 1_000_000, seconds: 2, ttfbSeconds: 0.1 },
  ];
  assert.equal(summarize(results, 2).mbitPerSec, 8); // 2 MB in 2 s of real time
  assert.equal(summarize(results).mbitPerSec, 4);    // would be halved if times were summed
});

test('parseArgs: defaults and validation', () => {
  assert.deepEqual(parseArgs(['https://example.com/a.jpg']),
    { url: 'https://example.com/a.jpg', count: 10, parallel: 1, timeoutMs: 60_000, help: false });
  const o = parseArgs(['http://a.b', '--count', '3', '--parallel', '2', '--timeout', '5']);
  assert.deepEqual([o.count, o.parallel, o.timeoutMs], [3, 2, 5000]);
  assert.throws(() => parseArgs([]), /URL is required/);
  assert.throws(() => parseArgs(['notaurl']), /Invalid URL/);
  assert.throws(() => parseArgs(['ftp://a.b/c']), /http\/https/);
  assert.throws(() => parseArgs(['http://a.b', '--count', '0']), /positive integer/);
  assert.throws(() => parseArgs(['http://a.b', '--parallel', '1.5']), /positive integer/);
});
