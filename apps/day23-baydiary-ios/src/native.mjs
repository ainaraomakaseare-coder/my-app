import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { createFileSharer } from './share.mjs';
if(Capacitor.isNativePlatform()) {
  document.addEventListener('baydiary:view',event=>{
    window.webkit?.messageHandlers?.baydiaryRoute?.postMessage(event.detail.view);
  });
  const readBase64=blob=>new Promise((resolve,reject)=>{
    const reader=new FileReader(); reader.onerror=()=>reject(new Error('ファイルを読み込めませんでした。'));
    reader.onload=()=>resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(blob);
  });
  // The bundled app has no local dev server, so relative /api/... paths would
  // resolve against the fake capacitor://localhost origin. Requests go to the
  // public API deployment instead; CapacitorHttp (enabled in capacitor.config.json)
  // intercepts fetch() natively, so this call is not subject to WKWebView CORS.
  const API_BASE='https://baydiary-api.vercel.app';
  window.BayDiaryNative={
    shareFile:createFileSharer({filesystem:Filesystem,share:Share,cache:Directory.Cache,readBase64}),
    async extractMemo(url,options){
      const target=/^https?:\/\//.test(url)?url:API_BASE+url;
      try{
        return await fetch(target,options);
      }catch(e){
        if(e.name==='AbortError')throw e;
        throw new Error('AI接続サーバーに接続できませんでした。デプロイがまだの可能性があります。別のAIで変換したJSONも読み込めます。');
      }
    }
  };
  document.addEventListener('DOMContentLoaded',()=>{
    if(window.BayDiaryShell)document.documentElement.classList.add('bay-native-shell');
    document.getElementById('share-download').textContent='画像を共有・保存';
  });
}
