// The response headers vercel.json sets for a path, so local test servers behave like production
// (including the Content-Security-Policy). `upgrade-insecure-requests` is dropped because the test
// servers are plain http; production is https only, where it has nothing to upgrade.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const conf = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vercel.json'), 'utf8'));
const rules = (conf.headers || []).map((r) => ({ re: new RegExp(`^${r.source.replace(/\(\.\*\)/g, '.*')}$`), headers: r.headers }));

export function vercelHeaders(pathname) {
  const out = {};
  for (const r of rules) {
    if (!r.re.test(pathname)) continue;
    for (const { key, value } of r.headers) {
      out[key] = key === 'Content-Security-Policy' ? value.replace(/;\s*upgrade-insecure-requests/, '') : value;
    }
  }
  return out;
}
