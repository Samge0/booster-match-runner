# Print "X Y W H" (screen coords + size) of the Booster Studio main window,
# clamped to the primary screen (a maximized window's border overflows by ~8px).
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
}
"@
Add-Type -AssemblyName System.Windows.Forms
$p = Get-Process "Booster Studio" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error "no Booster Studio window found"; exit 1 }
$r = New-Object W+RECT
[W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$x = [Math]::Max(0, $r.L)
$y = [Math]::Max(0, $r.T)
$w = [Math]::Min($r.R, $scr.Width) - $x
$h = [Math]::Min($r.B, $scr.Height) - $y
if ($w -le 0 -or $h -le 0) { Write-Error "window not visible on primary screen"; exit 1 }
# gdigrab needs even dimensions for some encoders; round down to even.
$w = [Math]::Floor($w / 2) * 2
$h = [Math]::Floor($h / 2) * 2
Write-Output "$x $y $w $h"
