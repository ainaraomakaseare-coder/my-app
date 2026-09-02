-- ============================================================================
-- 投稿卓 NEO / v7 … 連携先を「表示名」ではなく「SNS側のID」で見分ける
--
-- ★ 何が起きていたか
--   連携し直したときに行が二重に増えないよう、
--   「同じSNSで、同じ account_name なら同じ連携先」とみなして上書きしていた。
--   ところが account_name は SNS の表示名で、
--     ・取れなかったときは 'TikTok' のような固定の文字に落ちる
--     ・変えられるし、他人と同じにもできる
--   つまり別のアカウントを繋いだつもりでも、名前がぶつかると
--   先にあった連携先（＝別チャンネルのもの）を上書きしてしまう。
--   実際に「TikTok を繋いだら AI 側が繋ぎ直された」という形で表に出た。
--
-- ★ 直し方
--   SNS 側が発行する変わらないID（TikTok の open_id、X の user id、
--   YouTube のチャンネルID、Instagram の user_id）を持つ。
--   表示名が同じでも、IDが違えば別の連携先として増やす。
--
-- ★ 既にある行は external_id が空。
--   空の行は今までどおり名前で見分け、次に繋ぎ直したときにIDが入る。
--   だから、この移行だけで繋ぎ直しを強いることはない。
--
-- ★ 何度流しても壊れません。
-- ============================================================================

alter table sns_accounts add column if not exists external_id text;

comment on column sns_accounts.external_id is
  'SNS側の変わらないID。TikTok=open_id / X=user id / YouTube=channel id / Instagram=user_id。'
  '表示名と違って他とぶつからないので、連携し直しの突き合わせはこちらを使う。';

-- 同じSNSで同じIDの連携先は1つだけ。
-- ★ ここを DB の制約にしておくのは、上書き事故が「気づけない壊れ方」だから。
--   アプリ側の点検を通り抜けても、ここで必ず止まる。
--   external_id が空の行（v7 より前からある行）は対象外。
create unique index if not exists sns_accounts_external_uidx
  on sns_accounts (network, external_id)
  where external_id is not null;
