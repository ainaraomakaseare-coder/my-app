import test from 'node:test';
import assert from 'node:assert/strict';
import {createFileSharer} from '../src/share.mjs';
function fixture(shareImpl=async()=>({activityType:'test'})) {
 const calls=[];
 const filesystem={writeFile:async o=>{calls.push(['write',o]);return {uri:'file:///cache/result.png'};},deleteFile:async o=>calls.push(['delete',o])};
 const share={share:async o=>{calls.push(['share',o]);return shareImpl(o);}};
 return {calls,filesystem,run:createFileSharer({filesystem,share,cache:'CACHE',readBase64:async()=> 'encoded'})};
}
test('PNG and caption use native file URI; cleanup follows share completion',async()=>{
 const f=fixture();await f.run(new Blob(['png']),'result.png','3勝1敗 #ベイ日記');
 assert.deepEqual(f.calls.map(x=>x[0]),['write','share','delete']);
 assert.equal(f.calls[0][1].directory,'CACHE');assert.deepEqual(f.calls[1][1].files,['file:///cache/result.png']);assert.equal(f.calls[1][1].text,'3勝1敗 #ベイ日記');
});
test('cancel/failure still removes temporary file',async()=>{
 const f=fixture(async()=>{throw Error('cancelled')});await assert.rejects(f.run(new Blob(),'result.json'),/cancelled/);assert.equal(f.calls.at(-1)[0],'delete');
});
test('write failure does not open share sheet',async()=>{
 const f=fixture();f.filesystem.writeFile=async()=>{throw Error('disk full')};await assert.rejects(f.run(new Blob(),'result.json'),/disk full/);assert.equal(f.calls.length,0);
});
test('repeated tap cannot race file cleanup; subsequent share works',async()=>{
 let finish;const f=fixture(()=>new Promise(r=>finish=r));const first=f.run(new Blob(),'one.png');
 await new Promise(r=>setTimeout(r,0));await assert.rejects(f.run(new Blob(),'two.png'),/共有メニュー/);finish({});await first;
 const next=f.run(new Blob(),'three.png');await new Promise(r=>setTimeout(r,0));finish({});await next;
 assert.equal(f.calls.filter(x=>x[0]==='share').length,2);
});
test('filename cannot escape private cache folder',async()=>{const f=fixture();await f.run(new Blob(),'../../bad.json');assert.match(f.calls[0][1].path,/^baydiary-share\/\d+-[a-zA-Z0-9._-]+$/);});
