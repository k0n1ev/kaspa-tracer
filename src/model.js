import {sompi} from './amount.js';
export const COINBASE_SUBNETWORK = '01' + '00'.repeat(19);
export class DataError extends Error {
  constructor(message, code = 'invalid-data', retryable = false) {
    super(message); this.name = 'DataError'; this.code = code; this.retryable = retryable;
  }
}
export function txId(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) throw new DataError('Missing or invalid transaction ID');
  return value.toLowerCase();
}
export function indexOf(value) {
  if (value === null || value === undefined || value === '' || !/^\d+$/.test(String(value))) throw new DataError('Missing output index');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 4294967295) throw new DataError('Invalid output index');
  return n;
}
export const keyOf = (id, index) => `${txId(id)}:${indexOf(index)}`;
const bool = v => v === true || v === 'true';
const addressOf = o => o.script_public_key_address ?? o.scriptPublicKeyAddress ?? o.verboseData?.scriptPublicKeyAddress ?? null;

export function normalizeOutput(o, fallbackIndex) {
  if (!o || typeof o !== 'object') throw new DataError('Missing transaction output');
  return {index: indexOf(o.index ?? fallbackIndex), value: sompi(o.amount, 'output amount'), address: addressOf(o)};
}
export function normalizeTransaction(data, expectedId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new DataError('Invalid transaction response');
  const id = txId(data.transaction_id ?? data.transactionId ?? data.verboseData?.transactionId);
  if (id !== txId(expectedId)) throw new DataError('API returned a different transaction ID');
  if (data.is_accepted === false || data.isAccepted === false) throw new DataError('Transaction is not accepted by the indexer', 'not-accepted', true);
  if (!Array.isArray(data.outputs) || !data.outputs.length) throw new DataError('Transaction outputs are missing', 'missing-outputs', true);
  const outputs = data.outputs.map(normalizeOutput);
  if (new Set(outputs.map(o => o.index)).size !== outputs.length) throw new DataError('Duplicate transaction output index');
  const subnet = data.subnetwork_id ?? data.subnetworkId;
  const coinbase = typeof subnet === 'string' && subnet.toLowerCase() === COINBASE_SUBNETWORK;
  // The API represents coinbase inputs as null. Empty/missing inputs alone do NOT prove mining.
  if (!coinbase && (!Array.isArray(data.inputs) || !data.inputs.length)) {
    throw new DataError('Inputs missing and no coinbase subnetwork evidence', 'missing-inputs', true);
  }
  if (coinbase && Array.isArray(data.inputs) && data.inputs.length) throw new DataError('Coinbase transaction unexpectedly has inputs');
  const inputs = (data.inputs ?? []).map(i => {
    const resolved = i.previous_outpoint_resolved ?? i.previousOutpointResolved;
    const prev = i.previousOutpoint ?? i.previous_outpoint;
    const hash = txId(i.previous_outpoint_hash ?? i.previousOutpointHash ?? prev?.transactionId ?? resolved?.transaction_id);
    const index = indexOf(i.previous_outpoint_index ?? i.previousOutpointIndex ?? prev?.index ?? resolved?.index);
    const value = i.previous_outpoint_amount ?? i.previousOutpointAmount ?? resolved?.amount;
    return {txid: hash, index, key: keyOf(hash, index),
      value: value === undefined || value === null ? null : sompi(value, 'previous output amount'),
      address: i.previous_outpoint_address ?? i.previousOutpointAddress ?? (resolved ? addressOf(resolved) : null)};
  });
  if (new Set(inputs.map(i => i.key)).size !== inputs.length) throw new DataError('Duplicate input outpoint');
  const time = Number(data.accepting_block_time ?? data.block_time ?? data.verboseData?.blockTime ?? 0);
  return {id, coinbase, inputs, outputs, time: Number.isFinite(time) && time > 0 ? time : null,
    accepted: data.is_accepted ?? data.isAccepted ?? null};
}
export function findOutput(tx, index) {
  const result = tx.outputs.find(o => o.index === index);
  if (!result) throw new DataError(`Referenced output ${index} is missing`, 'missing-output', true);
  return result;
}
export function normalizeUTXOs(data, address) {
  if (!Array.isArray(data)) throw new DataError('UTXO API did not return a list');
  const unique = new Map();
  for (const row of data) {
    if (row.address && row.address !== address) throw new DataError('UTXO belongs to a different address');
    const out = row.outpoint ?? row.outPoint;
    const entry = row.utxoEntry ?? row.utxo_entry;
    if (!out || !entry) throw new DataError('Incomplete UTXO data');
    const id = txId(out.transactionId ?? out.transaction_id), index = indexOf(out.index);
    const key = keyOf(id, index), value = sompi(entry.amount, 'UTXO amount');
    const item = {key, txid: id, index, value, address, coinbase: bool(entry.isCoinbase ?? entry.is_coinbase)};
    const previous = unique.get(key);
    if (previous && (previous.value !== value || previous.coinbase !== item.coinbase)) throw new DataError('Conflicting duplicate UTXOs');
    unique.set(key, item);
  }
  return [...unique.values()];
}
