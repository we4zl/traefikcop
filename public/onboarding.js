let ui,flow=null,pollTimer,viewGeneration=0;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const field=(label,name,value='',extra='')=>`<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
const action=(text,action,extra='')=>`<button class="btn secondary" type="button" data-onboard="${action}" ${extra}>${text}</button>`;
const footer=text=>`<p class="form-error" role="alert"></p></div><div class="modal-footer">${action('Cancel','close')}<button class="btn primary" type="submit">${text}</button></div></form>`;
const command=(text,id)=>`<pre class="setup-command" id="${id}">${esc(text)}</pre>${action('Copy command','copy',`data-copy="${id}"`)}`;
function show(title,subtitle,content){clearTimeout(pollTimer);viewGeneration++;ui.modal(title,subtitle,content);}
function error(e){const out=document.querySelector('#modal .form-error');if(out)out.textContent=e.message;}
export function setupOnboarding(callbacks){
  ui=callbacks;
  document.addEventListener('submit',async e=>{
    const form=e.target;if(!form.id.startsWith('onboard-'))return;e.preventDefault();
    const submit=form.querySelector('[type="submit"]');submit.disabled=true;const data=Object.fromEntries(new FormData(form));
    try{
      if(form.id==='onboard-host'){
        flow.h={...flow.h,...data,container:data.container||'traefik',staticFile:data.staticFile||'/traefik.yml',port:Number(data.port),key:''};
        flow.key=data.managedKeyId?await ui.api('/api/ssh/keys').then(keys=>keys.find(k=>k.id===data.managedKeyId)):await ui.api('/api/ssh/keys','POST',{name:data.name+' connection'});
        flow.h.managedKeyId=flow.key.id;installKey();
      }
      if(form.id==='onboard-verify'){
        if(data.verified!=='on')throw new Error('Compare the fingerprint on the server and confirm that it matches.');
        flow.h.scanId=flow.scan.id;flow.h.fingerprint=flow.scan.fingerprint;
        const h=await ui.api(flow.h.id?'/api/hosts/'+flow.h.id:'/api/hosts',flow.h.id?'PUT':'POST',flow.h);flow.h=h;
        await ui.load();await testConnection();
      }
      if(form.id==='onboard-certificate'){
        data.host=flow.h.id;data.wildcard=!!data.wildcard;data.agree=!!data.agree;
        if(data.mode==='cloudflare')data.resolver='';else{data.resolver=data.mode;data.mode='existing';}
        const plan=await ui.api('/api/onboarding/certificate/preview','POST',data);
        // Remove the token from the DOM as soon as the server accepts the review.
        const token=form.querySelector('[name="cloudflareToken"]');if(token)token.value='';
        flow.plan=plan;
        show('Review certificate setup',flow.h.name,`<div class="modal-body"><ul class="setup-review">${plan.summary.map(s=>`<li>${esc(s)}</li>`).join('')}</ul><p>Traefik will create the DNS validation records. Your application’s A/AAAA records remain your responsibility.</p><p class="field-hint">A certificate request is successful only once a matching Let’s Encrypt certificate is observed on the host’s HTTPS port.</p></div><div class="modal-footer">${action('Back','certificate')}<button class="btn primary" data-onboard="apply">Get Let’s Encrypt certificate</button></div>`);
      }
    }catch(e){error(e);}finally{submit.disabled=false;}
  });
  document.addEventListener('click',async e=>{
    const button=e.target.closest('[data-onboard]');if(!button)return;button.disabled=true;
    try{switch(button.dataset.onboard){
      case 'close':document.querySelector('#modal').close();break;
      case 'copy':await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent);button.textContent='Copied';break;
      case 'scan':flow.scan=await ui.api('/api/ssh/scan','POST',flow.h);verifyFingerprint();break;
      case 'install':installKey();break;
      case 'retry':await testConnection();break;
      case 'certificate':await certificateSetup(flow.h.id);break;
      case 'apply':{const job=await ui.api('/api/onboarding/certificate/apply','POST',{id:flow.plan.id});showJob(job);break;}
      case 'check':await requestStatus(button.dataset.id);break;
      case 'keys':await keyList();break;
    }}catch(e){error(e);}finally{button.disabled=false;}
  });
  document.addEventListener('change',e=>{if(e.target.id==='certificate-mode')toggleCloudflare();if(e.target.id==='certificate-host')certificateSetup(e.target.value).catch(error);});
  document.querySelector('#modal').addEventListener('close',()=>{viewGeneration++;clearTimeout(pollTimer);});
}
export async function hostWizard(existing){
  const keys=await ui.api('/api/ssh/keys');flow={h:existing?{...existing}:{port:22,container:'traefik',staticFile:'/traefik.yml'}};
  const h=flow.h;
  show(existing?'Set up SSH access':'Add a host','1 of 4 · Connection details',`<form id="onboard-host"><div class="modal-body"><p>TraefikCop connects from its own server. No SSH software or key files are needed on the computer running your browser.</p><div class="form-grid">${field('Host name','name',h.name,'required maxlength="80" placeholder="e.g. homelab"')}${field('SSH address','address',h.address,'required placeholder="Hostname or IP"')}${field('SSH user','user',h.user,'required placeholder="e.g. deploy"')}${field('SSH port','port',h.port,'type="number" min="1" max="65535" required')}</div><label>SSH key<select name="managedKeyId"><option value="">Generate a new key in TraefikCop</option>${keys.map(k=>`<option value="${k.id}" ${h.managedKeyId===k.id?'selected':''}>${esc(k.name)} · ${esc(k.fingerprint.slice(0,20))}…</option>`).join('')}</select></label><p class="field-hint">Private keys stay in the app’s persistent data directory. Back up that directory securely when moving the app.</p><details><summary>Traefik settings</summary><div class="form-grid">${field('Container name','container',h.container,'required')}${field('Static config path inside container','staticFile',h.staticFile,'required')}</div>${field('Label (optional)','location',h.location)}</details>${footer('Continue to SSH instructions')}`);
}
function installKey(){
  const publicKey=flow.key.publicKey;
  const script=`mkdir -p "$HOME/.ssh"\nchmod 700 "$HOME/.ssh"\ntouch "$HOME/.ssh/authorized_keys"\nchmod 600 "$HOME/.ssh/authorized_keys"\ngrep -qxF '${publicKey}' "$HOME/.ssh/authorized_keys" || printf '%s\\n' '${publicKey}' >> "$HOME/.ssh/authorized_keys"`;
  show('Allow TraefikCop to connect','2 of 4 · Install the public key',`<div class="modal-body"><p>Open <strong>${esc(flow.h.address)}</strong> through its existing SSH access or your hosting provider’s console. Sign in as <strong>${esc(flow.h.user)}</strong>, then run:</p>${command(script,'install-key-command')}<p class="field-hint">This installs only the public key. The private key stays inside TraefikCop.</p><details><summary>Server prerequisites and Docker access</summary><p>The server needs an SSH server, Python 3, Docker Engine, and the Docker Compose plugin for installation or resolver changes. Verify as <strong>${esc(flow.h.user)}</strong>:</p>${command('python3 --version\ndocker ps\ndocker compose version','prerequisites-command')}<p>If Docker says “permission denied,” an administrator can grant Docker access:</p>${command(`sudo usermod -aG docker ${flow.h.user}`,'docker-access-command')}<p>Then sign out and back in. Membership in the Docker group grants administrator-level control over this server.</p><p>Allow the app server to reach SSH port ${flow.h.port}. Application traffic needs ports 80/443; the Docker API does not need to be exposed over TCP.</p></details><p>Next, we’ll read the server’s fingerprint so you can verify its identity before connecting.</p></div><div class="modal-footer">${action('Cancel','close')}<button class="btn primary" data-onboard="scan">Read server fingerprint</button></div>`);
}
function verifyFingerprint(){
  show('Verify the server','3 of 4 · Trust and connect',`<form id="onboard-verify"><div class="modal-body"><p>In the same trusted server console, run:</p>${command('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub','fingerprint-command')}<p>Compare its SHA256 fingerprint with the one TraefikCop received:</p><pre class="setup-command">${esc(flow.scan.fingerprint)}</pre><label class="setup-checkbox"><input type="checkbox" name="verified" required><span>The fingerprints match the server I intend to connect to.</span></label><p class="field-hint">Future connections reject a changed server key.</p>${footer('Trust and test connection')}`);
}
async function testConnection(){
  show('Testing SSH and Docker…',flow.h.name,`<div class="modal-body"><p>Checking access and looking for the Traefik container.</p></div>`);
  try{
    const facts=await ui.api('/api/onboarding/connection','POST',{host:flow.h.id});flow.facts=facts;
    show('Host connected','4 of 4 · HTTPS setup',`<div class="modal-body"><div class="info-strip">${esc(facts.message)}</div><p>${facts.exists?'You can request a certificate now, even before adding an application.':'The next step can install Traefik and configure Cloudflare DNS validation for your domain.'}</p><p>Have your domain and, if this is a new setup, your email address and Cloudflare API token ready.</p></div><div class="modal-footer">${action('Finish — set up HTTPS later','close')}<button class="btn primary" data-onboard="certificate">Get a Let’s Encrypt certificate</button></div>`);
    void ui.api('/api/hosts/'+flow.h.id+'/refresh','POST',{}).then(()=>ui.load()).catch(()=>{});
  }catch(e){show('Connection needs attention',flow.h.name,`<div class="modal-body"><p class="host-error">${esc(e.message)}</p><p>Your host is saved. Check the public key installation, SSH reachability, Python 3, and Docker permissions, then retry.</p></div><div class="modal-footer">${action('SSH instructions','install')}<button class="btn primary" data-onboard="retry">Test again</button></div>`);}
}
export async function certificateSetup(id){
  const hosts=ui.getState().hosts,h=hosts.find(h=>h.id===id)||hosts[0];if(!h){await hostWizard();return;}
  flow={h};show('Checking certificate setup…',h.name,`<div class="modal-body"><p>Reading the host’s Traefik configuration.</p></div>`);
  const facts=await ui.api('/api/onboarding/connection','POST',{host:h.id});flow.facts=facts;
  const resolvers=facts.resolvers.filter(r=>r.autoRenew&&!r.staging),defaults=ui.getState().domains.find(d=>d.host===h.id);
  show('Get a Let’s Encrypt certificate','Choose a domain. Traefik will handle validation and renewal.',`<form id="onboard-certificate"><div class="modal-body"><label>Host<select id="certificate-host">${hosts.map(x=>`<option value="${x.id}" ${x.id===h.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>${field('Domain','name',defaults?.name,'required placeholder="example.com"')}<label class="toggle-row"><span><strong>Include wildcard coverage</strong><small>Cover example.com and *.example.com.</small></span><input type="checkbox" name="wildcard" checked></label><label>Certificate setup<select name="mode" id="certificate-mode" aria-label="Certificate setup">${resolvers.map(r=>`<option value="${esc(r.name)}">Use ${esc(r.name)} · ${esc(r.provider||r.challenge)}</option>`).join('')}<option value="cloudflare">${facts.exists?'Set up a new Cloudflare resolver':'Install Traefik with Cloudflare'}</option></select></label>${facts.exists?`<label>HTTPS entry point<select name="entrypoint" required>${facts.entrypoints.map(e=>`<option value="${esc(e.name)}" ${/:443$/.test(e.address)?'selected':''}>${esc(e.name)} (${esc(e.address)})</option>`).join('')}</select></label>`:''}<div id="cloudflare-fields">${field('Let’s Encrypt account email','email','','type="email" autocomplete="email"')}${field('Cloudflare API token','cloudflareToken','','type="password" autocomplete="off" spellcheck="false"')}<p class="field-hint">Create a token with <strong>Zone / DNS / Edit</strong> and <strong>Zone / Zone / Read</strong>, limited to this domain’s zone. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Open Cloudflare API tokens ↗</a></p><p class="field-hint">We verify zone access before review; DNS write permission is exercised by Traefik during validation. The token is stored in a private file on the remote host for renewals.</p><label class="setup-checkbox"><input type="checkbox" name="agree"><span>I agree to the <a href="https://letsencrypt.org/repository/" target="_blank" rel="noreferrer">Let’s Encrypt subscriber agreement</a>.</span></label></div><p class="field-hint">No application is needed yet. Creating a certificate does not create the A/AAAA records used to reach your applications.</p>${footer('Review setup')}`);
  toggleCloudflare();
}
function toggleCloudflare(){const enabled=document.getElementById('certificate-mode').value==='cloudflare',fields=document.getElementById('cloudflare-fields');fields.hidden=!enabled;fields.querySelectorAll('input').forEach(input=>{input.disabled=!enabled;input.required=enabled;});}
export async function requestStatus(id){const job=await ui.api('/api/onboarding/certificate/status','POST',{id});showJob(job);}
function showJob(job){
  show(job.status==='issued'?'Certificate ready':job.status==='applying'?'Setting up HTTPS…':job.status==='waiting'?'Waiting for the certificate':'Setup needs attention',job.domain.name,`<div class="modal-body"><div class="info-strip">${esc(job.message)}</div>${job.lastCheck?`<p>${esc(job.lastCheck)}</p>`:''}${job.validTo?`<p>Valid until ${esc(new Date(job.validTo).toLocaleDateString())}.</p>`:''}<p>${['applying','waiting'].includes(job.status)?'You may close this window. Setup continues on the server; reopen this request from Certificates.':'Your request is saved under Certificates.'}</p></div><div class="modal-footer">${action('Close','close')}${job.status!=='applying'?action('Check certificate','check',`data-id="${job.id}"`):''}</div>`);
  void ui.load().catch(()=>{});
  if(['applying','waiting'].includes(job.status)){
    const generation=viewGeneration;
    pollTimer=setTimeout(async()=>{if(!document.querySelector('#modal').open)return;try{const updated=await ui.api('/api/onboarding/certificate/status','POST',{id:job.id});if(generation===viewGeneration&&document.querySelector('#modal').open)showJob(updated);}catch(e){if(generation===viewGeneration)error(e);}},job.status==='applying'?3000:15000);
  }
}
export async function keyList(){
  const keys=await ui.api('/api/ssh/keys');
  show('App-managed SSH keys','Private keys stay on the app server.',`<div class="modal-body"><p>These keys are stored in the app’s private data directory, alongside its local account and host settings. Back up the entire data volume securely when moving TraefikCop. Private keys are never returned to the browser.</p>${keys.map(k=>`<section class="setup-key"><h3>${esc(k.name)}</h3><p class="mono">${esc(k.fingerprint)}</p>${command(k.publicKey,'key-'+k.id)}</section>`).join('')||'<p>No keys yet. Add a host to generate one.</p>'}</div>`);
}
