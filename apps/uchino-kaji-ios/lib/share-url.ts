import {Capacitor} from "@capacitor/core";
export const SHARE_ORIGIN='https://uchino-kaji-shared.hiroyasmz.chatgpt.site';
export const API_ORIGIN=typeof window==='undefined'||Capacitor.isNativePlatform()?SHARE_ORIGIN:window.location.origin;
export const API_URL=API_ORIGIN+'/api/household';
