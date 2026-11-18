# speedtest

A console script that measures download speed. It sends 10 requests **one after another** to the address you give, waits for each response body to arrive in full, and then prints the average request time, the total amount downloaded and the download speed.

Node.js 18+ is required. There are no dependencies, because it uses the built-in `fetch`.

## Run

```bash
git clone https://github.com/Javokhiir/speedtest.git
cd speedtest
node speedtest.js https://proof.ovh.net/files/10Mb.dat
```

Options:

| Flag | Default | Meaning |
|------|---------|---------|
| `--count N` | 10 | number of sequential requests |
| `--timeout SEC` | 60 | timeout for each request, in seconds |

```bash
node speedtest.js https://proof.ovh.net/files/10Mb.dat --count 3
```

## Example output

```
Testing https://proof.ovh.net/files/10Mb.dat with 3 sequential requests

# 1  10.49 MB  14.378 s  5.83 Mbit/s
# 2  10.49 MB  12.112 s  6.93 Mbit/s
# 3  10.49 MB  12.645 s  6.63 Mbit/s

Successful requests: 3/3
Average request time: 13.045 s
Total downloaded:     31.46 MB
Download speed:       6.43 Mbit/s (0.80 MB/s)
```

## Units

- **Request time** is in seconds. It runs from sending the request until the last byte of the body is received, so the time to first byte is included.
- **Volume** is in megabytes, where **1 MB = 1,000,000 bytes** (decimal, as providers count it).
- **Speed** is in **megabits per second (Mbit/s)**, the unit internet plans use: `total bytes × 8 / 1,000,000 / total time of all requests`. The value in MB/s is shown in brackets.

Speed is computed from the totals, not as an average of the per-request speeds, so slow and fast requests are weighted by their real size.

## How it works

- The requests run sequentially in a `for` loop with `await`, so the next one starts only after the previous one has finished.
- The body is read as a stream, chunk by chunk. Bytes are counted as they arrive and the file is not held in memory, so even large files work.
- `Accept-Encoding: identity` and `Cache-Control: no-cache` are sent so that the measurement uses the real bytes rather than a gzip-compressed or cached copy.
- A failed request (a timeout or an HTTP error) is reported in the log and left out of the totals. If any request failed, the exit code is `2`. If all of them failed, it is `1`.
