import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import vm from 'node:vm';
test('bundle contains only web entry and bridge, with no external fonts',async()=>{
 assert.deepEqual((await fs.readdir('www')).sort(),['icon.png','index.html','native.js']);
 const html=await fs.readFile('www/index.html','utf8');
 assert.doesNotMatch(html,/fonts\.(googleapis|gstatic)\.com/);
 assert.ok(html.indexOf('src="native.js"')<html.indexOf('var LOGIC_MARK_START'));
 assert.match(html,/viewport-fit=cover/);
 for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
test('native config bundles offline assets and never a remote live-reload server',async()=>{
 const c=JSON.parse(await fs.readFile('capacitor.config.json','utf8'));assert.equal(c.appId,'com.hiroyaapps.baydiary');assert.equal(c.appName,'観戦日記');assert.equal(c.webDir,'www');assert.equal(c.server,undefined);
});
