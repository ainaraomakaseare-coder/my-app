import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { createFileSharer } from './share.mjs';
if(Capacitor.isNativePlatform()) {
  const readBase64=blob=>new Promise((resolve,reject)=>{
    const reader=new FileReader(); reader.onerror=()=>reject(new Error('ファイルを読み込めませんでした。'));
    reader.onload=()=>resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(blob);
  });
  window.BayDiaryNative={
    shareFile:createFileSharer({filesystem:Filesystem,share:Share,cache:Directory.Cache,readBase64}),
    // The local developer server cannot be reached from an installed app.
    async extractMemo(){throw new Error('iOS版のAI読み取りは準備中です。現在はJSONの読み込みを利用できます。');}
  };
  document.addEventListener('DOMContentLoaded',()=>{
    document.getElementById('memo-analyze').disabled=true;
    document.getElementById('memo-status').textContent='iOSテスト版ではAI読み取りを準備中です。JSONの読み込みは利用できます。';
    document.getElementById('share-download').textContent='画像を共有・保存';
  });
}
