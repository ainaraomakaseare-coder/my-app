'use strict';
/**
 * public/research-prompts.js（Chrome用の指示文）を確かめる。
 *
 *   node test/research-prompts.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const prompts = require('../public/research-prompts.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); failed++; }
}

const APP_URL = 'https://toukoutaku-neo.example.vercel.app';

(async () => {
  for (const genre of ['ai', 'career']) {
    const text = prompts.chromePrompt(genre, APP_URL);

    check(`${genre}: 渡したアプリURLが入る`, () => {
      assert.ok(text.includes(APP_URL), 'アプリURLが本文に無い');
    });

    check(`${genre}: 取り込みの手順（のび画面・取り込む）が入る`, () => {
      assert.ok(text.includes('のび'), '「のび」画面への案内が無い');
      assert.ok(text.includes('取り込む'), '取り込みボタンへの案内が無い');
      assert.ok(text.includes('Chromeの結果を取り込む'), '欄の名前が無い');
    });

    check(`${genre}: 見本の @example_user は「出力に含めない」と明記されている`, () => {
      assert.ok(text.includes('@example_user'));
      assert.ok(/この見本は出力に含めない|@example_user は出力しない/.test(text));
    });

    check(`${genre}: 見えない数字は null にするルールが入る`, () => {
      assert.ok(text.includes('null'));
    });

    check(`${genre}: そのジャンルのキーワードが入る`, () => {
      if (genre === 'ai') assert.ok(text.includes('AI 初心者'));
      else assert.ok(text.includes('第二新卒'));
    });

    check(`${genre}: 直近30日・のび率10倍・フォロワー10万人未満の条件が入る`, () => {
      assert.ok(text.includes('30日'));
      assert.ok(text.includes('10 倍'));
      assert.ok(text.includes('10万人未満'));
    });

    check(`${genre}: 12件を目安・水増ししない、の注意が入る`, () => {
      assert.ok(text.includes('12件'));
      assert.ok(text.includes('水増し'));
    });

    check(`${genre}: 個人情報・ログイン操作禁止などの厳守事項が入る`, () => {
      assert.ok(text.includes('ログイン操作'));
      assert.ok(text.includes('個人情報'));
    });
  }

  check('ai と career で内容が違う（使い回しでない）', () => {
    assert.notStrictEqual(prompts.chromePrompt('ai', APP_URL), prompts.chromePrompt('career', APP_URL));
  });

  check('未知のジャンルは ai 扱いにする（落ちない）', () => {
    const text = prompts.chromePrompt('other', APP_URL);
    assert.ok(text.includes('AI 初心者'));
  });

  check('docs/research/CHROME_COLLECT.md が、指示文はアプリのボタンにある旨を書いている', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'research', 'CHROME_COLLECT.md'), 'utf8');
    assert.ok(doc.includes('Chrome用の指示文をコピー'), 'ボタン名が書かれていない');
    assert.ok(doc.includes('research-prompts.js'), 'ソースの場所が書かれていない');
  });

  console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
  if (failed) process.exit(1);
})();
