# PowerShell entry point. PowerShell prefers this over jevcode.cmd and, unlike cmd.exe, passes
# multi-line arguments intact (cmd cuts a multi-line task at the first line break).
& node "$PSScriptRoot\..\a0\jevcode.mjs" @args
exit $LASTEXITCODE
