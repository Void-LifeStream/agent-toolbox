#requires -Version 7
<#
    print-checklist.ps1

    Render a checklist described by a JSON file into an A4 document, then either
    preview it as PNG images, send it to a printer, or export it to PDF.

    Why this exists: laying out a printable "tick box" checklist from a script
    normally means placing every line by hand with GDI+. That part is fine.
    What is not fine is discovering, after wasting paper, that the same drawing
    code lays out differently on a bitmap than on a printer — see the README for
    that trap. This script sidesteps it by using GraphicsUnit.Point throughout,
    so the preview you approve is the page you get.

    Usage:
      pwsh -File print-checklist.ps1 spec.json                        # preview PNGs
      pwsh -File print-checklist.ps1 spec.json -Mode print            # default printer, 1 copy
      pwsh -File print-checklist.ps1 spec.json -Mode print -Copies 4  # 4 identical sheets
      pwsh -File print-checklist.ps1 spec.json -Mode print -PrinterName "EPSON1234"
      pwsh -File print-checklist.ps1 spec.json -Mode pdf              # export PDF (Windows)

    Spec format (see examples/):
      {
        "title":  "big dark header line",
        "footer": "small grey footer line",
        "layout": "compact" | "roomy",
        "pages": [
          { "theme": "sub-heading in red",
            "blocks": [ { "head": "group heading", "items": ["one line", "..."] } ] }
        ]
      }

    One page in "pages" = a one-page checklist, which is the common case;
    several pages = a multi-page document. -Copies repeats the whole document.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Spec,

    [ValidateSet('preview', 'print', 'pdf')]
    [string]$Mode = 'preview',

    # Empty = whatever printer Windows considers default.
    [string]$PrinterName = '',

    [string]$OutDir = '',

    [int]$Dpi = 150,

    [int]$Copies = 1
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing.Common
Add-Type -AssemblyName System.Windows.Forms

if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = (Get-Location).Path }
if (-not (Test-Path -LiteralPath $Spec)) { throw "spec not found: $Spec" }

# ---------------------------------------------------------------- spec
# NOTE: the parsed document is $doc, deliberately NOT $spec. PowerShell variable
# names are case-insensitive, so `$spec = ... | ConvertFrom-Json` would assign to
# the [string]$Spec parameter — whose type constraint silently stringifies the
# object back into JSON text, after which every property lookup returns $null.
$doc = Get-Content -LiteralPath $Spec -Raw -Encoding utf8 | ConvertFrom-Json
$TITLE = if ($doc.title) { [string]$doc.title } else { 'Checklist' }
$FOOTER = if ($doc.footer) { [string]$doc.footer } else { '' }
$LAYOUT = if ($doc.layout) { [string]$doc.layout } else { 'compact' }

$Pages = @()
foreach ($p in @($doc.pages)) {
    $blocks = @()
    foreach ($b in @($p.blocks)) {
        $blocks += @{
            Head  = [string]$b.head
            Items = @(@($b.items) | ForEach-Object { [string]$_ })
        }
    }
    $Pages += @{ Theme = [string]$p.theme; Blocks = $blocks }
}
if ($Pages.Count -eq 0) { throw 'spec has no pages' }
if ($Copies -lt 1) { $Copies = 1 }

# ---------------------------------------------------------------- page geometry
# Everything below is in POINTS (A4 = 595 x 842). PaperSize is the one exception:
# it wants 1/100 inch, which is why the constants differ.
$PAGE_W = 595.0; $PAGE_H = 842.0
$PAPER_W100 = 827; $PAPER_H100 = 1169
$MARGIN_L = 42.0; $MARGIN_R = 42.0
$CONTENT_W = $PAGE_W - $MARGIN_L - $MARGIN_R

if ($LAYOUT -eq 'roomy') {
    $HEADER_H = 60.0; $CONTENT_TOP = 108.0; $CONTENT_BOTTOM = 786.0; $FOOTER_LINE_Y = 797.0
    $szTitle = 15.0; $szTheme = 12.5; $szGroup = 11.5; $szItem = 11.0; $szFoot = 8.0
    $lineFactor = 1.38; $groupFactor = 1.20; $groupGap = 7.0; $itemGap = 5.5; $blockGap = 11.0
}
else {
    $HEADER_H = 46.0; $CONTENT_TOP = 86.0; $CONTENT_BOTTOM = 800.0; $FOOTER_LINE_Y = 812.0
    $szTitle = 13.0; $szTheme = 11.5; $szGroup = 10.5; $szItem = 9.5; $szFoot = 7.5
    $lineFactor = 1.26; $groupFactor = 1.10; $groupGap = 4.0; $itemGap = 3.2; $blockGap = 6.0
}

# ---------------------------------------------------------------- fonts
$family = 'Microsoft YaHei'          # CJK-safe; falls back below
$names = @()
try { $names = [System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name } } catch { }
foreach ($alt in 'Microsoft YaHei', 'Microsoft YaHei UI', 'Segoe UI', 'SimSun', 'Arial') {
    if ($names -contains $alt) { $family = $alt; break }
}

