import {apportion, sompi, percent, stringify} from './amount.js';
import {DataError, findOutput, keyOf} from './model.js';
import {Frontier} from './frontier.js';
import {EntityRegistry} from './entities.js';
import {throwIfAborted, delay} from './api.js';

export const VERSION = '2.0.0';
export const DEFAULTS = Object.freeze({idleMs: 90_000, batchSize: 16, maxNodes: 50_000, maxEdges: 150_000, maxSteps: 200_000});

/** Output-level, iterative flow traversal. No wallet recursion or address cycles.
 * Accounting invariant at every externally visible update:
 * target = mining + exchanges + queued + in-flight + blocked.
 * All allocations are modeled proportions, not coin-identity claims.
 */
export class TraceSession {
  constructor({api, snapshot, registry = new EntityRegistry(), onUpdate = () => {}, now = Date.now, ...options}) {
    if (!api || !snapshot || !Array.isArray(snapshot.utxos)) throw new Error('A checked UTXO snapshot is required');
    this.api = api; this.snapshot = snapshot; this.registry = registry; this.onUpdate = onUpdate; this.now = now;
    this.options = {...DEFAULTS, ...options};
    for (const k of Object.keys(DEFAULTS)) if (!Number.isSafeInteger(this.options[k]) || this.options[k] < 1) throw new Error(`Invalid ${k}`);
    this.total = sompi(snapshot.total); this.frontier = new Frontier(); this.nodes = new Map(); this.txFlows = new Map();
    this.endpoints = new Map(); this.plans = new Map(); this.planFlights = new Map(); this.planEdges = 0; this.rootEdges = []; this.warnings = [...(snapshot.warnings ?? []), ...registry.warnings];
    this.totals = {mining: 0n, exchange: 0n, queued: 0n, active: 0n, blocked: 0n};
    this.stats = {steps: 0, nodes: 0, edges: 0, maxDepth: 0, oldestTime: null};
    this.state = 'ready'; this.reason = null; this.running = false; this.controller = null;
    this.createdAt = new Date().toISOString(); this.elapsedMs = 0; this.segmentStart = 0;
    this.lastDiscovery = this.now(); this.lastMarkedResolved = 0n;
    const keys = new Set(snapshot.utxos.map(u => u.key));
    if (keys.size !== snapshot.utxos.length) throw new Error('Snapshot contains duplicate outpoints');
    if (snapshot.utxos.length > this.options.maxNodes) throw new Error('Snapshot exceeds the browser node budget');
    if (snapshot.utxos.reduce((s, u) => s + sompi(u.value), 0n) !== this.total) throw new Error('Snapshot total does not match UTXOs');
    for (const u of snapshot.utxos) {
      const node = this.createNode(u, 0); this.addFlow(node, u.value);
      this.rootEdges.push({key: node.key, amount: u.value});
    }
    this.assertConservation();
  }
  createNode(meta, depth) {
    const key = keyOf(meta.txid, meta.index);
    if (meta.key && meta.key !== key) throw new DataError('Mismatched outpoint key');
    const node = {key, txid: meta.txid, index: meta.index, value: meta.value, address: meta.address ?? null,
      coinbaseHint: meta.coinbase === true, depth, order: this.nodes.size,
      through: 0n, pending: 0n, blocked: 0n, active: 0n, busy: false,
      recipe: null, edges: new Map(), error: null};
    this.nodes.set(key, node); this.stats.nodes = this.nodes.size;
    this.stats.maxDepth = Math.max(this.stats.maxDepth, depth);
    return node;
  }
  addFlow(node, amount) {
    if (amount <= 0n) return;
    node.through += amount;
    if (node.error) { node.blocked += amount; this.totals.blocked += amount; }
    else { node.pending += amount; this.totals.queued += amount; this.frontier.set(node); }
  }
  assertConservation() {
    const {mining, exchange, queued, active, blocked} = this.totals;
    if ([mining, exchange, queued, active, blocked].some(x => x < 0n) || mining + exchange + queued + active + blocked !== this.total) {
      throw new Error('Internal accounting invariant failed; do not use this result');
    }
  }
  emit() {
    this.assertConservation();
    try { this.onUpdate(this.summary()); } catch (error) { console.error('Render callback failed', error); }
  }
  summary() {
    const resolved = this.totals.mining + this.totals.exchange;
    return {version: VERSION, address: this.snapshot.address, state: this.state, reason: this.reason,
      total: this.total, resolved, coverage: percent(resolved, this.total), totals: {...this.totals},
      unresolved: this.total - resolved, stats: {...this.stats}, api: {...this.api.metrics},
      frontier: this.frontier.size, noDiscoveryMs: this.now() - this.lastDiscovery,
      elapsedMs: this.elapsedMs + (this.running ? this.now() - this.segmentStart : 0),
      capturedAt: this.snapshot.capturedAt, warnings: this.warnings,
      endpointCount: this.endpoints.size};
  }
  stop(reason = 'user') {
    if (!this.running) return;
    if (!this.controller.signal.aborted) {
      this.reason = reason; this.state = 'stopping'; this.controller.abort(); this.emit();
    }
  }
  async run() {
    if (this.running) throw new Error('This trace is already running');
    if (this.state === 'complete') return this.summary();
    if (this.reason === 'resource') throw new Error('Browser safety budget reached; export the partial result and use a larger-capacity implementation');
    this.controller = new AbortController(); const signal = this.controller.signal;
    // Retry failures on explicit continuation only. Keep successful expansions and all resolved flow.
    if (this.totals.blocked > 0n) {
      this.api.cache?.clear();
      for (const node of this.nodes.values()) {
        if (!node.blocked) continue;
        this.totals.blocked -= node.blocked; this.totals.queued += node.blocked;
        node.pending += node.blocked; node.blocked = 0n; node.error = null;
        this.frontier.set(node);
      }
    }
    this.running = true; this.state = 'running'; this.reason = null;
    this.segmentStart = this.now(); this.lastDiscovery = this.now();
    this.lastMarkedResolved = this.totals.mining + this.totals.exchange;
    const timer = setInterval(() => {
      if (this.running && !signal.aborted && this.now() - this.lastDiscovery >= this.options.idleMs) this.stop('no-discovery');
      this.emit();
    }, Math.min(250, this.options.idleMs));
    this.emit();
    try {
      while (this.frontier.size && !signal.aborted) {
        if (this.stats.steps >= this.options.maxSteps) { this.stop('resource'); break; }
        const batch = [];
        while (this.frontier.size && batch.length < Math.min(this.options.batchSize, this.options.maxSteps - this.stats.steps)) {
          const node = this.frontier.pop(), amount = node.pending;
          node.pending = 0n; node.active = amount; node.busy = true;
          this.totals.queued -= amount; this.totals.active += amount;
          this.stats.steps++; batch.push({node, amount});
        }
        const needed = batch.filter(({node}) => !node.recipe && !node.coinbaseHint && !this.registry.exchange(node.address))
          .map(({node}) => node.txid);
        try { await this.api.prefetchTransactions?.(needed, signal); } catch { /* stop/error is handled per work item */ }
        await Promise.all(batch.map(work => this.execute(work, signal)));
        this.emit();
        // Yield even on cached one-input chains so Stop and the watchdog can run.
        await delay(0);
      }
      if (signal.aborted) this.state = 'paused';
      else if (this.totals.blocked > 0n) { this.state = 'partial'; this.reason = 'data-unavailable'; }
      else { this.state = 'complete'; this.reason = this.total === 0n ? 'empty' : 'all-endpoints'; }
    } catch (error) {
      this.state = 'error'; this.reason = 'internal-error'; throw error;
    } finally {
      clearInterval(timer); this.elapsedMs += this.now() - this.segmentStart; this.running = false; this.emit();
    }
    return this.summary();
  }
  async prepare(node, signal) {
    if (node.recipe) return node.recipe;
    if (node.coinbaseHint) return {kind: 'mining', address: node.address, value: node.value, evidence: 'UTXO isCoinbase=true', time: null};
    const exchange = this.registry.exchange(node.address);
    if (exchange) return {kind: 'exchange', address: node.address, value: node.value, entity: exchange, time: null};
    const tx = await this.api.transaction(node.txid, signal);
    throwIfAborted(signal);
    const output = findOutput(tx, node.index);
    if (node.value !== null && node.value !== undefined && output.value !== node.value) throw new DataError('Referenced output amount disagrees with transaction');
    if (node.address && output.address && node.address !== output.address) throw new DataError('Referenced output address disagrees with transaction');
    const address = output.address ?? node.address;
    if (tx.coinbase) return {kind: 'mining', address, value: output.value, evidence: 'Coinbase subnetwork ID', time: tx.time};
    const label = this.registry.exchange(address);
    if (label) return {kind: 'exchange', address, value: output.value, entity: label, time: tx.time};
    const plan = await this.transactionPlan(tx, signal);
    return {kind: 'split', address, value: output.value, ...plan};
  }
  async transactionPlan(tx, signal) {
    if (this.plans.has(tx.id)) return this.plans.get(tx.id);
    if (this.planFlights.has(tx.id)) return this.planFlights.get(tx.id);
    const work = (async () => {
      const parents = tx.inputs.map(i => ({...i})).sort((a, b) => a.key.localeCompare(b.key));
      const missing = parents.filter(p => p.value === null);
      // No equal splitting or renormalizing around unknown-valued inputs.
      for (let i = 0; i < missing.length; i += 3) {
        await Promise.all(missing.slice(i, i + 3).map(async parent => {
          try {
            const prior = await this.api.transaction(parent.txid, signal);
            const out = findOutput(prior, parent.index);
            parent.value = out.value; parent.address = out.address ?? parent.address;
          } catch (error) {
            throwIfAborted(signal);
            throw new DataError(`Cannot obtain a required input amount: ${error.message}`, 'missing-input-value', true);
          }
        }));
      }
      throwIfAborted(signal);
      const inputTotal = parents.reduce((s, p) => s + p.value, 0n);
      const outputTotal = tx.outputs.reduce((s, o) => s + o.value, 0n);
      if (inputTotal < outputTotal || inputTotal === 0n) throw new DataError('Transaction input/output amounts do not reconcile');
      if (tx.accepted === null && !this.warnings.includes('Some transactions lack acceptance metadata; indexed outpoint references are being trusted.')) {
        this.warnings.push('Some transactions lack acceptance metadata; indexed outpoint references are being trusted.');
      }
      // Shared by every output of this transaction; do not clone fan-in arrays
      // for each sibling output. Count all plan edges, including zero allocations.
      if (this.planEdges + parents.length > this.options.maxEdges) {
        throw new DataError('Transaction-plan safety budget reached', 'resource');
      }
      const plan = {txid: tx.id, parents, outputTotal, inputTotal, fee: inputTotal - outputTotal, time: tx.time};
      this.plans.set(tx.id, plan); this.planEdges += parents.length; return plan;
    })();
    this.planFlights.set(tx.id, work);
    try { return await work; }
    finally { if (this.planFlights.get(tx.id) === work) this.planFlights.delete(tx.id); }
  }

