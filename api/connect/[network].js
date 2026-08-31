'use strict';
// /api/connect/youtube, /api/connect/tiktok, /api/connect/x, /api/connect/instagram
// SNS 側に登録するコールバックURLはこの形。クエリを付けないのは、
// Google・TikTok・X が登録時にクエリ付きURLを弾くことがあるため。
module.exports = require('../../lib/connect');
