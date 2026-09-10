import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {stringify} from 'yaml';
import {ssh,inspectHost} from './remote.mjs';
import {inspectCertificates} from './certificates.mjs';
import {readConfig,document,hash,validDomain,writeConfig} from './editor.mjs';
export const quote=v=>"'"+String(v).replaceAll("'","'\\''")+"'";
export const certificateRouter=name=>'traefikcop-certificate-'+hash(name).slice(0,12);
export function addCertificate(text,domain){
  const doc=document(text),name=certificateRouter(domain.name);
  const router={rule:`Host(\`${domain.name}\`) && Path(\`/.traefikcop-certificate\`)`,priority:1,entryPoints:[domain.entrypoint],service:'noop@internal',tls:{certResolver:domain.resolver,domains:[{main:domain.name,...(domain.wildcard?{sans:['*.'+domain.name]}:{})}]}};
  const previous=doc.getIn(['http','routers',name])?.toJSON();
  if(previous&&JSON.stringify(previous)!==JSON.stringify(router))throw new Error('A certificate request for this domain already exists with different settings. Keep its existing resolver and wildcard settings.');
  doc.setIn(['http','routers',name],router);return doc.toString();
}
const preflightScript=`import json,os,subprocess,sys
subprocess.run(['docker','info','--format','{{.ServerVersion}}'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
names=subprocess.check_output(['docker','ps','-a','--format','{{.Names}}'],text=True).splitlines()
compose=subprocess.run(['docker','compose','version'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
print(json.dumps({'home':os.path.expanduser('~'),'exists':sys.argv[1] in names,'compose':compose}))`;
export async function connectionFacts(h,run=ssh){
  const facts=JSON.parse(await run(h,`python3 -c ${quote(preflightScript)} ${quote(h.container)}`));
  if(!facts.exists)return {...facts,resolvers:[],entrypoints:[],message:'SSH and Docker work. Traefik is not installed under this container name.'};
  const inspection=await inspectHost(h,run);
  return {...facts,resolvers:inspection.resolvers,entrypoints:inspection.host.entrypoints||[],running:inspection.host.status==='online',message:inspection.host.status==='online'?'Connected to the running Traefik container.':'The Traefik container exists but is stopped. Start it before certificate setup.'};
}
export async function validateCloudflare(token,name,fetcher=fetch){
  if(typeof token!=='string'||!/^[-_a-zA-Z0-9]{20,256}$/.test(token))throw new Error('Enter a Cloudflare API token, not a global API key or Origin CA certificate.');
  // Query ancestor zones too, allowing a certificate for a delegated application subdomain.
  for(let domain=name;domain.includes('.');domain=domain.slice(domain.indexOf('.')+1)){
    let response,data;try{response=await fetcher('https://api.cloudflare.com/client/v4/zones?name='+encodeURIComponent(domain),{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});data=await response.json();}catch{throw new Error('Cloudflare could not be reached. Check the app server’s internet access.');}
    if(!response.ok||!data.success)throw new Error('Cloudflare rejected this token. Give it Zone / Zone / Read and Zone / DNS / Edit for the domain.');
    if(data.result?.some(z=>z.name===domain&&z.status==='active'))return domain;
  }
  throw new Error('No active Cloudflare zone was found for this domain. Check the domain, nameservers, and token’s zone scope.');
}
function mapped(c,target){const m=c.Mounts.filter(m=>m.Type==='bind'&&(target===m.Destination||target.startsWith(m.Destination.replace(/\/$/,'')+'/'))).sort((a,b)=>b.Destination.length-a.Destination.length)[0];if(!m)throw new Error('Automatic resolver setup requires bind-mounted YAML configuration.');return path.posix.join(m.Source,target.slice(m.Destination.length));}
function acme(email){return {acme:{email,storage:'/traefikcop-acme/acme.json',dnsChallenge:{provider:'cloudflare'}}};}
function inputDomain(input,h){const name=String(input.name||'').trim().toLowerCase();if(!validDomain(name))throw new Error('Enter a valid domain, without https:// or *.');return {id:hash(h.id+':'+name).slice(0,24),host:h.id,name,wildcard:!!input.wildcard,resolver:input.resolver,entrypoint:input.entrypoint};}
export async function planCertificate(h,input,run=ssh,fetcher=fetch){
  const facts=await connectionFacts(h,run),domain=inputDomain(input,h);
  if(facts.exists&&!facts.running)throw new Error('Start the existing Traefik container before requesting a certificate.');
  const plan={id:randomBytes(16).toString('hex'),h,domain,expires:Date.now()+600000};
  if(facts.exists&&input.mode!=='cloudflare'){
    const resolver=facts.resolvers.find(r=>r.name===domain.resolver&&r.autoRenew);
    if(!resolver)throw new Error('Select an existing ACME resolver, or set up Cloudflare.');
    if(domain.wildcard&&resolver.challenge!=='dns')throw new Error('Wildcard certificates require a DNS challenge resolver.');
    if(!facts.entrypoints.some(e=>e.name===domain.entrypoint))throw new Error('Select an HTTPS entry point.');
    if(resolver.staging)throw new Error('This resolver uses the Let’s Encrypt staging service. Choose a production resolver for a trusted certificate.');
    plan.bundle=await readConfig(h,undefined,run);plan.content=addCertificate(plan.bundle.text,domain);plan.kind='existing';
    plan.summary=[`Request ${domain.name}${domain.wildcard?' and *.'+domain.name:''} using ${domain.resolver}.`,`Update ${plan.bundle.path}; save a backup. Traefik reloads without a restart.`];
    return plan;
  }
  if(!facts.compose)throw new Error('Install the Docker Compose plugin on this server before setting up Traefik or a new resolver.');
  const email=String(input.email||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new Error('Enter your Let’s Encrypt account email.');
  if(input.agree!==true)throw new Error('Accept the Let’s Encrypt subscriber agreement to continue.');
  await validateCloudflare(input.cloudflareToken,domain.name,fetcher);
  domain.resolver='traefikcop-cloudflare';
  let root,composeFile,project,service,composeDoc,staticDoc,staticPath,dynamicPath,originalCompose=null,originalStatic=null,originalDynamic=null;
  if(!facts.exists){
    root=path.posix.join(facts.home,'traefikcop',h.container);composeFile=path.posix.join(root,'compose.yml');project='traefikcop-'+hash(h.id).slice(0,10);service='traefik';domain.entrypoint='https';staticPath=path.posix.join(root,'traefik.yml');dynamicPath=path.posix.join(root,'config.yml');
    if(h.staticFile!=='/traefik.yml')throw new Error('For a fresh installation, set the static configuration path to /traefik.yml.');
    composeDoc=document(stringify({services:{traefik:{image:'traefik:v3.7.13',container_name:h.container,restart:'unless-stopped',command:['--configFile=/traefik.yml'],ports:['80:80','443:443'],volumes:[`${root}/traefik.yml:/traefik.yml:ro`,`${root}/config.yml:/config.yml:ro`,'/var/run/docker.sock:/var/run/docker.sock:ro'],networks:['proxy']}},networks:{proxy:{name:project+'-proxy'}}}));
    staticDoc=document(stringify({entryPoints:{http:{address:':80',http:{redirections:{entryPoint:{to:'https',scheme:'https'}}}},https:{address:':443'}},providers:{docker:{endpoint:'unix:///var/run/docker.sock',exposedByDefault:false},file:{filename:'/config.yml',watch:true}}}));
  }else{
    const [c]=JSON.parse(await run(h,`docker inspect --type container ${quote(h.container)}`));
    const labels=c.Config?.Labels||{};composeFile=labels['com.docker.compose.project.config_files'];project=labels['com.docker.compose.project'];service=labels['com.docker.compose.service'];
    if(!composeFile?.startsWith('/')||composeFile.includes(',')||!project||!service)throw new Error('Adding a resolver requires a deployment with one Docker Compose file. Existing resolvers can still be used on other deployments.');
    if(c.Config.User&&!['root','0','0:0'].includes(c.Config.User))throw new Error('Automatic Cloudflare secret setup currently requires Traefik to run as root inside its container.');
    if((c.Config.Env||[]).some(e=>/^(?:CF_|CLOUDFLARE_)/.test(e)))throw new Error('This container already has Cloudflare credentials. Reuse its existing resolver to preserve those credentials.');
    if((c.Config.Env||[]).some(e=>/^TRAEFIK_/i.test(e)))throw new Error('This deployment uses environment-based static configuration. Automatic resolver setup requires YAML static configuration.');
    if((c.Config.Cmd||[]).some(arg=>!/^--configFile=/i.test(arg)))throw new Error('Automatic resolver setup supports YAML static configuration with only a --configFile command argument.');
    const bundle=await readConfig(h,undefined,run);domain.entrypoint=input.entrypoint;
    if(!facts.entrypoints.some(e=>e.name===domain.entrypoint))throw new Error('Select an HTTPS entry point.');
    staticPath=mapped(c,h.staticFile);dynamicPath=bundle.path;originalDynamic=bundle.text;
    originalStatic=await run(h,'cat '+quote(staticPath));
    if(hash(originalStatic)!==hash(await run(h,['docker','exec',h.container,'cat',h.staticFile].map(quote).join(' '))))throw new Error('Static configuration mount is stale. Recreate Traefik before setup.');
    staticDoc=document(originalStatic);if(staticDoc.hasIn(['certificatesResolvers',domain.resolver]))throw new Error('The TraefikCop resolver already exists. Select it under existing resolvers.');
    originalCompose=await run(h,'cat '+quote(composeFile));composeDoc=document(originalCompose);
    if(!composeDoc.hasIn(['services',service]))throw new Error('Traefik’s service could not be found in its Compose file.');
    if(composeDoc.has('include')||composeDoc.hasIn(['services',service,'extends']))throw new Error('Compose include/extends deployments require manual resolver setup. Existing resolvers remain usable.');
    root=path.posix.join(path.posix.dirname(composeFile),'.traefikcop-'+hash(h.id).slice(0,10));
  }
  staticDoc.setIn(['certificatesResolvers',domain.resolver],acme(email));
  const env=composeDoc.getIn(['services',service,'environment'])?.toJSON()||{};
  if(Array.isArray(env)){env.push('CF_DNS_API_TOKEN_FILE=/run/secrets/traefikcop-cloudflare');composeDoc.setIn(['services',service,'environment'],env);}else{composeDoc.setIn(['services',service,'environment','CF_DNS_API_TOKEN_FILE'],'/run/secrets/traefikcop-cloudflare');}
  const volumes=composeDoc.getIn(['services',service,'volumes'])?.toJSON()||[];
  volumes.push({type:'bind',source:root+'/cloudflare-token',target:'/run/secrets/traefikcop-cloudflare',read_only:true},{type:'bind',source:root+'/acme',target:'/traefikcop-acme'});composeDoc.setIn(['services',service,'volumes'],volumes);
  plan.kind=facts.exists?'configure':'install';
  plan.deployment={root,composeFile,project,service,fresh:!facts.exists,container:h.container,files:[{path:staticPath,content:staticDoc.toString(),expected:originalStatic===null?null:hash(originalStatic)},{path:dynamicPath,content:addCertificate(originalDynamic||'',domain),expected:originalDynamic===null?null:hash(originalDynamic)},{path:composeFile,content:composeDoc.toString(),expected:originalCompose===null?null:hash(originalCompose)}],secret:input.cloudflareToken,revision:plan.id};
  plan.summary=[`${facts.exists?'Add a Cloudflare resolver and recreate':'Install'} ${h.container}${facts.exists?' (brief interruption to traffic)':' with ports 80 and 443'}.`,`Save the scoped Cloudflare token and ACME account in ${root} on the remote host.`,`Request ${domain.name}${domain.wildcard?' and *.'+domain.name:''}. Traefik handles DNS validation and automatic renewal.`];
  if(facts.exists)plan.summary.push('Back up the Compose, static, and dynamic files before changing them.');
  return plan;
}
export async function applyCertificate(plan,run=ssh){
  if(plan.kind==='existing'){
    const live=await readConfig(plan.h,plan.bundle.file,run);
    if(live.version!==plan.bundle.version||live.path!==plan.bundle.path)throw new Error('Configuration changed since review. Review the request again.');
    if(hash(plan.content)!==live.version){try{await writeConfig(plan.h,live,plan.content,run,plan.id);}catch(e){throw new Error(e.message.replaceAll('History','the remote .traefikcop-history backup directory'));}}
  }else{
    const script=await readFile(new URL('./scripts/setup-traefik.py',import.meta.url),'utf8');
    const result=JSON.parse(await run(plan.h,'python3 -c '+quote(script),JSON.stringify(plan.deployment),240000));
    if(!result.ok)throw new Error(result.error||'Remote setup failed. Check the remote deployment before retrying.');
  }
}
export async function certificateStatus(h,domain,run=ssh){
  const inspection=await inspectHost(h,run),result=await inspectCertificates(h,inspection,run);
  // Match the actual public certificate, not just the presence of a resolver or request router.
  const cert=result.certificates.find(c=>c.status==='in-date'&&/Let's Encrypt/i.test(c.issuer)&&c.servedFor.some(s=>s.domain===domain.name&&s.covers)&&(!domain.wildcard||c.domains.split(/,\s*/).includes('DNS:*.'+domain.name)));
  return cert?{status:'issued',message:'Let’s Encrypt certificate is being served. Traefik will renew it automatically.',validTo:cert.validTo}:{status:'waiting',message:'Request configured; a matching Let’s Encrypt certificate is not being served yet. DNS validation may take several minutes. Check again; if this persists, check Traefik’s ACME logs and Cloudflare token permissions.'};
}
