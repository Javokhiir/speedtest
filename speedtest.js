#!/usr/bin/env node
'use strict';
// Download speed test: N GET requests to one URL (one after another by default),
// each body read to the end, then average time, total bytes and speed.

const DEFAULT_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 60_000;

function usage() {
  console.log(`Usage: node speedtest.js <url> [--count N] [--parallel N] [--timeout SEC]

  <url>          address to download (e.g. a large image)
  --count N      number of requests (default ${DEFAULT_COUNT})
  --parallel N   how many requests run at the same time (default 1 = strictly sequential)
  --timeout SEC  per-request timeout in seconds (default ${DEFAULT_TIMEOUT_MS / 1000})`);
}

function parseArgs(argv) {
  const opts = { url: null, count: DEFAULT_COUNT, parallel: 1, timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--count') opts.count = Number(argv[++i]);
    else if (a === '--parallel') opts.parallel = Number(argv[++i]);
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (!opts.url) opts.url = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.help) return opts;
  if (!opts.url) throw new Error('URL is required');
  let parsed;
  try { parsed = new URL(opts.url); } catch { throw new Error(`Invalid URL: ${opts.url}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http/https URLs are supported');
  if (!Number.isInteger(opts.count) || opts.count < 1) throw new Error('--count must be a positive integer');
  if (!Number.isInteger(opts.parallel) || opts.parallel < 1) throw new Error('--parallel must be a positive integer');
  if (!(opts.timeoutMs > 0)) throw new Error('--timeout must be a positive number');
  return opts;
}

const secondsSince = (start) => Number(process.hrtime.bigint() - start) / 1e9;

// One request. `seconds` is the full time until the last body byte;
// `ttfbSeconds` is the part spent waiting for the response to start (time to first byte).
async function measureOnce(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = process.hrtime.bigint();
  try {
    // fetch() resolves as soon as the response headers arrive, before the body is downloaded.
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      // identity: ask for the raw file, so we measure real bytes, not a gzip copy
      headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
    });
    const ttfbSeconds = secondsSince(start);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    let bytes = 0;
    // Read the body as a stream: counts bytes as they arrive, keeps memory flat for big files.
    for await (const chunk of res.body ?? []) bytes += chunk.length;
    return { bytes, seconds: secondsSince(start), ttfbSeconds };
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`timeout after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Runs `count` requests with `parallel` workers. Each worker takes the next request number
// only after its previous request has finished, so with parallel = 1 the requests go
// strictly one after another. A failed request is kept as { ok: false } and does not stop the run.
async function runRequests(url, count, timeoutMs, parallel = 1, onResult = () => {}) {
  const results = new Array(count);
  let next = 0;
  async function worker() {
    while (next < count) {
      const i = next++;
      try {
        results[i] = { ok: true, ...(await measureOnce(url, timeoutMs)) };
      } catch (err) {
        results[i] = { ok: false, error: err.cause?.message || err.message };
      }
      onResult(i + 1, results[i]);
    }
  }
  const start = process.hrtime.bigint();
  await Promise.all(Array.from({ length: Math.min(parallel, count) }, worker));
  return { results, wallSeconds: secondsSince(start) };
}

const toMbit = (bytes, seconds) => (seconds > 0 ? (bytes * 8) / 1e6 / seconds : 0);

// Totals over successful requests only.
// Sequential run: requests do not overlap, so speed = all bytes / sum of request times.
// Parallel run: requests overlap, so pass `wallSeconds` and speed = all bytes / wall-clock time.
function summarize(results, wallSeconds = null) {
  const ok = results.filter((r) => r.ok);
  const sum = (key) => ok.reduce((total, r) => total + r[key], 0);
  const totalBytes = sum('bytes');
  const totalSeconds = sum('seconds');
  const totalTtfb = sum('ttfbSeconds');
  return {
    requested: results.length,
    succeeded: ok.length,
    totalBytes,
    avgSeconds: ok.length ? totalSeconds / ok.length : 0,
    avgTtfbSeconds: ok.length ? totalTtfb / ok.length : 0,
    mbitPerSec: toMbit(totalBytes, wallSeconds ?? totalSeconds),
    // speed of the transfer itself, with the wait for the server's answer taken out
    bodyMbitPerSec: toMbit(totalBytes, totalSeconds - totalTtfb),
  };
}

const toMB = (bytes) => (bytes / 1e6).toFixed(2);

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n`);
    usage();
    process.exit(1);
  }
  if (opts.help) return usage();

  const isParallel = opts.parallel > 1;
  const mode = isParallel ? `requests, ${opts.parallel} at a time` : 'sequential requests';
  console.log(`Testing ${opts.url} with ${opts.count} ${mode}\n`);

  const { results, wallSeconds } = await runRequests(opts.url, opts.count, opts.timeoutMs, opts.parallel, (i, r) => {
    const n = `#${String(i).padStart(2)}`;
    if (r.ok) console.log(`${n}  ${toMB(r.bytes)} MB  ${r.seconds.toFixed(3).padStart(7)} s (TTFB ${r.ttfbSeconds.toFixed(3)} s)  ${toMbit(r.bytes, r.seconds).toFixed(2)} Mbit/s`);
    else console.log(`${n}  failed: ${r.error}`);
  });

  const s = summarize(results, isParallel ? wallSeconds : null);
  if (s.succeeded === 0) {
    console.error('\nAll requests failed.');
    process.exit(1);
  }
  console.log(`
Successful requests: ${s.succeeded}/${s.requested}
Average request time: ${s.avgSeconds.toFixed(3)} s (TTFB ${s.avgTtfbSeconds.toFixed(3)} s)
Total downloaded:     ${toMB(s.totalBytes)} MB
Download speed:       ${s.mbitPerSec.toFixed(2)} Mbit/s (${(s.mbitPerSec / 8).toFixed(2)} MB/s)`);
  if (isParallel) console.log(`Wall-clock time:      ${wallSeconds.toFixed(3)} s`);
  else console.log(`Speed without TTFB:   ${s.bodyMbitPerSec.toFixed(2)} Mbit/s`);
  if (s.succeeded < s.requested) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { parseArgs, measureOnce, runRequests, summarize };
