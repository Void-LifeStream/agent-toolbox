#!/usr/bin/env node
'use strict';
/**
 * safe-publish.cjs — 往 GitHub 仓库发布"改动"，而不是"整个目录"
 *
 * ── 为什么有这个脚本（2026-10-19 事故的直接产物）──────────────────────────
 * 本机 `git push` **会挂**：github.com:443 不通（实测 `Failed to connect after 21s`），
 * 而 api.github.com 可直连。所以发布一律走 REST API。
 *
 * 但 `publish-dir.cjs` **不能用在"本地落后于远端"的目录上** —— 它把**本地完整 tree**
 * 推上去，于是远端多出来的文件（`docs/…`）与别人后来加的几行（`package.json`）会被一起抹掉。
 * 2026-10-19 01:5x 就是这样把 `dsch-cuda` 的 `docs/cuda-run.png` 删了、`package.json` 少了 4 行
 * （已回滚，报告 §37 有完整复盘）。
 *
 * ── 它和 publish-dir 的区别（三条）──────────────────────────────────────
 *   ① **基于 `base_tree` 提交** ⇒ 只在**远端最新 tree**上"增/改"，**远端独有的文件自动保留**
 *   ② **默认拒绝"远端有、本地没有"的删除**（要删必须显式 `--allow-delete`）
 *   ③ **发布前检查行尾** —— 本地 CRLF / 远端 LF 会让整个文件"变了"（+93/-93 那种）
 *      默认中止；`--fix-eol` 会在**只可能是换行符差异**时自动转成远端的形式
 *
 * ── 它还会在发布后自检 ─────────────────────────────────────────────────
 * 用 `/compare/<parent>...<new>` 断言"**只有预期文件变了**"，不是靠"工具说成功了"。
 *
 * USAGE:
 *   node safe-publish.cjs <owner/repo> <local-dir> --message <file> [--branch main]
 *                         [--dry-run] [--fix-eol] [--allow-delete]
 *                         [--only <path>]... [--skip <name>]...
 *
 *   --only <path>  只发布这个路径（可重复）。用于"本地落后于远端、只改了其中几个文件"的场景 ——
 *                  否则本地落后造成的"假 modified"（例如 package.json 少几行）会被一起发布。
 *
 * Token 从 `TOKEN_PATH` 读（默认 `~/.dsh/.secrets/github-token`，改这个常量即可换位置）—— **永不打印、永不上命令行**。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const crypto = require('crypto');

const TOKEN_PATH = path.join(os.homedir(), '.dsh', '.secrets', 'github-token');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', '.DS_Store']);

function fail(msg) { console.error('error: ' + msg); process.exit(1); }
function log(msg) { console.log(msg); }

// ---------- args ----------
const argv = process.argv.slice(2);
if (argv.length < 2) fail('usage: node safe-publish.cjs <owner/repo> <local-dir> --message <file> [--branch main] [--dry-run] [--fix-eol] [--allow-delete]');
const repo = argv[0];
const localDir = path.resolve(argv[1]);
let messageFile = null, branch = 'main', dryRun = false, fixEol = false, allowDelete = false;
const extraSkip = [];
const onlyFilters = [];   // --only <path>：只发布这些路径（用于"本地落后于远端、只改了其中几个文件"的场景）
for (let i = 2; i < argv.length; i++) {
  const f = argv[i];
  if (f === '--message') messageFile = argv[++i];
  else if (f === '--branch') branch = argv[++i];
  else if (f === '--dry-run') dryRun = true;
  else if (f === '--fix-eol') fixEol = true;
  else if (f === '--allow-delete') allowDelete = true;
  else if (f === '--skip') extraSkip.push(argv[++i]);
  else if (f === '--only') {
    // ⚠️ 2026-10-19 复盘 #3：原来直接 push(argv[++i]) —— 漏传值时 push 进 undefined，
    //    结果是"过滤器开着但什么都匹配不上" ⇒ 静默变成"没有需要发布的改动"。
    const v = argv[++i];
    if (!v || v.startsWith('--')) fail('--only needs a path (e.g. --only README.md)');
    onlyFilters.push(v);
  }
  else fail('unknown option: ' + f);
}
if (!messageFile) fail('--message <file> is required');
if (!fs.existsSync(TOKEN_PATH)) fail('token file not found: ' + TOKEN_PATH);
if (!fs.existsSync(localDir) || !fs.statSync(localDir).isDirectory()) fail('not a directory: ' + localDir);
const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const message = fs.readFileSync(messageFile, 'utf8').trim();

// ---------- api ----------
function api(method, apiPath, body, { allow404 = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      hostname: 'api.github.com', path: apiPath, method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-safe-publish',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode === 404 || res.statusCode === 409) && allow404) return resolve(null);
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${method} ${apiPath} -> ${res.statusCode} ${text.slice(0, 300)}`));
        try { resolve(text === '' ? null : JSON.parse(text)); }
        catch { reject(new Error(`${method} ${apiPath} -> unparsable body`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- helpers ----------
function gitBlobSha(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

function collectFiles(dir, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || extraSkip.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...collectFiles(full, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/** CRLF/LF 统计。返回 {crlf, lfOnly}，lfOnly 是"前面不是 \r 的 \n"。 */
function lineEnds(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const allN = (text.match(/\n/g) || []).length;
  return { crlf, lfOnly: allN - crlf };
}

