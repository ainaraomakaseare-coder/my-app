export function createFileSharer({filesystem,share,cache,readBase64}) {
  let busy=false;
  return async function shareFile(blob,name,text='') {
    if(busy) throw new Error('共有メニューを閉じてから、もう一度お試しください。');
    busy=true;
    const safe=name.replace(/[^a-zA-Z0-9._-]/g,'_');
    const path='baydiary-share/'+Date.now()+'-'+safe;
    let written=false;
    try {
      const data=await readBase64(blob);
      const result=await filesystem.writeFile({path,directory:cache,data,recursive:true});
      written=true;
      return await share.share({title:'ベイ日記',text,files:[result.uri],dialogTitle:'結果を共有・保存'});
    } finally {
      if(written) { try { await filesystem.deleteFile({path,directory:cache}); } catch {} }
      busy=false;
    }
  };
}
