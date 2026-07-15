# Stress Test Performance Report

**Test run:** `20260716_0044`  
**Scenario:** 5,000 concurrent users · 100-item stock · Local machine  
**Duration:** ~549 ms (burst test)  
**Date:** 2026-07-16

---

## 1. Latency Breakdown (`http_req_duration`)

> `http_req_duration` = full round-trip from first byte sent to last byte received.  
> p99 is not captured in summary stats; the threshold asserts `p(99) < 2,000 ms` and **passed**. Given max = 473 ms, p99 is bounded between ~363 ms (p95) and 473 ms (max).

| Percentile | Latency     | What it means for a buyer                                          |
|------------|-------------|---------------------------------------------------------------------|
| **Min**    | 10.25 ms    | Fastest possible path — likely a locally-cached, uncontested slot  |
| **p50**    | 18.33 ms    | The typical buyer experience: very fast under normal concurrency   |
| **p90**    | 40.28 ms    | 90% of buyers were served in under 40 ms — still excellent         |
| **p95**    | 363.20 ms   | ⚠️ The worst 5% (~251 requests) waited ~9× longer than p90         |
| **p99**    | ≤ 473 ms    | Bounded by the observed max; threshold `p(99)<2000` passed ✅      |
| **Max**    | 473.03 ms   | Longest single request under the full 5 k-VU burst                |
| **Avg**    | 42.95 ms    | Mean pulled upward by the p95+ tail; median is more representative |

### What this means for buyers

The **median latency of 18 ms** is excellent — the atomic Lua script + Redis path is fast. The sharp cliff between **p90 (40 ms) → p95 (363 ms)** is the most important signal: under the extreme burst of 5,000 simultaneous arrivals, Node.js's single-threaded event loop queued up for a small fraction of requests. A secondary contributor is the TCP handshake burst at t=0 (see §2 below) — the same VUs that paid connection-establishment cost also hit a more loaded event loop. In a real flash sale this translates to ~1-in-20 buyers seeing a "slow" response, but still within a sub-500 ms threshold. No buyer was dropped or errored.

---

## 2. Bottleneck Analysis

k6 decomposes `http_req_duration` into three phases. Here is where time is actually spent:

| Phase                         | Avg (ms) | % of Req Duration | Notes                              |
|-------------------------------|----------|--------------------|-------------------------------------|
| **`http_req_waiting`** (TTFB) | 42.58    | **99.1 %**         | Server processing time (event loop) |
| `http_req_sending`            | 0.34     | 0.8 %              | Writing request bytes to socket     |
| `http_req_receiving`          | 0.02     | 0.05 %             | Reading response bytes off socket   |

Additional overhead **outside** `http_req_duration` (part of `iteration_duration`):

| Phase                   | Avg (ms) | p95 (ms) | Notes                                    |
|-------------------------|----------|----------|-------------------------------------------|
| `http_req_blocked`      | 2.31     | 20.41    | Waiting for a free TCP connection slot    |
| `http_req_connecting`   | 2.26     | 20.37    | TCP handshake to localhost                |
| `http_req_tls_handshaking` | 0.00  | 0.00     | No TLS (HTTP on loopback)                |

### Verdict: CPU / Application Processing Bottleneck

**99.1% of request time is server-side waiting (TTFB).** Networking is negligible — TCP handshake to localhost averages 2.26 ms and TLS is zero. The primary bottleneck is the Node.js event loop under 5,000 concurrent arrivals.

The `http_req_blocked` p95 of 20.41 ms is a **TCP connection-establishment cost**, not pool-slot starvation. Note that `http_req_blocked` avg (2.31 ms) ≈ `http_req_connecting` avg (2.26 ms) and p95 values are also nearly identical (20.41 ms vs 20.37 ms). In k6, `http_req_blocked` equals `http_req_connecting` when almost every blocked event is a *new* TCP handshake. When 5,000 VUs burst simultaneously, many establish fresh connections at t=0; once keep-alive is in place the cost does not recur. This is a burst startup artefact and has no causal relationship to the API's Redis connection.

