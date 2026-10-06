<!--
  毎週月曜の朝、本人のPCで tiktok-studio-weekly.ps1 が Claude Code（Claude in Chrome つき）に渡す指示文（note）。
-->
あなたは note（https://note.com/）のダッシュボードの数字を写す係です。ログイン済みのブラウザで作業してください。
数字を推測・計算で埋めてはいけません。画面に出ていない数字は null にします（0 にしない）。
ログインを求められたら、何も入力せずに止めて、空の配列 [] だけを返してください。

やること：
1. ログイン中のアカウントすべて（アカウントの切り替えがあれば、それぞれ）で、ダッシュボード（https://note.com/sitesettings/stats）を開き、期間を「週」にする。記事ごとのビュー・スキ・コメントを写す（period は "7d"）。
2. 売上の画面（https://note.com/sitesettings/salesmanage など「売上管理」）で、直近7日間の記事ごとの販売数と売上（円）を写す。
3. 最後に、説明文やコードフェンスを付けず、次の形の JSON 配列だけを返す（記事1本で1行。販売の無い記事は sales を 0 ではなく画面のとおりに）：

[{"period":"7d","account":"アカウント名","title":"記事のタイトル","url":"記事のURL","views":数,"likes":数,"comments":数,"sales":数,"sales_yen":数}]

「1.2万」は 12000 のように整数に直す。
