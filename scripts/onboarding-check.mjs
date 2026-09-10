// Disposable real Docker/Compose deployments. No production hosts or real ACME/Cloudflare calls.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {parse,stringify} from 'yaml';
import {chromium} from '@playwright/test';
import {planCertificate,applyCertificate,certificateRouter} from '../onboarding.mjs';
const exec=promisify(execFile),dir=await mkdtemp(path.join(tmpdir(),'tc-onboarding-'));
const name='tc-onboarding-'+Date.now(),h={id:'isolated',name:'Isolated host',address:'sandbox',user:'tester',port:22,key:'test',container:name,staticFile:'/traefik.yml'};
let project,browser,child;
const local=async(_h,command,input,timeout=20000)=>{const op=exec('bash',['-c',command],{timeout,maxBuffer:4*1024*1024});op.child.stdin.end(input);let {stdout}=await op;if(command.includes("'home':os.path.expanduser")){const facts=JSON.parse(stdout);facts.home=dir;stdout=JSON.stringify(facts);}return stdout;};
const cf=async()=>({ok:true,json:async()=>({success:true,result:[{name:'example.test',status:'active'}]})});
const waitFor=async(fn)=>{for(let i=0;i<100;i++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,150));}throw new Error('Condition timed out');};
try{
  const plan=await planCertificate(h,{mode:'cloudflare',name:'example.test',wildcard:true,email:'test@example.test',cloudflareToken:'not-a-real-cloudflare-token',agree:true},local,cf);
  assert.equal(plan.kind,'install');project=plan.deployment.project;
  // Fixture-only CA, dashboard and port mapping: there are no real certificate requests.
  for(const file of plan.deployment.files){const config=parse(file.content);if(file.path.endsWith('/traefik.yml')){config.api={insecure:true};config.certificatesResolvers['traefikcop-cloudflare'].acme.caServer='http://127.0.0.1:1/directory';file.content=stringify(config);}if(file.path.endsWith('/compose.yml')){config.services.traefik.ports=['127.0.0.1::8080'];file.content=stringify(config);}}
  await applyCertificate(plan,local);
  const root=plan.deployment.root,port=(await exec('docker',['port',name,'8080'])).stdout.trim();
  const runtime=async()=>fetch('http://'+port+'/api/http/routers').then(r=>r.json());
  await waitFor(async()=>(await runtime()).some(r=>r.name===certificateRouter('example.test')+'@file'&&r.status==='enabled'));
  assert.equal((await stat(root+'/cloudflare-token')).mode&0o777,0o600);
  assert.equal((await stat(root+'/acme/acme.json')).mode&0o777,0o600);
  // An existing resolver reuses persistent ACME state and preserves the deployment.
  const reuse=await planCertificate(h,{mode:'existing',name:'other.example.test',wildcard:true,resolver:'traefikcop-cloudflare',entrypoint:'https'},local);
  assert.equal(reuse.kind,'existing');await applyCertificate(reuse,local);
  await waitFor(async()=>(await runtime()).some(r=>r.name===certificateRouter('other.example.test')+'@file'));
  const stale=await planCertificate(h,{mode:'existing',name:'stale.example.test',wildcard:true,resolver:'traefikcop-cloudflare',entrypoint:'https'},local);
  await writeFile(root+'/config.yml',(await readFile(root+'/config.yml','utf8'))+'\n# external edit\n');
  await assert.rejects(applyCertificate(stale,local),/changed since review/);
  // Remove this disposable fixture's resolver to exercise adding one to an existing Compose service.
  const staticConfig=parse(await readFile(root+'/traefik.yml','utf8'));delete staticConfig.certificatesResolvers;await writeFile(root+'/traefik.yml',stringify(staticConfig));
  const compose=parse(await readFile(root+'/compose.yml','utf8'));delete compose.services.traefik.environment;compose.services.traefik.volumes=compose.services.traefik.volumes.filter(v=>typeof v==='string');await writeFile(root+'/compose.yml',stringify(compose));
  await exec('docker',['compose','-p',project,'-f',root+'/compose.yml','up','-d','--no-deps','--force-recreate','traefik']);
  const configure=await planCertificate(h,{mode:'cloudflare',name:'new.example.test',wildcard:true,entrypoint:'https',email:'test@example.test',cloudflareToken:'not-a-real-cloudflare-token',agree:true},local,cf);
  assert.equal(configure.kind,'configure');
  const sf=configure.deployment.files.find(f=>f.path.endsWith('/traefik.yml')),sc=parse(sf.content);sc.certificatesResolvers['traefikcop-cloudflare'].acme.caServer='http://127.0.0.1:1/directory';sf.content=stringify(sc);
  // A failed recreate must restore the original deployment and preserve backups.
  const failed=structuredClone(configure),cfFile=failed.deployment.files.find(f=>f.path.endsWith('/compose.yml')),badCompose=parse(cfFile.content);badCompose.services.traefik.image='traefikcop-image-that-does-not-exist:rollback-check';cfFile.content=stringify(badCompose);
  const beforeFailure=await readFile(root+'/compose.yml','utf8');
  await assert.rejects(applyCertificate(failed,local),/Original files were restored/);
  assert.equal(await readFile(root+'/compose.yml','utf8'),beforeFailure);
  assert.equal((await exec('docker',['inspect','--format','{{.State.Running}}',name])).stdout.trim(),'true');
  await rm(failed.deployment.root,{recursive:true,force:true});
  const inode=(await stat(root+'/traefik.yml')).ino;await applyCertificate(configure,local);assert.equal((await stat(root+'/traefik.yml')).ino,inode);
  const newPort=(await exec('docker',['port',name,'8080'])).stdout.trim();
  await waitFor(async()=>(await fetch('http://'+newPort+'/api/http/routers').then(r=>r.json())).some(r=>r.name===certificateRouter('new.example.test')+'@file'&&r.status==='enabled'));
  assert.ok((await readFile(configure.deployment.root+'/backups/manifest.json','utf8')).includes('compose.yml'));
  // Drive the real wizard, using only a local stand-in for SSH transport and server keyscan.
  await mkdir(dir+'/bin');await mkdir(dir+'/db');await exec('ssh-keygen',['-q','-t','ed25519','-N','','-f',dir+'/server-key']);const pub=(await readFile(dir+'/server-key.pub','utf8')).trim().split(' ').slice(0,2).join(' ');
  await writeFile(dir+'/bin/ssh','#!/usr/bin/python3\nimport subprocess,sys\nsys.exit(subprocess.run(sys.argv[-1],shell=True).returncode)\n',{mode:0o700});
  await writeFile(dir+'/bin/ssh-keyscan',`#!/bin/sh\nprintf '%s\\n' 'sandbox ${pub}'\n`,{mode:0o700});
  child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'3323',TRAEFIKCOP_DATA_DIR:dir+'/db',PATH:dir+'/bin:'+process.env.PATH},stdio:['ignore','pipe','pipe']});await once(child.stdout,'data');
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:3323');await page.getByLabel('Username',{exact:true}).fill('test-admin');await page.getByLabel('Password',{exact:true}).fill('isolated-password-long');await page.getByLabel('Confirm password').fill('isolated-password-long');await page.getByRole('button',{name:'Create administrator'}).click();
  await page.locator('[data-page="hosts"]').click();await page.getByRole('button',{name:'Add host',exact:true}).click();await page.getByLabel('Host name').fill('Wizard host');await page.getByLabel('SSH address').fill('sandbox');await page.getByLabel('SSH user').fill('tester');await page.getByText('Traefik settings',{exact:true}).click();await page.getByLabel('Container name').fill(name);
  await page.getByRole('button',{name:'Continue to SSH instructions'}).click();await page.getByRole('heading',{name:'Allow TraefikCop to connect'}).waitFor();await page.screenshot({path:'/tmp/traefikcop-ssh-onboarding.png',fullPage:true});
  await page.getByRole('button',{name:'Read server fingerprint'}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Trust and test connection'}).click();await page.getByRole('heading',{name:'Host connected',exact:true}).waitFor();
  await page.getByRole('button',{name:'Get a Let’s Encrypt certificate'}).click();await page.getByLabel('Domain',{exact:true}).fill('wizard.example.test');
  await page.getByLabel('Certificate setup',{exact:true}).selectOption('cloudflare');await page.getByLabel('Cloudflare API token').waitFor();await page.screenshot({path:'/tmp/traefikcop-certificate-onboarding.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'/tmp/traefikcop-onboarding-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});
  await page.getByLabel('Certificate setup',{exact:true}).selectOption('traefikcop-cloudflare');await page.getByRole('button',{name:'Review setup'}).click();await page.getByRole('heading',{name:'Review certificate setup'}).waitFor();await page.getByRole('button',{name:'Get Let’s Encrypt certificate',exact:true}).click();await page.getByRole('heading',{name:'Waiting for the certificate'}).waitFor();
  await page.getByRole('button',{name:'Close',exact:true}).click();await page.locator('[data-page="certificates"]').click();await page.getByRole('heading',{name:'Certificate requests'}).waitFor();await page.locator('#app').getByText('wizard.example.test',{exact:true}).waitFor();
  const db=JSON.parse(await readFile(dir+'/db/state.json','utf8'));assert.equal(db.hosts.length,1);assert.ok(db.hosts[0].managedKeyId);assert.equal(db.certificateJobs[0].status,'waiting');assert.deepEqual(errors,[]);
  console.log('PASS: fresh Compose install, existing resolver request, stale review rejection, existing Compose resolver setup, bind inode and backups, SSH wizard, certificate review/status, desktop/mobile. No real ACME or Cloudflare calls.');
}finally{
  if(browser)await browser.close();if(child){child.kill();await once(child,'exit');}
  await exec('docker',['rm','-f',name]).catch(()=>{});if(project)await exec('docker',['network','rm',project+'-proxy']).catch(()=>{});
  // Docker writes ACME state as root. Remove the disposable fixture through a root container if needed.
  await exec('docker',['run','--rm','-v',dir+':/cleanup','--entrypoint','sh','traefik:v3.7.13','-c','rm -rf /cleanup/traefik']).catch(()=>{});
  await rm(dir,{recursive:true,force:true});
}
