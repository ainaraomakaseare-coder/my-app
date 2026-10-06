# ============================================================================
# 毎週月曜の朝、TikTok Studio の数字を写して投稿卓へ送る（本人のPCで動く）
#
#   投稿卓はそれを Google ドライブの「投稿卓_分析データ」に tiktok_<日付>.json で置く。
#   分析の Claude はドライブから読むので、本人が貼る作業は要らない。
#
# ★ 動く条件
#   - PCがついていて、ログインしていること（Chrome を使うため）
#   - Chrome で TikTok Studio にログイン済みで、Claude in Chrome が入っていること
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

# --- 指示文（先頭の説明コメントは外す） ---
$prompt = Get-Content (Join-Path $here 'tiktok-studio-prompt.md') -Raw -Encoding UTF8
$prompt = [regex]::Replace($prompt, '(?s)^\s*<!--.*?-->\s*', '')

# --- Claude Code に Chrome で写してもらう ---
Write-Log 'TikTok Studio を写しています…'
Set-Location $root
$raw = (& claude -p $prompt --chrome --allowedTools 'mcp__claude-in-chrome__*' --output-format text 2>&1) -join "`n"
$raw | Out-File -FilePath (Join-Path $logDir "tiktok-studio_$stamp.raw.txt") -Encoding UTF8

# 返事の中から JSON 配列だけを取り出す（前後に一言付いても読めるように）
$start = $raw.IndexOf('[')
$end = $raw.LastIndexOf(']')
if ($start -lt 0 -or $end -le $start) { Write-Log 'JSON が返ってきませんでした。raw.txt を見てください。'; exit 1 }
$json = $raw.Substring($start, $end - $start + 1)
try { $rows = $json | ConvertFrom-Json } catch { Write-Log 'JSON として読めませんでした。raw.txt を見てください。'; exit 1 }
Write-Log ("{0} 本ぶん写しました。投稿卓へ送ります…" -f @($rows).Count)

# --- 投稿卓へ送る（投稿卓が Google ドライブに置く） ---
try {
  $res = Invoke-RestMethod -Method Post -Uri "$base/api/insights?export=tiktok-studio" `
    -Headers @{ Authorization = "Bearer $secret" } `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
  Write-Log ("ドライブに置きました：{0}" -f (($res.files | ForEach-Object { $_.name }) -join ', '))
} catch {
  Write-Log ("投稿卓へ送れませんでした：{0}" -f $_.Exception.Message)
  exit 1
}
