#!/usr/bin/env node
/**
 * update-files.cjs — update files in a repo you own, over the API, without ever running `git`.
 *
 * Why: on some machines `git push` hangs silently behind a proxy or a broken credential helper.
 * Everything here goes over `api.github.com`, so it either works or tells you exactly which HTTP
 * call failed.
 *
 * Companion to fork-and-pr.cjs: that one opens a PR against *someone else's* repo (fork → branch →
 * PR). This one updates files in *your own* repo directly, and is the right tool when you already
 * have write access and just want the file changed.
 *
 * ⚠️ Scope — pick the right tool:
 *   · this one takes an explicit **file list**, PUTs exactly those paths, and never deletes anything
 *     (no local directory layout required)
 *   · publishing a whole **directory** — where files you did not touch must survive, and CRLF/LF
 *     must not silently rewrite everything — is `safe-publish.cjs`'s job, not this one's
 *
 * Deliberately conservative:
 *   · dry-run by default — without --yes it performs ZERO write requests
 *   · every file is read back after the write and compared **by git blob sha**, not just by size
 *   · the PUT carries the `sha` it read, so if the branch moved in between, GitHub rejects the
 *     write (409) instead of clobbering it — there is deliberately no "force" flag
 *
 * Usage:
 *   node update-files.cjs --repo owner/name --files README.md docs/a.md --message "docs: ..."
 *   node update-files.cjs --repo owner/name --files ... --message "..." --yes
 *   node update-files.cjs --repo owner/name --files ... --message "..." --branch dev --yes
 *
 * Options:
 *   --repo <owner/name>   required
 *   --files <path...>     one or more local file paths (relative to cwd); the remote path is the
 *                         same string, so pass the path as it should appear in the repo
 *   --message <msg>       required — commit message for each file
 *   --branch <name>       default "main"
 *   --token-file <path>   file containing only the token (else $GITHUB_TOKEN)
 *   --yes                 actually write (otherwise dry-run)
 *
 * Exit code: 0 = all files verified, 1 = at least one failure.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

function parseArgs(argv) {
  const out = { files: [], branch: 'main', yes: false, tokenFile: null, repo: null, message: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) out.files.push(argv[++i]); }
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--message') out.message = argv[++i];
    else if (a === '--branch') out.branch = argv[++i];
    else if (a === '--token-file') out.tokenFile = argv[++i];
    else if (a === '--yes') out.yes = true;
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!out.repo || !out.files.length || !out.message) {
    console.error('need --repo, --files (>=1) and --message. See the header comment.');
    process.exit(2);
  }
  return out;
}

function readToken(opts) {
  const fromFile = (p) => fs.readFileSync(p, 'utf8').trim();
  if (opts.tokenFile) return fromFile(opts.tokenFile);
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  // convenience: $DSH_HOME/.secrets/github-token (the DSH layout this was written in)
  const dsh = path.join(process.env.DSH_HOME || path.join(require('os').homedir(), '.dsh'), '.secrets', 'github-token');
  if (fs.existsSync(dsh)) return fromFile(dsh);
  console.error('no token: pass --token-file, set $GITHUB_TOKEN, or create ' + dsh);
  process.exit(2);
}

function api(method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'update-files.cjs',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

(async () => {
  const opts = parseArgs(process.argv);
  const token = readToken(opts);
  const results = [];

  for (const localPath of opts.files) {
    const name = localPath.replace(/\\/g, '/');
    const full = path.resolve(process.cwd(), localPath);
    if (!fs.existsSync(full)) { results.push({ file: name, ok: false, step: 'read-local', msg: 'missing file' }); continue; }

    const content = fs.readFileSync(full);
    const apiPath = `/repos/${opts.repo}/contents/${enc(name)}?ref=${encodeURIComponent(opts.branch)}`;
    const get = await api('GET', apiPath, token);

    // 404 = new file; 200 = update. Anything else is a hard stop.
    if (get.status !== 200 && get.status !== 404) {
      results.push({ file: name, ok: false, step: 'GET', status: get.status, msg: get.json?.message });
      continue;
    }
    const exists = get.status === 200;
    const sha = exists ? get.json.sha : undefined;
    const remoteSize = exists ? get.json.size : null;

    const plan = { file: name, exists, localBytes: content.length, remoteBytes: remoteSize };
    if (!opts.yes) { results.push({ ...plan, ok: true, dry: true }); continue; }

    const put = await api('PUT', `/repos/${opts.repo}/contents/${enc(name)}`, token, {
      message: opts.message,
      content: content.toString('base64'),
      branch: opts.branch,
      ...(sha ? { sha } : {}),
    });
    if (put.status !== 200 && put.status !== 201) {
      results.push({ ...plan, ok: false, step: 'PUT', status: put.status, msg: put.json?.message });
      continue;
    }

    // Read back and compare size + git blob sha — "the API said ok" is not verification.
    const verify = await api('GET', apiPath, token);
    const remoteBlob = verify.json?.sha;
    const localBlob = require('crypto').createHash('sha1')
      .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`, 'utf8'), content]))
      .digest('hex');
    const okSize = verify.status === 200 && verify.json.size === content.length;
    const okBlob = remoteBlob === localBlob;
    results.push({
      ...plan,
      ok: okSize && okBlob,
      status: put.status,
      remoteBytes: verify.json?.size,
      blobMatch: okBlob,
      commit: put.json?.commit?.sha?.slice(0, 8),
    });
  }

  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\nFAILED: ${failed.length}` : `\nALL OK (${results.length} file(s))`);
  process.exit(failed.length ? 1 : 0);
})();
