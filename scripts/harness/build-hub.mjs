// Bundelt een hub-bronbestand met de Cloudflare-stubs: node build-hub.mjs <src/ndov-stream-hub.js> <uit.mjs>
import { build } from '/home/claude/ovlive/node_modules/esbuild/lib/main.js';
import path from 'node:path';
const [entry, out] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'error',
  alias: { 'cloudflare:workers': path.join(here, 'cf-stubs.mjs'), 'cloudflare:sockets': path.join(here, 'cf-stubs.mjs') } });
