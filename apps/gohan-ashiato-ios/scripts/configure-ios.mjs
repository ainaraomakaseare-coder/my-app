// cap add ios / cap sync のあとで、アプリ名・権限の説明文・バージョン・署名・アイコン・プライバシー申告を入れる
import fs from 'node:fs/promises';
import plist from 'plist';
import xcode from 'xcode';
import sharp from 'sharp';
const file = 'ios/App/App/Info.plist';
const info = plist.parse(await fs.readFile(file, 'utf8'));
info.CFBundleDisplayName = 'ごはんの足跡';
info.NSPhotoLibraryUsageDescription = '記録に添える写真を選び、写真の撮影日時と撮影場所を読み取るために写真ライブラリを使用します。';
info.NSPhotoLibraryAddUsageDescription = 'アプリで撮った料理の写真を写真ライブラリに保存するために使用します。';
info.NSCameraUsageDescription = '記録に添える料理の写真を撮るためにカメラを使用します。';
info.NSLocationWhenInUseUsageDescription = '食べた場所を記録し、近くのお店の候補を出すために現在地を使用します。';
info.ITSAppUsesNonExemptEncryption = false;
await fs.writeFile(file, plist.build(info));
const project = xcode.project('ios/App/App.xcodeproj/project.pbxproj');
project.parseSync();
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const build = process.env.BUILD_NUMBER || '1';
if (!/^\d+$/.test(build)) throw new Error('BUILD_NUMBER must be numeric');
project.updateBuildProperty('MARKETING_VERSION', version);
project.updateBuildProperty('CURRENT_PROJECT_VERSION', build);
// iPhone専用（iPadの審査用スクリーンショットを不要にする）
project.updateBuildProperty('TARGETED_DEVICE_FAMILY', '1');
if (process.env.IOS_TEAM_ID && process.env.IOS_PROFILE_UUID) {
  project.updateBuildProperty('DEVELOPMENT_TEAM', process.env.IOS_TEAM_ID);
  project.updateBuildProperty('CODE_SIGN_STYLE', 'Manual');
  project.updateBuildProperty('CODE_SIGN_IDENTITY', '"Apple Distribution"');
  project.updateBuildProperty('PROVISIONING_PROFILE_SPECIFIER', process.env.IOS_PROFILE_UUID);
}
await fs.copyFile('resources/PrivacyInfo.xcprivacy', 'ios/App/App/PrivacyInfo.xcprivacy');
if (!project.pbxGroupByName('Resources')) {
  const group = project.addPbxGroup([], 'Resources');
  const main = project.getFirstProject().firstProject.mainGroup;
  project.getPBXGroupByKey(main).children.push({ value: group.uuid, comment: 'Resources' });
}
// xcode's serializer emits a literal 'undefined' directory for an unset path.
delete project.pbxGroupByName('Resources').path;
if (!project.hasFile('App/PrivacyInfo.xcprivacy')) project.addResourceFile('App/PrivacyInfo.xcprivacy', { target: project.getFirstTarget().uuid });
await fs.writeFile('ios/App/App.xcodeproj/project.pbxproj', project.writeSync());
const icons = 'ios/App/App/Assets.xcassets/AppIcon.appiconset';
await fs.mkdir(icons, { recursive: true });
await sharp('resources/icon.png').resize(1024, 1024, { fit: 'cover' }).removeAlpha().png().toFile(icons + '/AppIcon.png');
await fs.writeFile(icons + '/Contents.json', JSON.stringify({ images: [{ filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }], info: { author: 'xcode', version: 1 } }, null, 2));
// 起動画面は無地（アプリの背景色）にする
const splash = 'ios/App/App/Assets.xcassets/Splash.imageset';
await fs.mkdir(splash, { recursive: true });
await sharp({ create: { width: 2732, height: 2732, channels: 3, background: '#F5F6F8' } }).png().toFile(splash + '/splash-2732x2732.png');
await fs.writeFile(splash + '/Contents.json', JSON.stringify({ images: ['1x', '2x', '3x'].map(scale => ({ filename: 'splash-2732x2732.png', idiom: 'universal', scale })), info: { author: 'xcode', version: 1 } }, null, 2));
console.log('Configured iOS identity, permissions, privacy manifest and icon.');
