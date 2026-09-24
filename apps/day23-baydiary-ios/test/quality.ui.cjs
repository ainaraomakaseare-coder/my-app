const {chromium}=require('playwright');const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
(async()=>{
 const root=path.join(__dirname,'../www');const s=http.createServer((q,r)=>{const f=q.url==='/native.js'?'native.js':'index.html';r.setHeader('Content-Type',f.endsWith('.js')?'application/javascript':'text/html; charset=utf-8');r.end(fs.readFileSync(path.join(root,f)));});await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const b=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});let passed=0;const check=(v)=>{assert.ok(v);passed++};
 try{const page=await b.newPage({viewport:{width:393,height:852}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+s.address().port);
 await page.evaluate(()=>{document.documentElement.classList.add('bay-native-shell');state.games=[normalizeGame({id:'one',date:localToday(),myTeam:'baystars',competition:'interleague',opponent:'ソフトバンク',result:'win',score:{bay:5,opp:2},venue:'横浜スタジアム',highlight:'最後まで声を出して応援。最高の一日！'})];saveState();setView('dashboard');});
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 fs.mkdirSync(path.join(__dirname,'../build/qa'),{recursive:true});const out=path.join(__dirname,'../build/qa');
 await page.screenshot({path:path.join(out,'ios-content-light.png'),fullPage:true});await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:path.join(out,'ios-content-dark.png'),fullPage:true});check(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor==='rgb(16, 17, 20)'));
 await page.setViewportSize({width:320,height:720});await page.evaluate(()=>{document.documentElement.style.fontSize='23px';setView('analysis');});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(()=>openForm('one'));await page.fill('#f-highlight','未保存の感想');page.once('dialog',d=>d.dismiss());check(await page.evaluate(()=>bayNavigate('dashboard'))===false);check(await page.inputValue('#f-highlight')==='未保存の感想');
 page.once('dialog',d=>d.accept());check(await page.evaluate(()=>bayNavigate('dashboard'))===true);
 await page.evaluate(()=>{openForm('one');window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===STORE_KEY)throw new DOMException('Quota','QuotaExceededError');return originalSetItem.call(this,k,v);};});
 await page.fill('#f-highlight','保存に失敗しても残る感想');page.once('dialog',d=>d.accept());await page.locator('#game-form button[type="submit"]').click();await page.waitForFunction(()=>!ui.saving);check(await page.evaluate(()=>ui.view==='form'&&state.games[0].highlight==='最後まで声を出して応援。最高の一日！'));check(await page.inputValue('#f-highlight')==='保存に失敗しても残る感想');
 await page.evaluate(()=>Storage.prototype.setItem=originalSetItem);await page.locator('#game-form button[type="submit"]').click();await page.waitForFunction(()=>ui.view==='list');check(await page.evaluate(()=>state.games[0].highlight==='保存に失敗しても残る感想'));
 await page.evaluate(()=>{openForm('one');ui.photos=[{id:'failed-photo',dataUrl:'data:image/png;base64,a',existing:false}];putPhoto=async()=>{throw Error('photo storage full')};});await page.locator('#game-form button[type="submit"]').click();await page.waitForFunction(()=>!ui.saving);check(await page.evaluate(()=>ui.view==='form'&&state.games[0].photoIds.length===0));check((await page.textContent('#f-api-status')).includes('写真を保存できません'));check(errors.length===0);
 console.log(JSON.stringify({passed,errors,screenshots:out}));
 }finally{await b.close();await new Promise(r=>s.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
