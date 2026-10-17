#!/usr/bin/env node
/**
 * mnemon-orphans.cjs — how much does a memory space hold that the main store does not?
 *
 * Why this exists: mnemon keeps one SQLite database per "memory space", and a sync or merge can
 * leave you with several spaces holding the same content. A copy looks complete — same row count,
 * same titles — so before deactivating or deleting one, the only question that matters is:
 *
 *     how many of these entries exist ONLY here?
 *
 * Three ways to answer it, and why two of them are wrong:
 *   · counting rows            → a copy has the same count as its source. Tells you nothing.
 *   · comparing ids            → a copy keeps the ids, but a re-imported entry gets a NEW id for
 *                                the same text, so ids under-report "same knowledge".
 *   · comparing content hashes → ✅ what this script does. sha256 of `content` is what "the same
 *                                knowledge" means here, regardless of id or row order.
 *
 * ⚠️ The trap worth knowing: `active` in the registry is not the whole story. Writing into a
 * deactivated space silently re-activates it upstream, and some tools print a space as
 * `[protected]` long after it was deactivated — so check the registry's `active` field, not a
 * screenshot of a health report.
 *
 * Read-only. Never writes, never deletes, never touches the registry.
 *
 * Usage:
 *   node mnemon-orphans.cjs                          # base = "default"; scan every other space
 *   node mnemon-orphans.cjs --base default
 *   node mnemon-orphans.cjs --data "C:\Users\me\.mnemon\data"
 *   node mnemon-orphans.cjs --json                   # machine-readable output
 *   node mnemon-orphans.cjs --top 20                 # orphan titles to print per space (default 5)
 *
 * Exit codes:
 *   0 — every scanned space is fully redundant (no orphans anywhere)
 *   1 — at least one space holds content the base store does not have
 *   2 — the base store could not be read
 *
 * Requires Node 22.5+ for the built-in `node:sqlite` module. No packages, no network.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('This script needs Node 22.5+ (built-in node:sqlite). Current: ' + process.version);
  process.exit(2);
}

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const DATA = flag('--data', path.join(os.homedir(), '.mnemon', 'data'));
const BASE = flag('--base', 'default');
const TOP = Number(flag('--top', '5'));
const JSON_OUT = has('--json');

const hash = (s) => crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');

function readSpace(dir) {
  const file = path.join(DATA, dir, 'mnemon.db');
  if (!fs.existsSync(file)) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT id, content, category, importance FROM insights').all();
    db.close();
    return rows;
  } catch (e) {
    return { error: e.message };
  }
}

function spaceNames() {
  // Optional: the DSH plugin's registry carries human names. Purely cosmetic — ignore if absent.
  const reg = path.join(DATA, '.dsh-memory-bodies.json');
  if (!fs.existsSync(reg)) return {};
  try {
    const bodies = JSON.parse(fs.readFileSync(reg, 'utf8')).bodies || [];
    return Object.fromEntries(bodies.map((b) => [b.id, { name: b.name, active: b.active }]));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- base
const baseRows = readSpace(BASE);
if (!baseRows || baseRows.error) {
  console.error(`Cannot read the base store "${BASE}" under ${DATA}` +
    (baseRows && baseRows.error ? `: ${baseRows.error}` : ''));
  process.exit(2);
}
const baseHashes = new Set(baseRows.map((r) => hash(r.content)));
const names = spaceNames();

// ---------------------------------------------------------------- scan
const dirs = fs.readdirSync(DATA, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== BASE)
  .map((d) => d.name)
  .sort();

const report = [];
let anyOrphans = false;

for (const dir of dirs) {
  const rows = readSpace(dir);
  if (rows === null) continue;                      // directory without a database — skip
  if (rows.error) { report.push({ space: dir, error: rows.error }); continue; }

  const orphans = rows.filter((r) => !baseHashes.has(hash(r.content)));
  if (orphans.length) anyOrphans = true;
  report.push({
    space: dir,
    name: (names[dir] && names[dir].name) || '',
    registryActive: names[dir] ? names[dir].active : null,
    total: rows.length,
    orphans: orphans.length,
    orphansPreview: orphans.slice(0, TOP).map((r) => ({
      id: r.id,
      category: r.category,
      importance: r.importance,
      head: String(r.content || '').replace(/\s+/g, ' ').slice(0, 110),
    })),
  });
}

// ---------------------------------------------------------------- output
if (JSON_OUT) {
  console.log(JSON.stringify({ data: DATA, base: BASE, baseEntries: baseRows.length, spaces: report }, null, 2));
} else {
  console.log(`base "${BASE}": ${baseRows.length} entries (${baseHashes.size} distinct contents)`);
  console.log(`data: ${DATA}\n`);
  for (const s of report) {
    const id = s.space.slice(0, 8);
    if (s.error) { console.log(`  ${id}  ! ${s.error}`); continue; }
    const flagTxt = s.registryActive === null ? '' : (s.registryActive ? ' [active]' : ' [inactive]');
    const verdict = s.orphans === 0 ? 'fully redundant — safe to deactivate' : `⚠ ${s.orphans} orphan(s)`;
    console.log(`  ${id}  ${String(s.total).padStart(4)} entries  →  ${verdict}${flagTxt}`);
    for (const o of s.orphansPreview) {
      console.log(`         · ${o.id.slice(0, 8)} [${o.category}] ${o.head}`);
    }
    if (s.orphans > s.orphansPreview.length) {
      console.log(`         … ${s.orphans - s.orphansPreview.length} more (use --top N to see them)`);
    }
  }
  console.log('\nA space with 0 orphans can be deactivated without losing knowledge.');
  console.log('A space with orphans: import those entries into the base store first.');
}

process.exit(anyOrphans ? 1 : 0);
