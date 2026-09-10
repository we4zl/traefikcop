import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {certificateDetails,inspectCertificates} from '../certificates.mjs';
const exec=promisify(execFile);
test('served certificate metadata, expiry, hostname checks and deduplication',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'tc-cert-'));
 try{
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem'),'-days','2','-subj','/CN=example.test/O=Test Issuer','-addext','subjectAltName=DNS:example.test,DNS:*.example.test']);
  const encoded=(await readFile(path.join(dir,'cert.pem'))).toString('base64');
  const good=certificateDetails(encoded,'app.example.test');assert.equal(good.covers,true);assert.equal(good.status,'in-date');assert.ok(good.domains.includes('*.example.test'));
  assert.equal(certificateDetails(encoded,'different.test').status,'name-mismatch');
  assert.equal(certificateDetails(encoded,'app.example.test',Date.now()+4*86400000).status,'expired');
  const data=await inspectCertificates({id:'host'}, {host:{entrypoints:[{name:'https',address:':443'}]},routes:[{tls:true,entrypoint:'https',domains:['app.example.test','photos.example.test']}]},async()=>JSON.stringify([{domain:'app.example.test',port:443,certificate:encoded},{domain:'photos.example.test',port:443,certificate:encoded}]));
  assert.equal(data.certificates.length,1);assert.equal(data.certificates[0].servedFor.length,2);assert.equal(data.certificates[0].trustVerified,false);assert.ok(!JSON.stringify(data).includes('PRIVATE KEY'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
