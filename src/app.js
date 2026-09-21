import {KaspaApi, validateApiBase} from './api.js';
import {validateAddress, shortAddress} from './address.js';
import {EntityRegistry, loadRegistry} from './entities.js';
import {TraceSession} from './engine.js';
import {makeDemo} from './demo.js';
import {formatKAS, percent, stringify} from './amount.js';
import {toCSV} from './export.js';

const $ = id => document.getElementById(id);
const make = (tag, className = '', text = '') => {
  const el = document.createElement(tag); if (className) el.className = className; if (text !== '') el.textContent = text; return el;
};
let current = null, startup = null, busy = false, generation = 0, demoMode = false;
let customLabels = [], pathStack = ['root'], pathLimit = 30, endpointLimit = 25;
let lastListRender = 0, lastState = '';
const donation = 'kaspa:qp83863lsstc5rmm3mppgke0wwyklqdryund4z8e8hnnjrmffcvdsn5c0ffee';
const pct = (n, total) => {
  const p = percent(n, total);
  return n > 0n && p < 0.01 ? '<0.01%' : `${p.toFixed(2)}%`;
};
function message(text, info = false) {
  $('message').textContent = text; $('message').hidden = !text;
  $('message').classList.toggle('info', info);
}
function controls() {
  $('traceButton').hidden = busy;
  $('traceButton').textContent = current ? 'New snapshot ↗' : 'Trace balance ↗';
  $('stopButton').hidden = !busy;
  $('stopButton').disabled = !!(current?.state === 'stopping' || startup?.signal.aborted);
  $('continueButton').hidden = busy || !current || !['paused', 'partial'].includes(current.state) || current.reason === 'resource';
  for (const id of ['addressInput', 'apiInput', 'idleInput', 'labelsInput', 'demoButton']) $(id).disabled = busy;
  $('exportJSON').disabled = !current; $('exportCSV').disabled = !current;
}
function metrics(data) {
  $('statRequests').textContent = (data.requests ?? 0).toLocaleString();
  $('statCache').textContent = (data.cacheHits ?? 0).toLocaleString();
  $('statRetries').textContent = (data.retries ?? 0).toLocaleString();
}
function statusText(s) {
  if (s.state === 'running') return `Following ${s.frontier.toLocaleString()} queued output(s). ${Math.floor(s.noDiscoveryMs / 1000)}s since meaningful endpoint discovery.`;
  if (s.state === 'stopping') return 'Stopping requests and preserving every unfinished contribution…';
  if (s.reason === 'empty') return 'No current unspent balance. Historical lifetime receipts are not mixed into this result.';
  if (s.reason === 'all-endpoints') return 'All snapshot value reached mining or labeled-exchange endpoints under this attribution model.';
  if (s.reason === 'no-discovery') return `Automatically paused after ${current.options.idleMs / 1000}s without meaningful endpoint discovery. Continue keeps the same snapshot.`;
  if (s.reason === 'resource') return 'Browser memory/work safety budget reached. Export the partial trace; no unfinished value has been discarded.';
  if (s.reason === 'user') return 'Stopped. Results and unfinished branches are preserved; Continue resumes the same snapshot.';
  if (s.reason === 'data-unavailable') return 'Some branches could not be resolved from available data. Continue retries them without losing discovered endpoints.';
  if (s.state === 'error') return 'The trace encountered an internal error. Do not rely on this result; take a fresh snapshot.';
  return 'Snapshot checked; ready to trace.';
}
function render(force = false) {
  if (!current) return;
  const s = current.summary();
  $('results').hidden = false; $('statusPanel').hidden = false;
  $('stateBadge').textContent = `${demoMode ? 'DEMO · ' : ''}${s.state.toUpperCase()}`;
  $('statusText').textContent = statusText(s);
  $('totalBalance').textContent = formatKAS(s.total);
  $('targetDisplay').textContent = s.address;
  $('balanceLabel').textContent = demoMode ? 'SYNTHETIC DEMO · NOT A REAL WALLET' : 'CURRENT UTXO SNAPSHOT';
  $('snapshotTime').textContent = `Captured ${new Date(s.capturedAt).toLocaleString()}`;
  $('coverageValue').textContent = s.total === 0n ? '—' : pct(s.resolved, s.total);
  const values = {mining: s.totals.mining, exchange: s.totals.exchange,
    pending: s.totals.queued + s.totals.active, blocked: s.totals.blocked};
  const names = {mining: 'Mining', exchange: 'Exchanges', pending: 'Still to trace', blocked: 'Data unavailable'};
  for (const [key, amount] of Object.entries(values)) {
    $(key + 'Value').textContent = `${formatKAS(amount)} KAS`;
    $(key + 'Percent').textContent = pct(amount, s.total);
    $(key + 'Segment').style.width = percent(amount, s.total) + '%';
    $(key + 'Segment').title = `${names[key]}: ${formatKAS(amount)} KAS`;
  }
  $('spectrum').setAttribute('aria-label', Object.entries(values).map(([key, amount]) => `${names[key]} ${pct(amount, s.total)}`).join(', '));
  $('conservationText').textContent = `ACCOUNTED FOR: ${formatKAS(s.total)} KAS = ${formatKAS(s.resolved)} attributed + ${formatKAS(s.unresolved)} unresolved. Integer-sompi reconciliation.`;
  metrics(s.api);
  $('statNodes').textContent = s.stats.nodes.toLocaleString();
  $('statDepth').textContent = s.stats.maxDepth.toLocaleString();
  $('statTime').textContent = s.elapsedMs < 60000 ? `${Math.floor(s.elapsedMs / 1000)}s` : `${Math.floor(s.elapsedMs / 60000)}m ${Math.floor(s.elapsedMs / 1000) % 60}s`;
  $('endpointCount').textContent = s.endpointCount.toLocaleString();
  const stateChanged = lastState !== s.state; lastState = s.state;
  if (force || stateChanged || Date.now() - lastListRender > 800) {
    renderEndpoints(); renderBranches(); renderPath(); renderWarnings(); lastListRender = Date.now();
  }
  controls();
}
function explorerLink(kind, value, title) {
  const link = make('a', '', title);
  link.href = `https://explorer.kaspa.org/${kind}/${encodeURIComponent(value)}`;
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  return link;
}
function inspectButton(key, text = 'Inspect path') {
  const b = make('button', 'text-button', text); b.type = 'button'; b.addEventListener('click', () => inspect(key)); return b;
}
function renderEndpoints() {
  const rows = current.endpointRows(), container = $('endpointList'); container.replaceChildren();
  if (!rows.length) container.append(make('p', 'empty', current.total === 0n ? 'No balance to attribute.' : 'No endpoint found yet. Unresolved value stays visible.'));
  for (const row of rows.slice(0, endpointLimit)) {
    const card = make('div', 'endpoint'), head = make('div', 'row-head');
    head.append(make('div', `row-name ${row.type}-text`, row.name));
    const value = make('div', 'row-value', `${formatKAS(row.amount)} KAS`);
    value.append(make('small', '', pct(row.amount, current.total))); head.append(value); card.append(head);
    const addressText = row.addresses.length === 1 ? shortAddress(row.addresses[0]) : `${row.addresses.length} labeled address(es)`;
    card.append(make('p', 'evidence', `${addressText} · ${row.sources.join(' · ')}`));
    const links = make('div', 'row-links');
    if (row.examples[0]) links.append(inspectButton(row.examples[0], 'View endpoint'));
    if (row.addresses[0] && !demoMode) links.append(explorerLink('addresses', row.addresses[0], 'Address ↗'));
    card.append(links);
    const track = make('div', 'mini-track'), fill = make('span', `${row.type}-fill`);
    fill.style.width = percent(row.amount, current.total) + '%'; track.append(fill); card.append(track); container.append(card);
  }
  $('moreEndpoints').hidden = rows.length <= endpointLimit;
}
function renderBranches() {
  const rows = [...current.nodes.values()].filter(n => n.pending + n.active + n.blocked > 0n)
    .sort((a, b) => {
      const av = a.pending + a.active + a.blocked, bv = b.pending + b.active + b.blocked;
      return av === bv ? a.key.localeCompare(b.key) : av > bv ? -1 : 1;
    });
  $('branchCount').textContent = rows.length.toLocaleString();
  const container = $('branchList'); container.replaceChildren();
  if (!rows.length) container.append(make('p', 'empty', current.state === 'complete' ? 'No unfinished branches.' : 'Waiting for trace updates…'));
  for (const row of rows.slice(0, 15)) {
    const card = make('div', 'branch'), head = make('div', 'row-head');
    const owner = row.address ? shortAddress(row.address) : `${row.txid.slice(0, 12)}…:${row.index}`;
    head.append(make('div', 'row-name', owner), make('div', 'row-value', `${formatKAS(row.pending + row.active + row.blocked)} KAS`));
    card.append(head, make('p', 'evidence', row.error ? `${row.error.code}: ${row.error.message}` : row.active ? 'Request / attribution in progress' : 'Queued for continued tracing'));
    card.append(inspectButton(row.key)); container.append(card);
  }
  $('branchFootnote').textContent = rows.length > 15 ? `Showing the 15 largest of ${rows.length.toLocaleString()} unfinished outputs. Full state is included in JSON.` : '';
}
function nodeState(node) {
  if (node.blocked > 0n) return 'Data unavailable';
  if (node.active > 0n) return 'In progress';
  if (node.pending > 0n) return 'Queued';
  if (node.recipe?.kind === 'mining') return 'Mining endpoint';
  if (node.recipe?.kind === 'exchange') return 'Exchange endpoint';
  if (node.recipe?.kind === 'split') return 'Expanded';
  return 'Not expanded';
}
function inspect(key) {
  if (!current || (key !== 'root' && !current.nodes.has(key))) return;
  if (pathStack.at(-1) !== key) pathStack.push(key);
  pathLimit = 30; renderPath();
  document.querySelector('.inspector').scrollIntoView({behavior: 'smooth', block: 'start'});
}
function renderPath() {
  const key = pathStack.at(-1), node = key === 'root' ? null : current.nodes.get(key);
  $('pathBack').disabled = pathStack.length <= 1;
  const details = $('pathDetails'); details.replaceChildren();
  let edges;
  if (!node) {
    $('pathTitle').textContent = `Snapshot · ${current.rootEdges.length.toLocaleString()} unspent output(s)`;
    details.append(document.createTextNode('These are the actual outputs returned for the target address. Attributed amounts are shares of this snapshot, not other addresses’ current balances.'));
    edges = current.rootEdges;
  } else {
    $('pathTitle').textContent = `Output ${node.txid}:${node.index}`;
    details.append(make('p', '', `Owner: ${node.address ?? 'Non-address / unavailable script'} · ${nodeState(node)}`));
    details.append(make('p', '', `Original output: ${formatKAS(node.value)} KAS · Attributed through it: ${formatKAS(node.through)} KAS`));
    if (node.recipe?.kind === 'exchange') details.append(make('p', '', `Endpoint: ${node.recipe.entity.name}. Label evidence: ${node.recipe.entity.evidence} — ${node.recipe.entity.source}`));
    if (node.recipe?.kind === 'mining') details.append(make('p', '', `Mining evidence: ${node.recipe.evidence}`));
    if (node.error) details.append(make('p', '', `${node.error.code}: ${node.error.message}`));
    if (!demoMode) {
      details.append(explorerLink('txs', node.txid, 'Transaction in explorer ↗'));
      if (node.address) details.append(explorerLink('addresses', node.address, 'Address in explorer ↗'));
    }
    edges = [...node.edges].map(([key, amount]) => ({key, amount}));
  }
  const sorted = [...edges].sort((a, b) => a.amount === b.amount ? a.key.localeCompare(b.key) : a.amount > b.amount ? -1 : 1);
  const tbody = $('pathRows'); tbody.replaceChildren();
  for (const edge of sorted.slice(0, pathLimit)) {
    const child = current.nodes.get(edge.key); if (!child) continue;
    const tr = make('tr'), label = make('td');
    label.append(make('div', 'output-id', `${child.txid.slice(0, 12)}…${child.txid.slice(-8)}:${child.index}`),
      make('div', 'output-owner', shortAddress(child.address)));
    tr.append(label, make('td', '', formatKAS(edge.amount)), make('td', '', nodeState(child)));
    const action = make('td'), button = make('button', 'ghost', 'Inspect →'); button.type = 'button';
    button.addEventListener('click', () => inspect(child.key)); action.append(button); tr.append(action); tbody.append(tr);
  }
  if (!sorted.length) {
    const tr = make('tr'), td = make('td', 'empty', node?.recipe && node.recipe.kind !== 'split'
      ? 'This branch ends here under the selected stopping rules.'
      : 'Funding inputs appear here after this output is expanded.');
    td.colSpan = 4; tr.append(td); tbody.append(tr);
  }
  $('morePaths').hidden = sorted.length <= pathLimit;
}
function renderWarnings() {
  const warnings = [...new Set(current.warnings)];
  if (demoMode) warnings.unshift('This is synthetic data. The demo’s addresses and exchange names are not real ownership claims.');
  $('warningsBox').hidden = warnings.length === 0;
  $('warningCount').textContent = `(${warnings.length})`;
  $('warningsList').replaceChildren(...warnings.map(w => make('p', '', w)));
}
async function startTrace(demo = false) {
  if (busy) return;
  let address, baseUrl, idleMs;
  try {
    address = demo ? null : validateAddress($('addressInput').value);
    baseUrl = validateApiBase($('apiInput').value.trim());
    const seconds = Number($('idleInput').value);
    if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 3600) throw new Error('Inactivity interval must be 10–3600 whole seconds');
    idleMs = seconds * 1000;
  } catch (error) { message(error.message); return; }
  const token = ++generation;
  current = null; busy = true; demoMode = demo; pathStack = ['root']; pathLimit = 30; endpointLimit = 25; lastState = '';
  startup = new AbortController(); const signal = startup.signal;
  message(demo ? 'Offline demonstration: 1,000 synthetic KAS. No live blockchain requests are made.' : '', demo);
  $('results').hidden = true; $('statusPanel').hidden = false;
  $('stateBadge').textContent = demo ? 'DEMO · PREPARING' : 'PREPARING';
  $('statusText').textContent = 'Checking unspent outputs against reported balance/count and loading source labels…';
  metrics({}); $('statNodes').textContent = '0'; $('statDepth').textContent = '0'; $('statTime').textContent = '0s';
  controls();
  try {
    const fixture = demo ? makeDemo() : null;
    const api = fixture?.api ?? new KaspaApi({baseUrl});
    api.onMetrics = data => { if (generation === token && !current) metrics(data); };
    address = fixture?.address ?? address; $('addressInput').value = address;
    const [snapshot, registry] = await Promise.all([
      api.snapshot(address, signal),
      fixture ? Promise.resolve(fixture.registry) : loadRegistry(api, signal, customLabels)
    ]);
    if (signal.aborted || token !== generation) return;
    current = new TraceSession({api, snapshot, registry, idleMs, onUpdate: () => { if (generation === token) render(); }});
    startup = null; render(true); await current.run();
  } catch (error) {
    startup?.abort();
    if (token !== generation) return;
    if (signal.aborted && !current && error.name === 'AbortError') {
      $('stateBadge').textContent = 'STOPPED';
      $('statusText').textContent = 'Stopped before a checked snapshot was available. Start again to take a fresh snapshot.';
    } else {
      $('stateBadge').textContent = 'ERROR'; $('statusText').textContent = 'Trace could not finish. No missing data is assumed to be zero.';
      message(error.message || 'Unexpected trace error'); console.error(error);
    }
  } finally {
    if (token === generation) { busy = false; startup = null; controls(); if (current) render(true); }
  }
}
async function continueTrace() {
  if (busy || !current) return;
  busy = true; $('addressInput').value = current.snapshot.address; controls();
  try { await current.run(); }
  catch (error) { message(error.message); }
  finally { busy = false; render(true); }
}
function download(text, extension, type) {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const a = make('a'); a.href = url;
  a.download = `kaspa-trace-${demoMode ? 'demo-' : ''}${current.snapshot.address.slice(-8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('traceForm').addEventListener('submit', event => { event.preventDefault(); startTrace(false); });
$('demoButton').addEventListener('click', () => startTrace(true));
$('continueButton').addEventListener('click', continueTrace);
$('stopButton').addEventListener('click', () => { if (current?.running) current.stop(); else startup?.abort(); controls(); });
$('pathBack').addEventListener('click', () => { if (pathStack.length > 1) pathStack.pop(); pathLimit = 30; renderPath(); });
$('pathRoot').addEventListener('click', () => { pathStack = ['root']; pathLimit = 30; renderPath(); });
$('morePaths').addEventListener('click', () => { pathLimit += 50; renderPath(); });
$('moreEndpoints').addEventListener('click', () => { endpointLimit += 50; renderEndpoints(); });
$('exportJSON').addEventListener('click', () => { if (current) download(stringify({...current.report(), demo: demoMode}), 'json', 'application/json'); });
$('exportCSV').addEventListener('click', () => { if (current) download(toCSV(current.report(), demoMode), 'csv', 'text/csv;charset=utf-8'); });
$('labelsInput').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('Label file must be smaller than 2 MB');
    const data = JSON.parse(await file.text()), rows = data.entities ?? data;
    const validator = new EntityRegistry(); validator.addRows(rows);
    if (validator.warnings.length) throw new Error(validator.warnings.join(' ') + ' No new labels were applied.');
    customLabels = rows;
    $('labelsHelp').textContent = `${rows.length} custom record(s) loaded for the next new trace. Source evidence is included in exports.`;
    message('Custom labels apply to the next new trace, not an already running or paused snapshot.', true);
  } catch (error) { message(error.message); event.target.value = ''; }
});
$('copyDonation').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(donation); $('copyStatus').textContent = 'Donation address copied.'; }
  catch { $('copyStatus').textContent = 'Clipboard unavailable. Select and copy the address above.'; }
});
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
const suppliedAddress = new URLSearchParams(location.search).get('address');
if (suppliedAddress) $('addressInput').value = suppliedAddress;
controls();
