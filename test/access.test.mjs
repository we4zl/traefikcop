import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostPolicy} from '../access.mjs';

test('local defaults reject remote addresses; LAN mode accepts only private IPs on the app port',()=>{
 const local=createHostPolicy({port:3001}),lan=createHostPolicy({port:3001,allowLAN:true});
 for(const h of ['localhost:3001','127.0.0.1:3001','[::1]:3001'])assert.equal(local.allows(h),true);
 for(const h of ['10.1.2.3:3001','172.16.0.1:3001','172.31.255.254:3001','192.168.1.2:3001','[fd00::1]:3001']){assert.equal(local.allows(h),false);assert.equal(lan.allows(h),true);}
 for(const h of ['172.15.0.1:3001','172.32.0.1:3001','192.169.1.1:3001','192.0.2.1:3001','10.1.2.3:80','evil.example:3001','10.1.2.3.evil.example:3001','2130706433:3001','[2001:db8::1]:3001','[fe80::1]:3001',undefined,'user@10.1.2.3:3001','10.1.2.3:3001/path'])assert.equal(lan.allows(h),false,String(h));
});
test('configured browser addresses are exact matches and reject invalid configuration',()=>{
 const policy=createHostPolicy({port:3001,extraHosts:' traefikcop.example.test:3001,192.0.2.50:3002 '});
 assert.equal(policy.allows('traefikcop.example.test:3001'),true);assert.equal(policy.allows('TRAEFIKCOP.EXAMPLE.TEST:3001'),true);assert.equal(policy.allows('192.0.2.50:3002'),true);
 for(const h of ['evil.traefikcop.example.test:3001','traefikcop.example.test:80','192.0.2.51:3002'])assert.equal(policy.allows(h),false);
 for(const extraHosts of ['*','https://example.test','example.test/path','example.test:65536'])assert.throws(()=>createHostPolicy({port:3001,extraHosts}));
});
