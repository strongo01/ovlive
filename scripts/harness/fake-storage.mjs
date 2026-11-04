// Nep DurableObjectStorage + ctx. Waarden worden structured-cloned zoals Cloudflare doet (geen gedeelde referenties).
export function makeCtx() {
  const data = new Map(); let alarm = null; const pending = [];
  const clone = (v) => (v instanceof Uint8Array ? new Uint8Array(v) : structuredClone(v));
  const storage = {
    async get(k) { if (Array.isArray(k)) return new Map(k.map((x) => [x, data.has(x) ? clone(data.get(x)) : undefined])); return data.has(k) ? clone(data.get(k)) : undefined; },
    async put(k, v) { if (typeof k === 'object' && !(k instanceof Uint8Array)) { for (const [kk, vv] of Object.entries(k)) data.set(kk, clone(vv)); } else data.set(k, clone(v)); },
    async delete(k) { if (Array.isArray(k)) { let n = 0; for (const x of k) n += data.delete(x) ? 1 : 0; return n; } return data.delete(k); },
    async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; }, async deleteAlarm() { alarm = null; },
  };
  return { storage, data, pending, blockConcurrencyWhile: (fn) => fn(), waitUntil: (p) => pending.push(p) };
}
