// Kaspa's 40-bit address checksum, not Bitcoin's 30-bit bech32 checksum.
// Specification reference: rusty-kaspa/crypto/addresses/src/bech32.rs.
const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
function polymod(values) {
  let c = 1n;
  for (const v of values) {
    const high = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(v);
    for (let j = 0; j < 5; j++) if ((high >> BigInt(j)) & 1n) c ^= GENERATORS[j];
  }
  return c ^ 1n;
}
function convert(values, from, to, pad) {
  let bits = 0, acc = 0;
  const out = [], mask = (1 << to) - 1;
  for (const value of values) {
    acc = ((acc << from) | value) & ((1 << (from + to - 1)) - 1);
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & mask); }
  }
  if (pad && bits) out.push((acc << (to - bits)) & mask);
  if (!pad && (bits >= from || ((acc << (to - bits)) & mask))) throw new Error('Invalid address padding');
  return out;
}
export function validateAddress(input) {
  if (typeof input !== 'string') throw new Error('Enter a Kaspa mainnet address');
  const text = input.trim();
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) throw new Error('Mixed-case address');
  const address = text.toLowerCase();
  const [prefix, encoded, extra] = address.split(':');
  if (prefix !== 'kaspa' || !encoded || extra !== undefined || encoded.length > 120) {
    throw new Error('Enter a complete kaspa: mainnet address (not a seed phrase)');
  }
  const values = [...encoded].map(c => ALPHABET.indexOf(c));
  if (values.some(v => v < 0) || values.length < 8 ||
      polymod([...prefix].map(c => c.charCodeAt(0) & 31).concat(0, values)) !== 0n) {
    throw new Error('Address checksum is invalid; check the pasted address');
  }
  const decoded = convert(values.slice(0, -8), 5, 8, false);
  const lengths = new Map([[0, 32], [1, 33], [8, 32]]);
  if (decoded.length - 1 !== lengths.get(decoded[0])) throw new Error('Unsupported address version or payload size');
  return address;
}
/** Also used to generate deterministic, non-owned addresses in offline tests. */
export function encodeAddress(payload, version = 0) {
  const prefix = 'kaspa', values = convert([version, ...payload], 8, 5, true);
  const check = polymod([...prefix].map(c => c.charCodeAt(0) & 31).concat(0, values, Array(8).fill(0)));
  const tail = Array.from({length: 8}, (_, i) => Number((check >> BigInt(5 * (7 - i))) & 31n));
  return `${prefix}:${values.concat(tail).map(v => ALPHABET[v]).join('')}`;
}
export const shortAddress = value => value ? `${value.slice(0, 17)}…${value.slice(-8)}` : 'Non-address script';
