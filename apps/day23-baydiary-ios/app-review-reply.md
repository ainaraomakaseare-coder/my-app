# App Review への返信（Guideline 2.1 - Information Needed、2026-09-30）

Appleから「開発者アカウントの審査履歴が少ないため、追加情報がほしい」という依頼が来たときの返信です。
下の英文を **「App Reviewに返信」** と **「App Review に関する情報」→「メモ」欄** の両方に貼ります。画面収録の動画は返信に添付します。

## 画面収録の撮り方（iPhone実機、1〜2分）

事前に iPhone を最新の iOS に更新し、TestFlight で最新ビルドを入れておく。記録が空の状態から始めると流れが分かりやすい。

1. コントロールセンターの「画面収録」を開始 → **ホーム画面からアプリのアイコンをタップして起動**（起動の場面から始めるのが必須）
2. ホーム →「＋ 観戦を記録する」→ 日付・対戦相手（12球団から選択）・球場（自動入力）・得点を入れ、写真や同行者も少し入れて保存
3. ホームで今季・通算成績が更新されたことを見せる
4. 「成績」タブ（年度別・月別・球場別）→「記録」タブ（一覧 → 1件を開いて編集 → 削除）→「選手」タブ
5. 結果を画像にして共有（共有シートが出るところまで）
6. 「設定」タブ → 「書き出す（JSON）」でバックアップ
7. 収録を停止

## 返信文（英語）

```
Hello, and thank you for reviewing Kansen Nikki (観戦日記). Please find the requested information below.

1. Screen recording
The attached recording was captured on a physical iPhone running the latest iOS. It starts with launching the app and shows the typical user flow: recording a game, viewing statistics, browsing, editing and deleting records, sharing a result image, and exporting a backup.
The app has no account registration or login (so no account deletion is needed), no user-generated content shared with other users, and no paid content or In-App Purchases.

2. Purpose and target audience
Kansen Nikki is a personal diary for Japanese professional baseball fans who go to games at the stadium. Users record each game they attended (date, teams, venue, score, result, photos, companions, ticket price, weather, notable players and comments), and the app calculates their personal win/loss record for the games they attended, by season, month, stadium and competition (regular season, interleague, Climax Series, Japan Series).
Problem it solves: fans who attend many games tend to forget which games they saw and have no easy way to know "my win rate when I am at the stadium". The app keeps these memories and statistics in one place.

3. How to use the main features (no login or sample files required)
- Launch the app. On the Home tab, tap "＋ 観戦を記録する" (Record a game).
- Enter the date, choose the opponent (select from the 12 NPB teams or type one manually); the venue is filled in automatically with the home stadium. Enter the score and tap Save. Photos, companions, ticket price, weather, players and notes are optional.
- Home tab: this season's and all-time record, and the last 6 games.
- 成績 (Stats) tab: records by year, month, stadium and competition.
- 記録 (Records) tab: list of games; tap a game to edit or delete it.
- 選手 (Players) tab: players the user noted.
- 設定 (Settings) tab: choose your team, and export/import all records as a JSON backup file.
- Share: "結果を共有" creates an image of the record and opens the standard iOS share sheet.
Recording two or three games is enough to see all statistics screens.

4. External services
The app does not use any external service: no server, no accounts, no analytics, no advertising, no AI services and no payment processors. The app makes no network requests; all screens are bundled in the app, and all records and photos are stored only on the device, so every feature works offline. Sharing uses the standard iOS share sheet.

5. Regional differences
The app is distributed only in Japan and is in Japanese. It works the same way everywhere; there is no region-dependent feature or content.

6. Regulated industry / third-party material
The app does not operate in a regulated industry. It is not affiliated with NPB or any team, and it does not use team logos, official photos or official game data. Team names appear only as text so users can identify the games they attended, and all data is entered by the user.

Thank you.
```
