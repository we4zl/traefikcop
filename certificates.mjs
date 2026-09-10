import {X509Certificate} from 'node:crypto';
import {ssh} from './remote.mjs';
const quote=v=>"'"+String(v).replaceAll("'","'\\''")+"'";
const script=`import base64,concurrent.futures,json,socket,ssl,sys
items=json.loads(sys.argv[1])
def probe(item):
 try:
  context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
  context.check_hostname=False
  context.verify_mode=ssl.CERT_NONE
  with socket.create_connection(('127.0.0.1',item['port']),timeout=3) as sock:
   with context.wrap_socket(sock,server_hostname=item['domain']) as conn:
    return dict(item,certificate=base64.b64encode(conn.getpeercert(binary_form=True)).decode())
 except Exception:
  return dict(item,error='TLS handshake failed on the Docker host loopback port')
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 print(json.dumps(list(pool.map(probe,items))))
`;
export function certificateDetails(encoded,domain,now=Date.now()){
  const cert=new X509Certificate(Buffer.from(encoded,'base64'));
  const expires=new Date(cert.validTo).getTime(),starts=new Date(cert.validFrom).getTime();
  const covers=!!cert.checkHost(domain),isDefault=cert.subject.includes('TRAEFIK DEFAULT CERT');
  return {fingerprint:cert.fingerprint256,subject:cert.subject,issuer:cert.issuer,domains:cert.subjectAltName||cert.subject,validFrom:new Date(starts).toISOString(),validTo:new Date(expires).toISOString(),daysRemaining:Math.ceil((expires-now)/86400000),covers,status:isDefault?'default':now>expires?'expired':now<starts?'not-yet-valid':!covers?'name-mismatch':'in-date'};
}
export async function inspectCertificates(h,inspection,run=ssh){
  const endpoints=new Map((inspection.host.entrypoints||[]).map(e=>[e.name,Number(/:(\d+)(?:\/tcp)?$/.exec(e.address||'')?.[1])]));
  const probes=new Map();
  for(const route of inspection.routes.filter(r=>r.tls)){
    const port=endpoints.get(route.entrypoint.split(',')[0].trim());if(!port)continue;
    for(const domain of route.domains){if(domain.includes('*'))continue;probes.set(port+':'+domain,{port,domain});}
  }
  if(!probes.size)return {certificates:[],certificateErrors:[]};
  let results;
  try{results=JSON.parse(await run(h,`python3 -c ${quote(script)} ${quote(JSON.stringify([...probes.values()].slice(0,20)))}`));}
  catch{return {certificates:[],certificateErrors:[{host:h.id,error:'Unable to inspect served certificates over SSH.'}]};}
  const certificates=new Map(),certificateErrors=[];
  for(const result of results){
    if(result.error){certificateErrors.push({host:h.id,domain:result.domain,port:result.port,error:result.error});continue;}
    try{
      const info=certificateDetails(result.certificate,result.domain);
      let existing=certificates.get(info.fingerprint);
      if(!existing){existing={...info,id:h.id+':'+info.fingerprint,host:h.id,checkedAt:new Date().toISOString(),servedFor:[],trustVerified:false};certificates.set(info.fingerprint,existing);}
      existing.servedFor.push({domain:result.domain,port:result.port,covers:info.covers,status:info.status});
      if(info.status==='name-mismatch'&&existing.status==='in-date')existing.status='name-mismatch';
    }catch{certificateErrors.push({host:h.id,domain:result.domain,error:'The served certificate could not be parsed.'});}
  }
  if(probes.size>20)certificateErrors.push({host:h.id,error:'Certificate checks are limited to 20 hostnames per refresh.'});
  for(const c of certificates.values()){
    const names=new Set(inspection.routes.filter(r=>r.resolver&&r.domains.some(d=>c.servedFor.some(s=>s.domain===d))).map(r=>r.resolver));
    const resolvers=(inspection.resolvers||[]).filter(r=>names.has(r.name)&&r.autoRenew);
    c.renewal={automaticConfigured:resolvers.length>0,resolvers:resolvers.map(r=>r.name),windowStartsAt:resolvers.length&&resolvers.every(r=>r.certificateDurationHours===2160)?new Date(new Date(c.validTo).getTime()-30*86400000).toISOString():null};
  }
  return {certificates:[...certificates.values()],certificateErrors};
}
