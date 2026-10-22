// One-off backfill: verify every exported lead's email via MillionVerifier.
// Third-party-domain scrapes are flagged, not verified (no wasted credits).
import { readFileSync } from 'node:fs';

const ENV_PATH = process.env.LEADS_ENV || './.env';
const LEADS_TABLE = process.env.LEADS_TABLE_ID;
const FREEMAIL = ['gmail.com','outlook.com','hotmail.com','yahoo.com','yahoo.co.uk','icloud.com','btinternet.com','aol.com','live.com','live.co.uk','me.com','sky.com','mail.com'];

function env() {
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  for (const k of ['N8N_API_KEY','N8N_BASE_URL','MILLIONVERIFIER_API_KEY']) if (!out[k]) throw new Error(k + ' missing');
  out.N8N_BASE_URL = out.N8N_BASE_URL.replace(/\/+$/, '');
  return out;
}
const E = env();
const H = { 'X-N8N-API-KEY': E.N8N_API_KEY, 'Content-Type': 'application/json' };
const log = (m) => console.log(m);
const siteDomain = (u) => { const m = String(u||'').match(/^(?:https?:\/\/)?(?:www\.)?([^\/?#:]+)/i); return m ? m[1].toLowerCase() : ''; };

async function rows(status) {
  const filter = encodeURIComponent(JSON.stringify({ type:'and', filters:[{ columnName:'status', condition:'eq', value:status }] }));
  let all = [], cursor = '';
  for (;;) {
    const r = await fetch(`${E.N8N_BASE_URL}/api/v1/data-tables/${LEADS_TABLE}/rows?limit=100&filter=${filter}${cursor?'&cursor='+encodeURIComponent(cursor):''}`, { headers: H });
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
    body: JSON.stringify({ filter: { type:'and', filters:[{ columnName:'place_id', condition:'eq', value:place_id }] }, data })
  });
  if (!r.ok) throw new Error('update ' + r.status + ' for ' + place_id);
}

async function verify(email) {
  const r = await fetch(`https://api.millionverifier.com/api/v3/?api=${E.MILLIONVERIFIER_API_KEY}&email=${encodeURIComponent(email)}&timeout=10`);
  if (!r.ok) return 'verify_error';
  const j = await r.json();
  let res = j.result || 'verify_error';
  if (res === 'disposable') res = 'invalid';
  if (res === 'error') res = 'verify_error';
  return res;
}

const exported = await rows('exported');
log('exported rows: ' + exported.length);
let verified = 0, flagged = 0, skipped = 0;
const results = [];
for (const r of exported) {
  if (!r.email) { skipped++; continue; }
  if (r.email_status === 'ok') { skipped++; continue; }
  const ed = String(r.email).split('@')[1] || '';
  const wd = siteDomain(r.website);
  const own = wd && (ed === wd || ed.endsWith('.' + wd) || wd.endsWith('.' + ed));
  if (!own && !FREEMAIL.includes(ed)) {
    await updateRow(r.place_id, { email_status: 'third_party_domain' });
    flagged++;
    results.push(`FLAGGED  ${r.name}: ${r.email} (site ${wd})`);
    continue;
  }
  const res = await verify(r.email);
  await updateRow(r.place_id, { email_status: res });
  verified++;
  results.push(`${res.toUpperCase().padEnd(11)} ${r.name}: ${r.email}`);
}
log('');
results.forEach(log);
log('');
log(`verified: ${verified}, flagged third-party: ${flagged}, skipped (no email / already ok): ${skipped}`);
