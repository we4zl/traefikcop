// Real browser clipboard checks on an insecure HTTP hostname and localhost.
// Temporary local state only; no connection to a managed server.
import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir=await mkdtemp(path.join(tmpdir(),'tc-clipboard-')),port=3330;
const insecure=`http://clipboard.example.test:${port}`,secure=`http://localhost:${port}`;
let child,browser;
try{
 child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),TRAEFIKCOP_DATA_DIR:dir,TRAEFIKCOP_ALLOWED_HOSTS:`clipboard.example.test:${port}`},stdio:['ignore','pipe','pipe']});await once(child.stdout,'data');
 browser=await chromium.launch({headless:true,args:['--no-proxy-server','--host-resolver-rules=MAP clipboard.example.test 127.0.0.1']});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function wizard(){await page.locator('[data-page="hosts"]').click();await page.getByRole('button',{name:'Add host',exact:true}).click();await page.getByLabel('Host name').fill('Clipboard test');await page.getByLabel('SSH address').fill('server.example.test');await page.getByLabel('SSH user').fill('deploy');await page.getByRole('button',{name:'Continue to SSH instructions'}).click();await page.getByRole('heading',{name:'Allow TraefikCop to connect'}).waitFor();return page.locator('#install-key-command').textContent();}
 async function paste(){await page.evaluate(()=>{document.getElementById('clipboard-paste-test')?.remove();const box=document.createElement('textarea');box.id='clipboard-paste-test';document.querySelector('dialog').append(box);});const box=page.locator('#clipboard-paste-test');await box.focus();await page.keyboard.press('Control+V');const value=await box.inputValue();await box.evaluate(e=>e.remove());return value;}
 await page.goto(insecure);assert.equal(await page.evaluate(()=>window.isSecureContext),false);assert.equal(await page.evaluate(()=>typeof navigator.clipboard),'undefined');
 await page.getByLabel('Username').fill('test-admin');await page.getByLabel('Password',{exact:true}).fill('clipboard-test-password');await page.getByLabel('Confirm password').fill('clipboard-test-password');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByRole('button',{name:'Add application',exact:true}).waitFor();
 let text=await wizard();await page.locator('[data-copy="install-key-command"]').click();assert.equal(await paste(),text);assert.equal(await page.locator('.clipboard-buffer').count(),0);
 // Repeated copies and other instruction blocks use the same working fallback.
 await page.getByText('Server prerequisites and Docker access',{exact:true}).click();await page.locator('[data-copy="prerequisites-command"]').click();assert.equal(await paste(),'python3 --version\ndocker ps\ndocker compose version');
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:secure});await page.goto(secure);await page.getByLabel('Username').fill('test-admin');await page.getByLabel('Password',{exact:true}).fill('clipboard-test-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Add application',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.isSecureContext),true);
 text=await wizard();await page.locator('[data-copy="install-key-command"]').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),text);
 // A refused modern API still falls back. Refusing both methods must never say “Copied”.
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new DOMException('Denied','NotAllowedError');}}}));
 await page.locator('[data-copy="install-key-command"]').click();assert.equal(await paste(),text);
 await page.evaluate(()=>{document.execCommand=()=>false;});await page.locator('[data-copy="install-key-command"]').click();await page.getByText('Automatic copy was blocked.',{exact:false}).waitFor();assert.equal(await page.locator('[data-copy="install-key-command"]').textContent(),'Copy command');assert.equal(await page.evaluate(()=>window.getSelection().toString()),text);assert.equal(await page.locator('.clipboard-buffer').count(),0);assert.deepEqual(errors,[]);
 console.log('PASS: exact multiline clipboard contents over insecure HTTP, repeated copies, secure Clipboard API, permission-denied fallback, and manual selection when both methods are blocked.');
}finally{if(browser)await browser.close();if(child){child.kill();await once(child,'exit');}await rm(dir,{recursive:true,force:true});}
