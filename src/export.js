import {kasDecimal, percent} from './amount.js';
function cell(value) {
  let s = String(value ?? '');
  // Prevent spreadsheet formula execution in untrusted entity labels/evidence.
  if (/^\s*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function toCSV(report, demo = false) {
  const total = BigInt(report.summary.total);
  const rows = [['snapshotAddress', 'capturedAt', 'demo', 'category', 'name', 'attributedSompi', 'attributedKAS', 'percentOfSnapshot', 'addresses', 'evidence', 'exampleOutpoints']];
  const add = (type, name, amount, addresses = [], evidence = [], examples = []) => rows.push([
    report.snapshot.address, report.snapshot.capturedAt, demo, type, name, amount.toString(), kasDecimal(amount),
    percent(amount, total).toFixed(4), addresses.join(' | '), evidence.join(' | '), examples.join(' | ')
  ]);
  for (const e of report.endpoints) add(e.type, e.name, BigInt(e.amount), e.addresses, e.sources, e.examples);
  const t = report.summary.totals;
  const pending = BigInt(t.queued) + BigInt(t.active), blocked = BigInt(t.blocked);
  if (pending > 0n) add('unresolved', 'Queued / in progress', pending);
  if (blocked > 0n) add('unresolved', 'Data unavailable', blocked);
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
