# tests/vscode-drive.ps1 — focus the VS Code window, send keys, then capture it.
# Focus, keystrokes and the screenshot all happen in this one process: a
# separate pwsh call would lose the foreground again before SendKeys runs.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tests/vscode-drive.ps1 `
#     -Keys '^+p','reload window' -WaitSeconds 12 -Out shot.png
param(
  [string[]]$Keys = @(),
  [int]$WaitSeconds = 0,
  [int]$KeyDelayMs = 900,
  [string]$Out = "E:\dsh work\杂项\wallpaper-port\Wallvia\tests\.state.png"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WV {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  /**
   * The workbench window, found by title *and size*: VS Code owns several
   * top-level windows (tooltips, hidden helpers) and the "main window"
   * heuristic regularly picks one of those — which made this script report
   * "no VS Code window", or capture a 157x25 sliver, while the real window was
   * plainly on screen.
   */
  public static IntPtr FindByTitle(string needle) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) {
        bestArea = area;
        best = h;
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@

$h = [WV]::FindByTitle("Visual Studio Code")
if ($h -eq [IntPtr]::Zero) { throw "no visible VS Code window" }
$title = (Get-Process Code | Where-Object { $_.Id -ne 0 } | Select-Object -First 1).ProcessName
if ([WV]::IsIconic($h)) { [WV]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 600 }
function Focus-Code {
  for ($i = 0; $i -lt 8; $i++) {
    # Windows blocks a background process from stealing focus. Tapping Alt
    # releases the foreground lock, which is what makes SetForegroundWindow
    # succeed. The Alt tap must not leave VS Code's menu bar active, so a
    # second tap closes whatever it opened before the real keys are sent.
    [System.Windows.Forms.SendKeys]::SendWait('%')
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait('%')
    Start-Sleep -Milliseconds 80
    [WV]::ShowWindow($h, 9) | Out-Null
    [WV]::BringWindowToTop($h) | Out-Null
    [WV]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 400
    if ([WV]::GetForegroundWindow() -eq $h) { return $true }
  }
  return $false
}

$focused = Focus-Code
$fg = [WV]::GetForegroundWindow()
Write-Host "window hwnd=$h focused=$focused"

foreach ($k in $Keys) {
  if ([WV]::GetForegroundWindow() -ne $h) { $focused = Focus-Code }
  if (-not $focused) { throw "refusing to type: VS Code is not the foreground window" }
  [System.Windows.Forms.SendKeys]::SendWait($k)
  Start-Sleep -Milliseconds $KeyDelayMs
}

if ($WaitSeconds -gt 0) {
  Write-Host "waiting ${WaitSeconds}s"
  Start-Sleep -Seconds $WaitSeconds
}

$r = New-Object WV+RECT
[WV]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [WV]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT: works while occluded
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "captured ${w}x${ht} printwindow=$ok -> $Out"
