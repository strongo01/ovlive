// Minimale nabootsing van cloudflare:workers en cloudflare:sockets voor Node-tests van NdovFeedHub.
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export function connect() { if (!globalThis.__socketFactory) throw new Error('globalThis.__socketFactory niet ingesteld'); return globalThis.__socketFactory(); }
