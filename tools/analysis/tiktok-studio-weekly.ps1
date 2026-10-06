# ============================================================================
# 毎週月曜の朝、TikTok Studio・A8.net・note・X の数字を写して投稿卓へ送る（本人のPCで動く）
#
#   投稿卓はそれを Google ドライブの「投稿卓_分析データ」に tiktok_／a8_／note_／x_<日付>.json で置く。
#   分析の Claude はドライブから読むので、本人が貼る作業は要らない。
#
# ★ 動く条件
#   - PCがついていて、ログインしていること（Chrome を使うため）
#   - Chrome で TikTok Studio・A8.net・note・X にログイン済みで、Claude in Chrome が入っていること
#   - 投稿卓の鍵（CRON_SECRET）が、環境変数 TOUKOUTAKU_CRON_SECRET か
#     my-app\.env.local の CRON_SECRET= の行にあること（鍵はリポジトリに入れない）
#
# ★ 登録は register-weekly-task.ps1。手で試すときは：
#   powershell -ExecutionPolicy Bypass -File tools\analysis\tiktok-studio-weekly.ps1
# ============================================================================
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$base = if ($env:TOUKOUTAKU_URL) { $env:TOUKOUTAKU_URL } else { 'https://my-app-rouge-one-46.vercel.app' }
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$log = Join-Path $logDir "tiktok-studio_$stamp.log"

function Write-Log($msg) { "$(Get-Date -Format 'HH:mm:ss') $msg" | Tee-Object -FilePath $log -Append }

# --- 鍵 ---
$secret = $env:TOUKOUTAKU_CRON_SECRET
if (-not $secret) {
  $envFile = Join-Path $root '.env.local'
  if (Test-Path $envFile) {
    $line = Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -match '^\s*CRON_SECRET\s*=' } | Select-Object -First 1
    if ($line) { $secret = ($line -replace '^\s*CRON_SECRET\s*=\s*', '').Trim().Trim('"') }
  }
}
if (-not $secret) { Write-Log '投稿卓の鍵（CRON_SECRET）が見つかりません。止めます。'; exit 1 }

# --- 写して送る（1つ失敗しても、ほかは続ける） ---
Set-Location $root
function Copy-AndSend($name, $promptFile, $kind) {
  $prompt = Get-Content (Join-Path $here $promptFile) -Raw -Encoding UTF8
  $prompt = [regex]::Replace($prompt, '(?s)^\s*<!--.*?-->\s*', '')
  Write-Log "$name を写しています…"
  $raw = (& claude -p $prompt --chrome --allowedTools 'mcp__claude-in-chrome__*' --output-format text 2>&1) -join "`n"
  $raw | Out-File -FilePath (Join-Path $logDir "${kind}_$stamp.raw.txt") -Encoding UTF8

  # 返事の中から JSON 配列だけを取り出す（前後に一言付いても読めるように）
  $start = $raw.IndexOf('[')
  $end = $raw.LastIndexOf(']')
  if ($start -lt 0 -or $end -le $start) { Write-Log "$name：JSON が返ってきませんでした。${kind}_$stamp.raw.txt を見てください。"; return $false }
  $json = $raw.Substring($start, $end - $start + 1)
  try { $rows = $json | ConvertFrom-Json } catch { Write-Log "$name：JSON として読めませんでした。"; return $false }
  if (@($rows).Count -eq 0) { Write-Log "$name：0件でした（ログインが切れている可能性）。送りません。"; return $false }
  Write-Log ("{0}：{1} 件写しました。投稿卓へ送ります…" -f $name, @($rows).Count)

  # 投稿卓へ送る（投稿卓が Google ドライブに置く）
  try {
    $res = Invoke-RestMethod -Method Post -Uri "$base/api/insights?export=$kind" `
      -Headers @{ Authorization = "Bearer $secret" } `
      -ContentType 'application/json; charset=utf-8' `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
    Write-Log ("{0}：ドライブに置きました：{1}" -f $name, (($res.files | ForEach-Object { $_.name }) -join ', '))
    return $true
  } catch {
    Write-Log ("{0}：投稿卓へ送れませんでした：{1}" -f $name, $_.Exception.Message)
    return $false
  }
}

$ok = @(
  (Copy-AndSend 'TikTok Studio' 'tiktok-studio-prompt.md' 'tiktok-studio'),
  (Copy-AndSend 'A8.net' 'a8-prompt.md' 'a8'),
  (Copy-AndSend 'note' 'note-prompt.md' 'note'),
  (Copy-AndSend 'X' 'x-prompt.md' 'x')
)
if ($ok -contains $false) { exit 1 }
