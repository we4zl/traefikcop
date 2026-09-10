import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SSHKeys,fingerprint} from '../ssh-keys.mjs';
import {addCertificate,validateCloudflare,certificateRouter} from '../onboarding.mjs';
import {parse} from 'yaml';

test('managed SSH keys persist privately and pin a verified endpoint',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tc-keys-'));
  try{
    const keys=new SSHKeys(dir);await keys.init();const k=await keys.generate('home');
    assert.match(k.publicKey,/^ssh-ed25519 /);assert.equal(k.fingerprint,fingerprint(k.publicKey));
    assert.ok(!JSON.stringify(await keys.list()).includes('PRIVATE KEY'));
    assert.equal((await stat(path.join(dir,'ssh',k.id))).mode&0o777,0o600);
    assert.equal((await stat(path.join(dir,'ssh'))).mode&0o777,0o700);
    await assert.rejects(keys.key('../../state.json'));
    const h={managedKeyId:k.id,address:'example.test',port:2222};
    keys.scans.set('review',{address:h.address,port:h.port,key:k.publicKey,fingerprint:k.fingerprint,expires:Date.now()+10000});
    await assert.rejects(keys.trust(h,'review','wrong'));
    await assert.rejects(keys.trust({...h,address:'other.test'},'review',k.fingerprint));
    const trustId=await keys.trust(h,'review',k.fingerprint);h.trustId=trustId;
    const restarted=new SSHKeys(dir);await restarted.init();const identity=await restarted.identity(h);
    assert.match(await readFile(identity.knownHosts,'utf8'),/\[example.test\]:2222 ssh-ed25519 /);
    await assert.rejects(restarted.identity({...h,port:22}),/endpoint changed/);
    await assert.rejects(keys.trust(h,'review',k.fingerprint));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('certificate trigger preserves routes and is idempotent; settings changes conflict',()=>{
  const text='# keep this\nhttp:\n  routers:\n    photos: {rule: "Host(`photos.example.test`)", service: photos}\n  services:\n    photos: {loadBalancer: {servers: [{url: "http://192.0.2.2:9000"}]}}\n';
  const d={name:'example.test',resolver:'cloudflare',entrypoint:'https',wildcard:true};
  const result=addCertificate(text,d),config=parse(result),original=parse(text);
  assert.match(result,/# keep this/);assert.deepEqual(config.http.services,original.http.services);assert.deepEqual(config.http.routers.photos,original.http.routers.photos);
  const router=config.http.routers[certificateRouter(d.name)];
  assert.equal(router.service,'noop@internal');assert.equal(router.priority,1);assert.deepEqual(router.tls.domains,[{main:d.name,sans:['*.example.test']}]);
  assert.equal(addCertificate(result,d),result);
  assert.throws(()=>addCertificate(result,{...d,wildcard:false}),/different settings/);
  assert.equal(parse(addCertificate('',d)).http.routers[certificateRouter(d.name)].tls.certResolver,'cloudflare');
});
test('Cloudflare zone verification scopes credentials, handles subdomains, and redacts errors',async()=>{
  const token='test-token-that-is-not-real',calls=[];
  const fetcher=async(url,options)=>{calls.push(url);assert.equal(options.headers.Authorization,'Bearer '+token);return {ok:true,json:async()=>({success:true,result:url.endsWith('name=example.test')?[{name:'example.test',status:'active'}]:[]})};};
  assert.equal(await validateCloudflare(token,'apps.example.test',fetcher),'example.test');assert.equal(calls.length,2);
  await assert.rejects(validateCloudflare(token,'example.test',async()=>({ok:false,json:async()=>({error:token})})),e=>!e.message.includes(token)&&e.message.includes('rejected'));
  await assert.rejects(validateCloudflare('bad','example.test',fetcher));
});
