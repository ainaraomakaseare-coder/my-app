export const SHARE_ORIGIN='https://uchino-kaji-shared.hiroyasmz.chatgpt.site';
export const API_ORIGIN=typeof window!=='undefined'&&window.location.protocol.startsWith('http')?window.location.origin:SHARE_ORIGIN;
export const API_URL=API_ORIGIN+'/api/household';
