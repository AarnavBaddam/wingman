# Real input checks that need system state: keyboard layouts, CapsLock, swapped buttons, held keys, stdin.
# Types into its own window. Restores layout, CapsLock and button swap in `finally`. Leave the mouse alone.
# Run: powershell -NoProfile -STA -File native/ydotool-win/e2e/input.e2e.ps1
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path "$PSScriptRoot\..\..\..\tools\ydotool.exe").Path
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SwapMouseButton(bool s);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v);
  [DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string id, uint f);
  [DllImport("user32.dll")] public static extern IntPtr ActivateKeyboardLayout(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool UnloadKeyboardLayout(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint t);
  [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int n, IntPtr[] l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string n, uint a, uint s, IntPtr x, uint c, uint f, IntPtr t);
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)] public struct Rec {
    [FieldOffset(0)] public ushort Type; [FieldOffset(4)] public int Down; [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort Vk; [FieldOffset(12)] public ushort Scan; [FieldOffset(14)] public char Ch; [FieldOffset(16)] public uint Ctl; }
  [DllImport("kernel32.dll", EntryPoint="WriteConsoleInputW")] public static extern bool WriteIn(IntPtr h, Rec[] r, uint n, out uint w);
  public static bool Inject(uint pid, string s) {
    FreeConsole(); if (!AttachConsole(pid)) return false;
    IntPtr h = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    bool ok = true; uint w;
    foreach (char c in s) { var r = new Rec[1]; r[0].Type = 1; r[0].Down = 1; r[0].Repeat = 1; r[0].Ch = c; ok &= WriteIn(h, r, 1, out w); }
    FreeConsole(); return ok;
  }
}
'@

$log = [Collections.ArrayList]::new()
$out = "$env:TEMP\ydotool-input-e2e.log"
$script:pass = 0; $script:fail = 0
function Say($s) { [void]$log.Add($s); [IO.File]::WriteAllLines($out, [string[]]$log, [Text.UTF8Encoding]::new($false)) }
function Ok($name, $good, $detail = '') {
  if ($good) { $script:pass++; Say "  ok   $name" } else { $script:fail++; Say "  FAIL $name $detail" }
}
function Pump($ms) { $end = [DateTime]::Now.AddMilliseconds($ms); while ([DateTime]::Now -lt $end) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 5 } }
function Y {
  $psi = [Diagnostics.ProcessStartInfo]::new($exe, ($args -join ' '))
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($psi)
  while (-not $p.HasExited) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 2 }
  $p.ExitCode
}
function U($s) { [regex]::Unescape($s) }
function TextFile($s) { $f = "$env:TEMP\ydo-e2e.txt"; [IO.File]::WriteAllText($f, $s, [Text.UTF8Encoding]::new($false)); $f }
function Fresh { $box.Clear(); [void]$form.Activate(); [void]$box.Focus(); Pump 120 }
function HeldAny { foreach ($v in 1, 2, 4, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C) { if ([W]::GetAsyncKeyState($v) -band 0x8000) { return $v } }; 0 }

$form = [Windows.Forms.Form]::new(); $form.Text = 'ydotool input e2e'; $form.TopMost = $true; $form.KeyPreview = $true
$form.StartPosition = 'Manual'; $form.Bounds = [Drawing.Rectangle]::new(200, 200, 700, 420)
$box = [Windows.Forms.RichTextBox]::new(); $box.Bounds = [Drawing.Rectangle]::new(10, 10, 660, 250); $box.AcceptsTab = $true; $form.Controls.Add($box)
$pad = [Windows.Forms.Panel]::new(); $pad.Bounds = [Drawing.Rectangle]::new(10, 270, 300, 90); $pad.BackColor = 'SteelBlue'; $form.Controls.Add($pad)
$clicks = [Collections.ArrayList]::new(); $keys = [Collections.ArrayList]::new()
$pad.Add_MouseDown({ param($s, $e) [void]$clicks.Add([string]$e.Button) })
$form.Add_KeyDown({ param($s, $e) [void]$keys.Add([string]$e.KeyCode) })
$form.Show(); [void]$form.Activate(); [void]$box.Focus(); Pump 400

