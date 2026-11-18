#!/usr/bin/env node
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
  const opts = { url: null, count: DEFAULT_COUNT, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (a === '--count') opts.count = Number(argv[++i]);
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (!opts.url) opts.url = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.url) throw new Error('URL is required');
  let parsed;
  try { parsed = new URL(opts.url); } catch { throw new Error(`Invalid URL: ${opts.url}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http/https URLs are supported');
  if (!Number.isInteger(opts.count) || opts.count < 1) throw new Error('--count must be a positive integer');
  if (!(opts.timeoutMs > 0)) throw new Error('--timeout must be a positive number');
  return opts;
}

// One request: time from sending until the last body byte is received.
async function measureOnce(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = process.hrtime.bigint();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    let bytes = 0;
    // Stream the body chunk by chunk: counts real bytes and keeps memory flat for big files.
    for await (const chunk of res.body) bytes += chunk.length;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    return { bytes, seconds };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`timeout after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const fmtMB = (bytes) => (bytes / 1e6).toFixed(2);
const mbps = (bytes, seconds) => (bytes * 8) / 1e6 / seconds;

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`Error: ${err.message}\n`); usage(); process.exit(1); }

  console.log(`Testing ${opts.url} with ${opts.count} sequential requests\n`);
  const results = [];
  for (let i = 1; i <= opts.count; i++) {
    try {
      const r = await measureOnce(opts.url, opts.timeoutMs);
      results.push(r);
      console.log(`#${String(i).padStart(2)}  ${fmtMB(r.bytes)} MB  ${r.seconds.toFixed(3)} s  ${mbps(r.bytes, r.seconds).toFixed(2)} Mbit/s`);
    } catch (err) {
      console.log(`#${String(i).padStart(2)}  failed: ${err.cause?.message || err.message}`);
    }
  }

  if (results.length === 0) { console.error('\nAll requests failed.'); process.exit(1); }

  const totalBytes = results.reduce((s, r) => s + r.bytes, 0);
  const totalSeconds = results.reduce((s, r) => s + r.seconds, 0);
  const speed = mbps(totalBytes, totalSeconds);

  console.log(`
Successful requests: ${results.length}/${opts.count}
Average request time: ${(totalSeconds / results.length).toFixed(3)} s
Total downloaded:     ${fmtMB(totalBytes)} MB
Download speed:       ${speed.toFixed(2)} Mbit/s (${(speed / 8).toFixed(2)} MB/s)`);
  if (results.length < opts.count) process.exit(2);
}

main();
