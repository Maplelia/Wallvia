# tests/capture-window.ps1 — screenshot a window even when it is occluded.
# Usage: powershell -ExecutionPolicy Bypass -File tests/capture-window.ps1 -Title "Visual Studio Code" -Out shot.png
param(
  [string]$Title = "Visual Studio Code",
  [string]$Out = "E:\dsh work\杂项\wallpaper-port\Wallvia\tests\.verify-window.png"
)

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@

$proc = Get-Process Code -ErrorAction Stop | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
if (-not $proc) { throw "no window matching '$Title'" }
$h = $proc.MainWindowHandle
if ([WinCap]::IsIconic($h)) { [WinCap]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 700 }

$r = New-Object WinCap+RECT
[WinCap]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
Write-Host "window: $($proc.MainWindowTitle)  ${w}x${ht}"

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 0x2 = PW_RENDERFULLCONTENT — captures DWM-composited content even if occluded
$ok = [WinCap]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "printwindow=$ok saved=$Out"
