import {parseLosslessJSON, sompi} from './amount.js';
import {DataError, normalizeTransaction, normalizeUTXOs, txId} from './model.js';

export const abortError = () => new DOMException('Operation stopped', 'AbortError');
export function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, Math.max(0, ms));
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); };
    signal?.addEventListener('abort', cancel, {once: true});
  });
}
export class ApiError extends Error {
  constructor(message, {status = 0, retryable = true, retryAfterMs = 0} = {}) {
    super(message); this.name = 'ApiError'; this.code = status ? `http-${status}` : 'network';
    this.status = status; this.retryable = retryable; this.retryAfterMs = retryAfterMs;
  }
}
export function retryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now || 0);
}
export function validateApiBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('API URL must be a complete HTTPS URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS API URL without credentials, query parameters or a fragment (localhost HTTP is allowed)');
  }
  return url.href.replace(/\/$/, '');
}

class Pool {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  acquire(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const entry = {signal, resolve, reject};
      entry.cancel = () => {
        const i = this.queue.indexOf(entry); if (i >= 0) this.queue.splice(i, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', entry.cancel, {once: true});
      this.queue.push(entry); this.drain();
    });
  }
  drain() {
    while (this.active < this.limit && this.queue.length) {
      const entry = this.queue.shift(); entry.signal?.removeEventListener('abort', entry.cancel);
      if (entry.signal?.aborted) { entry.reject(abortError()); continue; }
      this.active++;
      let released = false;
      entry.resolve(() => { if (!released) { released = true; this.active--; this.drain(); } });
    }
  }
}

