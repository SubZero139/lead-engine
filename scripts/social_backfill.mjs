// One-off backfill: extract social profile links from clinic websites
// for already-exported leads and merge them into the signals JSON.
import { readFileSync } from 'node:fs';

const ENV_PATH = process.env.LEADS_ENV || './.env';
const LEADS_TABLE = process.env.LEADS_TABLE_ID;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function env() {
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!out.N8N_API_KEY || !out.N8N_BASE_URL) throw new Error('n8n creds missing');
  out.N8N_BASE_URL = out.N8N_BASE_URL.replace(/\/+$/, '');
  return out;
}
const E = env();
const H = { 'X-N8N-API-KEY': E.N8N_API_KEY, 'Content-Type': 'application/json' };

function extractSocials(html) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const rx = /https?:\/\/(?:www\.)?(?:facebook\.com|instagram\.com|linkedin\.com|x\.com|twitter\.com|tiktok\.com)\/[A-Za-z0-9_.\/-]+/gi;
  let m;
  while ((m = rx.exec(html))) {
    const u = m[0].replace(/[\/.,)]+$/, '');
    const lo = u.toLowerCase();
    if (/sharer|\/share|intent|\/plugins|\/dialog|\/login|\/hashtag|\/p\/|\/reel|\/posts\/|\/photo|\/watch|\/status\//.test(lo)) continue;
    if (!out.includes(u)) out.push(u);
    if (out.length >= 8) break;
  }
  return out;
}

async function fetchPage(url) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: ac.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) return '';
    return await r.text();
  } catch { return ''; }
}

async function rows(status) {
  const filter = encodeURIComponent(JSON.stringify({ type: 'and', filters: [{ columnName: 'status', condition: 'eq', value: status }] }));
  let all = [], cursor = '';
  for (;;) {
    const r = await fetch(`${E.N8N_BASE_URL}/api/v1/data-tables/${LEADS_TABLE}/rows?limit=100&filter=${filter}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, { headers: H });
    if (!r.ok) throw new Error('rows fetch ' + r.status);
    const j = await r.json();
    all = all.concat(j.data || []);
    cursor = j.nextCursor || null;
    if (!cursor) break;
  }
  return all;
}

async function updateRow(place_id, data) {
  const r = await fetch(`${E.N8N_BASE_URL}/api/v1/data-tables/${LEADS_TABLE}/rows/update`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ filter: { type: 'and', filters: [{ columnName: 'place_id', condition: 'eq', value: place_id }] }, data })
  });
  if (!r.ok) throw new Error('update ' + r.status + ' for ' + place_id);
}

const leads = await rows('exported');
console.log('exported rows: ' + leads.length);
let updated = 0, none = 0, nosite = 0;
for (const r of leads) {
  if (!r.website) { nosite++; continue; }
  const m = String(r.website).match(/^(https?:\/\/[^\/?#]+)/i);
  const origin = m ? m[1] : 'https://' + String(r.website).replace(/^https?:\/\//i, '').split(/[\/?#]/)[0];
  const socials = new Set();
  for (const path of ['/', '/contact', '/contact-us']) {
    const html = await fetchPage(origin + path);
    extractSocials(html).forEach((s) => socials.add(s));
    if (socials.size >= 8) break;
  }
  const list = [...socials];
  if (!list.length) { none++; continue; }
  let sig = {};
  try { sig = JSON.parse(r.signals || '{}'); } catch {}
  sig.socialLinks = list;
  await updateRow(r.place_id, { signals: JSON.stringify(sig) });
  updated++;
  console.log(`  ${r.name}: ${list.join(' | ')}`);
}
console.log(`\nupdated: ${updated}, no socials found: ${none}, no website: ${nosite}`);
