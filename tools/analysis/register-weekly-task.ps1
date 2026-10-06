# ============================================================================
# tiktok-studio-weekly.ps1 を「毎週月曜 8:30」に動くよう Windows に登録する。1回だけ流せばよい。
#
#   powershell -ExecutionPolicy Bypass -File tools\analysis\register-weekly-task.ps1
#
# ★ 月曜 8:30 にPCが切れていたら、次にPCをつけてログインしたときに1回動く（StartWhenAvailable）。
#   分析の Claude は月曜 9:56 に読みに来るので、それまでにつければ間に合う。
# ★ やめるとき：Unregister-ScheduledTask -TaskName '投稿卓_TikTokStudio週次' -Confirm:$false
# ============================================================================
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'tiktok-studio-weekly.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" `
  -WorkingDirectory (Resolve-Path (Join-Path $here '..\..')).Path
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 8:30am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
# Chrome を使うので「ログインしているときだけ」動かす
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName '投稿卓_TikTokStudio週次' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Output '登録しました：毎週月曜 8:30（PCが切れていたら、次につけたとき）'
