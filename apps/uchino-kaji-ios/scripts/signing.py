"""Prepare private signing inputs on an ephemeral macOS runner. Never print secrets."""
import os,pathlib,base64,plistlib,subprocess,datetime
root=pathlib.Path(os.environ['RUNNER_TEMP'])/'kaji-signing';root.mkdir(mode=0o700,exist_ok=True)
def required(name):
 value=os.environ.get(name,'')
 if not value: raise SystemExit('Missing required secret: '+name)
 return value
cert=root/'distribution.p12';cert.write_bytes(base64.b64decode(required('DIST_CERT_BASE64')))
profile=root/'profile.mobileprovision';profile.write_bytes(base64.b64decode(required('PROFILE_BASE64')))
data=plistlib.loads(subprocess.check_output(['security','cms','-D','-i',str(profile)],stderr=subprocess.DEVNULL))
team=required('APPLE_TEAM_ID');bundle='com.hiroyaapps.uchinokaji'
if data['TeamIdentifier'][0]!=team or data['Entitlements']['application-identifier']!=team+'.'+bundle: raise SystemExit('Profile must belong to the selected team and '+bundle)
if data['ExpirationDate']<datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None): raise SystemExit('Provisioning profile expired')
if data.get('ProvisionedDevices') or data.get('ProvisionsAllDevices') or data['Entitlements'].get('get-task-allow'): raise SystemExit('App Store distribution profile required')
uuid=data['UUID']
for relative in ['Library/MobileDevice/Provisioning Profiles','Library/Developer/Xcode/UserData/Provisioning Profiles']:
 installed=pathlib.Path.home()/relative;installed.mkdir(parents=True,exist_ok=True);(installed/(uuid+'.mobileprovision')).write_bytes(profile.read_bytes())
key_id=required('API_KEY_ID')
if not key_id.isalnum(): raise SystemExit('Invalid API key ID')
keys=root/'private_keys';keys.mkdir(exist_ok=True);key=keys/('AuthKey_'+key_id+'.p8');key.write_text(required('API_PRIVATE_KEY'));key.chmod(0o600)
(root/'ExportOptions.plist').write_bytes(plistlib.dumps({'method':'app-store-connect','teamID':team,'signingStyle':'manual','signingCertificate':'Apple Distribution','provisioningProfiles':{bundle:uuid},'manageAppVersionAndBuildNumber':False}))
with open(os.environ['GITHUB_ENV'],'a') as env:env.write('IOS_PROFILE_UUID='+uuid+'\nIOS_TEAM_ID='+team+'\nAPI_PRIVATE_KEYS_DIR='+str(keys)+'\n')
print('Validated the dedicated App Store provisioning profile and prepared signing files.')