function New-Font([double]$size, $style) {
    return New-Object System.Drawing.Font($family, [float]$size, $style, [System.Drawing.GraphicsUnit]::Point)
}
$F_TITLE = New-Font $szTitle ([System.Drawing.FontStyle]::Bold)
$F_PAGENO = New-Font ($szFoot + 1.5) ([System.Drawing.FontStyle]::Regular)
$F_THEME = New-Font $szTheme ([System.Drawing.FontStyle]::Bold)
$F_GROUP = New-Font $szGroup ([System.Drawing.FontStyle]::Bold)
$F_ITEM = New-Font $szItem ([System.Drawing.FontStyle]::Regular)
$F_FOOT = New-Font $szFoot ([System.Drawing.FontStyle]::Regular)

# ---------------------------------------------------------------- brushes / pens
$C_DARK = [System.Drawing.Color]::FromArgb(26, 32, 44)
$C_ACCENT = [System.Drawing.Color]::FromArgb(196, 62, 40)
$C_GROUP = [System.Drawing.Color]::FromArgb(18, 54, 104)
$C_TEXT = [System.Drawing.Color]::FromArgb(24, 24, 28)
$C_GREY = [System.Drawing.Color]::FromArgb(120, 124, 132)
$C_BOX = [System.Drawing.Color]::FromArgb(70, 74, 82)

$BR_HEADER = New-Object System.Drawing.SolidBrush($C_DARK)
$BR_WHITE = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$BR_ACCENT = New-Object System.Drawing.SolidBrush($C_ACCENT)
$BR_GROUP = New-Object System.Drawing.SolidBrush($C_GROUP)
$BR_TEXT = New-Object System.Drawing.SolidBrush($C_TEXT)
$BR_GREY = New-Object System.Drawing.SolidBrush($C_GREY)
$PEN_BOX = New-Object System.Drawing.Pen($C_BOX, [float]0.9)
$PEN_LINE = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(206, 208, 214), [float]0.8)
$SF_FAR = New-Object System.Drawing.StringFormat
$SF_FAR.Alignment = [System.Drawing.StringAlignment]::Far

# ---------------------------------------------------------------- drawing
function Wrap-Text {
    param($g, [string]$Text, $Font, [double]$MaxWidth)
    $lines = New-Object System.Collections.Generic.List[string]
    $cur = ''
    foreach ($ch in $Text.ToCharArray()) {
        $cand = $cur + $ch
        if ($cur.Length -gt 0 -and $g.MeasureString($cand, $Font).Width -gt $MaxWidth) {
            $lines.Add($cur); $cur = [string]$ch
        }
        else { $cur = $cand }
    }
    if ($cur.Length -gt 0) { $lines.Add($cur) }
    return $lines
}

function Draw-Page {
    param($g, $Page, [int]$PageNo, [int]$Total, [ref]$BottomY)

    $g.FillRectangle($BR_HEADER, [float]0, [float]0, [float]$PAGE_W, [float]$HEADER_H)
    $titleH = $F_TITLE.GetHeight($g)
    $titleY = ($HEADER_H - $titleH) / 2.0
    $g.DrawString($TITLE, $F_TITLE, $BR_WHITE, [float]$MARGIN_L, [float]$titleY)
    $rectNo = [System.Drawing.RectangleF]::new([float]0, [float]$titleY, [float]($PAGE_W - $MARGIN_R), [float]$titleH)
    $g.DrawString("Page $PageNo / $Total", $F_PAGENO, $BR_WHITE, $rectNo, $SF_FAR)

    if ($Page.Theme) {
        $g.DrawString($Page.Theme, $F_THEME, $BR_ACCENT, [float]$MARGIN_L, [float]($HEADER_H + 10))
    }
    $g.DrawLine($PEN_LINE, [float]$MARGIN_L, [float]($HEADER_H + 28), [float]($PAGE_W - $MARGIN_R), [float]($HEADER_H + 28))

    $y = $CONTENT_TOP
    $itemLineH = $F_ITEM.GetHeight($g) * $lineFactor
    $groupAdvance = $F_GROUP.GetHeight($g) * $groupFactor + $groupGap

    foreach ($blk in $Page.Blocks) {
        $g.FillRectangle($BR_ACCENT, [float]$MARGIN_L, [float]($y + 2), [float]3.6, [float]($F_GROUP.GetHeight($g) * 0.78))
        $g.DrawString($blk.Head, $F_GROUP, $BR_GROUP, [float]($MARGIN_L + 9.0), [float]$y)
        $y += $groupAdvance

        foreach ($item in $blk.Items) {
            $box = 9.5
            $g.DrawRectangle($PEN_BOX, [float]($MARGIN_L + 2.0), [float]($y + 2.0), [float]$box, [float]$box)
            $textX = $MARGIN_L + 2.0 + $box + 6.0
            $textW = $CONTENT_W - ($textX - $MARGIN_L)
            $cy = $y
            foreach ($ln in (Wrap-Text -g $g -Text $item -Font $F_ITEM -MaxWidth $textW)) {
                $g.DrawString($ln, $F_ITEM, $BR_TEXT, [float]$textX, [float]$cy)
                $cy += $itemLineH
            }
            $y = $cy + ($itemGap - 3.0)
        }
        $y += $blockGap
    }
    $BottomY.Value = $y

    if ($FOOTER) {
        $g.DrawLine($PEN_LINE, [float]$MARGIN_L, [float]$FOOTER_LINE_Y, [float]($PAGE_W - $MARGIN_R), [float]$FOOTER_LINE_Y)
        $g.DrawString("$FOOTER  ·  Page $PageNo / $Total", $F_FOOT, $BR_GREY, [float]$MARGIN_L, [float]($FOOTER_LINE_Y + 7))
    }
}