$origLayout = [W]::GetKeyboardLayout(0)
$installed = New-Object IntPtr[] 32; $n = [W]::GetKeyboardLayoutList(32, $installed); $installed = $installed[0..($n - 1)]
$capsStart = [Console]::CapsLock
$cursorStart = [Windows.Forms.Cursor]::Position
$padCentre = $form.PointToScreen([Drawing.Point]::new(0, 0)); $px = $padCentre.X + 160; $py = $padCentre.Y + 315

$mixed = U 'azerty QWERTY 123 !@#$%^&*()[]{}\\|~`''"<>?/ \u20ac\u00e9\u00e8\u00f1\u00fc\u00df \u041f\u0440\u0438\u0432\u0435\u0442 \u4f60\u597d \ud83d\ude00 end'
$loaded = @()
try {
  Say "--- layouts"
  foreach ($klid in '00000409', '0000040C', '00000407', '00000809', '00020409', '00000419') {
    $h = [W]::LoadKeyboardLayout($klid, 0x101); $loaded += $h; Pump 150
    Fresh
    $rc = Y type -d 3 -H 3 -f (TextFile $mixed); Pump 250
    $got = $box.Text
    Ok "type exact on layout $klid" ($rc -eq 0 -and $got -ceq $mixed) "rc=$rc got=[$got]"
    $keys.Clear()
    $rc = Y clear; Pump 200
    Ok "clear empties on layout $klid, no Ctrl+Q" ($rc -eq 0 -and $box.Text -eq '' -and -not ($keys -contains 'Q' -and $klid -ne '0000040C' )) "left=[$($box.Text)] keys=$($keys -join ',')"
    if ($klid -eq '0000040C') { Ok 'AZERTY clear sends A, not Q' (($keys -contains 'A') -and -not ($keys -contains 'Q')) ($keys -join ',') }
  }
  [void][W]::ActivateKeyboardLayout($origLayout, 0); Pump 150

  Say "--- CapsLock"
  if (-not [Console]::CapsLock) { [void](Y key 58:1 58:0); Pump 150 }
  Fresh; $t = U 'aBc Def \u00e9! 12 XyZ'
  $rc = Y type -d 3 -H 3 -f (TextFile $t); Pump 200
  Ok 'type exact with CapsLock on' ($box.Text -ceq $t) "got=[$($box.Text)]"
  [void](Y key 58:1 58:0); Pump 150
  Ok 'CapsLock toggled back off' (-not [Console]::CapsLock)

  Say "--- upstream semantics in a real field"
  Fresh; [void](Y type 'a\nb\tc\\d\x41\qz'); Pump 200
  Ok 'escapes \n \t \\ \xHH, unknown dropped' ($box.Text -ceq "a`nb`tc\dAz") "got=[$($box.Text)]"
  Fresh; $f = "$env:TEMP\ydo-e2e-bom.txt"; [IO.File]::WriteAllBytes($f, [byte[]](0xEF, 0xBB, 0xBF) + [Text.Encoding]::UTF8.GetBytes("l1`r`nl2\n`r`n")); [void](Y type -d 2 -H 2 -f $f); Pump 200
  Ok 'file: BOM stripped, CRLF is one Enter, escapes off' ($box.Text -ceq "l1`nl2\n`n") "got=[$($box.Text)]"
  Fresh; Ok 'missing file exits 3' ((Y type -f C:\nope\none.txt) -eq 3)
  Fresh; [void](Y key 42:1 38:1 38:0 24:1 24:0 38:1 38:0 42:0); Pump 200
  Ok 'key: Shift+L O L is LOL' ($box.Text -ceq 'LOL') "got=[$($box.Text)]"
  [void](Y key 102:1 102:0 111:1 111:0 107:1 107:0 14:1 14:0); Pump 200
  Ok 'key: extended Home, Delete, End, Backspace' ($box.Text -ceq 'O') "got=[$($box.Text)]"
  [void](Y key 0 aaa 28:1 28:0); Pump 150
  Ok 'key: 0 and junk only delay' ($box.Text -ceq "O`n") "got=[$($box.Text)]"
  Fresh; $wpm = U 'The quick brown fox, jumps over 13 lazy dogs! The quick brown fox, jumps over 13 lazy dogs!'
  $sw = [Diagnostics.Stopwatch]::StartNew(); [void](Y type --human --wpm 180 -e 0 -f (TextFile $wpm)); $ms = $sw.ElapsedMilliseconds; Pump 200
  $real = [int](($wpm.Length / 5) / ($ms / 60000))
  Ok "--wpm 180 measures $real wpm" ($real -ge 155 -and $real -le 205 -and $box.Text -ceq $wpm) "len=$($box.Text.Length)"

  Say "--- buttons"
  $clicks.Clear(); [void](Y click-at $px $py); Pump 150
  Ok 'click-at is Left' ($clicks.Count -eq 1 -and $clicks[0] -eq 'Left') ($clicks -join ',')
  $clicks.Clear(); [void](Y click 0xC1); [void](Y click 0xC2); [void](Y click C3); [void](Y click C4); Pump 200
  Ok 'click C1 C2 C3 C4 are Right Middle XButton1 XButton2' (($clicks -join ',') -ceq 'Right,Middle,XButton1,XButton2') ($clicks -join ',')
  $clicks.Clear(); [void](Y click -r 3 -D 40 0xC0); Pump 200
  Ok 'click -r 3 repeats' ($clicks.Count -eq 3) "$($clicks.Count)"
  $clicks.Clear(); [void](Y click -P 0x00); Pump 150
  Ok 'click -P press+release' ($clicks.Count -eq 1)

  Say "--- swapped buttons"
  [void][W]::SwapMouseButton($true); Pump 150
  $clicks.Clear(); [void](Y click-at $px $py); Pump 150
  Ok 'swapped: click-at stays logical Left' ($clicks.Count -eq 1 -and $clicks[0] -eq 'Left') ($clicks -join ',')
  $clicks.Clear(); [void](Y click 0xC1); Pump 150
  Ok 'swapped: 0xC1 stays logical Right' ($clicks.Count -eq 1 -and $clicks[0] -eq 'Right') ($clicks -join ',')
  [void](Y click 0x40); Pump 80
  $held = HeldAny; [void](Y release); Pump 120
  Ok 'swapped: release lifts the held button' ($held -ne 0 -and (HeldAny) -eq 0) "held=$held after=$(HeldAny)"
  [void][W]::SwapMouseButton($false); Pump 150

  Say "--- release"
  [void](Y click 0x40); [void](Y key 42:1 29:1 56:1); Pump 100
  $v = @(1, 0xA0, 0xA2, 0xA4 | ? { [W]::GetAsyncKeyState($_) -band 0x8000 }).Count
  [void](Y release); Pump 150
  Ok 'release lifts button, Shift, Ctrl, Alt' ($v -eq 4 -and (HeldAny) -eq 0) "held=$v after=$(HeldAny)"

  Say "--- stdin"
  Fresh; $psi = [Diagnostics.ProcessStartInfo]::new($exe, 'stdin'); $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($psi); $p.StandardInput.Write('Piped1'); $p.StandardInput.Close()
  while (-not $p.HasExited) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 2 }; Pump 200
  Ok 'stdin from a pipe' ($box.Text -ceq 'Piped1') "got=[$($box.Text)]"
  Fresh; $psi = [Diagnostics.ProcessStartInfo]::new($exe, 'stdin'); $psi.UseShellExecute = $true; $psi.WindowStyle = 'Minimized'
  $p = [Diagnostics.Process]::Start($psi); Pump 500
  [void][W]::SetForegroundWindow($form.Handle); [void]$box.Focus(); Pump 250
  $inj = [W]::Inject([uint32]$p.Id, "Cons!"); Pump 500
  $typed = $box.Text
  [void][W]::Inject([uint32]$p.Id, [string][char]3); Pump 400
  $done = $p.HasExited; if (-not $done) { $p.Kill() }
  Ok 'stdin from a real console, Ctrl+C exits' ($inj -and $typed -ceq 'Cons!' -and $done) "inj=$inj got=[$typed] exited=$done"
}
catch { $script:fail++; Say "  FAIL aborted: $_ at $($_.InvocationInfo.ScriptLineNumber)" }
finally {
  [void][W]::SwapMouseButton($false)
  [void](Y release)
  if ([Console]::CapsLock -ne $capsStart) { [void](Y key 58:1 58:0) }
  [void][W]::ActivateKeyboardLayout($origLayout, 0)
  foreach ($h in $loaded) { if ($installed -notcontains $h) { [void][W]::UnloadKeyboardLayout($h) } }
  [Windows.Forms.Cursor]::Position = $cursorStart
  $form.Close()
}
Say "`n$($script:pass) passed, $($script:fail) failed"
exit ([int]($script:fail -ne 0))
