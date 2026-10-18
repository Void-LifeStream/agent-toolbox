# agent-toolbox

Small, dependency-free tools that came out of giving an AI coding agent a real desktop to work on.
Each one solves something the standard toolchain did not cover — and each one is here because
it was actually needed, not because it looked like a nice idea.

| tool | what it does | needs |
|---|---|---|
| [`shot-window.ps1`](shot-window.ps1) | Capture **any** window to a PNG — including Electron / Chromium windows, which come out pure black unless you know about `PrintWindow`'s `nFlags=2` | Windows, PowerShell 5.1+ |
| [`fork-and-pr.cjs`](fork-and-pr.cjs) | Open a pull request **without `git`**: fork → branch → commit → read-back verify → PR, entirely over `api.github.com` | Node 18+ (no packages) |
| [`update-files.cjs`](update-files.cjs) | Update files in **your own** repo without `git` — dry-run by default; every write is read back and compared by **git blob sha**, not just size | Node 18+ (no packages) |
| [`print-checklist/`](print-checklist/) | Render a JSON checklist into a printable A4 sheet — tick boxes, group headers, footer; preview as PNG, print, or export PDF | Windows, PowerShell 7 |
| [`mnemon-orphans.cjs`](mnemon-orphans.cjs) | Count what a memory space holds that the **main store does not** — the only safe basis for deactivating or deleting a duplicate space | Node 22.5+ (built-in `node:sqlite`, no packages) |

None of them installs anything, and none of them talks to a service you did not name.

---

## shot-window.ps1

Screenshot tooling usually covers the browser and the phone, and then stops. But sometimes the
window you need is just… a window.

```powershell
pwsh -File shot-window.ps1 -List                      # what can I capture?
pwsh -File shot-window.ps1 -Match notepad             # fuzzy match on title or process
pwsh -File shot-window.ps1 -WinPid 1234               # exact window
pwsh -File shot-window.ps1 -Match code -Out shot.png  # explicit output
```

It refuses to hand you a black image: after capturing it samples ~400 pixels and **exits 4 with a
warning** if more than 90% of them are near-black. That check exists because of a genuinely nasty
trap —

> Chromium and Electron windows render **pure black** through `PrintWindow` unless you pass
> `nFlags = 2` (`PW_RENDERFULLCONTENT`). The API still returns `True`. If you do not know this,
> you will spend an hour convinced the window "hasn't rendered yet".

Three other things it does on purpose: it refuses minimized windows (unreliable) unless you pass
`-AllowMinimized`, it refuses to guess when your match is ambiguous, and it exits with distinct
codes (`1` no match, `2` bad args, `3` minimized, `4` black-image guard) so a script can branch.

## fork-and-pr.cjs

`git push` occasionally hangs forever with zero output — proxies, credential helpers, very large
repos. This does the same job over the REST API, so a failure is an HTTP status instead of a
silent wait.

```bash
export GITHUB_TOKEN=...            # scope: repo (public_repo is enough for a public target)
node fork-and-pr.cjs --config pr.json          # dry run: prints every step, writes nothing
node fork-and-pr.cjs --config pr.json --yes    # for real
```

`pr.json`:

```json
{
  "upstream": "owner/repo",
  "owner":    "your-login",
  "branch":   "add-my-entry",
  "file":     "payload/my-entry.yml",
  "dest":     "data/entries/my-entry.yml",
  "message":  "Add my-entry",
  "title":    "Add my-entry",
  "bodyFile": "payload/pr-body.md"
}
```

Paths resolve relative to the config file, so a config and its payload travel together.

The part worth copying even if you write your own: **step 8 reads the file back from the branch
and compares it byte-for-byte before opening the PR.** Uploading the right bytes and *believing*
you uploaded the right bytes are different things, and only one of them is checkable.

It is also dry-run by default. Without `--yes` it does not create the fork, the branch, or
anything else — it just prints the six calls it would make.

## update-files.cjs

