#!/usr/bin/env node
/**
 * AutonomIQ Lead Engine — export scored leads from the n8n Data Table
 * into CSV + evidence markdown files, then flip their status in n8n.
 *
 * Usage:
 *   node pull_leads.mjs             (fetch, write files, update statuses)
 *   node pull_leads.mjs --dry-run   (fetch, write files, skip status updates)
 *
 * Env file (KEY=VALUE lines) is read from:
 *   ./.env
 * Override the path with the LEADS_ENV environment variable.
 *
 * No third-party dependencies — Node 18+ built-ins only (fetch, fs, path).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_ENV_PATH =
  './.env';
const LEADS_DIR = './leads';
const DATA_TABLE_ID = process.env.LEADS_TABLE_ID;

const CSV_COLUMNS = [
  'classification',
  'name',
  'owner_name',
  'email',
  'email_status',
  'email_source',
  'route',
  'entity_check',
  'company_number',
  'phone',
  'website',
  'gmaps_url',
  'review_count',
  'rating',
  'city',
  'social_links',
  'evidence',
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function log(msg) {
  console.log(msg);
}
function warn(msg) {
  console.warn(`WARNING: ${msg}`);
}
function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Env file parsing
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPath = process.env.LEADS_ENV || DEFAULT_ENV_PATH;
  if (!existsSync(envPath)) {
    fail(
      `Env file not found at: ${envPath}\n` +
        `Set the LEADS_ENV environment variable to point at the correct file, or check the path above.`
    );
  }

  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch (e) {
    fail(`Could not read env file at ${envPath}: ${e.message}`);
  }

  const vars = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue; // skip blank lines / notes / anything not KEY=VALUE
    let [, key, value] = m;
    value = value.trim().replace(/\r$/, '');
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }

  const apiKey = vars.N8N_API_KEY;
  let baseUrl = vars.N8N_BASE_URL;

  if (!apiKey) {
    fail(`N8N_API_KEY not found in env file (${envPath}). Check the file contents.`);
  }
  if (!baseUrl) {
    fail(`N8N_BASE_URL not found in env file (${envPath}). Check the file contents.`);
  }
  baseUrl = baseUrl.replace(/\/+$/, '');

  return { apiKey, baseUrl };
}

// ---------------------------------------------------------------------------
// n8n API helpers
// ---------------------------------------------------------------------------

async function apiFetch(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    fail(
      `Network error contacting n8n: ${e.message}\n` +
        `Check your internet connection and that N8N_BASE_URL in the env file is correct.`
    );
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (res.status === 401 || res.status === 403) {
    fail(
      `n8n rejected the API key (HTTP ${res.status}). ` +
        `Check N8N_API_KEY in the env file — it may have expired or been rotated. (Key value not shown.)`
    );
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText, body };
}

async function fetchScoredRows({ apiKey, baseUrl }) {
  const rows = [];
  let cursor = null;
  const filter = JSON.stringify({
    type: 'and',
    filters: [{ columnName: 'status', condition: 'eq', value: 'scored' }],
  });
  let page = 0;

  while (true) {
    page++;
    const url = new URL(`${baseUrl}/api/v1/data-tables/${DATA_TABLE_ID}/rows`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('filter', filter);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await apiFetch(url, { headers: { 'X-N8N-API-KEY': apiKey } });
    if (!res.ok) {
      fail(
        `Failed to fetch leads from n8n (page ${page}): HTTP ${res.status} ${res.statusText}. ` +
          (res.body && res.body.message ? `Message: ${res.body.message}` : '')
      );
    }

    const batch = res.body.data || [];
    rows.push(...batch);
    log(`  fetched page ${page}: ${batch.length} row(s) (running total ${rows.length})`);

    if (!res.body.nextCursor || batch.length === 0) break;
    cursor = res.body.nextCursor;
  }

  return rows;
}

async function updateRowStatus({ apiKey, baseUrl }, placeId, newStatus) {
  const url = `${baseUrl}/api/v1/data-tables/${DATA_TABLE_ID}/rows/update`;
  const body = {
    filter: {
      type: 'and',
      filters: [{ columnName: 'place_id', condition: 'eq', value: placeId }],
    },
    data: { status: newStatus },
    returnData: false,
    dryRun: false,
  };
  const res = await apiFetch(url, {
    method: 'PATCH',
    headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function updateStatuses(ctx, exportRows, discardRows) {
  let exportedOk = 0;
  let exportedFail = 0;
  let archivedOk = 0;
  let archivedFail = 0;

  for (const row of exportRows) {
    const ok = await updateRowStatus(ctx, row.place_id, 'exported');
    if (ok) exportedOk++;
    else {
      exportedFail++;
      warn(`Could not mark "${row.name}" (${row.place_id}) as exported.`);
    }
  }

  for (const row of discardRows) {
    const ok = await updateRowStatus(ctx, row.place_id, 'archived');
    if (ok) archivedOk++;
    else {
      archivedFail++;
      warn(`Could not mark "${row.name}" (${row.place_id}) as archived.`);
    }
  }

  return { exportedOk, exportedFail, archivedOk, archivedFail };
}

// ---------------------------------------------------------------------------
// CSV + evidence markdown writing
// ---------------------------------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) value = '';
  value = String(value);
  if (/[",\n\r]/.test(value)) {
    value = '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function classificationRank(c) {
  if (c === 'HOT') return 0;
  if (c === 'WARM') return 1;
  return 2;
}

function citySlug(city) {
  const c = (city || '').trim().toLowerCase();
  if (!c) return 'unknown-city';
  return c.replace(/\s+/g, '-');
}

function groupByCity(rows) {
  const map = {};
  for (const r of rows) {
    const slug = citySlug(r.city);
    if (!map[slug]) map[slug] = [];
    map[slug].push(r);
  }
  return map;
}

function todayDateString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function writeCsv(filePath, rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(CSV_COLUMNS.map((col) => csvEscape(r[col])).join(','));
  }
  const content = '\uFEFF' + lines.join('\r\n') + '\r\n';
  return writeWithFallback(filePath, content);
}

// If the target file is locked (open in Excel), fall back to a suffixed
// name rather than failing the whole export. Returns the path written.
function writeWithFallback(filePath, content) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? filePath : filePath.replace(/(\.[a-z]+)$/i, `-v${attempt + 1}$1`);
    try {
      writeFileSync(candidate, content, 'utf8');
      if (attempt > 0) console.log(`  NOTE: original file locked (open in Excel?); wrote ${candidate} instead`);
      return candidate;
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
    }
  }
  throw new Error(`all fallback names locked for ${filePath}`);
}

// Evidence values look like: "quote one" () | "quote two" (source) | ...
function parseEvidence(evidence) {
  if (!evidence) return [];
  return evidence
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((seg) => {
      const m = seg.match(/^"(.*)"\s*\((.*)\)$/s);
      if (m) {
        const quote = m[1];
        const src = m[2].trim();
        return src ? `${quote} (${src})` : quote;
      }
      return seg;
    });
}

function writeEvidenceMd(filePath, rows, cityLabel, dateStr) {
  const lines = [];
  lines.push(`# ${cityLabel} — Scored Leads Evidence (${dateStr})`);
  lines.push('');

  for (const r of rows) {
    lines.push(`## ${r.name} — ${r.classification} — Route: ${r.route || 'n/a'}`);
    const ratingPart = `Rating: ${r.rating || 0} (${r.review_count || 0} reviews)`;
    const websitePart = `Website: ${r.website || 'none'}`;
    const ownerPart = `Owner: ${r.owner_name || 'unknown'}`;
    const emailPart = r.email
      ? `Email: ${r.email} (${r.email_status || 'unverified'})`
      : 'Email: none found';
    lines.push(`${ratingPart} | ${websitePart} | ${ownerPart} | ${emailPart}`);
    if (r.social_links) lines.push(`Social: ${r.social_links}`);
    lines.push('');

    const quotes = parseEvidence(r.evidence);
    if (quotes.length) {
      lines.push('Evidence:');
      for (const q of quotes) lines.push(`- ${q}`);
    } else {
      lines.push('Evidence: none recorded.');
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return writeWithFallback(filePath, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printSummary({ cityCounts, discardCount, writtenFiles, updateSummary, dryRun }) {
  log('');
  log('=== SUMMARY ===');
  const cities = Object.keys(cityCounts);
  if (cities.length === 0) {
    log('No exportable (HOT/WARM) leads found among scored rows.');
  }
  for (const slug of cities) {
    const c = cityCounts[slug];
    log(`${slug}: ${c.hot} HOT, ${c.warm} WARM exported`);
  }
  log(`Discards found: ${discardCount} (DISCARD/ERROR)`);

  if (dryRun) {
    log('Dry run: no status updates were made in n8n.');
  } else if (updateSummary) {
    log(
      `Status updates: ${updateSummary.exportedOk} exported OK` +
        (updateSummary.exportedFail ? `, ${updateSummary.exportedFail} export update(s) FAILED` : '') +
        `; ${updateSummary.archivedOk} archived OK` +
        (updateSummary.archivedFail ? `, ${updateSummary.archivedFail} archive update(s) FAILED` : '') +
        '.'
    );
    if (updateSummary.exportedFail + updateSummary.archivedFail > 0) {
      warn(
        'Some status updates failed. The exported files are safe and correct — ' +
          're-running is safe, or check the n8n Data Table manually if this persists.'
      );
    }
  }

  log('Files written:');
  for (const f of writtenFiles) log(`  ${f}`);
  log('=== DONE ===');
}

async function main() {
  log(`AutonomIQ lead export — ${DRY_RUN ? 'DRY RUN' : 'LIVE RUN'}`);
  log('');

  log('Step 1/4: reading credentials...');
  const ctx = loadEnv();
  log(`  using n8n base URL: ${ctx.baseUrl}`);

  log('Step 2/4: fetching scored leads from n8n...');
  const rows = await fetchScoredRows(ctx);
  log(`  total scored rows fetched: ${rows.length}`);

  const exportRows = rows.filter((r) => r.classification === 'HOT' || r.classification === 'WARM');
  for (const r of exportRows) {
    try {
      const sg = JSON.parse(r.signals || '{}');
      const links = Array.isArray(sg.socialLinks) ? sg.socialLinks : [];
      r.social_links = links.filter((u) => !/\/2008\/|profile\.php|facebook\.com\/tr$/i.test(u)).join(' | ');
    } catch { r.social_links = ''; }
  }
  const discardRows = rows.filter((r) => r.classification === 'DISCARD' || r.classification === 'ERROR');
  const unknownRows = rows.filter(
    (r) => !['HOT', 'WARM', 'DISCARD', 'ERROR'].includes(r.classification)
  );
  if (unknownRows.length) {
    warn(
      `${unknownRows.length} scored row(s) have an unrecognised classification and were skipped: ` +
        unknownRows.map((r) => `${r.name} (${r.classification || 'blank'})`).join(', ')
    );
  }

  log(`  exportable (HOT/WARM): ${exportRows.length}`);
  log(`  discards (DISCARD/ERROR): ${discardRows.length}`);

  log('Step 3/4: writing CSV and evidence files...');
  mkdirSync(LEADS_DIR, { recursive: true });

  const byCity = groupByCity(exportRows);
  const dateStr = todayDateString();
  const writtenFiles = [];
  const cityCounts = {};

  for (const [slug, cityRows] of Object.entries(byCity)) {
    cityRows.sort((a, b) => classificationRank(a.classification) - classificationRank(b.classification));
    const hot = cityRows.filter((r) => r.classification === 'HOT').length;
    const warmCount = cityRows.filter((r) => r.classification === 'WARM').length;
    cityCounts[slug] = { hot, warm: warmCount };

    const csvPath = path.join(LEADS_DIR, `${dateStr}-${slug}.csv`);
    const mdPath = path.join(LEADS_DIR, `${dateStr}-${slug}-evidence.md`);
    const cityLabel = cityRows[0]?.city || slug;

    writeCsv(csvPath, cityRows);
    writeEvidenceMd(mdPath, cityRows, cityLabel, dateStr);

    writtenFiles.push(csvPath, mdPath);
    log(`  wrote ${csvPath}`);
    log(`  wrote ${mdPath}`);
  }

  if (exportRows.length === 0) {
    warn('No exportable (HOT/WARM) leads found among scored rows. No CSV/evidence files written.');
  }

  log('Step 4/4: updating lead statuses in n8n...');
  let updateSummary = null;
  if (DRY_RUN) {
    log('  dry run: skipping status updates.');
  } else {
    updateSummary = await updateStatuses(ctx, exportRows, discardRows);
  }

  printSummary({
    cityCounts,
    discardCount: discardRows.length,
    writtenFiles,
    updateSummary,
    dryRun: DRY_RUN,
  });
}

main().catch((e) => fail(`Unexpected error: ${e.stack || e.message}`));
