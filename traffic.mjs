import {DatabaseSync} from 'node:sqlite';
import {chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ssh} from './remote.mjs';
export const SAMPLE_MS=15000,RETENTION_MS=30*86400000;
export const RANGES={'10m':600000,'1h':3600000,'6h':21600000,'24h':86400000,'7d':604800000,'30d':RETENTION_MS};
const quote=v=>"'"+String(v).replaceAll("'","'\\''")+"'";
export const hostIdentity=h=>createHash('sha256').update(JSON.stringify([h.address,h.user,h.port,h.container])).digest('hex');
export function parseCounters(text){
  const interfaces=[];let tx=0n,rx=0n;
  for(const line of text.split('\n')){
    const match=/^\s*([^:]+):\s*(.+)$/.exec(line);if(!match||match[1].trim()==='lo')continue;
    const columns=match[2].trim().split(/\s+/);if(columns.length<16||!columns.every(s=>/^\d+$/.test(s)))throw new Error('Invalid network counters.');
    interfaces.push(match[1].trim());rx+=BigInt(columns[0]);tx+=BigInt(columns[8]);
  }
  if(!interfaces.length)throw new Error('No non-loopback network interfaces found.');
  return {rx:rx.toString(),tx:tx.toString(),interfaces:interfaces.sort().join(',')};
}
export async function readTraffic(h,run=ssh){
  // Pin both inspection and exec to one container ID. Include StartedAt to detect restarts.
  const script=`set -eu\ncid=$(docker inspect --type container --format '{{.Id}}' ${quote(h.container)})\ndocker inspect --format '{{.State.Running}}|{{.State.StartedAt}}|{{.HostConfig.NetworkMode}}|{{.Id}}' "$cid"\ndocker exec "$cid" cat /proc/net/dev`;
  const result=await run(h,script);const [header,...rest]=result.split('\n');
  const [running,started,network,id]=header.split('|');
  if(running!=='true')throw new Error('Traefik container is not running.');
  if(network==='host'||network?.startsWith('container:'))throw new Error('Shared network namespaces cannot isolate Traefik traffic.');
  if(!id||!started)throw new Error('Container identity is unavailable.');
  const counters=parseCounters(rest.join('\n'));
  return {...counters,generation:id+':'+started+':'+counters.interfaces};
}
export class TrafficStore{
  constructor(filename){
    this.db=new DatabaseSync(filename);if(filename!==':memory:')chmodSync(filename,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS traffic (host TEXT NOT NULL, ts INTEGER NOT NULL, identity TEXT NOT NULL, generation TEXT, tx TEXT, rx TEXT, start INTEGER, delta REAL, error TEXT, PRIMARY KEY(host,ts));
      CREATE INDEX IF NOT EXISTS traffic_age ON traffic(ts);`);
    this.latest=this.db.prepare('SELECT * FROM traffic WHERE host=? ORDER BY ts DESC LIMIT 1');
    this.insert=this.db.prepare('INSERT INTO traffic(host,ts,identity,generation,tx,rx,start,delta,error) VALUES(?,?,?,?,?,?,?,?,?)');
  }
  record(h,result,error='',at=Date.now()){
    const identity=hostIdentity(h),previous=this.latest.get(h.id);let start=null,delta=null;
    if(previous&&at<=previous.ts)return;
    if(result&&previous?.tx!==null&&previous?.tx!==undefined&&previous.identity===identity&&previous.generation===result.generation&&at-previous.ts<=SAMPLE_MS*3){
      const bytes=BigInt(result.tx)-BigInt(previous.tx);
      if(bytes>=0n){delta=Number(bytes);start=previous.ts;}
    }
    this.insert.run(h.id,at,identity,result?.generation||null,result?.tx||null,result?.rx||null,start,delta,error||null);
  }
  prune(now=Date.now()){this.db.prepare('DELETE FROM traffic WHERE ts < ?').run(now-RETENTION_MS);}
  history(hosts,range='10m',now=Date.now()){
    const duration=Object.hasOwn(RANGES,range)?RANGES[range]:null;if(!duration)throw new Error('Invalid traffic range.');
    const from=now-duration,bucketMs=Math.max(SAMPLE_MS,Math.ceil(duration/600/SAMPLE_MS)*SAMPLE_MS);
    const count=Math.ceil(duration/bucketMs),points=Array.from({length:count},(_,i)=>({time:from+i*bucketMs,rate:null,bytes:0,hosts:0,observed:0}));
    let totalBytes=0,observedMs=0,currentRate=0,currentHosts=0,latestAt=null;
    const summaries=[];
    const query=this.db.prepare(`WITH RECURSIVE buckets(i,lo,hi) AS (
      SELECT 0, ?, MIN(? + ?, ?)
      UNION ALL SELECT i+1, hi, MIN(hi+?, ?) FROM buckets WHERE hi < ?
    ) SELECT b.i AS bucket,
      SUM(t.delta * (MIN(t.ts,b.hi)-MAX(t.start,b.lo))*1.0/(t.ts-t.start)) AS bytes,
      SUM(MIN(t.ts,b.hi)-MAX(t.start,b.lo)) AS observed
      FROM buckets b JOIN traffic t ON t.host=? AND t.identity=?
      AND t.ts>b.lo AND t.ts<=b.hi+45000 AND t.ts<=? AND t.start<b.hi AND t.delta IS NOT NULL
      GROUP BY b.i ORDER BY b.i`);
    for(const h of hosts){
      const identity=hostIdentity(h),rows=query.all(from,from,bucketMs,now,bucketMs,now,now,h.id,identity,now),latest=this.latest.get(h.id);
      let bytes=0,observed=0;
      for(const row of rows){const index=Math.min(count-1,row.bucket),point=points[index];if(!point)continue;point.rate=(point.rate??0)+row.bytes/(row.observed/1000);point.bytes+=row.bytes;point.hosts++;point.observed+=row.observed;bytes+=row.bytes;observed+=row.observed;}
      const recent=latest?.identity===identity&&now-latest.ts<=SAMPLE_MS*3;
      const rate=recent&&latest.delta!==null?latest.delta/((latest.ts-latest.start)/1000):null;
      if(rate!==null){currentRate+=rate;currentHosts++;}
      if(latest?.identity===identity)latestAt=Math.max(latestAt||0,latest.ts);
      summaries.push({id:h.id,name:h.name,bytes,coverage:Math.min(1,observed/duration),currentRate:rate,lastSample:latest?.identity===identity?latest.ts:null,error:recent?latest.error||null:latest?'Collection is stale.':'Waiting for the first sample.'});
      totalBytes+=bytes;observedMs+=observed;
    }
    return {range,from,to:now,bucketMs,sampleMs:SAMPLE_MS,retentionDays:30,points:points.map(p=>({...p,partial:p.hosts>0&&(p.hosts<hosts.length||p.observed<bucketMs*hosts.length*0.9)})),summary:{totalBytes,currentRate:currentHosts?currentRate:null,currentHosts,hostCount:hosts.length,peakRate:points.some(p=>p.rate!==null)?Math.max(...points.map(p=>p.rate||0)):null,coverage:hosts.length?Math.min(1,observedMs/(duration*hosts.length)):0,latestAt},hosts:summaries,definition:'Outbound bytes across non-loopback interfaces of the Traefik container, including client responses and backend requests. Gaps are unknown, not zero.'};
  }
  close(){this.db.close();}
}
export function startTrafficCollector({store,getHosts,read=readTraffic,interval=SAMPLE_MS,onError=()=>{}}){
  let running=false,stopped=false,pruned=0;
  async function tick(){
    if(running||stopped)return;running=true;
    try{
      const hosts=[...getHosts()];let index=0;
      await Promise.all(Array.from({length:Math.min(4,hosts.length)},async()=>{while(index<hosts.length&&!stopped){const h=hosts[index++];let result,error;try{result=await read(h);}catch(e){error=e.message;}
        if(!stopped&&getHosts().some(x=>x.id===h.id&&hostIdentity(x)===hostIdentity(h)))store.record(h,result,error);
      }}));
      if(Date.now()-pruned>3600000){store.prune();pruned=Date.now();}
    }catch(e){onError(e);}finally{running=false;}
  }
  const timer=setInterval(tick,interval);timer.unref();tick();
  return {tick,stop(){stopped=true;clearInterval(timer);}};
}