export class KaspaApi {
  constructor({baseUrl = 'https://api.kaspa.org', fetchImpl = globalThis.fetch,
    concurrency = 3, minIntervalMs = 180, timeoutMs = 12000, retries = 3, cacheSize = 2500,
    random = Math.random, onMetrics = () => {}} = {}) {
    this.baseUrl = validateApiBase(baseUrl); this.fetch = fetchImpl; this.pool = new Pool(concurrency);
    this.minIntervalMs = minIntervalMs; this.timeoutMs = timeoutMs; this.retries = retries;
    this.cacheSize = cacheSize; this.random = random; this.onMetrics = onMetrics;
    this.nextStart = 0; this.cooldownUntil = 0; this.cache = new Map(); this.inFlight = new Map();
    this.batchSupported = true;
    this.metrics = {requests: 0, retries: 0, cacheHits: 0, failures: 0, active: 0, peakActive: 0};
  }
  emit() { try { this.onMetrics({...this.metrics}); } catch { /* UI must not interrupt accounting */ } }
  async json(path, {signal, method = 'GET', body} = {}) {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      let retryError;
      const release = await this.pool.acquire(signal);
      try {
        const start = Math.max(Date.now(), this.nextStart, this.cooldownUntil);
        this.nextStart = start + this.minIntervalMs;
        await delay(start - Date.now(), signal);
        while (Date.now() < this.cooldownUntil) await delay(this.cooldownUntil - Date.now(), signal);
        throwIfAborted(signal);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener('abort', cancel, {once: true});
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
        this.metrics.requests++; this.metrics.active++;
        this.metrics.peakActive = Math.max(this.metrics.peakActive, this.metrics.active); this.emit();
        try {
          const response = await this.fetch(this.baseUrl + path, {
            method, signal: controller.signal, credentials: 'omit', cache: 'no-store',
            headers: body ? {'Content-Type': 'application/json', Accept: 'application/json'} : {Accept: 'application/json'},
            ...(body ? {body: JSON.stringify(body)} : {})
          });
          if (!response.ok) {
            const wait = retryAfter(response.headers?.get('Retry-After'));
            if (response.status === 429 || wait) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + (wait || 1500));
            throw new ApiError(`API returned HTTP ${response.status}`, {status: response.status,
              retryable: [408, 425, 429].includes(response.status) || response.status >= 500, retryAfterMs: wait});
          }
          const text = await response.text();
          if (text.length > 32 * 1024 * 1024) throw new ApiError('API response exceeds browser safety budget', {retryable: false});
          let data;
          try { data = parseLosslessJSON(text); }
          catch { throw new ApiError('API returned invalid JSON', {retryable: false}); }
          throwIfAborted(signal);
          return data;
        } catch (error) {
          throwIfAborted(signal);
          retryError = error instanceof ApiError ? error : new ApiError(timedOut ? 'API request timed out' : 'Network or CORS error');
        } finally {
          clearTimeout(timer); signal?.removeEventListener('abort', cancel);
          this.metrics.active--; this.emit();
        }
      } finally { release(); }
      if (!retryError.retryable || attempt >= this.retries) {
        this.metrics.failures++; this.emit(); throw retryError;
      }
      this.metrics.retries++; this.emit();
      await delay(Math.max(retryError.retryAfterMs, 600 * 2 ** attempt + this.random() * 300), signal);
    }
  }
  remember(id, transaction) {
    this.cache.delete(id); this.cache.set(id, transaction);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
  }
  async transaction(id, signal) {
    throwIfAborted(signal); id = txId(id);
    if (this.cache.has(id)) {
      const tx = this.cache.get(id); this.remember(id, tx); this.metrics.cacheHits++; this.emit(); return tx;
    }
    if (this.inFlight.has(id)) { this.metrics.cacheHits++; this.emit(); return this.inFlight.get(id); }
    const work = this.json(`/transactions/${id}?inputs=true&outputs=true&resolve_previous_outpoints=light`, {signal})
      .then(data => { const tx = normalizeTransaction(data, id); this.remember(id, tx); return tx; });
    this.inFlight.set(id, work);
    try { return await work; }
    finally { if (this.inFlight.get(id) === work) this.inFlight.delete(id); }
  }
  /** One request can warm a whole frontier batch. Missing rows fall back to GET.
   * Failed batches are never cached as empty transactions or zero amounts.
   */
  async prefetchTransactions(ids, signal) {
    if (!this.batchSupported) return;
    const needed = [...new Set(ids)].filter(id => !this.cache.has(id) && !this.inFlight.has(id)).slice(0, 32);
    if (needed.length < 2) return;
    try {
      const rows = await this.json('/transactions/search?resolve_previous_outpoints=light', {
        method: 'POST', body: {transactionIds: needed}, signal
      });
      if (!Array.isArray(rows)) throw new DataError('Invalid transaction search result');
      for (const row of rows) {
        const id = row.transaction_id ?? row.transactionId;
        if (!needed.includes(id)) continue;
        try { this.remember(id, normalizeTransaction(row, id)); } catch { /* GET will report the precise error */ }
      }
    } catch (error) {
      throwIfAborted(signal);
      // Do not burn a retry budget on every batch when a proxy blocks POST/CORS.
      this.batchSupported = false;
    }
  }
  names(signal) { return this.json('/addresses/names', {signal}); }
  async snapshot(address, signal) {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(signal);
      const path = `/addresses/${encodeURIComponent(address)}`;
      const [raw, balanceData, countResult] = await Promise.all([
        this.json(`${path}/utxos`, {signal}),
        this.json(`${path}/balance`, {signal}),
        this.json(`${path}/utxos/count`, {signal}).then(data => ({data}), error => ({error}))
      ]);
      throwIfAborted(signal);
      const utxos = normalizeUTXOs(raw, address);
      const total = utxos.reduce((s, u) => s + u.value, 0n);
      const balance = sompi(balanceData?.balance, 'reported balance');
      let count = null;
      const warnings = [];
      if (countResult.data) {
        count = sompi(countResult.data.count, 'UTXO count');
      } else warnings.push('UTXO-count endpoint unavailable; snapshot cross-checked against balance only.');
      last = {utxos, total, balance, count};
      if (total === balance && (count === null || count === BigInt(utxos.length))) {
        return {address, utxos, total, reportedBalance: balance, count, capturedAt: new Date().toISOString(),
          apiBase: this.baseUrl, warnings,
          note: 'Amount/count cross-check, not an atomic block-pinned snapshot. Live activity, caching and reorganizations can change state.'};
      }
      if (!attempt) await delay(1400, signal);
    }
    throw new DataError(`Could not establish a consistent UTXO snapshot: ${last.utxos.length} outputs / ${last.total} sompi returned, ` +
      `${last.balance} sompi balance reported${last.count !== null ? ` / ${last.count} outputs expected` : ''}. ` +
      'The address may be active, the indexer may lag, or its UTXO limit may be exceeded. Retry later or use your own compatible API. No balance has been assumed.',
      'snapshot-mismatch', true);
  }
}
