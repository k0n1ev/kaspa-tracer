import {KaspaApi, delay} from './api.js';
import {encodeAddress} from './address.js';
import {EntityRegistry} from './entities.js';
import {COINBASE_SUBNETWORK} from './model.js';
import {SOMPI, stringify} from './amount.js';

export const DEMO_ADDRESS = encodeAddress(Array(32).fill(9));
const address = n => encodeAddress(Array(32).fill(n));
const id = n => n.toString(16).padStart(64, '0');
/** Synthetic 1,000 KAS snapshot: mining 20%, Demo exchange A 60%, B 20%.
 * No real wallet ownership is implied. Never send funds to these addresses.
 */
export function makeDemo({latency = 260} = {}) {
  const root = DEMO_ADDRESS, miner = address(10), exchangeA = address(11), exchangeB = address(12), middle = address(13);
  const out = (index, amount, owner) => ({index, amount: (BigInt(amount) * SOMPI).toString(), script_public_key_address: owner});
  const input = (n, index, amount, owner) => ({previous_outpoint_hash: id(n), previous_outpoint_index: index,
    previous_outpoint_amount: (BigInt(amount) * SOMPI).toString(), previous_outpoint_address: owner});
  const tx = (n, outputs, inputs, coinbase = false) => ({transaction_id: id(n), is_accepted: true,
    subnetwork_id: coinbase ? COINBASE_SUBNETWORK : '00'.repeat(20), outputs, inputs,
    block_time: Date.UTC(2026, 0, n)});
  const data = new Map([
    [id(1), tx(1, [out(0, 100, miner), out(1, 100, root)], null, true)],
    [id(2), tx(2, [out(0, 300, exchangeA), out(1, 300, exchangeA)], null, true)],
    [id(3), tx(3, [out(0, 200, exchangeB)], null, true)],
    [id(4), tx(4, [out(0, 400, middle)], [input(1, 0, 100, miner), input(2, 0, 300, exchangeA)])],
    [id(5), tx(5, [out(0, 600, root)], [input(4, 0, 400, middle), input(3, 0, 200, exchangeB)])],
    [id(6), tx(6, [out(0, 300, root)], [input(2, 1, 300, exchangeA)])]
  ]);
  const rawUTXOs = [[1, 1, 100, true], [5, 0, 600, false], [6, 0, 300, false]].map(([n, index, amount, coinbase]) => ({
    address: root, outpoint: {transactionId: id(n), index}, utxoEntry: {amount: (BigInt(amount) * SOMPI).toString(), isCoinbase: coinbase}
  }));
  const rows = [{address: exchangeA, name: 'Demo exchange A', type: 'exchange', enabled: true, source: 'Synthetic demo fixture'},
    {address: exchangeB, name: 'Demo exchange B', type: 'exchange', enabled: true, source: 'Synthetic demo fixture'}];
  const registry = new EntityRegistry(); registry.addRows(rows);
  const fetchImpl = async (url, options = {}) => {
    await delay(latency, options.signal);
    const parsed = new URL(url); let result;
    if (parsed.pathname.endsWith('/utxos/count')) result = {count: 3};
    else if (parsed.pathname.endsWith('/utxos')) result = rawUTXOs;
    else if (parsed.pathname.endsWith('/balance')) result = {balance: (1000n * SOMPI).toString()};
    else if (parsed.pathname === '/transactions/search') result = JSON.parse(options.body).transactionIds.map(k => data.get(k)).filter(Boolean);
    else if (parsed.pathname.startsWith('/transactions/')) result = data.get(parsed.pathname.split('/').pop());
    else if (parsed.pathname === '/addresses/names') result = rows;
    return new Response(stringify(result ?? {error: 'not found'}), {status: result ? 200 : 404, headers: {'Content-Type': 'application/json'}});
  };
  const api = new KaspaApi({baseUrl: 'https://demo.invalid', fetchImpl, minIntervalMs: 0});
  return {api, registry, address: root};
}
