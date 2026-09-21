import {validateAddress} from './address.js';

// These are category/name matchers, NOT assertions that an address belongs to a brand.
const EXCHANGE_NAMES = /^(?:mexc|kucoin|gate(?:\.io)?|coinex|binance|bybit|okx|okex|bitget|kraken|htx|huobi|upbit|bitmart|bingx|phemex|xt(?:\.com)?|lbank|bitfinex|poloniex)(?:$|[\s\-:#(])/i;
export function inferType(name) { return EXCHANGE_NAMES.test(name.trim()) ? 'exchange' : 'entity'; }

export class EntityRegistry {
  constructor() { this.records = new Map(); this.warnings = []; this.fetchedAt = null; }
  addRows(rows, {source = '', api = false} = {}) {
    if (!Array.isArray(rows)) throw new Error('Entity registry must be an array of records');
    let added = 0, skipped = 0;
    for (const item of rows) {
      try {
        const address = validateAddress(item.address);
        if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 160) throw new Error('Invalid label');
        const name = item.name.trim();
        const type = api ? inferType(name) : item.type;
        if (!['exchange', 'entity', 'pool'].includes(type)) throw new Error('Entity type must be exchange, entity or pool');
        if (!api && (typeof item.source !== 'string' || !item.source.trim())) throw new Error('Custom labels need a source');
        const terminal = type === 'exchange' && (api || item.enabled === true);
        const record = {address, name, type, terminal, source: api ? source : item.source,
          evidence: api ? 'public-registry' : terminal ? 'operator-supplied' : 'unverified-label',
          asOf: item.asOf ?? null};
        const existing = this.records.get(address);
        // Disabled legacy suggestions must not downgrade fresh registry classifications.
        if (!existing || terminal || !existing.terminal) { this.records.set(address, record); added++; }
      } catch { skipped++; }
    }
    if (skipped) this.warnings.push(`${skipped} invalid entity record(s) were ignored.`);
    return added;
  }
  get(address) { return address ? this.records.get(address) ?? null : null; }
  exchange(address) { const r = this.get(address); return r?.terminal ? r : null; }
  export() { return [...this.records.values()]; }
}

export async function loadRegistry(api, signal, customRows = []) {
  const registry = new EntityRegistry();
  try {
    const response = await fetch('./data/entities.json', {signal, cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json(); registry.addRows(data.entities ?? data);
  } catch (e) {
    if (signal?.aborted) throw e;
    registry.warnings.push('Local entity file could not be loaded.');
  }
  try {
    registry.addRows(await api.names(signal), {api: true, source: api.baseUrl + '/addresses/names'});
    registry.fetchedAt = new Date().toISOString();
  } catch (e) {
    if (signal?.aborted) throw e;
    registry.warnings.push('Live address registry unavailable. Unverified legacy labels will not terminate tracing.');
  }
  if (customRows.length) registry.addRows(customRows);
  return registry;
}
