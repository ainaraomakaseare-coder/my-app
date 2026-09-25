const {chromium}=require('playwright');const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert/strict');
(async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{});
 let checks=0;const check=(name,value)=>{assert.ok(value,name);checks++;};
 try{
 const ctx=await browser.newContext({viewport:{width:1280,height:1100},acceptDownloads:true});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>{CURRENT_YEAR=2026;});
 check('empty home',await page.locator('#scr-dashboard').isVisible());check('no fabricated stats',(await page.locator('.metric strong').allTextContents()).every(x=>x==='—'));
 const games=[
 {id:'old',date:'2024-04-10',opponent:'阪神',result:'lose',venue:'横浜スタジアム'},
 ...['win','lose','win','draw','win','win','lose'].map((r,i)=>({id:'g'+i,date:'2026-0'+(i<3?'4':'5')+'-'+String(i+10),opponent:['巨人','阪神','広島'][i%3],result:r,venue:i%2?'東京ドーム':'横浜スタジアム',score:{bay:r==='win'?5:2,opp:r==='lose'?6:2}})),
 {id:'unknown',date:'2026-05-25',opponent:'中日',venue:''},
 {id:'t',date:'2026-04-01',myTeam:'tigers',result:'win',opponent:'DeNA',venue:'阪神甲子園球場'}];
 await page.evaluate(g=>{state={games:g.map(normalizeGame),settings:{myTeam:'baystars'}};saveState();setView('dashboard');},games);
 check('season excludes other teams',(await page.locator('.metric').first().textContent()).includes('4勝 2敗 1分'));
 check('unknown included in attendance',(await page.locator('.metric').first().textContent()).includes('8試合'));
 check('all-time includes previous season',(await page.locator('.metric').nth(1).textContent()).includes('4勝 3敗 1分'));
 check('six recent badges',await page.locator('.result-dot').count()===6);
 check('latest first',(await page.locator('.result-dot').first().textContent())==='負');
 await page.click('#nav-analysis');await page.selectOption('#analysis-year','2026');
 check('year rows include cumulative',await page.locator('#year-table tbody tr').count()===3);
 check('month grouping',await page.locator('#month-table tbody tr').count()===2);
 check('unknown venue bucket',(await page.locator('#venue-table').textContent()).includes('球場未設定'));
 await page.fill('#actual-win','60');await page.fill('#actual-lose','40');await page.fill('#actual-draw','5');await page.click('#actual-form button');
 check('percentage point comparison',(await page.locator('#comparison-result').textContent()).includes('+6.7 pt'));
 await page.selectOption('#analysis-team','tigers');check('team records isolated',await page.inputValue('#actual-win')==='');
 check('team venue isolated',(await page.locator('#venue-table').textContent()).includes('阪神甲子園球場')&&!(await page.locator('#venue-table').textContent()).includes('横浜'));
 await page.selectOption('#analysis-team','baystars');check('comparison restored',await page.inputValue('#actual-win')==='60');
 await page.selectOption('#analysis-year','2024');check('year records isolated',await page.inputValue('#actual-win')==='');
 await page.click('#nav-settings');await page.selectOption('#settings-team','tigers');await page.click('#nav-dashboard');check('home follows settings',(await page.locator('#header-summary').textContent()).includes('阪神'));
 await page.click('#home-add');check('new record team',await page.inputValue('#f-team')==='tigers');await page.fill('#f-date','2026-06-01');await page.fill('#f-opponent','DeNA');await page.selectOption('#f-result','draw');await page.click('#f-save');await page.waitForSelector('#scr-list:not([hidden])');
 check('snapshot saved',await page.evaluate(()=>state.games.at(-1).myTeam==='tigers'));
 await page.click('[data-edit="g0"]');check('old record team preserved',await page.inputValue('#f-team')==='baystars');await page.fill('#f-highlight','編集後も球団を保持');await page.click('#f-save');await page.waitForSelector('#scr-list:not([hidden])');check('edit preserves team',await page.evaluate(()=>state.games.find(g=>g.id==='g0').myTeam==='baystars'));
 await page.reload();await page.click('#nav-settings');check('settings persist',await page.inputValue('#settings-team')==='tigers');
 await page.click('#nav-analysis');await page.selectOption('#analysis-team','baystars');await page.selectOption('#analysis-year','2026');check('comparison persists',await page.inputValue('#actual-win')==='60');
 // Photo and analytics round-trip through the real export/import controls.
 await page.evaluate(async()=>{await putPhoto('photo-test','data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');state.games[0].photoIds=['photo-test'];saveState();});
 await page.click('#nav-settings');const downloadPromise=page.waitForEvent('download');await page.click('#export-btn');const download=await downloadPromise;const payload=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
 check('export has photos and analytics',!!payload.photos['photo-test']&&payload.settings.actualRecords.baystars['2026'].win===60);
 await page.evaluate(()=>{state={games:[],settings:{}};saveState();});await page.setInputFiles('#import-input',{name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(payload))});await page.waitForSelector('#scr-list:not([hidden])');
 check('import restores records and photos',await page.evaluate(async()=>state.games.length===11&&!!(await getPhoto('photo-test'))));
 // API lookup must use the team being edited and ID-based home/away detection.
 await page.evaluate(()=>{state.settings.apiKey='test-only';delete state.settings.apiTeamKey;delete state.settings.apiTeamId;});
 await page.route('https://v1.baseball.api-sports.io/**',route=>{const u=route.request().url();let response=[];if(u.includes('/leagues?'))response=[{id:1,name:'NPB',seasons:[{season:2026,current:true}]}];else if(u.includes('/teams?')){check('API searches selected team',u.includes('Hanshin'));response=[{id:22,name:'Hanshin'}];}else response=[{teams:{home:{id:33,name:'Yokohama'},away:{id:22,name:'Hanshin'}},scores:{home:{total:2},away:{total:5}}}];return route.fulfill({json:{response}});});
 await page.click('#add-game');await page.selectOption('#f-team','tigers');await page.fill('#f-date','2026-05-01');check('result API button hidden',!(await page.isVisible('#f-api-fetch')));const apiResult=await page.evaluate(()=>fetchGameFromApi(document.getElementById('f-date').value));check('away score uses team ID',apiResult.bay===5);await page.click('#f-cancel');
 // Names imported from a backup are rendered as text, never markup.
 await page.evaluate(()=>{state.games.push(normalizeGame({id:'escape',date:'2026-06-02',venue:'<img src=x onerror="window.injected=1">',result:'win'}));ui.analysisTeam='baystars';ui.analysisYear=2026;setView('analysis');});check('venue escaped',await page.locator('#venue-table img').count()===0);
 await page.evaluate(()=>{state.games=state.games.filter(g=>g.id!=='escape');state.settings.myTeam='baystars';saveState();setView('dashboard');});
 const out=process.env.BAYDIARY_QA_DIR;if(out)fs.mkdirSync(out,{recursive:true});
 for(const width of [1280,390,320]){
 await page.setViewportSize({width,height:width>700?1100:844});
 for(const view of ['dashboard','analysis','list','players','settings']){
 await page.evaluate(v=>setView(v),view);check('no page overflow '+width+' '+view,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 if(out&&width!==320&&['dashboard','analysis'].includes(view))await page.screenshot({path:path.join(out,view+'-'+width+'.png'),fullPage:true});
 }
 await page.evaluate(()=>openForm(null));check('form no overflow '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.click('#f-cancel');
 }
 check('no runtime errors',errors.length===0);
 console.log(JSON.stringify({passed:checks,errors,screenshots:out||null}));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1);});
