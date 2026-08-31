'use strict';
/** tiktok への投稿。まだ実装していない（DAY11 の作業中）。 */
module.exports = {
  async step() {
    const e = new Error('tiktok への投稿はまだ実装されていません。');
    e.hint = 'DAY11 の作業中です。実装が終わるまで、この投稿先のチェックを外してください。';
    throw e;
  },
};
