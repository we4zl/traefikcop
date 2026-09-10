// Isolated integration test: temporary local Docker container, fake SSH transport to localhost.
// No production host or production user database is touched.
import {chromium} from '@playwright/test';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const exec=promisify(execFile),dir=await mkdtemp(path.join(tmpdir(),'traefikcop-integration-'));
const name='traefikcop-test-'+Date.now();let child,browser;
try{
 await mkdir(path.join(dir,'bin'));await mkdir(path.join(dir,'db'));
 await writeFile(path.join(dir,'bin','ssh'),'#!/usr/bin/python3\nimport subprocess,sys\nsys.exit(subprocess.run(sys.argv[-1],shell=True).returncode)\n',{mode:0o700});
 await writeFile(path.join(dir,'traefik.yml'),`api: {insecure: true}\nentryPoints:\n  http: {address: ':8000'}\n  https: {address: ':8001'}\nproviders: {file: {filename: /config.yml, watch: true}}\ncertificatesResolvers:\n  cloudflare:\n    acme:\n      email: test@example.test\n      storage: /tmp/acme.json\n      caServer: http://127.0.0.1:1/directory\n      dnsChallenge: {provider: cloudflare}\n`);
 await writeFile(path.join(dir,'config.yml'),'# Preserve me\nhttp:\n  middlewares:\n    headers: {headers: {customResponseHeaders: {X-Test: keep}}}\n');
 await exec('docker',['run','-d','--name',name,'-p','127.0.0.1::8080','-v',`${dir}/traefik.yml:/traefik.yml:ro`,'-v',`${dir}/config.yml:/config.yml:ro`,'traefik:v3.7.13']);
 const mapping=(await exec('docker',['port',name,'8080'])).stdout.trim();
 const runtime=async()=>{const res=await fetch(`http://${mapping}/api/http/routers`);return res.json();};
 const waitFor=async(fn)=>{for(let i=0;i<80;i++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Runtime condition timed out');};
 await waitFor(async()=>Array.isArray(await runtime()));
 await writeFile(path.join(dir,'db','state.json'),JSON.stringify({admin:null,hosts:[{id:'sandbox',name:'sandbox',address:'sandbox',user:'test',port:22,key:'test',container:name,staticFile:'/traefik.yml'}],events:[]}));
 child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'3320',TRAEFIKCOP_DATA_DIR:path.join(dir,'db'),PATH:path.join(dir,'bin')+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});
 await once(child.stdout,'data');
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:3320');await page.getByLabel('Username',{exact:true}).fill('test-admin');await page.getByLabel('Password',{exact:true}).fill('isolated-test-password');await page.getByLabel('Confirm password').fill('isolated-test-password');await page.getByRole('button',{name:'Create administrator'}).click();
 await page.getByRole('button',{name:'Add application',exact:true}).waitFor();
 await waitFor(async()=>!(await page.getByRole('button',{name:'Refresh',exact:true}).isDisabled()));
 assert.equal(JSON.parse(await readFile(path.join(dir,'db','state.json'),'utf8')).domains?.length||0,0);
 await page.locator('[data-page="services"]').click();await page.getByRole('button',{name:'Add application',exact:true}).click();
 await page.getByLabel('App name',{exact:true}).fill('Photo library');await page.getByLabel('External FQDN',{exact:true}).fill('gallery.example.test');await page.getByLabel('Internal FQDN / IP',{exact:true}).fill('127.0.0.1');await page.getByLabel('Port',{exact:true}).fill('8080');
 await page.screenshot({path:'/tmp/traefikcop-application-editor.png',fullPage:true});
 await page.getByRole('button',{name:'Review changes'}).click();await page.getByRole('button',{name:'Apply change'}).click();
 await page.getByRole('button',{name:'Photo library',exact:true}).waitFor();await waitFor(async()=>(await runtime()).some(r=>r.name==='Photo library@file'&&r.status==='enabled'));
 assert.equal((await runtime()).find(r=>r.name==='Photo library@file').rule,'Host(`gallery.example.test`)');
 await page.getByRole('button',{name:'Edit Photo library',exact:true}).click();assert.equal(await page.getByLabel('App name',{exact:true}).inputValue(),'Photo library');await page.getByLabel('External FQDN',{exact:true}).fill('pictures.example.test');await page.getByLabel('Port',{exact:true}).fill('8000');await page.getByRole('button',{name:'Review changes'}).click();await page.getByRole('button',{name:'Apply change'}).click();await page.getByText('http://127.0.0.1:8000/',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Photo library',exact:true}).click();await page.getByRole('button',{name:'Disable',exact:true}).click();await page.getByRole('button',{name:'Apply change'}).click();await page.getByText('Disabled',{exact:true}).waitFor();await waitFor(async()=>!(await runtime()).some(r=>r.name==='Photo library@file'&&r.status==='enabled'));
 await page.getByRole('button',{name:'Photo library',exact:true}).click();await page.getByRole('button',{name:'Enable',exact:true}).click();await page.getByRole('button',{name:'Apply change'}).click();await waitFor(async()=>(await runtime()).some(r=>r.name==='Photo library@file'&&r.status==='enabled'));await page.locator('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Photo library',exact:true}).click();await page.getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('button',{name:'Apply change'}).click();await page.getByRole('heading',{name:'No routes discovered'}).waitFor();await waitFor(async()=>!(await runtime()).some(r=>r.name==='Photo library@file'&&r.status==='enabled'));
 await page.locator('[data-page="activity"]').click();await page.getByRole('button',{name:'Restore',exact:true}).first().click();await page.getByRole('button',{name:'Apply change'}).click();await page.locator('dialog').waitFor({state:'hidden'});await waitFor(async()=>(await runtime()).some(r=>r.name==='Photo library@file'&&r.status==='enabled'));
 const text=await readFile(path.join(dir,'config.yml'),'utf8');assert.match(text,/# Preserve me/);assert.match(text,/X-Test: keep/);assert.match(text,/Host\(`pictures.example.test`\)/);
 await page.locator('[data-page="services"]').click();await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/traefikcop-editor-mobile.png',fullPage:true});const overflow=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right})));if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))console.log(JSON.stringify(overflow));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 console.log('PASS: real Traefik reload on add, edit, disable, enable, delete and rollback; desktop/mobile browser; middleware preservation.');
}catch(e){console.error('INTEGRATION FAILURE',e.message);console.error((await exec('docker',['logs','--tail','30',name])).stderr);console.error(await readFile(path.join(dir,'config.yml'),'utf8'));throw e;}finally{if(browser)await browser.close();if(child){child.kill();await once(child,'exit');}await exec('docker',['rm','-f',name]).catch(()=>{});await rm(dir,{recursive:true,force:true});}
