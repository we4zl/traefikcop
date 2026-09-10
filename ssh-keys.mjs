import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,readdir,rm,chmod} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const exec=promisify(execFile);
const id=()=>randomBytes(16).toString('hex');
const valid=id=>typeof id==='string'&&/^[a-f0-9]{32}$/.test(id);
export const fingerprint=key=>'SHA256:'+createHash('sha256').update(Buffer.from(key.split(/\s+/)[1],'base64')).digest('base64').replace(/=+$/,'');
export class SSHKeys {
  constructor(dataDir){this.directory=path.join(dataDir,'ssh');this.scans=new Map();}
  async init(){await mkdir(this.directory,{recursive:true,mode:0o700});await chmod(this.directory,0o700);}
  async list(){const entries=await readdir(this.directory);return Promise.all(entries.filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>readFile(path.join(this.directory,n),'utf8').then(JSON.parse)));}
  async generate(name){
    if(typeof name!=='string'||!name.trim()||name.length>80)throw new Error('Name the SSH key (up to 80 characters).');
    if((await this.list()).length>=100)throw new Error('The app already has 100 keys. Reuse an existing key.');
    const keyId=id(),filename=path.join(this.directory,keyId);
    try{
      await exec('ssh-keygen',['-q','-t','ed25519','-N','','-C','traefikcop-'+keyId.slice(0,8),'-f',filename],{timeout:10000});
      await chmod(filename,0o600);
      const publicKey=(await readFile(filename+'.pub','utf8')).trim();
      const metadata={id:keyId,name:name.trim(),publicKey,fingerprint:fingerprint(publicKey),createdAt:new Date().toISOString()};
      await writeFile(filename+'.json',JSON.stringify(metadata),{mode:0o600,flag:'wx'});return metadata;
    }catch{await Promise.all([filename,filename+'.pub',filename+'.json'].map(p=>rm(p,{force:true})));throw new Error('Could not generate an SSH key. Install OpenSSH client tools on the app server.');}
  }
  async key(keyId){if(!valid(keyId))throw new Error('Select an app-managed SSH key.');try{return JSON.parse(await readFile(path.join(this.directory,keyId+'.json'),'utf8'));}catch{throw new Error('SSH key not found in app storage.');}}
  async scan(h){
    for(const [k,v] of this.scans)if(v.expires<Date.now())this.scans.delete(k);
    if(this.scans.size>=100)throw new Error('Too many pending fingerprint checks. Try again later.');
    let stdout;try{({stdout}=await exec('ssh-keyscan',['-T','5','-t','ed25519','-p',String(h.port),h.address],{timeout:8000,maxBuffer:32768}));}catch{throw new Error('Could not read the server fingerprint. Check its address, SSH port, and network access. An Ed25519 host key is required.');}
    const lines=stdout.split('\n').filter(l=>!l.startsWith('#')&&l.includes(' ssh-ed25519 '));
    const keys=[...new Set(lines.map(l=>l.trim().split(/\s+/).slice(1,3).join(' ')))];
    if(keys.length!==1)throw new Error('The address returned conflicting or missing host keys. Use a specific server address.');
    const scan={id:id(),address:h.address,port:h.port,key:keys[0],fingerprint:fingerprint(keys[0]),expires:Date.now()+600000};this.scans.set(scan.id,scan);
    return {id:scan.id,fingerprint:scan.fingerprint};
  }
  async trust(h,scanId,confirmedFingerprint){
    await this.key(h.managedKeyId);
    const scan=this.scans.get(scanId);
    if(!scan||scan.expires<Date.now()||scan.address!==h.address||scan.port!==h.port||scan.fingerprint!==confirmedFingerprint)throw new Error('Fingerprint check expired or connection details changed. Scan and verify again.');
    const trustId=id();
    await writeFile(path.join(this.directory,trustId+'.known_hosts'),`[${h.address}]:${h.port} ${scan.key}\n${h.address} ${scan.key}\n`,{mode:0o600,flag:'wx'});
    await writeFile(path.join(this.directory,trustId+'.trust'),JSON.stringify({address:h.address,port:h.port,fingerprint:scan.fingerprint}),{mode:0o600,flag:'wx'});
    this.scans.delete(scanId);return trustId;
  }
  async identity(h){
    await this.key(h.managedKeyId);
    if(!valid(h.trustId))throw new Error('Verify this server’s SSH fingerprint first.');
    const trust=JSON.parse(await readFile(path.join(this.directory,h.trustId+'.trust'),'utf8'));
    if(trust.address!==h.address||trust.port!==h.port)throw new Error('SSH endpoint changed. Verify the new server fingerprint.');
    return {key:path.join(this.directory,h.managedKeyId),knownHosts:path.join(this.directory,h.trustId+'.known_hosts')};
  }
}
