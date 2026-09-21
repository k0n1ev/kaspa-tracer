/** Indexed max heap with occasional FIFO selection to avoid starving small branches. */
export class Frontier {
  constructor() { this.heap = []; this.positions = new Map(); this.age = new Map(); this.pops = 0; }
  get size() { return this.heap.length; }
  better(a, b) { return a.pending > b.pending || (a.pending === b.pending && a.order < b.order); }
  swap(a, b) {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
    this.positions.set(this.heap[a].key, a); this.positions.set(this.heap[b].key, b);
  }
  up(i) { while (i > 0) { const p = (i - 1) >> 1; if (!this.better(this.heap[i], this.heap[p])) break; this.swap(i, p); i = p; } return i; }
  down(i) {
    while (true) {
      let best = i, left = i * 2 + 1, right = left + 1;
      if (left < this.size && this.better(this.heap[left], this.heap[best])) best = left;
      if (right < this.size && this.better(this.heap[right], this.heap[best])) best = right;
      if (best === i) return; this.swap(i, best); i = best;
    }
  }
  set(node) {
    if (node.pending <= 0n || node.busy) return;
    if (this.positions.has(node.key)) { const i = this.up(this.positions.get(node.key)); this.down(i); return; }
    this.positions.set(node.key, this.size); this.age.set(node.key, node); this.heap.push(node); this.up(this.size - 1);
  }
  remove(key) {
    const i = this.positions.get(key); if (i === undefined) return null;
    const node = this.heap[i], last = this.heap.pop();
    this.positions.delete(key); this.age.delete(key);
    if (i < this.size) { this.heap[i] = last; this.positions.set(last.key, i); this.down(this.up(i)); }
    return node;
  }
  pop() {
    if (!this.size) return null;
    const key = ++this.pops % 8 === 0 ? this.age.keys().next().value : this.heap[0].key;
    return this.remove(key);
  }
}
