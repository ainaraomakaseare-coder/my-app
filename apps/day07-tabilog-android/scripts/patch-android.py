#!/usr/bin/env python3
"""
`npx cap add android` で毎回作り直す android/ フォルダに、旅の足跡に必要な設定を足す（CIで毎回実行する）。
iOSでCIがInfo.plistに足しているもの（.github/workflows/tabilog-ios-build.yml）のAndroid版。

- マイク・カメラの権限（音声でまとめて記録・その場で撮った写真）
- カスタムURLスキーム tabilog://（ログイン後にアプリへ戻る tabilog://auth?… と、Web版の「アプリで開く」tabilog://open?…）
- バージョン（versionName は package.json、versionCode は引数）
- リリース署名（環境変数 ANDROID_KEYSTORE_PATH などがあるときだけ。無ければ署名なしのまま）

使い方: python3 scripts/patch-android.py <versionCode>
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANDROID = os.path.join(HERE, "android")
MANIFEST = os.path.join(ANDROID, "app", "src", "main", "AndroidManifest.xml")
BUILD_GRADLE = os.path.join(ANDROID, "app", "build.gradle")


def patch_manifest():
    with open(MANIFEST, encoding="utf-8") as f:
        s = f.read()
    perms = [
        "android.permission.RECORD_AUDIO",
        "android.permission.MODIFY_AUDIO_SETTINGS",
        "android.permission.CAMERA",
    ]
    for p in perms:
        tag = '<uses-permission android:name="%s" />' % p
        if tag not in s:
            s = s.replace('<uses-permission android:name="android.permission.INTERNET" />',
                          '<uses-permission android:name="android.permission.INTERNET" />\n    ' + tag, 1)
    scheme = (
        "            <intent-filter>\n"
        '                <action android:name="android.intent.action.VIEW" />\n'
        '                <category android:name="android.intent.category.DEFAULT" />\n'
        '                <category android:name="android.intent.category.BROWSABLE" />\n'
        '                <data android:scheme="tabilog" />\n'
        "            </intent-filter>\n"
    )
    if 'android:scheme="tabilog"' not in s:
        marker = "        </activity>"
        assert marker in s, "MainActivityの終わりが見つからない"
        s = s.replace(marker, scheme + "\n" + marker, 1)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        f.write(s)


def patch_gradle(version_code):
    with open(os.path.join(HERE, "package.json"), encoding="utf-8") as f:
        version_name = json.load(f)["version"]
    with open(BUILD_GRADLE, encoding="utf-8") as f:
        s = f.read()
    s, n1 = re.subn(r"versionCode \d+", "versionCode %d" % version_code, s, count=1)
    s, n2 = re.subn(r'versionName "[^"]*"', 'versionName "%s"' % version_name, s, count=1)
    assert n1 == 1 and n2 == 1, "versionCode / versionName が見つからない"
    if os.environ.get("ANDROID_KEYSTORE_PATH") and "signingConfigs {" not in s:
        # パスワードはファイルに書かず、ビルド時に環境変数から読む
        signing = (
            "    signingConfigs {\n"
            "        release {\n"
            "            storeFile file(System.getenv('ANDROID_KEYSTORE_PATH'))\n"
            "            storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')\n"
            "            keyAlias System.getenv('ANDROID_KEY_ALIAS')\n"
            "            keyPassword System.getenv('ANDROID_KEY_PASSWORD')\n"
            "        }\n"
            "    }\n"
        )
        s = s.replace("    buildTypes {\n", signing + "    buildTypes {\n", 1)
        s = s.replace("        release {\n            minifyEnabled false",
                      "        release {\n            signingConfig signingConfigs.release\n            minifyEnabled false", 1)
        assert "signingConfig signingConfigs.release" in s, "releaseのbuildTypeが見つからない"
    with open(BUILD_GRADLE, "w", encoding="utf-8") as f:
        f.write(s)
    print("versionName=%s versionCode=%d signed=%s" % (version_name, version_code, bool(os.environ.get("ANDROID_KEYSTORE_PATH"))))


if __name__ == "__main__":
    patch_manifest()
    patch_gradle(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
