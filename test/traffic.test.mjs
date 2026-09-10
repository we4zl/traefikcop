import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TrafficStore,parseCounters,readTraffic,RETENTION_MS} from '../traffic.mjs';
const h={id:'one',name:'one',address:'one',user:'user',port:22,container:'traefik'};
const sample=(tx,generation='container:boot:eth0')=>({tx:String(tx),rx:'0',generation});
test('network parsing excludes loopback and preserves large integer counters',()=>{
 const c=parseCounters(' lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n eth0: 12 0 0 0 0 0 0 0 90071992547409930 0 0 0 0 0 0 0\n eth1: 8 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0');
 assert.equal(c.tx,'90071992547409935');assert.equal(c.rx,'20');assert.equal(c.interfaces,'eth0,eth1');
 assert.throws(()=>parseCounters('lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0'));
});
test('traffic rates, clipped totals, and zero traffic differ from missing readings',()=>{
 const store=new TrafficStore(':memory:');try{
  store.record(h,sample(1000),'',1000000);store.record(h,sample(16000),'',1015000);store.record(h,sample(16000),'',1030000);
  const data=store.history([h],'10m',1030000);
  assert.equal(data.summary.totalBytes,15000);assert.equal(data.summary.currentRate,0);
  assert.equal(data.summary.coverage,30/600);assert.equal(data.points.at(-1).rate,0);assert.equal(data.points[0].rate,null);
  assert.equal(data.summary.peakRate,1000);
  const clipped=store.history([h],'10m',1610000);assert.equal(clipped.summary.totalBytes,5000);assert.equal(clipped.summary.currentRate,null);
 }finally{store.close();}
});
test('resets, offline intervals, long gaps and changed host targets do not produce spikes',()=>{
 const store=new TrafficStore(':memory:');try{
  store.record(h,sample(100000),'',1000000);store.record(h,sample(200000),'',1015000);
  store.record(h,sample(500,'restarted'),'',1030000);assert.equal(store.history([h],'10m',1030000).summary.currentRate,null);
  store.record(h,undefined,'SSH offline',1045000);store.record(h,sample(999999,'restarted'),'',1060000);
  assert.equal(store.history([h],'10m',1060000).summary.totalBytes,100000);
  store.record(h,sample(2000000,'restarted'),'',1200000);assert.equal(store.history([h],'10m',1200000).summary.currentRate,null);
  const changed={...h,address:'different'};store.record(changed,sample(9999999999),'',1215000);
  assert.equal(store.history([changed],'10m',1215000).summary.totalBytes,0);
 }finally{store.close();}
});
test('aggregate history marks partial hosts instead of treating them as zero',()=>{
 const store=new TrafficStore(':memory:');try{
  store.record(h,sample(0),'',1000000);store.record(h,sample(15000),'',1015000);
  const data=store.history([h,{...h,id:'two'}],'10m',1015000);
  assert.equal(data.summary.currentRate,1000);assert.equal(data.summary.currentHosts,1);assert.equal(data.points.at(-1).partial,true);
  assert.equal(data.hosts[1].currentRate,null);
 }finally{store.close();}
});
test('history persists across collector restart and retention removes expired samples',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'traffic-test-'));let store;
 try{const filename=path.join(dir,'traffic.sqlite');store=new TrafficStore(filename);store.record(h,sample(0),'',1000000);store.record(h,sample(15000),'',1015000);store.close();store=new TrafficStore(filename);assert.equal(store.history([h],'10m',1015000).summary.totalBytes,15000);store.prune(RETENTION_MS+1016000);assert.equal(store.history([h],'30d',RETENTION_MS+1016000).summary.totalBytes,0);}finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
test('shared network namespaces are rejected instead of reporting host-wide traffic',async()=>{
 await assert.rejects(readTraffic(h,async()=> 'true|boot|host|id\n'),/Shared/);
});
