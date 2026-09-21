# Runs inside the executor sandbox. Reports its own PID and spawns two
# long-lived children that should die with the JevCode job:
#   childPid    - ordinary child (Start-Process), must stay inside the job
#   wmiChildPid - created through WMI (Win32_Process.Create), which normally
#                 escapes any job because WmiPrvSE is the real parent
param([string]$OutFile = 'sentinel.json')

$child = Start-Process -FilePath powershell.exe -WindowStyle Hidden -PassThru `
    -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 600'

$wmiChildPid = $null
$wmiError = $null
try {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -ErrorAction Stop `
        -Arguments @{ CommandLine = 'powershell.exe -NoProfile -WindowStyle Hidden -Command Start-Sleep -Seconds 600' }
    if ($r.ReturnValue -eq 0) { $wmiChildPid = [int]$r.ProcessId } else { $wmiError = "ReturnValue $($r.ReturnValue)" }
} catch {
    $wmiError = $_.Exception.Message
}

[pscustomobject]@{
    sentinelPid = $PID
    childPid    = $child.Id
    wmiChildPid = $wmiChildPid
    wmiError    = $wmiError
    user        = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    at          = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -Path $OutFile -Encoding UTF8