The other half of `fork-and-pr.cjs`. That one is for repos you *don't* own (fork → branch → PR);
this one is for repos you **do** — it PUTs the file and stops, because you already have write
access and a PR would just be ceremony.

```bash
export GITHUB_TOKEN=...
node update-files.cjs --repo me/proj --files README.md docs/a.md --message "docs: ..."        # dry run
node update-files.cjs --repo me/proj --files README.md docs/a.md --message "docs: ..." --yes    # for real
```

Same two ideas as its sibling, plus one:

- **dry-run unless `--yes`** — without it, zero write requests.
- **it distinguishes "new" from "update"** — the read happens first, so a 404 is reported as a
  create, not as an error. (The `sha` is only sent for files that already exist.)
- **read-back verification by git blob sha** — after the PUT it fetches the file again and compares
  **size and blob sha**, not just "the API returned 200". A 200 means the call was accepted; it does
  not mean the branch now holds the bytes you sent.

The sha is computed locally the way git does it — `sha1("blob <len>\0" + content)` — which makes the
comparison independent of how the server stores the file. If you compare only sizes, a same-length
edit slips through; hashing is the cheapest way to close that gap.

`README.md` is a good example of why the local path *is* the remote path: run the tool from a
directory laid out like the repo (`README.md`, `docs/a.md`, …) and nothing needs mapping.

## print-checklist.ps1

Printing a tick-box checklist from a script usually means placing every line by hand — and then
finding out that the preview and the printout disagree. They do, if you use `GraphicsUnit.Display`:
it means *1/100 inch* on a printer but *one pixel* on the bitmap you preview into, so the same code
lays out at two different scales and even measures its own text differently. This tool uses points
everywhere, so the page you approve is the page that prints.

```powershell
pwsh -File print-checklist/print-checklist.ps1 print-checklist/examples/vehicle-inspection.json
pwsh -File print-checklist/print-checklist.ps1 print-checklist/examples/vehicle-inspection.json -Mode print -Copies 4
```

The checklist itself is just JSON; see [print-checklist/README.md](print-checklist/README.md) for the
spec, the flags and the long version of the trap above.


## mnemon-orphans.cjs

[mnemon](https://github.com/omdsh-dev/dsh-mnemon) keeps one SQLite database per "memory space".
A sync or merge can leave you with several spaces holding the same content — and a duplicate looks
complete: same row count, same titles, nothing obviously wrong. Before you deactivate or delete one,
there is exactly one question worth asking:

> **How many of these entries exist only here?**

Three ways to answer it, and two of them are wrong:

| approach | why it fails |
|---|---|
| count rows | a duplicate has the same count as its source — it tells you nothing |
| compare ids | a copy keeps the ids, but a *re-imported* entry gets a **new id** for the same text, so ids under-report "same knowledge" |
| **compare content hashes** | ✅ what this script does: sha256 of `content`, independent of id and row order |

```bash
node mnemon-orphans.cjs                        # base = "default", scan every other space
node mnemon-orphans.cjs --data ~/.mnemon/data
node mnemon-orphans.cjs --json                 # machine-readable
node mnemon-orphans.cjs --top 20               # orphan titles to print per space
```

Read-only: no writes, no deletes, no registry changes. Exit codes: `0` every space is fully
redundant · `1` at least one space holds orphans · `2` the base store could not be read.

The run that motivated it: 13 spaces, **652 entries** across the non-base ones, and **0 orphans** in
eight of them — pure copies, safe to switch off. Two spaces held **6 entries between them** that
existed nowhere else. Counting rows would have said "they all look complete"; comparing by id would
have missed two of the six.

⚠️ What this tool deliberately does **not** answer: whether a space is currently active. That lives
in the plugin registry's `active` field, and it is worth checking separately — writing into a
deactivated space silently re-activates it upstream, and some health reports keep printing a space
as "protected" long after it was switched off. **Check the registry field, not a screenshot.**

---

## License

MIT — see [LICENSE](LICENSE).
