// Lead Engine batch runner: fires Workflow B via webhook until no raw
// leads remain, then runs pull_leads.mjs to export. Safe to re-run.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.LEADS_ENV || './.env';
const WORKFLOW_ID = process.env.WORKFLOW_B_ID;
const LEADS_TABLE = process.env.LEADS_TABLE_ID;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH;
const MAX_BATCHES = 12;
const BATCH_TIMEOUT_MS = 6 * 60 * 1000;
const POLL_MS = 10000;

function env() {
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!out.N8N_API_KEY || !out.N8N_BASE_URL) throw new Error('N8N_API_KEY / N8N_BASE_URL missing in env file');
  out.N8N_BASE_URL = out.N8N_BASE_URL.replace(/\/+$/, '');
  return out;
}
const E = env();
const H = { 'X-N8N-API-KEY': E.N8N_API_KEY };
const log = (m) => console.log(new Date().toISOString().slice(11, 19) + ' ' + m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(path) {
  const r = await fetch(E.N8N_BASE_URL + path, { headers: H });
  if (!r.ok) throw new Error('API ' + r.status + ' on ' + path);
  return r.json();
}

async function rawCount() {
  const filter = encodeURIComponent(JSON.stringify({ type: 'and', filters: [{ columnName: 'status', condition: 'eq', value: 'raw' }] }));
  let count = 0, cursor = '';
  for (;;) {
    const j = await api(`/api/v1/data-tables/${LEADS_TABLE}/rows?limit=100&filter=${filter}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    const items = j.data || j.rows || j.items || [];
    count += items.length;
    cursor = j.nextCursor || null;
    if (!cursor) break;
  }
  return count;
}

async function latestExecution() {
  const j = await api(`/api/v1/executions?workflowId=${WORKFLOW_ID}&limit=1`);
  return (j.data && j.data[0]) || null;
}

async function runBatch(n) {
  const before = await latestExecution();
  const beforeId = before ? Number(before.id) : 0;
  const r = await fetch(`${E.N8N_BASE_URL}/webhook/${WEBHOOK_PATH}`, { method: 'POST' });
  if (!r.ok && r.status !== 200) throw new Error('Webhook fire failed: HTTP ' + r.status);
  log(`batch ${n}: fired (webhook HTTP ${r.status})`);
  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error('batch ' + n + ' timed out');
    await sleep(POLL_MS);
    const ex = await latestExecution();
    if (ex && Number(ex.id) > beforeId && ex.finished) {
      if (ex.status !== 'success') throw new Error('batch ' + n + ' execution ' + ex.id + ' ended with status ' + ex.status);
      log(`batch ${n}: execution ${ex.id} finished (${ex.status})`);
      return;
    }
  }
}

async function deactivate() {
  const r = await fetch(`${E.N8N_BASE_URL}/api/v1/workflows/${WORKFLOW_ID}/deactivate`, { method: 'POST', headers: H });
  log('workflow deactivated: HTTP ' + r.status);
}

let raw = await rawCount();
log('starting; raw leads: ' + raw);
try {
  for (let n = 1; raw > 0 && n <= MAX_BATCHES; n++) {
    const before = raw;
    await runBatch(n);
    raw = await rawCount();
    log(`raw remaining: ${raw}`);
    if (raw >= before) throw new Error('no progress after batch ' + n + ' (raw ' + before + ' -> ' + raw + ') - aborting');
  }
} finally {
  await deactivate();
}
if (raw > 0) throw new Error('stopped with ' + raw + ' raw leads left');
log('all batches done; running export...');
const res = spawnSync(process.execPath, [join(HERE, 'pull_leads.mjs')], { stdio: 'inherit' });
if (res.status !== 0) throw new Error('pull_leads.mjs exited ' + res.status);
log('export complete');
