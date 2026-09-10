import {isIP} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseDocument} from 'yaml';
import {ssh} from './remote.mjs';
const quote=v=>"'"+String(v).replaceAll("'","'\\''")+"'";
export const hash=text=>createHash('sha256').update(text).digest('hex');
const problem=(message,status=400)=>Object.assign(new Error(message),{status});
export function document(text){const d=parseDocument(text,{uniqueKeys:true});if(d.errors.length)throw problem('The active configuration contains invalid YAML. No changes were made.');d.toJS({maxAliasCount:50});return d;}
export const validDomain=d=>typeof d==='string'&&d.length<=253&&d.includes('.')&&d.split('.').every(p=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(p));
export async function readConfig(h,file,run=ssh){
  const [c]=JSON.parse(await run(h,`docker inspect --type container ${quote(h.container)}`));
  if(!c?.State?.Running)throw problem('Traefik must be running before editing.');
  const staticText=await run(h,['docker','exec',h.container,'cat',h.staticFile].map(quote).join(' '));
  const config=document(staticText).toJS();
  const provider=config.providers?.file;
  if(!provider || provider.watch===false)throw problem('Enable a watched file provider before editing applications.');
  const target=file || provider.filename;
  if(!target || !target.startsWith('/') || target.split('/').includes('..'))throw problem('Select a dynamic configuration file for this application.');
  const directory=provider.directory && path.posix.normalize(provider.directory);
  if(target!==provider.filename && !(directory&&target.startsWith(directory.replace(/\/$/,'')+'/')&&/\.ya?ml$/.test(target)))throw problem('This file is not part of the active file provider.');
  if(!/\.ya?ml$/.test(target))throw problem('The editor supports YAML configuration files.');
  const mounts=(c.Mounts||[]).filter(m=>m.Type==='bind'&&(target===m.Destination||target.startsWith(m.Destination.replace(/\/$/,'')+'/'))).sort((a,b)=>b.Destination.length-a.Destination.length);
  const mount=mounts[0];if(!mount)throw problem('The dynamic configuration needs a host bind mount for editing.');
  const remotePath=path.posix.join(mount.Source,target.slice(mount.Destination.length));
  const text=await run(h,['cat',remotePath].map(quote).join(' '));
  const mountedText=await run(h,['docker','exec',h.container,'cat',target].map(quote).join(' '));
  if(hash(text)!==hash(mountedText))throw problem('The host file and container mount differ. Recreate the container with the current mount before editing.',409);
  const doc=document(text);
  return {text,doc,config,file:target,path:remotePath,version:hash(text)};
}
function defaultEntryPoint(bundle){
  const entries=Object.entries(bundle.config.entryPoints||{}).filter(([,e])=>!e.address?.endsWith('/udp'));
  const routers=Object.values(bundle.doc.toJS().http?.routers||{});
  const secure=entries.find(([,e])=>/:443(?:\/tcp)?$/.test(e.address||''))||entries.find(([n,e])=>['https','websecure'].includes(n)||e.http?.tls)||entries.find(([n])=>routers.some(r=>r.tls!==undefined&&r.tls!==false&&r.entryPoints?.includes(n)));
  if(secure)return {name:secure[0],tls:true};
  const plain=entries.find(([,e])=>/:80(?:\/tcp)?$/.test(e.address||''))||entries.find(([n])=>['http','web'].includes(n))||entries.find(([n])=>routers.some(r=>r.tls===undefined&&r.entryPoints?.includes(n)));
  if(plain)return {name:plain[0],tls:false};
  throw problem('No HTTP or HTTPS entry point was found in this host’s configuration.');
}
export function domainForHostname(domains,hostname){
  return domains.filter(d=>hostname===d.name||hostname.endsWith('.'+d.name)).sort((a,b)=>b.name.length-a.name.length)[0];
}
function newRouteSettings(bundle,domain,hostname){
  const entry=domain?{name:domain.entrypoint,tls:true}:defaultEntryPoint(bundle);
  if(!bundle.config.entryPoints?.[entry.name])throw problem('The domain HTTPS entry point is not configured on this host.');
  if(!entry.tls)return {settings:{entryPoints:[entry.name]},notice:'Public HTTP on '+entry.name+'. No HTTPS entry point was discovered.'};
  const resolvers=bundle.config.certificatesResolvers||{},inherited=bundle.config.entryPoints[entry.name].http?.tls?.certResolver;
  const available=Object.entries(resolvers).filter(([,r])=>r.acme&&!r.acme.caServer?.includes('staging')).map(([name])=>name);
  const resolver=domain?.resolver||inherited||(available.length===1?available[0]:'');
  const tls={};
  if(resolver){
    const acme=resolvers[resolver]?.acme;if(!acme)throw problem('The domain certificate resolver is not configured on this host.');
    tls.certResolver=resolver;
    if(domain?.wildcard){
      if(!acme.dnsChallenge)throw problem('Wildcard certificates require a DNS certificate resolver.');
      const prefix=hostname===domain.name?'':hostname.slice(0,-domain.name.length-1);
      if(!prefix.includes('.'))tls.domains=[{main:domain.name,sans:['*.'+domain.name]}];
    }
  }
  return {settings:{entryPoints:[entry.name],tls},notice:resolver?'HTTPS on '+entry.name+' using certificate resolver '+resolver+'. Certificate issuance and DNS must be working for this hostname.':'HTTPS on '+entry.name+' using Traefik’s certificate store. No resolver was selected automatically; ensure a certificate covers this hostname.'};
}
export function editorForm(bundle,routeName,disabled){
  const router=routeName ? bundle.doc.getIn(['http','routers',routeName])?.toJSON() || disabled?.router : null;
  if(routeName&&!router)throw problem('Application no longer exists. Refresh and try again.',409);
  const rule=router?.rule||'';
  const match=/^Host\(\s*[`"]([^`"]+)[`"]\s*\)$/.exec(rule);
  if(router&&!match)throw problem('This application has a compound routing rule. The simple form cannot safely replace it.');
  const service=router && bundle.doc.getIn(['http','services',router.service])?.toJSON();
  const servers=service?.loadBalancer?.servers;
  if(router&&(!servers||servers.length!==1))throw problem('This application uses a shared provider or multiple backends. The simple form supports one backend URL.');
  let address='',port=80,backendHTTPS=false;
  if(servers){const u=new URL(servers[0].url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw problem('This backend URL has advanced options and cannot be edited with the simple form.');address=u.hostname.replace(/^\[|\]$/g,'');port=Number(u.port||(u.protocol==='https:'?443:80));backendHTTPS=u.protocol==='https:';}
  const entry=router?{name:router.entryPoints?.[0]||'',tls:router.tls!==undefined&&router.tls!==false}:defaultEntryPoint(bundle);
  return {routeName:routeName||'',hostname:match?.[1]||'',address,port,backendHTTPS,entrypoint:entry.name,resolver:router?.tls?.certResolver||'',tls:entry.tls,middlewares:router?.middlewares||[],enabled:!disabled,version:bundle.version,file:bundle.file};
}
export function buildChange(bundle,input,{disabled,domain,allRoutes=[]}={}){
  const doc=document(bundle.text), before=doc.toJS();
  const routeName=String(input.routeName||'');
  const old=routeName ? before.http?.routers?.[routeName] || disabled?.router : null;
  if(routeName&&!old)throw problem('Application no longer exists.',409);
  if(input.version!==bundle.version)throw problem('Configuration changed since you opened this form. Reopen it before saving.',409);
  const action=input.action||'save';
  if(!['save','disable','enable','delete'].includes(action))throw problem('Unknown application action.');
  if(action!=='save'&&!old)throw problem('Select an existing application.');
  let nextDisabled=disabled||null,name=routeName,summary,notice;
  if(action==='disable'){
    if(disabled)throw problem('Application is already disabled.');
    nextDisabled={router:old};doc.deleteIn(['http','routers',name]);summary=`Disable ${name}`;
  }else if(action==='enable'){
    if(!disabled)throw problem('Application is already enabled.');
    if(before.http?.routers?.[name])throw problem('A router with this name already exists.',409);
    const hostname=/^Host\([`"]([^`"]+)[`"]\)$/.exec(old.rule)?.[1];
    if(hostname&&allRoutes.some(r=>r.domains.includes(hostname)))throw problem('Another route now uses this hostname.',409);
    doc.setIn(['http','routers',name],old);nextDisabled=null;summary=`Enable ${name}`;
  }else if(action==='delete'){
    doc.deleteIn(['http','routers',name]);nextDisabled=null;summary=`Delete ${name}`;
  }else{
    if(old)editorForm(bundle,name,disabled);
    // Accept the former name/subdomain + domain payload for existing API clients.
    const fullHostname=input.hostname!==undefined;
    const base=String(input.domain||'').trim().toLowerCase(),subdomain=String(input.name||'').trim().toLowerCase();
    const hostname=(fullHostname?String(input.hostname).trim().toLowerCase():(subdomain?subdomain+'.'+base:base)).replace(/\.$/,'');
    if(!validDomain(hostname)||isIP(hostname))throw problem('Enter a valid external FQDN, without a URL, path, wildcard, or port.');
    const appName=fullHostname?String(input.name||'').trim():(subdomain.replaceAll('.','-')||base.replaceAll('.','-'));
    if(fullHostname&&!old&&(!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,79}$/.test(appName)||appName.startsWith('traefikcop-certificate-')))throw problem('App name must start with a letter or number and use up to 80 letters, numbers, spaces, dots, underscores, or dashes.');
    if(old&&fullHostname&&appName!==routeName)throw problem('An existing application’s name cannot be changed. Its hostname and backend can be edited independently.');
    const address=String(input.address||'').trim();
    if(!address||/[\s/@?#\\]/.test(address)||address.startsWith('-'))throw problem('Enter an internal hostname or IP address, without a URL or port.');
    const port=Number(input.port);if(!Number.isInteger(port)||port<1||port>65535)throw problem('Backend port must be between 1 and 65535.');
    let url;try{url=new URL(`${input.backendHTTPS?'https':'http'}://${address.includes(':')?'['+address.replace(/^\[|\]$/g,'')+']':address}:${port}`);}catch{throw problem('Invalid internal address.');}
    if(allRoutes.some(r=>!(r.source==='file'&&r.file===bundle.file&&r.name===name)&&r.domains.includes(hostname)))throw problem('Another application on this host already uses this hostname.');
    name=name||appName;
    if(!old&&before.http?.routers?.[name])throw problem('An application with this name already exists.');
    const router=structuredClone(old||{});
    router.rule=`Host(\`${hostname}\`)`;
    if(!old){
      if(domain&&!(hostname===domain.name||hostname.endsWith('.'+domain.name)))throw problem('The selected domain profile does not match this hostname.');
      const selected=newRouteSettings(bundle,domain,hostname);Object.assign(router,selected.settings);notice=selected.notice;
    }else notice='Existing public HTTP/HTTPS settings and middleware are preserved.';
    const originalService=old&&before.http?.services?.[old.service];
    const service=structuredClone(originalService||{loadBalancer:{}});
    const originalURL=originalService?.loadBalancer?.servers?.[0]?.url;
    if(originalURL){const u=new URL(originalURL);url.pathname=u.pathname;}
    service.loadBalancer.servers=[{...(originalService?.loadBalancer?.servers?.[0]||{}),url:url.toString()}];
    const serviceName='traefikcop-'+hash(name).slice(0,12);
    if(before.http?.services?.[serviceName]&&old?.service!==serviceName)throw problem('The managed backend name is already in use.');
    router.service=serviceName;doc.setIn(['http','services',serviceName],service);
    if(disabled)nextDisabled={router};else doc.setIn(['http','routers',name],router);
    summary=`${old?'Update':'Publish'} ${hostname} → ${url.toString()}`;
  }
  // Traefik rejects empty map nodes such as routers: {}. Omit the section instead.
  if(doc.getIn(['http','routers'])?.items?.length===0)doc.deleteIn(['http','routers']);
  if(doc.getIn(['http','services'])?.items?.length===0)doc.deleteIn(['http','services']);
  const content=String(doc);document(content);
  return {content,name,summary,notice,disabled:nextDisabled,previousDisabled:disabled||null,action,changed:hash(content)!==bundle.version};
}
export async function writeConfig(h,bundle,content,run=ssh,revision=randomBytes(16).toString('hex')){
  const script=await readFile(new URL('./scripts/write-config.py',import.meta.url),'utf8');
  let result;
  try{result=JSON.parse(await run(h,`python3 -c ${quote(script)}`,JSON.stringify({path:bundle.path,expected:bundle.version,content,revision})));}catch{throw problem('The SSH write did not return a result. Refresh and inspect History before retrying.',502);}
  if(result.conflict)throw problem('The remote file changed during save. Refresh and review again.',409);
  if(!result.ok)throw problem(result.error||'Remote write failed.',502);
  const mounted=await run(h,['docker','exec',h.container,'cat',bundle.file].map(quote).join(' '));
  if(hash(mounted)!==hash(content))throw problem('The file was written, but the container did not see it. Inspect History and the bind mount.',502);
  return {...result,revision};
}
