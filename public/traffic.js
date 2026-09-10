const esc=(s='')=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ranges=[['10m','10 min'],['1h','1 hour'],['6h','6 hours'],['24h','24 hours'],['7d','7 days'],['30d','30 days']];
let request,scopeFor,selectedRange='24h';
const cache=new Map(),pending=new Set(),errors=new Map();
export const bytes=value=>{if(value===null||value===undefined)return '—';const units=['B','KiB','MiB','GiB','TiB'];let n=Math.max(0,value),i=0;while(n>=1024&&i<units.length-1){n/=1024;i++;}return `${n.toLocaleString(undefined,{maximumFractionDigits:i?1:0})} ${units[i]}`;};
const rate=value=>value===null||value===undefined?'—':bytes(value)+'/s';
const key=(scope,range)=>scope+':'+range;
export function setupTraffic({api,getScope}){
  request=api;scopeFor=getScope;
  document.addEventListener('click',e=>{const range=e.target.closest('[data-traffic-range]');if(range){selectedRange=range.dataset.trafficRange;const root=document.querySelector('[data-traffic-history]');if(root){root.outerHTML=trafficPage(scopeFor());}}});
  document.addEventListener('pointermove',e=>{
    const svg=e.target.closest('svg[data-traffic-chart]');if(!svg)return;
    const root=svg.closest('[data-traffic-widget]'),data=cache.get(key(root.dataset.scope,root.dataset.range))?.data;if(!data)return;
    const r=svg.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*900;
    const index=Math.max(0,Math.min(data.points.length-1,Math.round((x-75)/805*(data.points.length-1))));
    const p=data.points[index],line=svg.querySelector('.traffic-cursor');line.setAttribute('x1',75+index/(Math.max(1,data.points.length-1))*805);line.setAttribute('x2',line.getAttribute('x1'));line.setAttribute('visibility','visible');
    root.querySelector('[data-traffic-tooltip]').textContent=`${new Date(p.time).toLocaleString()} · ${p.rate===null?'No measurement':rate(p.rate)}${p.partial?' · partial coverage':''}`;
  });
  document.addEventListener('pointerout',e=>{const svg=e.target.closest('svg[data-traffic-chart]');if(svg&&!svg.contains(e.relatedTarget)){svg.querySelector('.traffic-cursor')?.setAttribute('visibility','hidden');}});
  setInterval(()=>{if(!document.hidden)refreshVisible(true);},15000);
}
async function fetchTraffic(scope,range,force=false){
  const k=key(scope,range);if(pending.has(k)||(!force&&cache.has(k)&&Date.now()-cache.get(k).at<14000))return;
  pending.add(k);
  try{const data=await request('/api/traffic?'+new URLSearchParams({host:scope,range}));cache.set(k,{at:Date.now(),data});errors.delete(k);}
  catch(e){errors.set(k,e.message);}
  finally{pending.delete(k);for(const root of document.querySelectorAll('[data-traffic-widget]')){if(root.dataset.scope===scope&&root.dataset.range===range)root.innerHTML=widgetBody(scope,range,root.hasAttribute('data-expanded'));}}
}
function refreshVisible(force=false){for(const root of document.querySelectorAll('[data-traffic-widget]'))fetchTraffic(root.dataset.scope,root.dataset.range,force);}
function chart(data,expanded){
  const points=data.points,maximum=Math.max(1,...points.map(p=>p.rate||0)),top=16,bottom=expanded?215:135,height=bottom+36;
  const x=i=>75+i/Math.max(1,points.length-1)*805,y=n=>bottom-(n/maximum)*(bottom-top);
  let segments=[],current=[],partial=false;
  for(let i=0;i<points.length;i++){const p=points[i];if(p.rate===null){if(current.length)segments.push({points:current,partial});current=[];continue;}if(current.length&&partial!==p.partial){segments.push({points:current,partial});current=[current[current.length-1]];}partial=p.partial;current.push([x(i),y(p.rate)]);}
  if(current.length)segments.push({points:current,partial});
  const paths=segments.map(s=>{
    const line=s.points.map(p=>p.map(n=>n.toFixed(2)).join(',')).join(' '),first=s.points[0],last=s.points.at(-1);
    return `${s.points.length>1?`<polygon class="traffic-area ${s.partial?'partial':''}" points="${first[0]},${bottom} ${line} ${last[0]},${bottom}"/><polyline class="traffic-line ${s.partial?'partial':''}" points="${line}"/>`:`<circle class="traffic-dot" cx="${first[0]}" cy="${first[1]}" r="3"/>`}`;
  }).join('');
  const ticks=[0,.5,1].map(f=>`<line class="traffic-grid" x1="75" x2="880" y1="${y(maximum*f)}" y2="${y(maximum*f)}"/><text class="traffic-axis" x="65" y="${y(maximum*f)+4}" text-anchor="end">${esc(bytes(maximum*f))}</text>`).join('');
  const timeLabel=t=>new Date(t).toLocaleString(undefined,data.to-data.from>86400000?{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}:{hour:'2-digit',minute:'2-digit'});
  return `<svg data-traffic-chart viewBox="0 0 900 ${height}" role="img" aria-label="Outbound traffic in bytes per second. ${Math.round(data.summary.coverage*100)} percent sampling coverage.">${ticks}${paths}<line class="traffic-cursor" visibility="hidden" x1="75" x2="75" y1="${top}" y2="${bottom}"/><text class="traffic-axis" x="75" y="${bottom+26}">${esc(timeLabel(data.from))}</text><text class="traffic-axis" x="880" y="${bottom+26}" text-anchor="end">${esc(timeLabel(data.to))}</text>${!segments.length?`<text class="traffic-empty-label" x="470" y="${(top+bottom)/2}" text-anchor="middle">Collecting samples — rates appear after two readings</text>`:''}</svg>`;
}
function widgetBody(scope,range,expanded){
  const k=key(scope,range),data=cache.get(k)?.data,error=errors.get(k);
  if(!data)return `<div class="traffic-loading">${esc(error||'Reading traffic history…')}</div>`;
  const s=data.summary,stale=s.latestAt&&Date.now()-s.latestAt>45000;
  return `<div class="traffic-metrics"><div><small>Current egress${s.currentHosts<s.hostCount?' · partial':''}</small><strong>${rate(s.currentRate)}</strong></div><div><small>Observed sent</small><strong>${bytes(s.totalBytes)}</strong></div><div><small>Peak ${data.bucketMs/1000}s average</small><strong>${rate(s.peakRate)}</strong></div><div><small>Sampling coverage</small><strong>${Math.round(s.coverage*100)}<span>%</span></strong></div></div>${chart(data,expanded)}<div class="traffic-chart-footer"><span data-traffic-tooltip>Hover to inspect · ${s.latestAt?'last sample '+new Date(s.latestAt).toLocaleTimeString():'waiting for a sample'}</span><span>${stale?'Collection stale':error?'Update failed':'Every 15 seconds'}</span></div>${error?`<p class="traffic-error">${esc(error)} — displaying the last successful response.</p>`:''}${expanded?`<div class="table-scroll"><table><thead><tr><th>Host</th><th>Current egress</th><th>Observed sent</th><th>Coverage</th><th>Collector</th></tr></thead><tbody>${data.hosts.map(h=>`<tr><td>${esc(h.name)}</td><td class="mono">${rate(h.currentRate)}</td><td class="mono">${bytes(h.bytes)}</td><td>${Math.round(h.coverage*100)}%</td><td>${esc(h.error||(h.currentRate===null?'Establishing baseline':'Collecting'))}</td></tr>`).join('')||'<tr><td colspan="5">Add a host to start collecting traffic.</td></tr>'}</tbody></table></div>`:''}`;
}
export function trafficCard(scope){queueMicrotask(refreshVisible);return `<section class="panel traffic-panel"><button class="traffic-open" data-action="traffic-history" aria-label="Open egress traffic history"><span><strong>Egress traffic</strong><small>Last 10 minutes · Traefik container</small></span><span>View history ↗</span></button><div class="traffic-clickable" role="button" tabindex="0" data-action="traffic-history" aria-label="Open historical egress statistics"><div data-traffic-widget data-scope="${esc(scope)}" data-range="10m">${widgetBody(scope,'10m',false)}</div></div></section>`;}
export function trafficPage(scope){queueMicrotask(refreshVisible);return `<div data-traffic-history><div class="page-heading"><div><div class="eyebrow">TRAFFIC HISTORY</div><h1>Egress traffic</h1><p>Outbound traffic from your Traefik containers.</p></div></div><div class="traffic-ranges" role="group" aria-label="Traffic time range">${ranges.map(([value,label])=>`<button class="btn ${selectedRange===value?'primary':'secondary'}" data-traffic-range="${value}" aria-pressed="${selectedRange===value}">${label}</button>`).join('')}</div><section class="panel traffic-panel"><div data-traffic-widget data-expanded data-scope="${esc(scope)}" data-range="${selectedRange}">${widgetBody(scope,selectedRange,true)}</div></section><p class="footnote">Includes client responses and requests to backends across all non-loopback container interfaces. This is container egress, not an internet billing meter or per-application bandwidth. Shared host/container network namespaces are excluded.</p><p class="footnote">History is collected every 15 seconds while TraefikCop runs, even with this page closed, and retained for 30 days. Collection starts when monitoring is enabled; older traffic cannot be reconstructed. Gaps and restarts are unknown, not zero. Totals include only observed intervals. Amber segments indicate partial coverage across hosts.</p></div>`;}
