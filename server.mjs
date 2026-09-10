import {createHostPolicy} from './access.mjs';
import {SSHKeys} from './ssh-keys.mjs';
import {connectionFacts,planCertificate,applyCertificate,certificateStatus} from './onboarding.mjs';
import http from 'node:http';
import {inspectCertificates} from './certificates.mjs';
import {TrafficStore,startTrafficCollector,RANGES} from './traffic.mjs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { inspectHost, probeHealth, validateHost, keyDirectory, extractRoutes, configureSSHKeys } from './remote.mjs';
import {readConfig,editorForm,buildChange,writeConfig,hash,validDomain,domainForHostname,document as configDocument} from './editor.mjs';

const scrypt=promisify(scryptCallback), port=Number(process.env.PORT || 3001);
const hostPolicy=createHostPolicy({port,allowLAN:process.env.TRAEFIKCOP_ALLOW_LAN==='1',extraHosts:process.env.TRAEFIKCOP_ALLOWED_HOSTS||''});
const dataDir=path.resolve(process.env.TRAEFIKCOP_DATA_DIR || '.data');
await mkdir(dataDir,{recursive:true,mode:0o700});
const sshKeys=new SSHKeys(dataDir);await sshKeys.init();configureSSHKeys(sshKeys);
const certificatePlans=new Map();
const dbPath=path.join(dataDir,'state.json');
let db;
try { db=JSON.parse(await readFile(dbPath,'utf8')); }
catch(e){if(e.code!=='ENOENT')throw e;db={admin:null,hosts:[],events:[]};}
let queue=Promise.resolve();
function transact(fn){const work=queue.then(async()=>{const next=structuredClone(db);await fn(next);const temp=dbPath+'.tmp';await writeFile(temp,JSON.stringify(next,null,2),{mode:0o600});await rename(temp,dbPath);db=next;});queue=work.catch(()=>{});return work;}
await transact(next=>{next.domains ||= [];next.disabled ||= {};next.revisions ||= [];next.certificateJobs ||= [];for(const job of next.certificateJobs)if(job.status==='applying')Object.assign(job,{status:'interrupted',message:'The app restarted during setup. Inspect the remote deployment before retrying.'});});
const traffic=new TrafficStore(path.join(dataDir,'traffic.sqlite'));
const collector=startTrafficCollector({store:traffic,getHosts:()=>db.hosts,onError:()=>console.error('Traffic collector could not persist a sample.')});
const sessions=new Map(), attempts=new Map(), snapshots=new Map(), inFlight=new Map(), previews=new Map(), editing=new Set();
const disabledKey=(h,file,name)=>hash(h+':'+file+':'+name);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const token=()=>randomBytes(32).toString('base64url');
const sessionCookie=(value,age)=>`tc_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function hashPassword(password,salt=randomBytes(16).toString('hex')){return {salt,hash:(await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024})).toString('hex')};}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
async function body(req){if(!req.headers['content-type']?.startsWith('application/json'))throw Object.assign(new Error('JSON required.'),{status:415});let data='';for await(const chunk of req){data+=chunk;if(data.length>32768)throw Object.assign(new Error('Request too large.'),{status:413});}try{return JSON.parse(data);}catch{throw Object.assign(new Error('Invalid JSON.'),{status:400});}}
function event(next,title,detail,type='host'){next.events.unshift({id:token(),title,detail,type,time:Date.now()});next.events=next.events.slice(0,100);}
function currentSession(req){const value=(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('tc_session='))?.slice(11);const s=sessions.get(value);if(!s || s.expires<Date.now()){sessions.delete(value);return null;}return {value,...s};}
function newSession(res){const id=token(),csrf=token();sessions.set(id,{csrf,expires:Date.now()+8*3600000});res.setHeader('Set-Cookie',sessionCookie(id,8*3600));return csrf;}
function rateLimit(key){const now=Date.now();for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);const value=attempts.get(key)||{count:0,until:now+15*60000};value.count++;attempts.set(key,value);return value.count<=10;}
async function refresh(h){
  if(editing.has(h.id))throw fail('A configuration change is being applied. Try again shortly.',409);
  if(inFlight.has(h.id))return inFlight.get(h.id);
  const work=(async()=>{
    let result;
    try{result=await inspectHost(h);if(result.host.status==='online'){const [routes,certs]=await Promise.all([probeHealth(h,result.routes),inspectCertificates(h,result)]);result.routes=routes;Object.assign(result,certs);}}catch(e){result={host:{...h,status:'offline',error:e.message,lastChecked:new Date().toISOString(),warnings:[]},routes:[],resolvers:[]};}
    snapshots.set(h.id,result);
    await transact(next=>event(next,result.host.status==='online'?'Host refreshed':'Host unavailable',`${h.name}${result.host.error?' · '+result.host.error:''}`,result.host.status==='online'?'host':'warning'));
    return result;
  })().finally(()=>inFlight.delete(h.id));inFlight.set(h.id,work);return work;
}
function workspace(){
  const routes=db.hosts.flatMap(h=>snapshots.get(h.id)?.routes||[]);
  for(const d of Object.values(db.disabled)){if(db.hosts.some(h=>h.id===d.host)&&!routes.some(r=>r.host===d.host&&r.file===d.file&&r.name===d.name))routes.push({...d.display,enabled:false,health:{status:'unknown',reason:'Application is disabled.'}});}
  return {hosts:db.hosts.map(h=>({...h,status:'pending',...(snapshots.get(h.id)?.host||{})})),routes:routes.filter(r=>!r.name.startsWith('traefikcop-certificate-')),certificateJobs:db.certificateJobs,resolvers:db.hosts.flatMap(h=>snapshots.get(h.id)?.resolvers||[]),certificates:db.hosts.flatMap(h=>snapshots.get(h.id)?.certificates||[]),certificateErrors:db.hosts.flatMap(h=>snapshots.get(h.id)?.certificateErrors||[]),domains:db.domains,events:db.events,revisions:db.revisions.map(({id,host,name,summary,status,time})=>({id,host,name,summary,status,time})),username:db.admin.username,accessMode:hostPolicy.label,keyDirectory,live:true};
}
async function applicationPreview(input){
  const h=db.hosts.find(h=>h.id===input.host);if(!h)throw fail('Host not found.',404);
  if(editing.has(h.id))throw fail('A change is already in progress.',409);
  const bundle=await readConfig(h,input.file);
  const key=disabledKey(h.id,bundle.file,input.routeName||'');
  const disabled=db.disabled[key];
  const current=await inspectHost(h);
  const change=buildChange(bundle,input,{disabled,domain:domainForHostname(db.domains.filter(d=>d.host===h.id),String(input.hostname??input.domain??'').trim().toLowerCase().replace(/\.$/,'')),allRoutes:current.routes});
  const id=token();
  for(const [k,p] of previews)if(p.expires<Date.now())previews.delete(k);
  if(previews.size>100)throw fail('Too many pending previews. Try again later.',429);
  previews.set(id,{h,bundle,change,input,expires:Date.now()+10*60000});
  return {id,summary:change.summary,host:h.name,application:change.name,action:change.action,enabled:!change.disabled,notice:(change.notice?change.notice+' ':'')+'Saving updates the remote configuration file. Traefik watches it for reloads. Existing middleware is preserved; a backup and rollback revision are saved.'};
}
async function applyPreview(id){
  const preview=previews.get(id);if(!preview||preview.expires<Date.now())throw fail('Preview expired. Review the form again.',409);
  const {h,bundle,change}=preview;
  if(editing.has(h.id)||inFlight.has(h.id))throw fail('Wait for the current host operation to finish.',409);
  if(!db.hosts.some(x=>x.id===h.id&&JSON.stringify(x)===JSON.stringify(h)))throw fail('Connection settings changed. Review again.',409);
  editing.add(h.id);previews.delete(id);
  const revisionId=randomBytes(16).toString('hex'),key=disabledKey(h.id,bundle.file,change.name);
  const previousDisabled=db.disabled[key]||null;
  if(change.previousDisabled!==undefined&&JSON.stringify(previousDisabled)!==JSON.stringify(change.previousDisabled)){editing.delete(h.id);throw fail('Disabled application state changed since preview. Review again.',409);}
  const nextDisabled=change.disabled ? {...change.disabled,host:h.id,file:bundle.file,name:change.name,display:extractRoutes(h.id,{http:{routers:{[change.name]:change.disabled.router},services:configDocument(change.content).toJS().http?.services||{}}},'file',bundle.file)[0]} : null;
  try{
    // Journal before touching the remote host so an interrupted request remains recoverable.
    await transact(next=>{next.revisions.unshift({id:revisionId,host:h.id,name:change.name,summary:change.summary,status:'pending',time:Date.now(),file:bundle.file,path:bundle.path,before:bundle.text,after:change.content,beforeDisabled:previousDisabled,afterDisabled:nextDisabled,key});});
    // Recheck the mount and file, including when an edit changes only a disabled router.
    const live=await readConfig(h,bundle.file);
    if(live.version!==bundle.version||live.path!==bundle.path)throw fail('Configuration or mount changed since preview. Review again.',409);
    if(change.changed)await writeConfig(h,bundle,change.content,undefined,revisionId);
    await transact(next=>{if(nextDisabled)next.disabled[key]=nextDisabled;else delete next.disabled[key];next.revisions.find(r=>r.id===revisionId).status='applied';event(next,'Application '+({save:'saved',disable:'disabled',enable:'enabled',delete:'deleted'}[change.action]),change.summary,'application');});
  }catch(e){await transact(next=>{const r=next.revisions.find(r=>r.id===revisionId);if(r)r.status=e.status===409?'conflict':'uncertain';});throw e;}
  finally{editing.delete(h.id);}
  await refresh(h);
  return {ok:true,revision:revisionId,message:'Saved to the mounted configuration. Traefik reload is requested by its file watcher; runtime API confirmation is not configured.'};
}
async function restoreRevision(id){
  const revision=db.revisions.find(r=>r.id===id);if(!revision)throw fail('Revision not found.',404);
  if(revision.status==='conflict')throw fail('This change was rejected and cannot be restored.');
  const h=db.hosts.find(h=>h.id===revision.host);if(!h)throw fail('Host is no longer configured.');
  const bundle=await readConfig(h,revision.file);
  if(bundle.version!==hash(revision.after))throw fail('Newer or external changes exist. Restore the most recent change first.',409);
  const key=revision.key;
  if(JSON.stringify(db.disabled[key]||null)!==JSON.stringify(revision.afterDisabled)&&!['pending','uncertain'].includes(revision.status))throw fail('Disabled application state has changed. Restore the latest change first.',409);
  const previewId=token();
  previews.set(previewId,{h,bundle,input:{},expires:Date.now()+600000,change:{name:revision.name,summary:'Restore before: '+revision.summary,content:revision.before,disabled:revision.beforeDisabled,previousDisabled:db.disabled[key]||null,action:'save',changed:hash(revision.before)!==bundle.version}});
  return {id:previewId,summary:'Restore before: '+revision.summary,host:h.name,notice:'This restores the configuration file and this application’s enabled state. It is blocked if newer or external edits exist.'};
}

const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']],['/assets/weazlhead.jpg',['assets/weazlhead.jpg','image/jpeg']],['/traffic.js',['traffic.js','text/javascript; charset=utf-8']],['/onboarding.js',['onboarding.js','text/javascript; charset=utf-8']]]);
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  // Reject DNS rebinding and cross-origin requests, including initial account setup.
  if(!hostPolicy.allows(req.headers.host)){json(res,403,{error:'Host not allowed. Use the server’s LAN IP or configure TRAEFIKCOP_ALLOWED_HOSTS.'});return;}
  const requestURL=new URL(req.url,`http://${req.headers.host}`);const pathname=requestURL.pathname;
  try{
    if(!pathname.startsWith('/api/')){
      if(!['GET','HEAD'].includes(req.method)){json(res,405,{error:'Method not allowed.'});return;}
      const asset=assets.get(pathname);if(!asset){json(res,404,{error:'Not found.'});return;}
      const data=await readFile(fileURLToPath(new URL(`./public/${asset[0]}`,import.meta.url)));res.writeHead(200,{'Content-Type':asset[1]});res.end(req.method==='HEAD'?undefined:data);return;
    }
    const write=!['GET','HEAD'].includes(req.method);
    if(write && req.headers.origin!==`http://${req.headers.host}`){json(res,403,{error:'Same-origin request required.'});return;}
    const session=currentSession(req);
    if(pathname==='/api/session' && req.method==='GET'){json(res,200,{authenticated:!!session,setupRequired:!db.admin,username:session?db.admin.username:undefined,csrf:session?.csrf});return;}
    if(['/api/setup','/api/login'].includes(pathname) && req.method==='POST'){
      if(!rateLimit(req.socket.remoteAddress)){json(res,429,{error:'Too many attempts. Try again in 15 minutes.'});return;}
      const input=await body(req);
      if(typeof input?.username!=='string'||typeof input?.password!=='string'||input.password.length>256){json(res,400,{error:'Enter a username and password.'});return;}
      if(pathname==='/api/setup'){
        if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(input.username)||input.password.length<12){json(res,400,{error:'Use a valid username and a password of at least 12 characters.'});return;}
        await transact(async next=>{if(next.admin)throw Object.assign(new Error('Administrator already configured.'),{status:409});next.admin={username:input.username,...await hashPassword(input.password)};event(next,'Administrator created',input.username,'auth');});
      } else {
        const candidate=await hashPassword(input.password,db.admin?.salt || '0'.repeat(32));
        if(!db.admin || input.username!==db.admin.username || !equal(candidate.hash,db.admin.hash)){json(res,401,{error:'Invalid username or password.'});return;}
      }
      attempts.delete(req.socket.remoteAddress);json(res,200,{csrf:newSession(res),username:db.admin.username});return;
    }
    if(!session){json(res,401,{error:'Please sign in.'});return;}
    if(write && !equal(req.headers['x-csrf-token'],session.csrf)){json(res,403,{error:'Invalid session token. Sign in again.'});return;}
    if(pathname==='/api/logout' && req.method==='POST'){sessions.delete(session.value);res.setHeader('Set-Cookie',sessionCookie('',0));json(res,200,{ok:true});return;}
    if(pathname==='/api/traffic' && req.method==='GET'){
      const scope=requestURL.searchParams.get('host')||'all',range=requestURL.searchParams.get('range')||'10m';
      if(!Object.hasOwn(RANGES,range))throw fail('Invalid traffic range.');
      const hosts=scope==='all'?db.hosts:db.hosts.filter(h=>h.id===scope);
      if(scope!=='all'&&!hosts.length)throw fail('Host not found.',404);
      json(res,200,traffic.history(hosts,range));return;
    }
    if(pathname==='/api/workspace' && req.method==='GET'){json(res,200,workspace());return;}
    if(pathname==='/api/ssh/keys' && req.method==='GET'){json(res,200,await sshKeys.list());return;}
    if(pathname==='/api/ssh/keys' && req.method==='POST'){const input=await body(req);json(res,201,await sshKeys.generate(input.name));return;}
    if(pathname==='/api/ssh/scan' && req.method==='POST'){const h=validateHost(await body(req));json(res,200,await sshKeys.scan(h));return;}
    if(pathname==='/api/onboarding/connection' && req.method==='POST'){const input=await body(req),h=db.hosts.find(h=>h.id===input.host);if(!h)throw fail('Host not found.',404);json(res,200,await connectionFacts(h));return;}
    if(pathname==='/api/onboarding/certificate/preview' && req.method==='POST'){
      const input=await body(req),h=db.hosts.find(h=>h.id===input.host);if(!h)throw fail('Host not found.',404);
      if(editing.has(h.id))throw fail('A change is already in progress.',409);
      for(const [id,p] of certificatePlans)if(p.expires<Date.now())certificatePlans.delete(id);
      if(certificatePlans.size>=30)throw fail('Too many pending certificate reviews.',429);
      const plan=await planCertificate(h,input);certificatePlans.set(plan.id,plan);
      json(res,200,{id:plan.id,kind:plan.kind,domain:plan.domain,summary:plan.summary});return;
    }
    if(pathname==='/api/onboarding/certificate/apply' && req.method==='POST'){
      const input=await body(req),plan=certificatePlans.get(input.id);
      if(!plan||plan.expires<Date.now())throw fail('Review expired. Open certificate setup again.',409);
      const h=db.hosts.find(h=>h.id===plan.h.id);if(!h||JSON.stringify(h)!==JSON.stringify(plan.h))throw fail('Connection settings changed. Review again.',409);
      if(editing.has(h.id)||inFlight.has(h.id))throw fail('Wait for the current host operation to finish.',409);
      editing.add(h.id);certificatePlans.delete(plan.id);
      const job={id:plan.id,host:h.id,domain:plan.domain,status:'applying',message:'Applying the reviewed configuration over SSH…',createdAt:Date.now()};
      try{await transact(next=>{next.certificateJobs=next.certificateJobs.filter(j=>!(j.host===h.id&&j.domain.name===job.domain.name));next.certificateJobs.unshift(job);});}catch(e){editing.delete(h.id);throw e;}
      void (async()=>{
        try{
          await applyCertificate(plan);
          await transact(next=>{next.domains=next.domains.filter(d=>d.id!==plan.domain.id);next.domains.push(plan.domain);Object.assign(next.certificateJobs.find(j=>j.id===job.id),{status:'waiting',message:'Request configured. Waiting for Traefik to serve the certificate.'});event(next,'Certificate requested',plan.domain.name,'domain');});
        }catch(e){await transact(next=>Object.assign(next.certificateJobs.find(j=>j.id===job.id),{status:'error',message:e.code?'Setup failed. Inspect the remote deployment before retrying.':e.message}));}
        finally{editing.delete(h.id);if(plan.deployment)plan.deployment.secret='';}
        await refresh(h);
      })().catch(()=>console.error('Certificate setup could not persist its final status. Inspect the remote host.'));
      json(res,202,job);return;
    }
    if(pathname==='/api/onboarding/certificate/status' && req.method==='POST'){
      const input=await body(req),job=db.certificateJobs.find(j=>j.id===input.id);if(!job)throw fail('Certificate request not found.',404);
      const h=db.hosts.find(h=>h.id===job.host);if(!h)throw fail('Host not found.',404);
      if(['waiting','issued','error','interrupted'].includes(job.status)&&!editing.has(h.id)){
        let status;try{status=await certificateStatus(h,job.domain);}catch(e){status={status:'waiting',message:e.message};}
        await transact(next=>{const saved=next.certificateJobs.find(j=>j.id===job.id);if(!saved)return;if(['error','interrupted'].includes(saved.status)&&status.status!=='issued')saved.lastCheck=status.message;else Object.assign(saved,status);saved.checkedAt=Date.now();});
      }
      json(res,200,db.certificateJobs.find(j=>j.id===job.id));return;
    }
    if(pathname==='/api/hosts' && req.method==='POST'){
      const input=await body(req),h={...validateHost(input),id:token()};if(h.managedKeyId)h.trustId=await sshKeys.trust(h,input.scanId,input.fingerprint);await transact(next=>{if(next.hosts.length>=50)throw new Error('Maximum of 50 hosts reached.');next.hosts.push(h);event(next,'Host added',h.name);});json(res,201,h);return;
    }
    if(pathname==='/api/application' && req.method==='GET'){
      const h=db.hosts.find(h=>h.id===requestURL.searchParams.get('host'));if(!h)throw fail('Host not found.',404);
      const file=requestURL.searchParams.get('file')||undefined,name=requestURL.searchParams.get('name')||'';
      const bundle=await readConfig(h,file);const disabled=db.disabled[disabledKey(h.id,bundle.file,name)];
      json(res,200,{...editorForm(bundle,name,disabled),host:h.id});return;
    }
    if(pathname==='/api/applications/preview' && req.method==='POST'){json(res,200,await applicationPreview(await body(req)));return;}
    if(pathname==='/api/applications/apply' && req.method==='POST'){const input=await body(req);json(res,200,await applyPreview(input.id));return;}
    if(pathname==='/api/history/restore' && req.method==='POST'){const input=await body(req);json(res,200,await restoreRevision(input.id));return;}
    if(pathname==='/api/domains' && req.method==='POST'){
      const input=await body(req),h=db.hosts.find(h=>h.id===input.host);if(!h)throw fail('Host not found.',404);
      const name=String(input.name||'').trim().toLowerCase();if(!validDomain(name))throw fail('Enter a valid domain name.');
      const inspection=await inspectHost(h);
      const resolver=inspection.resolvers.find(r=>r.name===input.resolver);if(!resolver)throw fail('Select a certificate resolver configured on this host.');
      if(input.wildcard&&resolver.challenge!=='dns')throw fail('Wildcard certificates need DNS validation.');
      if(!inspection.host.entrypoints.some(e=>e.name===input.entrypoint))throw fail('Select a configured HTTPS entry point.');
      const domain={id:hash(h.id+':'+name).slice(0,24),host:h.id,name,resolver:resolver.name,entrypoint:input.entrypoint,wildcard:!!input.wildcard};
      await transact(next=>{next.domains=next.domains.filter(d=>d.id!==domain.id);next.domains.push(domain);event(next,'Domain settings saved',name,'domain');});json(res,200,domain);return;
    }
    const match=/^\/api\/hosts\/([a-zA-Z0-9_-]+)(\/refresh)?$/.exec(pathname);
    if(match){
      const h=db.hosts.find(h=>h.id===match[1]);if(!h){json(res,404,{error:'Host not found.'});return;}
      if(match[2] && req.method==='POST'){json(res,200,await refresh(h));return;}
      if(!match[2] && req.method==='PUT'){if(inFlight.has(h.id)||editing.has(h.id)){json(res,409,{error:'Wait for the current connection check to finish.'});return;}const input=await body(req),updated={...validateHost(input),id:h.id};if(updated.managedKeyId){await sshKeys.key(updated.managedKeyId);if(h.trustId&&h.address===updated.address&&h.port===updated.port)updated.trustId=h.trustId;else updated.trustId=await sshKeys.trust(updated,input.scanId,input.fingerprint);}if((db.revisions.some(r=>r.host===h.id)||db.certificateJobs.some(j=>j.host===h.id))&&(updated.address!==h.address||updated.user!==h.user||updated.port!==h.port||updated.container!==h.container||updated.staticFile!==h.staticFile))throw fail('This host has configuration history. Add a separate host for a different target.');await transact(next=>{next.hosts=next.hosts.map(x=>x.id===h.id?updated:x);event(next,'Host settings changed',updated.name);});snapshots.delete(h.id);json(res,200,updated);return;}
      if(!match[2] && req.method==='DELETE'){if(inFlight.has(h.id)||editing.has(h.id)){json(res,409,{error:'Wait for the current connection check to finish.'});return;}await transact(next=>{next.hosts=next.hosts.filter(x=>x.id!==h.id);next.domains=next.domains.filter(x=>x.host!==h.id);next.certificateJobs=next.certificateJobs.filter(j=>j.host!==h.id);event(next,'Host removed',h.name);});snapshots.delete(h.id);json(res,200,{ok:true});return;}
    }
    json(res,404,{error:'Endpoint not found.'});
  }catch(e){json(res,e.status || 400,{error:e.code?'Unable to access application data.':e.message || 'Request failed.'});}
});
server.requestTimeout=30000;server.headersTimeout=10000;
server.listen(port,process.env.LISTEN_ADDRESS||'127.0.0.1',()=>console.log(`TraefikCop → http://localhost:${port}\nLocal authentication enabled. Application editing and TCP health checks enabled.`));
setInterval(()=>{for(const [id,p] of certificatePlans)if(p.expires<Date.now())certificatePlans.delete(id);for(const [id,s] of sessions)if(s.expires<Date.now())sessions.delete(id);},60000).unref();