/**
 * 快速二进制判定：前 8 KiB 里出现 NUL 就当二进制。
 * ⚠️ 2026-10-19 复盘 #4：二进制绝不能走行尾统计/转换 ——
 * `replace(/\r\n/g,'\n')` 打在 PNG/JPEG 上会**把文件改坏**，而且 sha 变了还自以为"统一了行尾"。
 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 把本地行尾统一成远端的形态 —— **只在两边都是"纯"行尾时**动手：
 *   本地纯 CRLF + 远端纯 LF   ⇒ 转 LF
 *   本地纯 LF   + 远端纯 CRLF ⇒ 转 CRLF
 * 混合行尾（既有 \r\n 又有裸 \n）一律不碰（那多半是作者故意的）。
 * ⚠️ **不要求内容相同** —— 内容本来就改了，行尾照样要统一，
 *    否则整个文件在 GitHub 上会显示为"全变了"（2026-10-19 事故，报告 §37）。
 */
function normalizeEol(localBuf, remoteText) {
  const localText = localBuf.toString('utf8');
  const L = lineEnds(localText), R = lineEnds(remoteText);
  const localPureCrlf = L.crlf > 0 && L.lfOnly === 0;
  const localPureLf = L.crlf === 0;
  const remotePureLf = R.crlf === 0;
  const remotePureCrlf = R.crlf > 0 && R.lfOnly === 0;
  if (localPureCrlf && remotePureLf) return Buffer.from(localText.replace(/\r\n/g, '\n'), 'utf8');
  if (localPureLf && remotePureCrlf) return Buffer.from(localText.replace(/\n/g, '\r\n'), 'utf8');
  return null;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; results[i] = await worker(items[i], i); }
  }));
  return results;
}

