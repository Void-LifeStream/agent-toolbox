# agent-toolbox

Small, dependency-free tools that came out of giving an AI coding agent a real desktop to work on.
Each one solves something the standard toolchain did not cover — and each one is here because
it was actually needed, not because it looked like a nice idea.

| tool | what it does | needs |
|---|---|---|
| [`shot-window.ps1`](shot-window.ps1) | Capture **any** window to a PNG — including Electron / Chromium windows, which come out pure black unless you know about `PrintWindow`'s `nFlags=2` | Windows, PowerShell 5.1+ |
| [`fork-and-pr.cjs`](fork-and-pr.cjs) | Open a pull request **without `git`**: fork → branch → commit → read-back verify → PR, entirely over `api.github.com` | Node 18+ (no packages) |
| [`print-checklist/`](print-checklist/) | Render a JSON checklist into a printable A4 sheet — tick boxes, group headers, footer; preview as PNG, print, or export PDF | Windows, PowerShell 7 |

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

---

## License

MIT — see [LICENSE](LICENSE).