  reaches(start, target) {
    const seen = new Set(), stack = [start];
    while (stack.length) {
      const key = stack.pop(); if (key === target) return true;
      if (seen.has(key)) continue; seen.add(key);
      const recipe = this.nodes.get(key)?.recipe;
      if (recipe?.kind === 'split') for (const parent of recipe.parents) stack.push(parent.key);
    }
    return false;
  }
  validateMeta(meta, existing, extra = 0n) {
    if (existing) {
      if (existing.value !== null && existing.value !== meta.value) throw new DataError('Inconsistent values for a shared outpoint');
      if (existing.address && meta.address && existing.address !== meta.address) throw new DataError('Inconsistent addresses for a shared outpoint');
    }
    if ((existing?.through ?? 0n) + extra > meta.value) throw new DataError('Attributed flow exceeds this output; index data may be inconsistent');
  }
  commit(node, amount, recipe) {
    if (node.through > recipe.value) throw new DataError('Attributed amount exceeds referenced output');
    let deltas = null, cumulative = null, nextShares = null, flow = null;
    if (recipe.kind === 'split') {
      flow = this.txFlows.get(node.txid);
      if (flow && flow.keys.join(',') !== recipe.parents.map(p => p.key).join(',')) throw new DataError('Inconsistent transaction inputs');
      cumulative = (flow?.total ?? 0n) + amount;
      if (cumulative > recipe.outputTotal) throw new DataError('Overlapping or inconsistent snapshot ancestry');
      nextShares = apportion(cumulative, recipe.parents.map(p => p.value));
      deltas = nextShares.map((v, i) => v - (flow?.shares[i] ?? 0n));
      if (deltas.some(v => v < 0n) || deltas.reduce((s, v) => s + v, 0n) !== amount) throw new Error('Invalid cumulative apportionment');
      let newNodes = 0, newEdges = 0;
      for (let i = 0; i < recipe.parents.length; i++) {
        const p = recipe.parents[i], existing = this.nodes.get(p.key);
        // Even a zero-contribution edge can prove malformed cyclic data.
        if (this.reaches(p.key, node.key)) throw new DataError('Invalid cyclic transaction-outpoint data (not a wallet-address loop)', 'invalid-cycle');
        if (!existing && deltas[i] > 0n) newNodes++;
        if (!node.edges.has(p.key) && deltas[i] > 0n) newEdges++;
        this.validateMeta(p, existing, deltas[i]);
      }
      if (this.nodes.size + newNodes > this.options.maxNodes || this.stats.edges + newEdges > this.options.maxEdges) {
        throw new DataError('Browser graph safety budget reached; no remaining flow was discarded', 'resource');
      }
    }
    // No awaits after validation: one atomic accounting commit.
    node.recipe = recipe; node.value = recipe.value; node.address = recipe.address;
    if (recipe.time && (!this.stats.oldestTime || recipe.time < this.stats.oldestTime)) this.stats.oldestTime = recipe.time;
    this.totals.active -= amount; node.active = 0n;
    if (recipe.kind !== 'split') this.credit(node, amount, recipe);
    else {
      this.txFlows.set(node.txid, {total: cumulative, shares: nextShares, keys: recipe.parents.map(p => p.key)});
      for (let i = 0; i < recipe.parents.length; i++) {
        if (deltas[i] <= 0n) continue;
        const p = recipe.parents[i];
        let parent = this.nodes.get(p.key);
        if (!parent) parent = this.createNode(p, node.depth + 1);
        else {
          parent.depth = Math.max(parent.depth, node.depth + 1);
          if (!parent.address && p.address) parent.address = p.address;
          this.stats.maxDepth = Math.max(this.stats.maxDepth, parent.depth);
        }
        if (!node.edges.has(p.key)) this.stats.edges++;
        node.edges.set(p.key, (node.edges.get(p.key) ?? 0n) + deltas[i]);
        this.addFlow(parent, deltas[i]);
      }
    }
  }
  credit(node, amount, recipe) {
    const type = recipe.kind;
    const key = type === 'exchange' ? `exchange:${recipe.entity.name}` : `mining:${recipe.address ?? 'non-address-script'}`;
    let entry = this.endpoints.get(key);
    const fresh = !entry;
    if (!entry) {
      const label = this.registry.get(recipe.address);
      entry = {key, type, name: type === 'exchange' ? recipe.entity.name : label ? `Mining rewards · ${label.name}` : 'Mining rewards',
        amount: 0n, addresses: new Set(), examples: new Set(), sources: new Set()};
      this.endpoints.set(key, entry);
    }
    entry.amount += amount;
    if (recipe.address) entry.addresses.add(recipe.address);
    if (entry.examples.size < 5) entry.examples.add(node.key);
    entry.sources.add(type === 'exchange' ? `${recipe.entity.evidence}: ${recipe.entity.source}` : recipe.evidence);
    this.totals[type] += amount;
    const resolved = this.totals.mining + this.totals.exchange;
    const threshold = this.total > 0n ? (this.total + 9_999n) / 10_000n : 1n;
    if (fresh || resolved - this.lastMarkedResolved >= threshold) {
      this.lastDiscovery = this.now(); this.lastMarkedResolved = resolved;
    }
  }
  async execute({node, amount}, signal) {
    try {
      throwIfAborted(signal);
      const recipe = await this.prepare(node, signal);
      throwIfAborted(signal); this.commit(node, amount, recipe);
    } catch (error) {
      if (error.code === 'resource') this.stop('resource');
      if (signal.aborted || error.name === 'AbortError') {
        this.totals.active -= amount; this.totals.queued += amount;
        node.active = 0n; node.pending += amount;
      } else {
        this.totals.active -= amount; node.active = 0n;
        node.error = {code: error.code ?? 'invalid-data', message: error.message, retryable: error.retryable ?? false};
        node.blocked += amount + node.pending; this.totals.blocked += amount + node.pending;
        this.totals.queued -= node.pending; node.pending = 0n;
      }
    } finally { node.busy = false; this.frontier.set(node); }
  }
  endpointRows() {
    return [...this.endpoints.values()].map(e => ({...e, addresses: [...e.addresses], examples: [...e.examples], sources: [...e.sources]}))
      .sort((a, b) => a.amount === b.amount ? a.name.localeCompare(b.name) : a.amount > b.amount ? -1 : 1);
  }
  blockedRows() {
    return [...this.nodes.values()].filter(n => n.blocked > 0n)
      .sort((a, b) => a.blocked === b.blocked ? a.key.localeCompare(b.key) : a.blocked > b.blocked ? -1 : 1);
  }
  report() {
    return {schema: 'kaspa-origin-tracer/report-v2', version: VERSION, exportedAt: new Date().toISOString(),
      method: 'Current UTXO ancestry; proportional input-value attribution with cumulative monotone integer apportionment; stop at registry/operator-labeled exchanges or coinbase evidence.',
      interpretation: 'Exact accounting in integer sompi; source shares are a model, not unique coin ownership. Exchange labels are not cryptographic identity proof. Coinbase endpoints include rewards/fees. Unknown flow is not inferred to be mining.',
      summary: this.summary(), snapshot: this.snapshot, settings: this.options, endpoints: this.endpointRows(),
      labels: this.registry.export(), registryFetchedAt: this.registry.fetchedAt, root: this.rootEdges,
      transactionPlans: [...this.plans.values()],
      nodes: [...this.nodes.values()].map(n => ({key: n.key, txid: n.txid, index: n.index, address: n.address,
        outputValue: n.value, attributedThrough: n.through, pending: n.pending, active: n.active, blocked: n.blocked,
        depth: n.depth, recipe: n.recipe?.kind === 'split' ? {kind: 'split', transactionPlan: n.txid, address: n.address, value: n.value} : n.recipe, error: n.error, edges: [...n.edges].map(([key, amount]) => ({key, amount}))}))};
  }
  reportJSON() { return stringify(this.report()); }
}
