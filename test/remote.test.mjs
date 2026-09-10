import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHost, extractRoutes, dockerRoutes, inspectHost, probeHealth } from '../remote.mjs';
const h={id:'test',name:'test',address:'test.example',user:'deploy',port:22,key:'id_ed25519',container:'traefik',staticFile:'/traefik.yml'};
test('host settings reject command and key-path injection',()=>{
  for(const changes of [{address:'-oProxyCommand=evil'},{user:'root;id'},{key:'../../etc/passwd'},{container:'x$(id)'},{staticFile:'/../../etc/passwd'},{port:70000}]) assert.throws(()=>validateHost({...h,...changes}));
  assert.equal(validateHost(h).port,22);
});
test('live discovery omits credentials, environment variables, and middleware secrets',async()=>{
  const container={State:{Running:true,Status:'running'},Config:{Image:'traefik:test',Env:['TOKEN=never-return-this'],Labels:{'org.opencontainers.image.version':'v3.test','secret':'never-return-this','traefik.enable':'true','traefik.http.routers.dashboard.rule':'Host(`dashboard.example.com`)','traefik.http.middlewares.auth.basicauth.users':'never-return-this'}},NetworkSettings:{Networks:{proxy:{}}},Mounts:[]};
  const fake=async(_h,cmd)=>{
    if(cmd.startsWith('docker inspect'))return JSON.stringify([container]);
    if(cmd==='docker ps -q')return 'abcdef';
    if(cmd.includes("'/traefik.yml'"))return 'entryPoints: {https: {address: ":443"}}\nproviders: {file: {filename: /config.yml}, docker: {}}\ncertificatesResolvers: {cloudflare: {acme: {email: admin@example.com, dnsChallenge: {provider: cloudflare, secret: never-return-this}}}}';
    if(cmd.includes("'/config.yml'"))return 'http:\n  routers:\n    app: {rule: "Host(`app.example.com`)", service: app, tls: {}, entryPoints: [https]}\n  services:\n    app: {loadBalancer: {servers: [{url: "http://user:never-return-this@backend:8080/?token=never-return-this"}]}}\n  middlewares:\n    auth: {basicAuth: {users: [never-return-this]}}';
    throw new Error('Unexpected command');
  };
  const data=await inspectHost(h,fake);
  assert.equal(data.routes.length,2);
  assert.equal(data.routes[0].target,'http://backend:8080/');
  assert.equal(data.resolvers[0].name,'cloudflare');
  assert.ok(!JSON.stringify(data).includes('never-return-this'));
  assert.ok(!JSON.stringify(data).includes('Env'));
});
test('health aggregation handles multiple backends, failed ports, and unavailable probes',async()=>{
  const routes=extractRoutes('test',{http:{routers:{app:{service:'app'}},services:{app:{loadBalancer:{servers:[{url:'http://one:8000'},{url:'https://two'}]}}}}},'file');
  let command;
  const checked=await probeHealth(h,routes,async(_h,cmd)=>{command=cmd;return JSON.stringify([{url:'http://one:8000/',status:'up'},{url:'https://two/',status:'down'}]);});
  assert.equal(checked[0].health.status,'partial');
  assert.match(command,/docker.*exec/);
  assert.match(command,/nc/);
  const failed=await probeHealth(h,routes,async()=>{throw new Error('offline');});
  assert.equal(failed[0].health.status,'unknown');
  assert.equal(failed[0].health.checks.length,2);
});
test('internal Docker services have no fabricated backend address',()=>{
  const routes=dockerRoutes('test',[{Name:'/traefik',Config:{Labels:{'traefik.enable':'true','traefik.http.routers.dashboard.rule':'Host(`dashboard.example.com`)','traefik.http.routers.dashboard.service':'api@internal','traefik.http.routers.dashboard.tls.certresolver':'cloudflare'}}}]);
  assert.equal(routes[0].target,'api@internal');
  assert.equal(routes[0].tls,true);
  assert.deepEqual(routes[0].targets,[]);
});
