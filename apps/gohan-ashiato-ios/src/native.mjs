// iPhoneアプリでだけ読み込む橋渡し。Web版の app.js は window.GohanNative があればこれを使う
import { Capacitor } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
if (Capacitor.isNativePlatform()) window.GohanNative = { Camera, Filesystem, Share };
