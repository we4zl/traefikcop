import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {document,hash,buildChange,editorForm} from '../editor.mjs';
const exec=promisify(execFile);
const initial=`# Keep this comment\nhttp:\n  routers:\n    old:\n      rule: Host(\`old.example.com\`)\n      service: shared\n      entryPoints: [https]\n      middlewares: [auth, headers]\n      tls: {}\n    other:\n      rule: Host(\`other.example.com\`)\n      service: shared\n  services:\n    shared:\n      loadBalancer:\n        passHostHeader: true\n        serversTransport: private\n        servers: [{url: 'https://backend:8000/path'}]\n  middlewares:\n    auth: {basicAuth: {users: ['sensitive-hash']}}\ntcp: {routers: {}}\n`;
const bundle=text=>({text,doc:document(text),version:hash(text),file:'/config.yml',path:'/tmp/config.yml',config:{entryPoints:{https:{address:':443'}},certificatesResolvers:{cloudflare:{acme:{dnsChallenge:{provider:'cloudflare'}}}}}});
const domain={name:'example.com',resolver:'cloudflare',entrypoint:'https',wildcard:true};
test('editing preserves middleware, TLS, shared services, paths, and unrelated config',()=>{
  const b=bundle(initial),input={version:b.version,routeName:'old',name:'renamed',domain:'example.com',address:'newbackend',port:9000,backendHTTPS:false};
  const result=buildChange(b,input);
  const before=b.doc.toJS(),after=document(result.content).toJS();
  assert.deepEqual(after.http.middlewares,before.http.middlewares);
  assert.deepEqual(after.http.services.shared,before.http.services.shared);
  assert.deepEqual(after.http.routers.other,before.http.routers.other);
  assert.deepEqual(after.http.routers.old.middlewares,['auth','headers']);
  assert.deepEqual(after.http.routers.old.tls,{});
  const backend=after.http.services[after.http.routers.old.service];
  assert.equal(backend.loadBalancer.servers[0].url,'http://newbackend:9000/path');
  assert.equal(backend.loadBalancer.serversTransport,'private');
  assert.deepEqual(after.tcp,before.tcp);
  assert.match(result.content,/# Keep this comment/);
});
test('new app gets HTTPS, wildcard resolver, and isolated service',()=>{
  const b=bundle(initial),r=buildChange(b,{version:b.version,name:'photos',domain:'example.com',address:'immich',port:2283},{domain});
  const config=document(r.content).toJS();
  assert.equal(config.http.routers.photos.tls.certResolver,'cloudflare');
  assert.deepEqual(config.http.routers.photos.tls.domains,[{main:'example.com',sans:['*.example.com']}]);
  assert.equal(config.http.services[config.http.routers.photos.service].loadBalancer.servers[0].url,'http://immich:2283/');
});
test('disable and enable remove and restore the router without deleting a shared backend',()=>{
  const b=bundle(initial),off=buildChange(b,{version:b.version,routeName:'old',action:'disable'});
  const disabled=off.disabled;
  assert.ok(!document(off.content).toJS().http.routers?.old);
  assert.ok(document(off.content).toJS().http.services.shared);
  const updated=bundle(off.content),on=buildChange(updated,{version:updated.version,routeName:'old',action:'enable'},{disabled});
  assert.deepEqual(document(on.content).toJS(),b.doc.toJS());
  const removed=buildChange(updated,{version:updated.version,routeName:'old',action:'delete'},{disabled});
  assert.equal(removed.disabled,null);
});
test('conflicts, duplicate domains, unsafe hosts and complex rules are rejected',()=>{
  const b=bundle(initial),input={version:b.version,name:'photos',domain:'example.com',address:'backend',port:80};
  assert.throws(()=>buildChange(b,{...input,version:'old'},{domain}),/changed/);
  assert.throws(()=>buildChange(b,{...input,address:'host/path'},{domain}),/internal/);
  assert.throws(()=>buildChange(b,input,{domain,allRoutes:[{domains:['photos.example.com']}]}),/already uses/);
  assert.throws(()=>buildChange(b,input,{domain:{...domain,resolver:'missing'}}),/resolver/);
  const complex=bundle(initial.replace('Host(`old.example.com`)','Host(`old.example.com`) && PathPrefix(`/x`)'));
  assert.throws(()=>editorForm(complex,'old'),/compound/);
});
test('remote writer preserves bind-mount inode, backs up contents and rejects stale writes',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'traefikcop-writer-')),file=path.join(dir,'config.yml');
  try{
    await writeFile(file,initial,{mode:0o640});const before=await stat(file);
    const invoke=async payload=>{const operation=exec('python3',['scripts/write-config.py']);operation.child.stdin.end(JSON.stringify(payload));return JSON.parse((await operation).stdout);};
    const content=initial+'# new comment\n';
    const first=await invoke({path:file,content,expected:hash(initial),revision:'abc123'});
    assert.equal(first.ok,true);assert.equal((await stat(file)).ino,before.ino);assert.equal((await stat(file)).mode,before.mode);
    assert.equal(await readFile(first.backup,'utf8'),initial);
    assert.equal((await stat(first.backup)).mode&0o777,0o600);
    const stale=await invoke({path:file,content:'broken',expected:hash(initial),revision:'def456'});
    assert.equal(stale.conflict,true);assert.equal(await readFile(file,'utf8'),content);
    const rollback=await invoke({path:file,content:initial,expected:hash(content),revision:'abcd4567'});
    assert.equal(rollback.ok,true);assert.equal(await readFile(file,'utf8'),initial);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('disabling the last router omits empty maps that Traefik rejects',()=>{
  const b=bundle('http:\n  routers:\n    only: {rule: "Host(`only.example.com`)", service: backend}\n  services:\n    backend: {loadBalancer: {servers: [{url: "http://backend:80"}]}}\n');
  const result=buildChange(b,{routeName:'only',version:b.version,action:'disable'});
  assert.equal(document(result.content).toJS().http.routers,undefined);
  assert.ok(document(result.content).toJS().http.services.backend);
});
