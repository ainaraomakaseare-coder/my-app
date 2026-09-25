const {chromium}=require('playwright');
const fs=require('fs'),http=require('http'),path=require('path'),assert=require('assert/strict');
(async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../../day23-baydiary/index.html'),'utf8');
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
 const page=await browser.newPage({viewport:{width:393,height:852}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
 await page.addInitScript(()=>{window.nativeShares=[];window.BayDiaryNative={shareFile:async(blob,name,text)=>{nativeShares.push({name,text,type:blob.type,size:blob.size,body:blob.type==='application/json'?await blob.text():null});}};});
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(()=>{state.games=[normalizeGame({id:'native-test',myTeam:'baystars',date:localToday(),opponent:'阪神',venue:'横浜スタジアム',result:'win',score:{bay:3,opp:1}})];saveState();openShare(false);});
 await page.locator('#share-native').waitFor();await page.waitForFunction(()=>!document.getElementById('share-native').disabled);
 await page.click('#share-native');await page.waitForFunction(()=>nativeShares.length===1);
 let data=await page.evaluate(()=>nativeShares[0]);assert.equal(data.type,'image/png');assert.ok(data.size>1000);assert.match(data.text,/ベイ日記/);
 await page.click('#share-download');await page.waitForFunction(()=>nativeShares.length===2);
 await page.click('#share-close');await page.click('#nav-settings');await page.click('#export-btn');await page.waitForFunction(()=>nativeShares.length===3);
 data=await page.evaluate(()=>nativeShares[2]);assert.equal(data.type,'application/json');assert.equal(JSON.parse(data.body).games.length,1);
 await page.reload();assert.equal(await page.evaluate(()=>state.games.length),1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:8,errors}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
