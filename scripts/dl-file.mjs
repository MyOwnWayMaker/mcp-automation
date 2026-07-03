import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const startUrl = process.argv[2];
const out = process.argv[3];
const referer = process.argv[4] || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const H = { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) };

// 1. Resolve the get_file redirect manually so we can control the scheme.
let target = startUrl;
const r0 = await fetch(startUrl, { redirect: 'manual', headers: H });
if (r0.status >= 300 && r0.status < 400 && r0.headers.get('location')) {
  target = r0.headers.get('location');
  console.error('redirect ->', target);
}

async function tryFetch(u) {
  const res = await fetch(u, { redirect: 'follow', headers: H });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  console.error('OK', res.status, 'type=', res.headers.get('content-type'), 'len=', res.headers.get('content-length'), 'final=', res.url);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
  console.error('SAVED', out);
}

try {
  await tryFetch(target);
} catch (e) {
  console.error('https attempt failed:', e.message || e.code || e);
  if (target.startsWith('https://')) {
    const httpUrl = 'http://' + target.slice('https://'.length);
    console.error('retrying over HTTP ->', httpUrl);
    await tryFetch(httpUrl);
  } else {
    throw e;
  }
}
