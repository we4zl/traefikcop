import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
const exec = promisify(execFile);
export const keyDirectory = process.env.TRAEFIKCOP_SSH_DIR || path.join(homedir(), '.local/share/traefikcop/ssh');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
let keyStore;
export function configureSSHKeys(store){keyStore=store;}
export function validateHost(input) {
  const h = Object.fromEntries(['name','address','user','key','container','staticFile','location'].map(k => [k, String(input[k] || '').trim()]));
  h.port = Number(input.port || 22);
  if(input.managedKeyId){if(!/^[a-f0-9]{32}$/.test(input.managedKeyId))throw new Error('Invalid managed SSH key.');h.managedKeyId=input.managedKeyId;h.key='';}
  if (!h.name || h.name.length > 80) throw new Error('Enter a host name of 1–80 characters.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(h.address)) throw new Error('Enter an SSH hostname or IP address.');
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(h.user)) throw new Error('Enter a valid SSH username.');
  if (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535) throw new Error('Invalid SSH port.');
  if (!h.managedKeyId && (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,100}$/.test(h.key) || h.key.includes('..'))) throw new Error('Use a key filename from the configured SSH key directory.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(h.container)) throw new Error('Enter a valid Docker container name.');
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(h.staticFile) || h.staticFile.split('/').includes('..')) throw new Error('Enter an absolute static configuration path inside the container.');
  return h;
}
export async function ssh(h, command, input, timeout=20000) {
  const identity=h.managedKeyId?await keyStore.identity(h):{key:path.join(keyDirectory,h.key)};
  try {
    const operation = exec('ssh', ['-T',...(identity.knownHosts?['-F','/dev/null','-o','UserKnownHostsFile='+identity.knownHosts,'-o','GlobalKnownHostsFile=/dev/null']:[]),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-o','ConnectionAttempts=1','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o','IdentitiesOnly=yes','-i',identity.key,'-p',String(h.port),`${h.user}@${h.address}`,command], {timeout,maxBuffer:4*1024*1024,encoding:'utf8'});
    operation.child.stdin.on('error',()=>{});
    operation.child.stdin.end(input);
    const {stdout}=await operation;
    return stdout;
  } catch (e) {
    const stderr=String(e.stderr || '');
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)) throw new Error('SSH host key verification failed. Verify the server fingerprint in known_hosts.');
    if (/Permission denied/.test(stderr)) throw new Error('SSH or Docker permission denied. Check the SSH key and Docker access.');
    if (/No such container|No such object/.test(stderr)) throw new Error('The configured Traefik container was not found.');
    if (/No such file|can.t open/.test(stderr)) throw new Error('The configured file was not found.');
    if (/resolve hostname/.test(stderr)) throw new Error('The SSH hostname could not be resolved.');
    if (e.killed || /timed out/.test(stderr)) throw new Error('SSH connection timed out.');
    throw new Error('Remote command failed. Check that SSH, Docker, and the container are available.');
  }
}
const containerCommand = (h, ...args) => ['docker','exec',h.container,...args].map(quote).join(' ');
const safeURL = value => { try { const u=new URL(value); u.username='';u.password='';u.search='';u.hash='';return u.toString(); } catch { return ''; } };
export function extractRoutes(hostId, config, source, file='') {
  const http=config.http || {}, services=http.services || {};
  return Object.entries(http.routers || {}).map(([name,r])=>{
    const targets=(services[r.service]?.loadBalancer?.servers || []).map(s=>safeURL(s.url)).filter(Boolean);
    const domains=[...String(r.rule || '').matchAll(/Host\(\s*[`"]([^`"]+)[`"]/g)].map(m=>m[1]);
    return {id:`${hostId}:${source}:${file}:${name}`,host:hostId,name,domains,target:targets.join(', ') || String(r.service || 'Provider default'),targets,tls:r.tls!==undefined && r.tls!==false,resolver:r.tls?.certResolver || '',enabled:true,source,entrypoint:(r.entryPoints || []).join(', '),rule:r.rule || '',middlewares:r.middlewares || [],file,status:'configured'};
  });
}
export function dockerRoutes(hostId, containers) {
  const routes=[];
  for(const c of containers) {
    const labels=c.Config?.Labels || {};
    if(labels['traefik.enable']!=='true') continue;
    const routers={};
    for(const [key,value] of Object.entries(labels)) {
      const match=/^traefik\.http\.routers\.([^.]+)\.(.+)$/i.exec(key);
      if(!match)continue;
      const r=routers[match[1]] ||= {}, field=match[2].toLowerCase();
      if(field==='rule'||field==='service')r[field]=value;
      if(field==='entrypoints')r.entryPoints=value.split(',').map(s=>s.trim());
      if(field==='middlewares')r.middlewares=value.split(',').map(s=>s.trim());
      if(field==='tls' && value==='true')r.tls ||= {};
      if(field==='tls.certresolver'){r.tls ||= {};r.tls.certResolver=value;}
    }
    routes.push(...extractRoutes(hostId,{http:{routers}},'docker',c.Name || c.Id));
  }
  return routes;
}
export async function inspectHost(h, run=ssh) {
  const [c]=JSON.parse(await run(h,`docker inspect --type container ${quote(h.container)}`));
  if(!c)throw new Error('Docker returned no container.');
  const base={...h,status:c.State?.Running?'online':'offline',version:c.Config?.Labels?.['org.opencontainers.image.version'] || '',image:c.Config?.Image,containerState:c.State?.Status,startedAt:c.State?.StartedAt,networks:Object.keys(c.NetworkSettings?.Networks || {}),mounts:(c.Mounts || []).map(m=>({source:m.Source,destination:m.Destination,readOnly:!m.RW})),lastChecked:new Date().toISOString(),error:'',warnings:[]};
  if(!c.State?.Running)return {host:base,routes:[],resolvers:[]};
  const config=parse(await run(h,containerCommand(h,'cat',h.staticFile)),{maxAliasCount:50}) || {};
  base.entrypoints=Object.entries(config.entryPoints || {}).map(([name,e])=>({name,address:e.address}));
  base.fileProvider=config.providers?.file ? {filename:config.providers.file.filename,directory:config.providers.file.directory,watch:config.providers.file.watch!==false} : null;
  const resolvers=Object.entries(config.certificatesResolvers || {}).map(([name,r])=>({id:`${h.id}:${name}`,host:h.id,name,email:r.acme?.email || '',challenge:r.acme?.dnsChallenge?'dns':r.acme?.httpChallenge?'http':r.acme?.tlsChallenge?'tls':'other',provider:r.acme?.dnsChallenge?.provider || '',staging:!!r.acme?.caServer?.includes('staging'),autoRenew:!!r.acme,certificateDurationHours:r.acme?.certificatesDuration??2160,source:'live'}));
  let files=[];
  if(base.fileProvider?.filename)files=[base.fileProvider.filename];
  else if(base.fileProvider?.directory){
    files=(await run(h,containerCommand(h,'find',base.fileProvider.directory,'-type','f'))).split('\n').filter(p=>/\.ya?ml$/i.test(p)).slice(0,30);
    base.warnings.push('Directory discovery includes up to 30 YAML files; TOML is not yet supported.');
  }
  const routes=[];
  for(const file of files){
    if(!String(file).startsWith('/')){base.warnings.push('A relative configuration path was skipped.');continue;}
    try {routes.push(...extractRoutes(h.id,parse(await run(h,containerCommand(h,'cat',file)),{maxAliasCount:50}) || {},'file',file));}
    catch {base.warnings.push(`Could not read or parse dynamic configuration: ${file}`);}
  }
  if(config.providers?.docker){
    try {
      const ids=(await run(h,'docker ps -q')).trim().split(/\s+/).filter(id=>/^[a-f0-9]+$/.test(id));
      if(ids.length)routes.push(...dockerRoutes(h.id,JSON.parse(await run(h,'docker inspect --type container '+ids.slice(0,100).map(quote).join(' ')))));
      if(ids.length>100)base.warnings.push('Docker discovery was limited to the first 100 containers.');
    } catch {base.warnings.push('Docker-label route discovery failed.');}
  }
  base.directory=base.fileProvider?.directory || base.fileProvider?.filename || '';
  base.warnings.push('Discovery reads configuration sources. Application health, active API state, and certificate expiry have not been verified. TCP port reachability is checked separately.');
  return JSON.parse(JSON.stringify({host:base,routes,resolvers}));
}

// Run the probe inside the existing Traefik container: same DNS and network namespace.
// Python runs on the Docker host only to coordinate bounded, parallel docker exec calls.
const probeScript = `import concurrent.futures,json,subprocess,sys,time
data=json.loads(sys.argv[1])
def check(target):
 started=time.monotonic()
 try:
  p=subprocess.run(['docker','exec',data['container'],'nc','-z','-w','3',target['hostname'],str(target['port'])],capture_output=True,text=True,timeout=5)
  diagnostic=(p.stderr+p.stdout).lower()
  unavailable=any(s in diagnostic for s in ['executable file not found','invalid option','unrecognized option','permission denied','is not running','no such container']) or p.returncode in [125,126,127]
  status='unknown' if unavailable else 'up' if p.returncode==0 else 'down'
  reason='TCP connection accepted' if status=='up' else 'Probe tool unavailable in container' if status=='unknown' else 'Name resolution failed' if 'bad address' in diagnostic else 'Connection refused or timed out'
 except subprocess.TimeoutExpired:
  status,reason='down','Connection check timed out after 5 seconds'
 except Exception:
  status,reason='unknown','Unable to execute container probe'
 return dict(target,status=status,reason=reason,durationMs=round((time.monotonic()-started)*1000))
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
 print(json.dumps(list(pool.map(check,data['targets']))))
`;
export async function probeHealth(h,routes,run=ssh){
  const endpoints=new Map();
  for(const route of routes)for(const url of route.targets||[]){
    try{const u=new URL(url);if(!['http:','https:','h2c:'].includes(u.protocol))continue;const hostname=u.hostname.replace(/^\[|\]$/g,'');const port=Number(u.port||(u.protocol==='https:'?443:80));if(hostname.startsWith('-'))continue;endpoints.set(url,{url,hostname,port});}catch{}
  }
  const checkedAt=new Date().toISOString();let results=[];
  if(endpoints.size){
    try{results=JSON.parse(await run(h,`python3 -c ${quote(probeScript)} ${quote(JSON.stringify({container:h.container,targets:[...endpoints.values()].slice(0,24)}))}`));}
    catch{results=[...endpoints.values()].map(t=>({...t,status:'unknown',reason:'Probe unavailable. Check SSH, host Python 3, and container nc support.'}));}
  }
  const byURL=new Map(results.map(r=>[r.url,r]));
  return routes.map(r=>{
    const checks=(r.targets||[]).map(url=>byURL.get(url)||{url,status:'unknown',reason:'Unsupported backend protocol or probe limit reached.'});
    const status=!checks.length?'unknown':checks.every(c=>c.status==='up')?'up':checks.every(c=>c.status==='down')?'down':checks.some(c=>c.status==='up'||c.status==='down')?'partial':'unknown';
    return {...r,health:{status,checks,checkedAt,perspective:'Traefik container',kind:'TCP',reason:checks.length?'':r.source==='docker'?'Docker-label backend address not resolved; no port probe performed.':'No concrete backend URL available.'}};
  });
}
