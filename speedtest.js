#!/usr/bin/env node
'use strict';
// Download speed test: N sequential GET requests to one URL,
// each body read to the end, then average time, total bytes and speed.

const DEFAULT_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 60_000;

function usage() {
  console.log(`Usage: node speedtest.js <url> [--count N] [--timeout SEC]

  <url>          address to download (e.g. a large image)
  --count N      number of sequential requests (default ${DEFAULT_COUNT})
  --timeout SEC  per-request timeout in seconds (default ${DEFAULT_TIMEOUT_MS / 1000})`);
}

function parseArgs(argv) {
  const opts = { url: null, count: DEFAULT_COUNT, timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--count') opts.count = Number(argv[++i]);
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
  if (!(opts.timeoutMs > 0)) throw new Error('--timeout must be a positive number');
  return opts;
}

// One request: time from sending until the last body byte is received.
async function measureOnce(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = process.hrtime.bigint();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      // identity: ask for the raw file, so we measure real bytes, not a gzip copy
      headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    let bytes = 0;
    // Read the body as a stream: counts bytes as they arrive, keeps memory flat for big files.
    for await (const chunk of res.body ?? []) bytes += chunk.length;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    return { bytes, seconds };
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`timeout after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Requests go strictly one after another: the next starts only when the previous has finished.
// A failed request is kept in the list as { ok: false } and does not stop the run.
async function runSequential(url, count, timeoutMs, onResult = () => {}) {
  const results = [];
  for (let i = 1; i <= count; i++) {
    let result;
    try {
      result = { ok: true, ...(await measureOnce(url, timeoutMs)) };
    } catch (err) {
      result = { ok: false, error: err.cause?.message || err.message };
    }
    results.push(result);
    onResult(i, result);
  }
  return results;
}

const toMbit = (bytes, seconds) => (seconds > 0 ? (bytes * 8) / 1e6 / seconds : 0);

// Totals over successful requests only. Speed = all bytes / all time,
// not the mean of per-request speeds, so every request weighs by its real size.
function summarize(results) {
  const ok = results.filter((r) => r.ok);
  const totalBytes = ok.reduce((sum, r) => sum + r.bytes, 0);
  const totalSeconds = ok.reduce((sum, r) => sum + r.seconds, 0);
  return {
    requested: results.length,
    succeeded: ok.length,
    totalBytes,
    avgSeconds: ok.length ? totalSeconds / ok.length : 0,
    mbitPerSec: toMbit(totalBytes, totalSeconds),
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

  console.log(`Testing ${opts.url} with ${opts.count} sequential requests\n`);
  const results = await runSequential(opts.url, opts.count, opts.timeoutMs, (i, r) => {
    const n = `#${String(i).padStart(2)}`;
    if (r.ok) console.log(`${n}  ${toMB(r.bytes)} MB  ${r.seconds.toFixed(3)} s  ${toMbit(r.bytes, r.seconds).toFixed(2)} Mbit/s`);
    else console.log(`${n}  failed: ${r.error}`);
  });

  const s = summarize(results);
  if (s.succeeded === 0) {
    console.error('\nAll requests failed.');
    process.exit(1);
  }
  console.log(`
Successful requests: ${s.succeeded}/${s.requested}
Average request time: ${s.avgSeconds.toFixed(3)} s
Total downloaded:     ${toMB(s.totalBytes)} MB
Download speed:       ${s.mbitPerSec.toFixed(2)} Mbit/s (${(s.mbitPerSec / 8).toFixed(2)} MB/s)`);
  if (s.succeeded < s.requested) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { parseArgs, measureOnce, runSequential, summarize };
