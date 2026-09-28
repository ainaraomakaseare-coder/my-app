-- ============================================================================
-- 投稿卓 NEO / v12 … 案件つきの投稿を Threads にも出せるようにする
--
-- ★ 何が変わるか
--   A8.net で広告を載せられる媒体（affiliate_networks）に threads を足す。
--   A8.net は Threads を掲載できる SNS として認めている。ただし
--   「投稿本文へのリンク掲載は控え、プロフィール欄のリンクを使う」よう
--   案内している（iOS アプリでリンクが正しく開かない不具合のため）。
--   本文にリンクを入れないことは、アプリ側（api/posts.js）で止める。
--
-- ★ 何度流しても壊れません。関数を置き換えるだけで、行は触りません。
-- ============================================================================

-- A8.net で広告を載せられる媒体。lib/account-scope.js の AFFILIATE_NETWORKS と同じ。
create or replace function affiliate_networks() returns text[]
language sql immutable as $$ select array['instagram','youtube','tiktok','pinterest','threads'] $$;
