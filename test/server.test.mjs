import {request as httpRequest} from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';

for(const lan of [false,true])test((lan?'LAN':'local')+' authentication, session protection, persistence, and host isolation',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'traefikcop-test-'));
  const port=lan?3326:3319,base=`http://127.0.0.1:${port}`,origin=lan?`http://192.168.1.50:${port}`:base;
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),TRAEFIKCOP_DATA_DIR:dir,TRAEFIKCOP_ALLOW_LAN:lan?'1':'0',TRAEFIKCOP_ALLOWED_HOSTS:''},stdio:['ignore','pipe','pipe']});
  try{
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('Test server failed to start');}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Startup timeout')),5000).unref())]);
    const request=(url,method='GET',data,headers={})=>new Promise((resolve,reject)=>{
      const req=httpRequest(base+url,{method,headers:{Host:new URL(origin).host,Origin:origin,'Content-Type':'application/json',...headers}},res=>{
        let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:{get:key=>{const value=res.headers[key.toLowerCase()];return Array.isArray(value)?value.join(', '):value;}},json:async()=>JSON.parse(text)}));
      });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
    });
    assert.equal((await request('/api/session','GET',undefined,{Host:`evil.example:${port}`})).status,403);
    assert.equal((await request('/api/session','GET',undefined,{Host:`192.168.1.50:${port}`})).status,lan?200:403);
    assert.equal((await request('/api/workspace')).status,401);
    assert.equal((await request('/api/ssh/keys')).status,401);
    assert.equal((await request('/api/ssh/keys','POST',{name:'denied'})).status,401);
    assert.equal((await request('/api/traffic')).status,401);
    assert.equal((await request('/api/setup','POST',{username:'test',password:'test-password-long'},{Origin:'https://evil.example'})).status,403);
    const setup=await request('/api/setup','POST',{username:'test',password:'test-password-long'});
    assert.equal(setup.status,200);
    const {csrf}=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
    assert.match(setup.headers.get('set-cookie'),/HttpOnly/);
    const headers={Cookie:cookie,'X-CSRF-Token':csrf};
    assert.equal((await request('/api/traffic?range=constructor','GET',undefined,headers)).status,400);
    assert.equal((await request('/api/traffic?host=missing','GET',undefined,headers)).status,404);
    const traffic=await (await request('/api/traffic?range=10m','GET',undefined,headers)).json();assert.equal(traffic.summary.hostCount,0);assert.equal(traffic.summary.currentRate,null);
    assert.equal((await request('/api/login','POST',{username:'test',password:'wrong'})).status,401);
    assert.equal((await request('/api/setup','POST',{username:'another',password:'another-long-password'})).status,409);
    assert.equal((await request('/api/hosts','POST',{}, {Cookie:cookie})).status,403);
    assert.equal((await request('/api/ssh/keys','POST',{name:'denied'},{Cookie:cookie})).status,403);
    const key=await (await request('/api/ssh/keys','POST',{name:'persisted key'},headers)).json();
    assert.match(key.publicKey,/^ssh-ed25519 /);assert.ok(!JSON.stringify(key).includes('PRIVATE KEY'));
    assert.equal((await request('/ssh/'+key.id)).status,404);
    const data={name:'one',address:'one.example',user:'deploy',port:22,key:'id_ed25519',container:'traefik',staticFile:'/traefik.yml'};
    assert.equal((await request('/api/hosts','POST',{...data,address:'x;id'},headers)).status,400);
    assert.equal((await request('/api/hosts','POST',{...data,managedKeyId:key.id},headers)).status,400);
    const first=await (await request('/api/hosts','POST',data,headers)).json();
    const second=await (await request('/api/hosts','POST',{...data,name:'two',address:'two.example'},headers)).json();
    assert.notEqual(first.id,second.id);
    let workspace=await (await request('/api/workspace','GET',undefined,headers)).json();
    assert.equal(workspace.hosts.length,2);
    assert.deepEqual(workspace.routes,[]);
    assert.ok(!JSON.stringify(workspace).includes('hash'));
    assert.equal((await request(`/api/hosts/${first.id}`,'DELETE',undefined,headers)).status,200);
    workspace=await (await request('/api/workspace','GET',undefined,headers)).json();
    assert.equal(workspace.hosts[0].id,second.id);
    assert.equal((await request('/api/routes','POST',{},headers)).status,404);
    const disk=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8'));
    assert.ok(disk.admin.hash);
    assert.ok(!JSON.stringify(disk).includes('test-password-long'));
    await request('/api/logout','POST',{},headers);
    assert.equal((await request('/api/workspace','GET',undefined,headers)).status,401);
    assert.equal((await request('/api/login','POST',{username:'test',password:'test-password-long'})).status,200);
  }finally{child.kill();await once(child,'exit');await rm(dir,{recursive:true,force:true});}
});
