#!/usr/bin/env node
/**
 * fork-and-pr.cjs — open a pull request without ever running `git`.
 *
 * Why: on some machines (corporate proxies, huge repos, broken credential helpers) `git push`
 * just hangs with no output for many minutes. Everything here goes over `api.github.com`
 * instead, so it either works or tells you exactly which HTTP call failed.
 *
 * It is deliberately conservative:
 *   · dry-run by default — without --yes it performs ZERO write requests (not even the fork)
 *   · every step checks the current state first, so re-running is safe
 *   · it reads the file back from the branch and compares byte-for-byte BEFORE opening the PR
 *
 * Usage:
 *   node fork-and-pr.cjs --config pr.json            # dry-run: prints what it would do
 *   node fork-and-pr.cjs --config pr.json --yes      # do it
 *
 * Token, in priority order:
 *   1. $GITHUB_TOKEN
 *   2. --token-file <path>          (a file containing only the token)
 * Scopes needed: `repo` (public_repo is enough for a public target).
 *
 * pr.json looks like this — every path is relative to the config file's own directory
 * unless it is absolute, so a config and its payload can travel together:
 * {
 *   "upstream":  "owner/repo",              // the repository you want to contribute to
 *   "owner":     "your-github-login",       // your account; the fork lives under it
 *   "branch":    "add-my-entry",
 *   "file":      "payload/my-entry.yml",    // local file to upload
 *   "dest":      "data/entries/my-entry.yml", // path inside the repo
 *   "message":   "Add my-entry",
 *   "title":     "Add my-entry",
 *   "bodyFile":  "payload/pr-body.md"
 * }
 */

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argOf(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const YES = argv.includes('--yes');
const CONFIG = argOf('--config');
const TOKEN_FILE = argOf('--token-file');

if (!CONFIG) {
  console.error('usage: node fork-and-pr.cjs --config <pr.json> [--yes] [--token-file <path>]');
  process.exit(2);
}

function die(msg, extra) {
  console.error('\nFAILED: ' + msg);
  if (extra) console.error(String(extra).slice(0, 800));
  process.exit(1);
}

// ── config ───────────────────────────────────────────────────────────────────
const cfgPath = path.resolve(CONFIG);
if (!fs.existsSync(cfgPath)) die('config not found: ' + cfgPath);
let cfg;
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
catch (e) { die('config is not valid JSON: ' + e.message); }

const baseDir = path.dirname(cfgPath);
const resolveLocal = (p) => (path.isAbsolute(p) ? p : path.join(baseDir, p));

for (const k of ['upstream', 'owner', 'branch', 'file', 'dest', 'message', 'title']) {
  if (!cfg[k]) die(`config is missing "${k}"`);
}
const LOCAL_FILE = resolveLocal(cfg.file);
const LOCAL_BODY = cfg.bodyFile ? resolveLocal(cfg.bodyFile) : null;
if (!fs.existsSync(LOCAL_FILE)) die('file to upload not found: ' + LOCAL_FILE);
if (LOCAL_BODY && !fs.existsSync(LOCAL_BODY)) die('bodyFile not found: ' + LOCAL_BODY);

const UPSTREAM = cfg.upstream;
const OWNER = cfg.owner;
const ME = `${OWNER}/${UPSTREAM.split('/')[1]}`;
const BRANCH = cfg.branch;
const DEST = cfg.dest.replace(/^\/+/, '');

// ── token ────────────────────────────────────────────────────────────────────
let token = process.env.GITHUB_TOKEN || '';
if (!token && TOKEN_FILE) {
  const p = path.resolve(TOKEN_FILE.replace(/^~/, os.homedir()));
  if (!fs.existsSync(p)) die('token file not found: ' + p);
  token = fs.readFileSync(p, 'utf8').trim();
}
if (!token) die('no token: set $GITHUB_TOKEN or pass --token-file <path>');

// ── http ─────────────────────────────────────────────────────────────────────
function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath.startsWith('/') ? apiPath : '/' + apiPath,
      method,
      headers: {
        'User-Agent': 'fork-and-pr',
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { /* leave raw text */ }
        resolve({ status: res.statusCode, json, text: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const log = (s) => console.log(s);

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  log('==========================================================');
  log(YES ? ' LIVE MODE (--yes)' : ' DRY RUN (default) — add --yes to actually do it');
  log('==========================================================');

  const fileText = fs.readFileSync(LOCAL_FILE, 'utf8');
  const fileBytes = Buffer.byteLength(fileText, 'utf8');
  const bodyText = LOCAL_BODY ? fs.readFileSync(LOCAL_BODY, 'utf8') : (cfg.body || '');

  log('\n[0] payload');
  log(`    ${DEST}`);
  log(`      ${fileBytes} B, ${fileText.split('\n').length} lines`);
  log(`    body: ${Buffer.byteLength(bodyText, 'utf8')} B`);

  log('\n[1] upstream reachable?');
  const up = await api('GET', `/repos/${UPSTREAM}`);
  if (up.status !== 200) die(`upstream ${UPSTREAM} not reachable (HTTP ${up.status})`, up.text);
  const BASE = up.json.default_branch || 'main';
  log(`    OK ${up.json.full_name}  (default branch: ${BASE})`);

  log('\n[2] does the target path already exist upstream?');
  const exists = await api('GET', `/repos/${UPSTREAM}/contents/${DEST}`);
  if (exists.status === 200) die(`${DEST} already exists upstream — someone may have added it; check by hand`, exists.text);
  log(`    OK not present (HTTP ${exists.status})`);

  log('\n[3] fork present?');
  const fk = await api('GET', `/repos/${ME}`);
  const hasFork = fk.status === 200;
  log(hasFork ? `    OK exists: ${fk.json.full_name} (will reuse)` : '    -> not there yet, will create');

  if (!YES) {
    log('\n----------------------------------------------------------');
    log(' dry run finished. With --yes it would do:');
    if (!hasFork) log(`   1. POST /repos/${UPSTREAM}/forks`);
    log(`   2. GET  /repos/${ME}/git/ref/heads/${BASE}`);
    log(`   3. POST /repos/${ME}/git/refs                 (create ${BRANCH})`);
    log(`   4. PUT  /repos/${ME}/contents/${DEST}   (${fileBytes} B)`);
    log('   5. GET  read back the file and compare byte-for-byte');
    log(`   6. POST /repos/${UPSTREAM}/pulls              (base=${BASE})`);
    log('----------------------------------------------------------');
    return;
  }

  // ── writes start here ──────────────────────────────────────────────────────
  if (!hasFork) {
    log(`\n[4] creating fork…`);
    const r = await api('POST', `/repos/${UPSTREAM}/forks`, { default_branch_only: true });
    if (r.status !== 202 && r.status !== 200) die(`fork failed (HTTP ${r.status})`, r.text);
    log(`    OK ${r.json.full_name} — created, waiting for it to become available`);
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      const c = await api('GET', `/repos/${ME}`);
      if (c.status === 200) { log(`    OK ready after ${i + 1} poll(s)`); ready = true; break; }
    }
    if (!ready) die('fork did not become available within ~30s — re-run the same command later; it will reuse it');
  }

  log(`\n[5] reading ${ME}:${BASE} head…`);
  const ref = await api('GET', `/repos/${ME}/git/ref/heads/${BASE}`);
  if (ref.status !== 200) die(`could not read the base ref (HTTP ${ref.status})`, ref.text);
  const baseSha = ref.json.object.sha;
  log(`    OK ${baseSha.slice(0, 12)}…`);

  log(`\n[6] creating branch ${BRANCH}…`);
  const mk = await api('POST', `/repos/${ME}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: baseSha });
  if (mk.status === 201) log('    OK created');
  else if (mk.status === 422) log('    OK already exists, reusing');
  else die(`could not create the branch (HTTP ${mk.status})`, mk.text);

  log(`\n[7] committing ${DEST} (${fileBytes} B, base64)…`);
  const put = await api('PUT', `/repos/${ME}/contents/${DEST}`, {
    message: cfg.message,
    content: Buffer.from(fileText, 'utf8').toString('base64'),
    branch: BRANCH,
  });
  if (put.status !== 201 && put.status !== 200) die(`commit failed (HTTP ${put.status})`, put.text);
  log(`    OK commit ${put.json.commit.sha.slice(0, 12)}…`);

  log('\n[8] reading the file back from the branch and comparing');
  const back = await api('GET', `/repos/${ME}/contents/${DEST}?ref=${BRANCH}`);
  if (back.status !== 200) die(`read-back failed (HTTP ${back.status})`, back.text);
  const remoteText = Buffer.from(back.json.content, 'base64').toString('utf8');
  const same = remoteText === fileText;
  log(`    local ${fileBytes} B / remote ${Buffer.byteLength(remoteText, 'utf8')} B => ${same ? 'identical' : 'MISMATCH'}`);
  if (!same) die('remote content differs from local — stopped before opening the PR. Compare by hand.');

  log(`\n[9] opening the pull request against ${UPSTREAM}:${BASE}…`);
  const pr = await api('POST', `/repos/${UPSTREAM}/pulls`, {
    title: cfg.title,
    head: `${OWNER}:${BRANCH}`,
    base: BASE,
    body: bodyText,
  });
  if (pr.status === 201) {
    log(`    OK PR #${pr.json.number}`);
    log(`    ${pr.json.html_url}`);
  } else if (pr.status === 422) {
    log('    NOTE: HTTP 422 — a pull request for this branch may already exist. Look here:');
    log(`    https://github.com/${UPSTREAM}/pulls?q=is%3Apr+head%3A${OWNER}%3A${BRANCH}`);
  } else die(`could not open the PR (HTTP ${pr.status})`, pr.text);

  log('\n==========================================================');
  log(' done');
  log('==========================================================');
})().catch((e) => die('unexpected error', e && e.stack));
