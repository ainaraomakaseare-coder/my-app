// Local development server. Public deployment requires authentication and per-user quotas.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const htmlPath = path.join(__dirname, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const logic = html.slice(html.indexOf('var LOGIC_MARK_START'), html.indexOf('var LOGIC_MARK_END = 1;'));
const box = {};
vm.runInNewContext(logic, box);
function createServer({key=process.env.OPENAI_API_KEY, model=process.env.OPENAI_MODEL || 'gpt-4o-mini', fetchImpl=fetch, publicURL=process.env.PUBLIC_APP_URL || ''}={}) {
  let busy=false, requests=[];
  const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const server=http.createServer(async(req,res)=>{
    const port=server.address().port;
    const hosts=['127.0.0.1:'+port,'localhost:'+port];
    if(!hosts.includes(req.headers.host))return send(res,403,{error:'許可されていないホストです。'});
    if(req.method==='GET' && req.url==='/icon.png') {
      const iconPath=path.join(__dirname,'icon.png');
      res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'});
      fs.createReadStream(iconPath).pipe(res);return;
    }
    if(req.method==='GET' && (req.url==='/' || req.url==='/index.html')) {
      let current=fs.readFileSync(htmlPath,'utf8');
      try { const u=new URL(publicURL);if(u.protocol==='https:'&&!u.username&&!u.password&&!/^(localhost|127\.|\[::1\])/.test(u.hostname))current=current.replace('<meta name="baydiary-public-url" content="">','<meta name="baydiary-public-url" content="'+u.href.replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]))+'">'); } catch {}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(current);return;
    }
    if(req.method==='GET' && req.url==='/api/ai-status')return send(res,200,{configured:Boolean(key)});
    if(req.url!=='/api/memo-extract')return send(res,404,{error:'Not found'});
    if(req.method!=='POST')return send(res,405,{error:'POSTを使用してください。'});
    if(req.headers.origin!=='http://'+req.headers.host || !/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return send(res,403,{error:'アプリ画面から読み取りを実行してください。'});
    if(!key)return send(res,503,{error:'AI読み取りの接続設定がまだありません。サーバーにOPENAI_API_KEYを設定してください。別のAIで変換したJSONも利用できます。'});
    requests=requests.filter(t=>Date.now()-t<60000);
    if(busy || requests.length>=10)return send(res,429,{error:'読み取り中、または利用回数が多いため、少し待って再試行してください。'});
    busy=true;requests.push(Date.now());
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try {
      let bytes=0,chunks=[];
      for await(const chunk of req){bytes+=chunk.length;if(bytes>150000){send(res,413,{error:'メモを小さく分けてください。'});return;}chunks.push(chunk);}
      let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(res,400,{error:'入力JSONが不正です。'});}
      if(!input || typeof input.text!=='string' || !input.text.trim() || input.text.length>30000 || !box.TEAMS.some(t=>t.id===input.defaultTeam) || (input.defaultYear!==null && (!Number.isInteger(input.defaultYear)||input.defaultYear<1900||input.defaultYear>9999)))return send(res,400,{error:'メモ・応援球団・補完年度を確認してください。'});
      const response=await fetchImpl('https://api.openai.com/v1/responses',{
        method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},signal:controller.signal,
        body:JSON.stringify({model,store:false,max_output_tokens:14000,instructions:box.memoInstructions(),input:JSON.stringify({text:input.text,defaultTeam:input.defaultTeam,defaultYear:input.defaultYear}),text:{format:{type:'json_schema',name:'baseball_diary_import',strict:true,schema:box.MEMO_SCHEMA}}})
      });
      if(!response.ok)return send(res,response.status===429?429:502,{error:response.status===429?'AIサービスの利用上限です。時間をおいて再試行してください。':'AIサービスへ接続できませんでした。サーバーのキー・モデル設定を確認してください。'});
      const result=await response.json();
      const content=(result.output||[]).flatMap(item=>item.content||[]);
      if(content.some(c=>c.type==='refusal'))return send(res,422,{error:'このメモはAIで読み取れませんでした。内容を確認するかJSONを直接入力してください。'});
      if(result.status!=='completed')return send(res,422,{error:'読み取りが完了しませんでした。メモを分割して再試行してください。'});
      let parsed;try{parsed=JSON.parse(content.filter(c=>c.type==='output_text').map(c=>c.text).join(''));}catch{return send(res,502,{error:'AIの応答を読み取れませんでした。'});}
      if(!parsed||!Array.isArray(parsed.games)||parsed.games.length>100)return send(res,422,{error:'一度に100試合までです。メモを分割してください。'});
      send(res,200,{games:parsed.games});
    }catch(error){if(!res.writableEnded)send(res,error.name==='AbortError'||controller.signal.aborted?504:502,{error:controller.signal.aborted?'AI読み取りが時間切れになりました。メモを分割して再試行してください。':'AIサービスとの通信に失敗しました。メモは保存されていません。'});}
    finally{clearTimeout(timer);busy=false;}
  });
  server.requestTimeout=100000;
  return server;
}
module.exports={createServer};
if(require.main===module){const server=createServer();server.listen(Number(process.env.PORT||60154),'127.0.0.1',()=>console.log('ベイ日記: http://127.0.0.1:'+server.address().port+' / AI接続 '+(process.env.OPENAI_API_KEY?'設定済み':'未設定')));}
