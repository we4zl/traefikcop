import {isIP} from 'node:net';

function address(value){
  if(typeof value!=='string'||value.length>320)return null;
  const match=/^(\[[a-f\d:.]+\]|[a-z\d](?:[a-z\d.-]*[a-z\d])?)(?::([1-9]\d{0,4}))?$/i.exec(value);
  if(!match)return null;
  const port=Number(match[2]||80);if(port>65535)return null;
  return {hostname:match[1].replace(/^\[|\]$/g,'').toLowerCase(),port};
}
function privateIP(hostname){
  if(isIP(hostname)===4){const [a,b]=hostname.split('.').map(Number);return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168);}
  return isIP(hostname)===6&&/^f[cd]/i.test(hostname);
}
export function createHostPolicy({port,allowLAN=false,extraHosts=''}={}){
  const configured=extraHosts.split(',').map(s=>s.trim()).filter(Boolean).map(value=>{
    const parsed=address(value);if(!parsed)throw new Error('TRAEFIKCOP_ALLOWED_HOSTS must contain comma-separated host:port values, without URLs or wildcards.');return parsed;
  });
  return {
    label:allowLAN?'LAN IPs'+(configured.length?' and configured names':''):configured.length?'Configured addresses':'Localhost only',
    allows(value){
      const parsed=address(value);if(!parsed)return false;
      if(configured.some(h=>h.hostname===parsed.hostname&&h.port===parsed.port))return true;
      if(parsed.port!==port)return false;
      if(['localhost','127.0.0.1','::1'].includes(parsed.hostname))return true;
      return allowLAN&&privateIP(parsed.hostname);
    }
  };
}
