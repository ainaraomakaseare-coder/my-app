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
  const result = {program:"楽天ポイント",confidence:"medium",lots:[
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
  console.log("7 worker assertions passed");
})().catch(err=>{console.error(err);process.exitCode=1;});