// ---------- main ----------
(async () => {
  log(`${repo}  branch ${branch}${dryRun ? '   [DRY RUN]' : ''}`);

  // ① 远端 head + base tree
  const ref = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`, undefined, { allow404: true });
  if (!ref) fail(`branch ${branch} not found in ${repo}`);
  const headSha = ref.object.sha;
  const headCommit = await api('GET', `/repos/${repo}/git/commits/${headSha}`);
  const baseTreeSha = headCommit.tree.sha;
  const tree = await api('GET', `/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`);
  // ⚠️ 2026-10-19 复盘补：GitHub 对超大 tree 会截断（truncated:true）。此时"远端有哪些文件"
  //    的判断是**残缺的** ⇒ 可能把远端已有文件当"新增"、或漏掉 base_tree 之外的比较基准。
  //    宁可不发，也不能带着残缺的基准发。
  if (tree.truncated) {
    fail(`远端 tree 被 GitHub 截断（读到 ${tree.tree.length} 项，truncated=true）—— 仓库太大，本工具不适用；请改用 publish-dir 或缩小 --only 范围`);
  }
  const remote = new Map();
  for (const e of tree.tree) if (e.type === 'blob') remote.set(e.path, e.sha);
  log(`  remote head ${headSha.slice(0, 12)} · tree ${baseTreeSha.slice(0, 12)} · ${remote.size} 个 blob`);

  // ② 本地
  const files = collectFiles(localDir);
  const local = new Map();
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(localDir, rel));
    local.set(rel, { sha: gitBlobSha(buf), buf, size: buf.length });
  }
  log(`  local  ${files.length} 个文件 · ${(files.reduce((s, r) => s + local.get(r).size, 0) / 1024).toFixed(1)} KiB`);

  // ③ 对比
  const added = [], modified = [], identical = [];
  for (const [p, v] of local) {
    if (!remote.has(p)) added.push(p);
    else if (remote.get(p) !== v.sha) modified.push(p);
    else identical.push(p);
  }
  const remoteOnly = [...remote.keys()].filter((p) => !local.has(p)).sort();

  log(`  added ${added.length} · modified ${modified.length} · identical ${identical.length} · remote-only ${remoteOnly.length}`);
  if (added.length) log(`    + ${added.join(', ')}`);
  if (modified.length) log(`    ~ ${modified.join(', ')}`);

  // ④ ⚠️ 远端有、本地没有 —— 默认保留（因为用 base_tree，本来就不会删）
  if (remoteOnly.length) {
    if (allowDelete) log(`    - 将删除：${remoteOnly.join(', ')}   (--allow-delete)`);
    else log(`    ⚠️ 远端独有 ${remoteOnly.length} 个文件，**将自动保留**（本工具用 base_tree，不覆盖）：${remoteOnly.slice(0, 8).join(', ')}${remoteOnly.length > 8 ? ' …' : ''}`);
  }

  // ⑤ 行尾检查（只对 modified —— added 没有"远端版本"可比）
  const eolPlan = new Map();   // path -> Buffer（转换后的内容）
  const eolBad = [];
  await mapLimit(modified, 4, async (p) => {
    // ⚠️ 2026-10-19 复盘 #4：二进制不做行尾统计/转换（`replace(/\r\n/g,'\n')` 会把 PNG/JPEG 改坏）
    if (looksBinary(local.get(p).buf)) { log(`    ⏭ ${p}: 二进制，跳过行尾检查`); return; }
    const blob = await api('GET', `/repos/${repo}/git/blobs/${remote.get(p)}`);
    const remoteText = Buffer.from(blob.content || '', 'base64').toString('utf8');
    const loc = lineEnds(local.get(p).buf.toString('utf8'));
    const rem = lineEnds(remoteText);
    const looksEol = (loc.crlf > 0 && rem.crlf === 0) || (loc.crlf === 0 && rem.crlf > 0);
    if (!looksEol) return;
    const converted = normalizeEol(local.get(p).buf, remoteText);
    if (converted) {
      eolPlan.set(p, converted);
      log(`    ⚠️ 行尾差异 ${p}: local CRLF=${loc.crlf}/LF=${loc.lfOnly} · remote CRLF=${rem.crlf}/LF=${rem.lfOnly} ⇒ ${fixEol ? '已转成远端形态' : '**整文件会显示为变化**（加 --fix-eol 自动转）'}`);
    } else {
      eolBad.push(p);
      log(`    ⚠️ ${p}: 行尾不是"纯 CRLF vs 纯 LF"（混合行尾？）⇒ 不自动转，请手工确认`);
    }
  });

  if (eolBad.length) fail(`有 ${eolBad.length} 个文件的行尾无法自动处理（${eolBad.join(', ')}）—— 请手工统一后再发`);
  if (eolPlan.size && !fixEol) {
    if (dryRun) log(`    （dry-run：加 --fix-eol 才会把上面 ${eolPlan.size} 个文件转成远端行尾；否则它们会整文件重写）`);
    else fail(`有 ${eolPlan.size} 个文件行尾与远端不同 —— 加 --fix-eol 自动转，或先手工统一`);
  }

  // ⑥ 组装要提交的 changes（受 --only 过滤）
  const changes = [];
  const skipped = [];
  for (const p of [...added, ...modified]) {
    if (onlyFilters.length && !onlyFilters.includes(p)) { skipped.push(p); continue; }
    const useBytes = eolPlan.has(p) && fixEol ? eolPlan.get(p) : local.get(p).buf;
    const useSha = gitBlobSha(useBytes);
    if (useSha === remote.get(p)) { log(`    = ${p}: 转换后与远端一致，跳过`); continue; }
    changes.push({ path: p, bytes: useBytes, sha: useSha, isNew: added.includes(p) });
  }
  if (skipped.length) log(`  ⏭ --only 排除了 ${skipped.length} 个"看起来变了"的文件（**不会被执行**）：${skipped.join(', ')}`);
  if (changes.length === 0) { log('  没有需要发布的改动。'); return; }

  log(`  ⇒ 实际提交 ${changes.length} 个文件：${changes.map((c) => c.path).join(', ')}`);
  if (dryRun) { log('  [DRY RUN] 未写入。'); return; }

  // ⑦ blob
  await mapLimit(changes, 4, async (c) => {
    const b = await api('POST', `/repos/${repo}/git/blobs`, { content: c.bytes.toString('base64'), encoding: 'base64' });
    c.blobSha = b.sha;
  });

  // ⑧ tree（base_tree！远端独有文件自动保留）
  const treeBody = {
    base_tree: baseTreeSha,
    tree: changes.map((c) => ({ path: c.path, mode: '100644', type: 'blob', sha: c.blobSha })),
  };
  for (const p of remoteOnly) if (allowDelete) treeBody.tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
  const newTree = await api('POST', `/repos/${repo}/git/trees`, treeBody);

  // ⑨ commit
  const newCommit = await api('POST', `/repos/${repo}/git/commits`, { message, tree: newTree.sha, parents: [headSha] });

  // ⑩ ref
  await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: newCommit.sha, force: false });

  log(`  ✅ commit ${newCommit.sha.slice(0, 12)} · tree ${newTree.sha.slice(0, 12)}`);
  log(`     ${repo}`);

    // ⑪ 自检：compare 应只有预期文件
    //   ⚠️ 2026-10-19 复盘补：**删除也必须纳入自检** —— §37 那次事故正是"删了 docs/"而工具仍说成功。
    const cmp = await api('GET', `/repos/${repo}/compare/${headSha}...${newCommit.sha}`);
    const cmpFiles = cmp.files || [];
    const expected = changes.map((c) => c.path).sort();
    const expectedDeletes = allowDelete ? remoteOnly.slice().sort() : [];
    const actual = cmpFiles.filter((f) => f.status !== 'removed').map((f) => f.filename).sort();
    const extra = actual.filter((p) => !expected.includes(p));
    const missing = expected.filter((p) => !actual.includes(p));
    const actualDeleted = cmpFiles.filter((f) => f.status === 'removed').map((f) => f.filename).sort();
    const unexpectedDelete = actualDeleted.filter((p) => !expectedDeletes.includes(p));
    const notDeleted = expectedDeletes.filter((p) => !actualDeleted.includes(p));
    log(`  self-check: compare 显示 ${cmpFiles.length} 个文件${allowDelete ? '（含 --allow-delete 的删除）' : ''}`);
    if (extra.length || missing.length || unexpectedDelete.length || notDeleted.length) {
      log('  ⚠️ 自检不一致：');
      if (extra.length) log(`     多出（不该变却变了）：${JSON.stringify(extra)}`);
      if (missing.length) log(`     缺少（该变却没变）：${JSON.stringify(missing)}`);
      if (unexpectedDelete.length) log(`     🚨 意外删除：${JSON.stringify(unexpectedDelete)}`);
      if (notDeleted.length) log(`     声明要删但没删：${JSON.stringify(notDeleted)}`);
      process.exit(2);
    }
    log(`  ✅ 自检通过：恰好 ${expected.length} 个改了${expectedDeletes.length ? ('、' + expectedDeletes.length + ' 个删了') : ''}，无意外删除`);
})().catch((e) => fail(e && e.message ? e.message : String(e)));
