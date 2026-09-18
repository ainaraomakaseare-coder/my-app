// API通信をモックし、画像や秘密情報を外部へ送らずWorker境界を検証する。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.join(__dirname, "../worker/src/index.js"), "utf8");
let sent;
let modelOutput;
const context = { Response, console, fetch: async (_url, init) => {
  sent = JSON.parse(init.body);
  return Response.json(modelOutput);
}};
vm.runInNewContext(source.replace("export default {", "globalThis.worker = {"), context);
const env = {ALLOWED_ORIGIN:"https://example.test",ANTHROPIC_API_KEY:"test-only",AI_RATE_LIMITER:{limit:async()=>({success:true})}};
const call = () => context.worker.fetch(new Request("https://worker.test",{
  method:"POST",headers:{origin:env.ALLOWED_ORIGIN,"content-type":"application/json"},
  body:JSON.stringify({images:[{mediaType:"image/png",data:"test-fixture"}]})
}),env,{});
(async()=>{
  const result = {program:"楽天ポイント",confidence:"medium",unit:"pt",pageKind:"balance",regularExpiryDate:null,regularExpiryMonth:null,totalBalance:null,regularBalance:null,limitedBalance:null,limitedBreakdownComplete:false,lots:[
    {pointType:"期間限定",balance:100,expiryDate:null,expiryMonth:"2026-07"},
    {pointType:"期間限定",balance:200,expiryDate:null,expiryMonth:"08"}
  ]};
  modelOutput = {stop_reason:"tool_use",content:[{type:"tool_use",name:"extract_point_info",input:result}]};
  let response = await call();
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),result);
  assert.equal(sent.messages[0].content.filter(b=>b.type==="image").length,1);
  assert.ok(sent.tools[0].input_schema.properties.lots.items.properties.expiryMonth);
  modelOutput.stop_reason="max_tokens";
  response=await call();
  assert.equal(response.status,502);
  assert.equal((await response.json()).error,"invalid_model_output");
  modelOutput={content:[{type:"tool_use",name:"extract_point_info",input:{program:"楽天ポイント"}}]};
  assert.equal((await call()).status,502);
  const limitedLots = [
    {pointType:"期間限定",balance:100,expiryDate:null,expiryMonth:"2026-07"},
    {pointType:"期間限定",balance:100,expiryDate:null,expiryMonth:"2026-08"}
  ];
  async function extract(fields) {
    const input={program:"楽天ポイント",confidence:"high",unit:"pt",pageKind:"balance",regularExpiryDate:null,regularExpiryMonth:null,totalBalance:1000,regularBalance:null,limitedBalance:200,limitedBreakdownComplete:true,lots:limitedLots,...fields};
    modelOutput={stop_reason:"tool_use",content:[{type:"tool_use",name:"extract_point_info",input}]};
    const response=await call();
    return {status:response.status,body:await response.json()};
  }
  let checked=await extract({});
  assert.equal(checked.status,200);
  assert.equal(checked.body.lots.find(l=>l.pointType==="通常").balance,800);
  assert.equal(checked.body.lots.reduce((n,l)=>n+l.balance,0),1000);
  checked=await extract({regularBalance:800});
  assert.equal(checked.body.lots.find(l=>l.pointType==="通常").balance,800);
  assert.equal((await extract({regularBalance:1000})).status,422); // 合計を通常と誤認
  assert.equal((await extract({lots:[...limitedLots,{pointType:"期間限定",balance:200}]})).status,422); // 小計の二重取り込み
  assert.equal((await extract({lots:limitedLots.slice(0,1)})).status,422); // 月の欠落
  assert.equal((await extract({limitedBalance:null,limitedBreakdownComplete:false})).status,422);
  checked=await extract({limitedBalance:null,limitedBreakdownComplete:true});
  assert.equal(checked.body.lots.find(l=>l.pointType==="通常").balance,800);
  assert.equal((await extract({totalBalance:100})).status,422);
  assert.equal((await extract({lots:[{pointType:"通常",balance:1000}]})).status,422);
  checked=await extract({totalBalance:800,regularBalance:800,limitedBalance:0,lots:[]});
  assert.equal(checked.body.lots.length,1);
  assert.equal(checked.body.lots[0].balance,800);
  checked=await extract({totalBalance:null,regularBalance:800});
  assert.equal(checked.body.lots.reduce((n,l)=>n+l.balance,0),1000);
  assert.equal((await extract({limitedBalance:-1})).status,422);
  assert.equal((await extract({lots:[{pointType:"期間限定",balance:null}]})).status,422);
  const anaBalances=[165,255,255,33,24,241,4,1000,1,560,1000];
  const anaMonths=["2027-04","2027-05","2027-06","2027-07","2027-08","2027-09","2027-10","2027-11","2028-03","2028-07","2028-12"];
  checked=await extract({program:"ANAマイレージ",unit:"マイル",totalBalance:3538,regularBalance:3538,limitedBalance:0,lots:anaBalances.map((balance,i)=>({pointType:"通常",balance,expiryDate:null,expiryMonth:anaMonths[i]}))});
  assert.equal(checked.status,200);
  assert.equal(checked.body.lots.length,11);
  assert.equal(checked.body.lots.reduce((n,l)=>n+l.balance,0),3538);
  assert.ok(checked.body.lots.every(l=>l.pointType==="通常"));
  checked=await extract({program:"ハピタス",totalBalance:251,regularBalance:251,limitedBalance:0,regularExpiryDate:"2026-10-25",lots:[]});
  assert.equal(checked.body.lots[0].expiryDate,"2026-10-25");
  checked=await extract({program:"PayPayポイント",totalBalance:9897,regularBalance:0,limitedBalance:9897,lots:[8683,125,918,171].map((balance,i)=>({pointType:"期間限定",balance,expiryDate:["2026-09-30","2026-10-31","2026-12-31","2027-01-31"][i],expiryMonth:null}))});
  assert.equal(checked.body.lots.length,4);
  assert.equal(checked.body.lots.reduce((n,l)=>n+l.balance,0),9897);
  assert.equal((await extract({pageKind:"scheduled"})).body.error,"scheduled_only");
  assert.equal((await extract({pageKind:"mixed_services"})).body.error,"mixed_services");
  assert.equal((await extract({pageKind:"unsupported"})).body.error,"unsupported_screen");
  checked=await extract({program:"楽天ポイント",totalBalance:19,regularBalance:null,limitedBalance:0,lots:[]});
  assert.equal(checked.body.lots[0].balance,19);
  checked=await extract({program:"永久不滅ポイント",totalBalance:12449,regularBalance:12449,limitedBalance:null,lots:[]});
  assert.equal(checked.body.lots[0].balance,12449);
  assert.equal((await extract({totalBalance:280,regularBalance:200,limitedBalance:80,regularExpiryDate:"2027-04-24",lots:[]})).status,422); // 最短期限は全80ptの期限とは限らない
  checked=await extract({totalBalance:280,regularBalance:200,limitedBalance:80,regularExpiryDate:"2027-04-24",lots:[{pointType:"期間限定",balance:80,expiryDate:"2027-02-28"}]});
  assert.equal(checked.body.lots.find(l=>l.pointType==="通常").expiryDate,"2027-04-24");
  console.log("37 worker assertions passed");
})().catch(err=>{console.error(err);process.exitCode=1;});
