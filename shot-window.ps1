# shot-window.ps1 — capture any window to a PNG on Windows (including Electron / Chromium windows)
#
# Why this exists: the obvious screenshot paths cover the browser and the phone, but not
# "a specific desktop window" — which is exactly what you need when you want to show what
# an app looks like. This one takes a window title, a process name, or a PID.
#
# No third-party tools required: PowerShell + .NET (System.Drawing) + Win32 (PrintWindow).
#
# Two traps worth knowing before you debug anything:
#   1. Chromium / Electron windows need `PrintWindow` with **nFlags = 2** (PW_RENDERFULLCONTENT).
#      With 0 you get a **pure black image while PrintWindow still returns True** — which is
#      very easy to misread as "the tool is broken" or "the window hasn't rendered".
#   2. `PrintWindow` is unreliable for **minimized** windows (black or blank). This script
#      refuses them by default; pass -AllowMinimized and it will try to restore first.
#
# USAGE
#   pwsh -File shot-window.ps1 -List                       # list capturable windows (title + pid + size)
#   pwsh -File shot-window.ps1 -Match notepad              # fuzzy match on title or process name
#   pwsh -File shot-window.ps1 -Match chrome -Out x.png    # explicit output path
#   pwsh -File shot-window.ps1 -WinPid 1234                # exact window by PID
#   pwsh -File shot-window.ps1 -Match code -Method BitBlt  # fallback channel (window must be visible on top)
#
# Output defaults to ~/window-shots/, filename timestamped. Exit codes:
#   0 ok · 1 no match / bad window · 2 bad arguments · 3 minimized (refused) · 4 black-image guard tripped

param(
  [switch]$List,
  [string]$Match,
  [int]$WinPid = 0,
  [string]$Out,
  [ValidateSet('PrintWindow', 'BitBlt')][string]$Method = 'PrintWindow',
  [switch]$AllowMinimized,
  [string]$Dir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not ('Shot.W' -as [type])) {
  Add-Type -Namespace Shot -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hwnd);
[DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
[DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr hdcDest, int x, int y, int w, int h, IntPtr hdcSrc, int sx, int sy, int rop);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@
}

function Get-ShotWindows {
  Get-Process |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    ForEach-Object {
      $r = New-Object Shot.W+RECT
      [void][Shot.W]::GetWindowRect($_.MainWindowHandle, [ref]$r)
      [pscustomobject]@{
        Pid   = $_.Id
        Proc  = $_.ProcessName
        Title = $_.MainWindowTitle
        W     = $r.Right - $r.Left
        H     = $r.Bottom - $r.Top
        Min   = [Shot.W]::IsIconic($_.MainWindowHandle)
      }
    } | Sort-Object Proc
}

if ($List) {
  Write-Host '== capturable windows =='
  Get-ShotWindows | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
  Write-Host 'usage: pwsh -File shot-window.ps1 -Match <part of title or process name>'
  exit 0
}

# ---- pick the window ----
$cands = Get-ShotWindows
if ($WinPid -gt 0) { $target = $cands | Where-Object { $_.Pid -eq $WinPid } }
elseif ($Match) { $target = $cands | Where-Object { $_.Title -like "*$Match*" -or $_.Proc -like "*$Match*" } }
else { Write-Host 'give -Match <text> or -WinPid <pid>, or use -List to see what is available.'; exit 2 }

$target = @($target)
if ($target.Count -eq 0) {
  Write-Host ("no matching window: " + $(if ($WinPid) { "pid=$WinPid" } else { "-Match $Match" }))
  exit 1
}
if ($target.Count -gt 1) {
  Write-Host 'more than one match — pick one with -WinPid:'
  $target | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
  exit 1
}
$win = $target[0]

if ($win.Min -and -not $AllowMinimized) {
  Write-Host ("window is MINIMIZED (pid {0}) — PrintWindow is unreliable for minimized windows." -f $win.Pid)
  Write-Host '   restore it first, or pass -AllowMinimized (the script will try to restore it).'
  exit 3
}

$proc = Get-Process -Id $win.Pid
$hWnd = $proc.MainWindowHandle
if ($win.Min -and $AllowMinimized) { [void][Shot.W]::ShowWindow($hWnd, 9); Start-Sleep -Milliseconds 400 }  # 9 = SW_RESTORE

$rect = New-Object Shot.W+RECT
[void][Shot.W]::GetWindowRect($hWnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Host ("window has a bogus size: {0}x{1}" -f $w, $h); exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = $false
if ($Method -eq 'PrintWindow') {
  # nFlags = 2 is PW_RENDERFULLCONTENT — Chromium/Electron windows come out black without it
  $ok = [Shot.W]::PrintWindow($hWnd, $hdc, 2)
} else {
  [void][Shot.W]::SetForegroundWindow($hWnd)
  Start-Sleep -Milliseconds 300
  $src = [Shot.W]::GetWindowDC($hWnd)
  $ok = [Shot.W]::BitBlt($hdc, 0, 0, $w, $h, $src, 0, 0, 0x00CC0020)   # SRCCOPY
  [void][Shot.W]::ReleaseDC($hWnd, $src)
}
$g.ReleaseHdc($hdc)
$g.Dispose()

if (-not $ok) { $bmp.Dispose(); Write-Host 'the capture API returned false. Try -Method BitBlt (window on top, unobstructed).'; exit 1 }

# ---- all-black guard: the classic symptom of PrintWindow without flag 2 ----
# Better to complain than to hand someone a black PNG and let them wonder.
$sample = 0; $dark = 0
for ($x = 0; $x -lt $w; $x += [Math]::Max(1, [int]($w / 20))) {
  for ($y = 0; $y -lt $h; $y += [Math]::Max(1, [int]($h / 20))) {
    $c = $bmp.GetPixel($x, $y); $sample++
    if ($c.R -lt 8 -and $c.G -lt 8 -and $c.B -lt 8) { $dark++ }
  }
}
$darkRatio = if ($sample) { [Math]::Round($dark / $sample, 3) } else { 0 }

$dir = if ($Dir) { $Dir } else { Join-Path $env:USERPROFILE 'window-shots' }
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
if (-not $Out) { $Out = Join-Path $dir ('win-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.png') }
if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path $dir $Out }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$size = [Math]::Round((Get-Item -LiteralPath $Out).Length / 1KB, 1)
$bmp.Dispose()

Write-Host ("saved: {0}" -f $Out)
Write-Host ("  window : {0} (pid {1})  {2}" -f $win.Proc, $win.Pid, $win.Title)
Write-Host ("  size   : {0}x{1}   {2} KB   via {3}" -f $w, $h, $size, $Method)
if ($darkRatio -gt 0.9) {
  Write-Host ("  WARNING: {0:P0} of sampled pixels are near-black — this image is probably empty." -f $darkRatio)
  Write-Host '    If the window is Chromium/Electron, make sure you went through PrintWindow with nFlags=2;'
  Write-Host '    otherwise try -Method BitBlt (bring the window to the front first, nothing covering it).'
  exit 4
} else {
  Write-Host ("  black pixel share {0:P0} (normal)" -f $darkRatio)
}
