# Generates the Link Opener PNG icons (16/32/48/128) with a gradient rounded
# square and a "link" chain motif. Run once with: powershell -File generate-icons.ps1
Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded-rectangle background with a purple -> cyan diagonal gradient.
  $radius = [Math]::Max(2, [int]($size * 0.22))
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path2.AddArc(0, 0, $d, $d, 180, 90)
  $path2.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path2.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path2.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path2.CloseFigure()

  $c1 = [System.Drawing.Color]::FromArgb(255, 124, 92, 255)
  $c2 = [System.Drawing.Color]::FromArgb(255, 43, 212, 255)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45)
  $g.FillPath($brush, $path2)

  # Two interlocking rounded links drawn with a thick white pen.
  $penW = [Math]::Max(2, [single]($size * 0.085))
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penW)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

  $lw = [single]($size * 0.34)
  $lh = [single]($size * 0.20)
  $off = [single]($size * 0.11)
  $cx = $size / 2.0
  $cy = $size / 2.0

  $r1 = New-Object System.Drawing.RectangleF(($cx - $lw + $off * 0.4), ($cy - $lh - $off * 0.2), $lw, $lh)
  $r2 = New-Object System.Drawing.RectangleF(($cx - $off * 0.4), ($cy + $off * 0.2 - $lh), $lw, $lh)
  # Shift the second link down to interlock.
  $r2.Y = $cy - $off * 0.2

  $rad = $lh / 2.0
  function Add-RoundRect($gp, $rf, $rr) {
    $dd = $rr * 2
    $gp.AddArc($rf.X, $rf.Y, $dd, $dd, 180, 90)
    $gp.AddArc($rf.Right - $dd, $rf.Y, $dd, $dd, 270, 90)
    $gp.AddArc($rf.Right - $dd, $rf.Bottom - $dd, $dd, $dd, 0, 90)
    $gp.AddArc($rf.X, $rf.Bottom - $dd, $dd, $dd, 90, 90)
    $gp.CloseFigure()
  }

  $gp1 = New-Object System.Drawing.Drawing2D.GraphicsPath
  Add-RoundRect $gp1 $r1 $rad
  $g.DrawPath($pen, $gp1)

  $gp2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  Add-RoundRect $gp2 $r2 $rad
  $g.DrawPath($pen, $gp2)

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($s in 16, 32, 48, 128) {
  New-Icon $s (Join-Path $dir "$s.png")
}
Write-Host "Icons generated."