function New-PageGraphics {
    param($Target)
    $g = if ($Target -is [System.Drawing.Bitmap]) { [System.Drawing.Graphics]::FromImage($Target) } else { $Target }
    $g.PageUnit = [System.Drawing.GraphicsUnit]::Point     # <- the whole point: same units everywhere
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    return $g
}

# ---------------------------------------------------------------- preview
if ($Mode -eq 'preview') {
    $pxW = [int][math]::Round($PAGE_W / 72.0 * $Dpi)
    $pxH = [int][math]::Round($PAGE_H / 72.0 * $Dpi)
    for ($i = 0; $i -lt $Pages.Count; $i++) {
        $bmp = New-Object System.Drawing.Bitmap($pxW, $pxH)
        $bmp.SetResolution([float]$Dpi, [float]$Dpi)
        $g = New-PageGraphics -Target $bmp
        $g.Clear([System.Drawing.Color]::White)
        $bottom = 0
        Draw-Page -g $g -Page $Pages[$i] -PageNo ($i + 1) -Total $Pages.Count -BottomY ([ref]$bottom)
        $g.Dispose()
        $file = Join-Path $OutDir ("preview-page-{0}.png" -f ($i + 1))
        $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $flag = if ($bottom -gt $CONTENT_BOTTOM) { "  <<< OVERFLOW by $([math]::Round($bottom - $CONTENT_BOTTOM)) pt" } else { '  ok' }
        Write-Host ("[preview] {0}{1}  (content bottom {2} / limit {3})" -f $file, $flag, [math]::Round($bottom), $CONTENT_BOTTOM)
    }
    exit 0
}

# ---------------------------------------------------------------- print / pdf
$targetPrinter = $PrinterName
$printToFile = $false
$fileName = ''
if ($Mode -eq 'pdf') {
    $targetPrinter = 'Microsoft Print to PDF'
    $printToFile = $true
    $suffix = [System.IO.Path]::GetFileNameWithoutExtension($Spec)
    $fileName = Join-Path $OutDir "$suffix.pdf"
}

$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.DocumentName = [System.IO.Path]::GetFileNameWithoutExtension($Spec)
if ($targetPrinter) { $doc.PrinterSettings.PrinterName = $targetPrinter }
if (-not $doc.PrinterSettings.IsValid) {
    throw "printer not available: $($doc.PrinterSettings.PrinterName)"
}
if ($doc.PrinterSettings.CanDuplex) { $doc.PrinterSettings.Duplex = [System.Drawing.Printing.Duplex]::Simplex }
$doc.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('A4', [int]$PAPER_W100, [int]$PAPER_H100)
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

if ($printToFile) {
    $doc.PrinterSettings.PrintToFile = $true
    $doc.PrinterSettings.PrintFileName = $fileName
}

$script:sheet = 0
$script:logical = $Pages.Count
$script:totalSheets = $script:logical * $Copies
$script:report = @()

$doc.add_PrintPage({
        param($sender, $e)
        $g = $e.Graphics
        $g.PageUnit = [System.Drawing.GraphicsUnit]::Point
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
        $idx = $script:sheet % $script:logical
        $bottom = 0
        Draw-Page -g $g -Page $Pages[$idx] -PageNo ($idx + 1) -Total $script:logical -BottomY ([ref]$bottom)
        $script:report += [pscustomobject]@{ Sheet = $script:sheet + 1; Bottom = [math]::Round($bottom); Overflow = ($bottom -gt $CONTENT_BOTTOM) }
        $script:sheet++
        $e.HasMorePages = ($script:sheet -lt $script:totalSheets)
    })

Write-Host ("[{0}] target: {1} ; sheets: {2} ({3} page(s) x {4} cop(ies))" -f $Mode, $doc.PrinterSettings.PrinterName, $script:totalSheets, $script:logical, $Copies)
$doc.Print()
$doc.Dispose()

foreach ($r in $script:report) {
    $mark = if ($r.Overflow) { '  <<< OVERFLOW' } else { '' }
    Write-Host ("    sheet {0}: content bottom {1}{2}" -f $r.Sheet, $r.Bottom, $mark)
}
if ($Mode -eq 'pdf') { Write-Host "[pdf] $fileName" }
Write-Host 'done'
