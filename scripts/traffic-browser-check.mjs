// Disposable local Docker deployment, generated example.test certificate, synthetic traffic.
// No personal server, account, SSH credentials, or live DNS/ACME service is used.
import {chromium} from '@playwright/test';
import {TrafficStore} from '../traffic.mjs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const exec=promisify(execFile),dir=await mkdtemp(path.join(tmpdir(),'tc-traffic-browser-'));
const name='tc-traffic-'+Date.now();
const h={id:'fixture',name:'Test host',address:'sandbox',user:'tester',port:22,key:'test',container:name,staticFile:'/traefik.yml'};
let child,browser;
try{
 await mkdir(path.join(dir,'bin'));await mkdir(path.join(dir,'db'));
 await writeFile(path.join(dir,'bin','ssh'),'#!/usr/bin/python3\nimport subprocess,sys\nsys.exit(subprocess.run(sys.argv[-1],shell=True).returncode)\n',{mode:0o700});
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem'),'-days','2','-subj','/CN=example.test/O=Test Issuer','-addext','subjectAltName=DNS:example.test,DNS:*.example.test']);
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const tlsPort=reservation.address().port;await new Promise((resolve,reject)=>reservation.close(e=>e?reject(e):resolve()));
 await writeFile(path.join(dir,'traefik.yml'),`entryPoints:\n  https: {address: ':${tlsPort}'}\nproviders: {file: {filename: /config.yml, watch: true}}\ncertificatesResolvers:\n  cloudflare:\n    acme:\n      email: test@example.test\n      storage: /tmp/acme.json\n      caServer: http://127.0.0.1:1/directory\n      dnsChallenge: {provider: cloudflare}\n`);
 await writeFile(path.join(dir,'config.yml'),`http:\n  routers:\n    photos:\n      rule: 'Host(\`photos.example.test\`)'\n      entryPoints: [https]\n      service: noop@internal\n      tls: {certResolver: cloudflare}\ntls:\n  certificates:\n    - certFile: /fixtures/cert.pem\n      keyFile: /fixtures/key.pem\n`);
 await exec('docker',['run','-d','--name',name,'-p',`127.0.0.1:${tlsPort}:${tlsPort}`,'-v',`${dir}/traefik.yml:/traefik.yml:ro`,'-v',`${dir}/config.yml:/config.yml:ro`,'-v',`${dir}/cert.pem:/fixtures/cert.pem:ro`,'-v',`${dir}/key.pem:/fixtures/key.pem:ro`,'traefik:v3.7.13']);
 await writeFile(path.join(dir,'db','state.json'),JSON.stringify({admin:null,hosts:[h],events:[]}),{mode:0o600});
 const store=new TrafficStore(path.join(dir,'db','traffic.sqlite'));const now=Date.now();let tx=0;
 for(let i=0;i<41;i++){tx+=Math.round((1000+Math.sin(i/3)*750)*15000);store.record(h,{tx:String(tx),rx:'0',generation:'test-fixture'},'',now-600000+i*15000);}store.close();
 child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'3322',TRAEFIKCOP_DATA_DIR:path.join(dir,'db'),PATH:path.join(dir,'bin')+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});await once(child.stdout,'data');
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:3322');await page.getByLabel('Username',{exact:true}).fill('test-admin');await page.getByLabel('Password',{exact:true}).fill('test-traffic-password');await page.getByLabel('Confirm password').fill('test-traffic-password');await page.getByRole('button',{name:'Create administrator'}).click();
 await page.locator('[data-traffic-widget] svg').waitFor();await page.locator('.traffic-line').first().waitFor();
 await page.getByRole('button',{name:'Open egress traffic history',exact:true}).click();
 await page.getByRole('heading',{name:'Egress traffic',exact:true}).waitFor();await page.getByRole('button',{name:'10 min',exact:true}).click();await page.locator('[data-expanded] svg').waitFor();
 await page.screenshot({path:path.join(tmpdir(),'traefikcop-traffic-history.png'),fullPage:true});
 await page.getByRole('button',{name:'30 days',exact:true}).click();await page.locator('[data-range="30d"] svg').waitFor();
 await page.locator('[data-page="certificates"]').click();await page.getByRole('heading',{name:/^example\.test/}).waitFor({timeout:30000});
 await page.getByText('Automatic · cloudflare',{exact:true}).waitFor();await page.getByText('Test Issuer',{exact:true}).waitFor();await page.screenshot({path:path.join(tmpdir(),'traefikcop-fixture-certificate.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.getByRole('button',{name:'Toggle navigation'}).click();await page.locator('[data-page="traffic"]').click();await page.locator('[data-expanded] svg').waitFor();await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 console.log('PASS: clickable traffic history, historical ranges, locally served synthetic wildcard certificate, auto-renewal label, and mobile layouts. No personal server access.');
}finally{if(browser)await browser.close();if(child){child.kill();await once(child,'exit');}await exec('docker',['rm','-f',name]).catch(()=>{});await rm(dir,{recursive:true,force:true});}
