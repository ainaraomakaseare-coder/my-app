import fs from 'node:fs/promises';
import plist from 'plist';
import xcode from 'xcode';
import sharp from 'sharp';
const file='ios/App/App/Info.plist';
const info=plist.parse(await fs.readFile(file,'utf8'));
info.CFBundleDisplayName='ベイ日記';
info.NSCameraUsageDescription='観戦記録に添付する写真を撮影するためにカメラを使用します。';
info.NSPhotoLibraryUsageDescription='観戦記録に添付する写真を選ぶために写真ライブラリを使用します。';
info.NSPhotoLibraryAddUsageDescription='共有した観戦成績の画像を写真ライブラリに保存するために使用します。';
info.ITSAppUsesNonExemptEncryption=false;
await fs.writeFile(file,plist.build(info));
const project=xcode.project('ios/App/App.xcodeproj/project.pbxproj');
project.parseSync();
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const build=process.env.BUILD_NUMBER||'1';
if(!/^\d+$/.test(build))throw new Error('BUILD_NUMBER must be numeric');
project.updateBuildProperty('MARKETING_VERSION',version);
project.updateBuildProperty('CURRENT_PROJECT_VERSION',build);
if(process.env.IOS_TEAM_ID && process.env.IOS_PROFILE_UUID) {
  project.updateBuildProperty('DEVELOPMENT_TEAM',process.env.IOS_TEAM_ID);
  project.updateBuildProperty('CODE_SIGN_STYLE','Manual');
  project.updateBuildProperty('CODE_SIGN_IDENTITY','"Apple Distribution"');
  project.updateBuildProperty('PROVISIONING_PROFILE_SPECIFIER',process.env.IOS_PROFILE_UUID);
}
await fs.copyFile('resources/PrivacyInfo.xcprivacy','ios/App/App/PrivacyInfo.xcprivacy');
if(!project.pbxGroupByName('Resources')) {
  const group=project.addPbxGroup([],'Resources');
  const main=project.getFirstProject().firstProject.mainGroup;
  project.getPBXGroupByKey(main).children.push({value:group.uuid,comment:'Resources'});
}
if(!project.hasFile('App/PrivacyInfo.xcprivacy'))project.addResourceFile('App/PrivacyInfo.xcprivacy',{target:project.getFirstTarget().uuid});
await fs.copyFile('native/BayDiaryViewController.swift','ios/App/App/BayDiaryViewController.swift');
if(!project.hasFile('BayDiaryViewController.swift')) {
  const groups=project.hash.project.objects.PBXGroup;
  const appGroup=Object.keys(groups).find(key=>groups[key]?.path==='App');
  if(!appGroup)throw new Error('Xcode App group not found');
  project.addSourceFile('BayDiaryViewController.swift',{target:project.getFirstTarget().uuid},appGroup);
}
const scenePath='ios/App/App/SceneDelegate.swift';
let scene=await fs.readFile(scenePath,'utf8');
scene=scene.replace('window?.rootViewController = CAPBridgeViewController()','window?.rootViewController = BayDiaryViewController()');
await fs.writeFile(scenePath,scene);
const storyboardPath='ios/App/App/Base.lproj/Main.storyboard';
let storyboard=await fs.readFile(storyboardPath,'utf8');
storyboard=storyboard.replace('customClass="CAPBridgeViewController" customModule="Capacitor"','customClass="BayDiaryViewController" customModule="App"');
await fs.writeFile(storyboardPath,storyboard);
await fs.writeFile('ios/App/App.xcodeproj/project.pbxproj',project.writeSync());
const icons='ios/App/App/Assets.xcassets/AppIcon.appiconset';
await fs.mkdir(icons,{recursive:true});
await sharp('resources/icon.svg').png().toFile(icons+'/AppIcon.png');
await fs.writeFile(icons+'/Contents.json',JSON.stringify({images:[{filename:'AppIcon.png',idiom:'universal',platform:'ios',size:'1024x1024'}],info:{author:'xcode',version:1}},null,2));
console.log('Configured iOS identity, permissions, privacy manifest and opaque 1024px icon.');