In a cloud/staging environment with a dedicated Redis instance and real network latency, TTFB will increase as Redis round-trips add wire time; the p90→p95 cliff may widen further. This local result sets a baseline, not a ceiling.

---

## 3. Throughput & Success Rate

| Metric                        | Value            |
|-------------------------------|------------------|
| **Total requests**            | 5,020            |
| **Requests per second (RPS)** | **9,142 req/s**  |
| **HTTP error rate**           | **0 %** ✅       |
| **Unexpected status codes**   | **0 %** ✅       |
| **Test duration**             | ~549 ms (burst)  |

> Note: 9,142 RPS reflects a short burst (all 5,000 VUs fired within ~549 ms), not a sustained throughput figure. Sustained RPS under constant load will differ.

### Business Logic Validation

| Outcome                              | Count | Expected  | Pass? |
|--------------------------------------|-------|-----------|-------|
| `202 Created` — stock sold           | 100   | = 100     | ✅    |
| `409 Rejected` — over-limit / dupe  | 4,901 | remainder | ✅    |
| `200 Already ordered` — idempotent  | 19    | ≥ 0       | ✅    |
| `spam_wins_202` — spammer bypassed  | 1     | ≤ 1       | ✅ ⚠️ |
| **Total**                            | **5,020** | 5,020 | ✅    |

Exactly **100 orders were created** — matching stock precisely. No inventory leak, no oversell. The `spam_wins_202` counter hit exactly 1 (the threshold boundary); worth watching if VU count or request rate is raised further.

### k6 Threshold Summary

| Threshold                    | Result   |
|------------------------------|----------|
| `http_req_failed rate == 0`  | ✅ PASS  |
| `p(95) < 500 ms`             | ✅ PASS (363 ms) |
| `p(99) < 2,000 ms`           | ✅ PASS  |
| `spam_wins_202 count <= 1`   | ✅ PASS (borderline) |
| `unexpected_status rate == 0`| ✅ PASS  |

---

## 4. Key Metrics Summary

| Metric                  | Value          |
|-------------------------|----------------|
| VUs                     | 5,000          |
| Stock items             | 100            |
| Total requests          | 5,020          |
| RPS (burst)             | 9,142 req/s    |
| HTTP error rate         | 0 %            |
| Latency — min           | 10.25 ms       |
| Latency — p50 (median)  | 18.33 ms       |
| Latency — p90           | 40.28 ms       |
| Latency — p95           | 363.20 ms      |
| Latency — p99           | < 473 ms       |
| Latency — max           | 473.03 ms      |
| Latency — avg           | 42.95 ms       |
| Primary bottleneck      | TTFB / Node.js event loop (99.1 % of req time) |
| Orders created          | 100 / 100 ✅   |
| Oversell incidents      | 0 ✅           |
| All thresholds passed   | ✅             |

---

## 5. Local Test Verdict

### 🟢 GREEN — Ready for Staging / Cloud Testing

All five k6 thresholds passed. Inventory control is exact (100/100, no oversell). Zero HTTP errors across 5,020 requests. The service handled a 5,000-VU burst correctly and cleanly.

**Three things to watch in staging:**

1. **p90→p95 cliff** — The jump from 40 ms to 363 ms is steep. Under sustained (not burst) load in staging, measure whether this flattens or worsens. If it worsens, investigate Node.js event loop lag and Redis round-trip times under real network conditions.

2. **`spam_wins_202 = 1`** — The anti-spam check passed at its exact boundary. Increase VU count or request rate to confirm the guard holds under heavier attack profiles.

3. **k6 connection-establishment cost** — `http_req_blocked` p95 of 20.41 ms is a TCP handshake burst: all 5,000 VUs connect simultaneously at t=0, and `http_req_blocked ≈ http_req_connecting` confirms these are new connections, not pool-slot waits. This is a one-time startup cost with no effect on sustained throughput. In cloud tests, adding a short k6 ramp-up stage before the main burst will spread connection establishment over time and flatten this tail without any server-side change.
