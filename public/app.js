const $=(s,r=document)=>r.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const api=async(p,o={})=>{const r=await fetch(p,{headers:{'content-type':'application/json'},...o,body:o.body?JSON.stringify(o.body):undefined});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t};if(!r.ok)throw new Error(j.error||r.status);return j}
let data=null,view='apps',filter=''
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));b.classList.add('on');view=b.dataset.v;render()})
const stateChip=s=>`<span class="chip ${/ready|running/.test(s)?'ok':/stop|unknown|fail/.test(s)?'bad':'warn'}">${esc(s)}</span>`
const icon=a=>a.icon?`<img class="ic" src="${esc(a.icon)}" onerror="this.src='icon.png'">`:`<img class="ic" src="icon.png">`
async function load(){data=await api('/api/overview');$('#sub').textContent=`${data.apps.length} apps · ${data.ports.length} published ports${data.conflicts.length?` · ${data.conflicts.length} conflicts`:''}`}
async function render(){const m=$('#main');try{if(!data)await load();if(view==='apps')apps(m);else if(view==='ports')ports(m);else await settings(m)}catch(e){m.innerHTML=`<div class="msg bad">${esc(e.message)}</div>`}}
function apps(m){
  const list=data.apps.filter(a=>!filter||(a.name+a.id).toLowerCase().includes(filter))
  m.innerHTML=`${!data.umbrel.configured?`<div class="msg warn">umbrelOS API not connected: state, versions and one-click updates are limited. <a href="#" onclick="view='settings';render();return false" style="color:#fcd34d">Connect</a></div>`:''}${data.umbrel.error?`<div class="msg bad">umbrelOS API: ${esc(data.umbrel.error)}</div>`:''}
  <div class="toolbar"><input placeholder="Search apps" value="${esc(filter)}" oninput="filter=this.value.toLowerCase();apps($('#main'));this.focus();this.setSelectionRange(99,99)"><button onclick="data=null;render()">Refresh</button></div>
  <div class="grid">${list.map(a=>`<div class="card" onclick="openApp('${a.id}')"><div class="ch">${icon(a)}<div><b>${esc(a.name)}</b><small>${esc(a.id)}${a.version?' · v'+esc(a.version):''}</small></div></div>
  <div class="chips">${stateChip(a.state)}${a.private?'<span class="chip priv">private store</span>':`<span class="chip">${esc(a.source)}</span>`}${a.updateAvailable?'<span class="chip warn">update</span>':''}${a.pending&&a.pending.status!=='done'?`<span class="chip warn">${esc(a.pending.status)}</span>`:''}
  ${a.ports.map(p=>`<span class="chip">:${p.port}${p.proto==='udp'?'/udp':''}</span>`).join('')}<span class="chip">${a.containers.length} ctr</span></div></div>`).join('')}</div>`}
function ports(m){
  m.innerHTML=`${data.conflicts.length?data.conflicts.map(c=>`<div class="msg bad">Port ${esc(c.port)} published by ${c.apps.map(esc).join(', ')}</div>`).join(''):'<div class="msg ok">No host port conflicts.</div>'}
  <div class="box"><table><tr><th>Host port</th><th>App</th><th>Container</th><th>→</th></tr>${[...data.ports].sort((a,b)=>a.port-b.port).map(p=>`<tr><td><b>${p.port}</b>/${p.proto}</td><td>${esc(p.app)}</td><td>${esc(p.container)}</td><td>${p.target}</td></tr>`).join('')}</table></div>`}
async function settings(m){const s=await api('/api/settings')
  m.innerHTML=`<div class="box"><h3>umbrelOS API</h3><p style="opacity:.75">Optional, enables live state/versions and automatic updates after you save. In umbrelOS open <b>Settings → MCP</b>, enable it, give access to <b>all apps</b>, create a token named “Harbormaster”, and paste it here.</p>
  <label>Token ${s.umbrelToken?'<span class="chip ok">set</span>':''}<input id="ut" type="password" placeholder="paste token"></label><br><br><label>Endpoint<input id="uu" value="${esc(s.umbrelMcpUrl)}"></label></div>
  <div class="box"><h3>Private store (Gitea)</h3><p>Repo <b>${esc(s.storeRepo)}</b> ${s.giteaToken?'<span class="chip ok">token set</span>':'<span class="chip bad">no token</span>'}</p><input id="gt" type="password" placeholder="replace Gitea token (optional)"></div>
  <button class="primary" onclick="saveSettings()">Save & test</button><pre id="out" class="hidden"></pre>`}
async function saveSettings(){const o=$('#out');o.classList.remove('hidden');o.textContent='Testing…';o.textContent=JSON.stringify(await api('/api/settings',{method:'POST',body:{umbrelToken:$('#ut').value,umbrelMcpUrl:$('#uu').value,giteaToken:$('#gt').value}}),null,2);data=null}
let cur=null
async function openApp(id){const a=data.apps.find(x=>x.id===id);$('#drawer').classList.remove('hidden');const p=$('#panel');p.innerHTML='Loading…'
  cur={a,info:await api('/api/apps/'+id)};const i=cur.info
  p.innerHTML=`<div class="ch">${icon(a)}<div><b style="font-size:20px">${esc(a.name)}</b><small>${esc(a.id)}${a.version?' · v'+esc(a.version):''}</small></div><button style="margin-left:auto" onclick="$('#drawer').classList.add('hidden')">✕</button></div>
  <div class="chips">${stateChip(a.state)}${a.private?'<span class="chip priv">private store</span>':''}${a.uiPort?`<a class="chip" style="color:#fff" target="_blank" href="http://${location.hostname}:${a.uiPort}">open :${a.uiPort}</a>`:''}</div>
  <div style="display:flex;gap:8px;margin-top:14px"><button onclick="act('restart')">Restart</button>${data.umbrel.configured?`<button onclick="act('stop')">Stop</button><button onclick="act('start')">Start</button>${a.updateAvailable?`<button class="primary" onclick="act('update')">Update</button>`:''}`:''}</div>
  ${i.pending?`<div class="msg warn">Pending change → v${esc(i.pending.version)}: ${esc(i.pending.status)}${i.pending.status==='waiting-for-user'?' — umbrelOS will show an Update for this app within ~5 min; click Update there (or connect the umbrelOS API in Settings for automatic updates).':''}</div>`:''}
  <div class="tabs"><button class="on" onclick="tab(this,'ov')">Overview</button><button onclick="tab(this,'env')">Environment</button><button onclick="tab(this,'logs')">Logs</button><button onclick="tab(this,'edit')">${a.private?'Edit':'Adopt'}</button></div><div id="tab"></div>`
  tab(p.querySelector('.tabs button'),'ov')}
async function act(x){try{await api(`/api/apps/${cur.a.id}/${x}`,{method:'POST'});alert(x+' requested')}catch(e){alert(e.message)}}
async function tab(btn,t){btn.parentNode.querySelectorAll('button').forEach(b=>b.classList.remove('on'));btn.classList.add('on');const el=$('#tab'),i=cur.info,a=cur.a
  if(t==='ov')el.innerHTML=`<div class="box"><table><tr><th>Container</th><th>Image</th><th>Status</th></tr>${i.containers.map(c=>`<tr><td>${esc(c.service)}<br><small style="opacity:.5">${esc(c.name)}</small></td><td><small>${esc(c.image)}</small></td><td>${stateChip(c.state)} <small>${esc(c.status)}</small></td></tr>`).join('')}</table></div>
   <div class="box"><b>Host ports</b><div class="chips">${a.ports.map(p=>`<span class="chip">${p.port}→${p.target}/${p.proto}</span>`).join('')||'<small style="opacity:.6">none (served through the Umbrel app proxy)</small>'}</div></div>
   <div class="box"><b>Mounts</b><pre>${esc(i.containers.flatMap(c=>c.mounts.map(m=>c.service+': '+m)).join('\n'))}</pre></div>`
  if(t==='env')el.innerHTML=i.containers.map(c=>`<div class="box"><b>${esc(c.service)}</b><table>${c.env.map(e=>`<tr><td><code>${esc(e.k)}</code></td><td><small>${esc(e.v)}</small></td></tr>`).join('')}</table></div>`).join('')
  if(t==='logs'){el.innerHTML='<pre>Loading…</pre>';el.innerHTML=`<button onclick="tab($('.tabs button:nth-child(3)'),'logs')">Reload</button><pre>${esc(await api(`/api/apps/${a.id}/logs?lines=300`))}</pre>`}
  if(t==='edit'){if(!a.private){el.innerHTML=`<div class="box"><p>This app comes from <b>${esc(a.source)}</b> and is read-only here.</p><p style="opacity:.75">Adopt copies its definition into your private store as a new app you can edit. Switching requires uninstalling the original (its data is deleted), so back up first.</p><button class="primary" onclick="adoptApp()">Adopt into private store</button><pre id="out" class="hidden"></pre></div>`;return}
   const man=i.manifest||'';const port=(man.match(/^port:\s*(\d+)/m)||[])[1]||''
   el.innerHTML=`<div class="box"><div class="row"><label>App port (Umbrel app proxy)<input id="uiPort" value="${esc(port)}" oninput="check()"></label><label>Change note<input id="note" placeholder="e.g. move to port 7192"></label></div>
   <p><small style="opacity:.6">docker-compose.yml — edit ports, environment, image or any value. Secrets are fine here: this store is private to your network.</small></p><textarea id="compose" oninput="check()">${esc(i.compose)}</textarea>
   <div id="issues"></div><button class="primary" onclick="saveApp()">Save, commit & update</button><pre id="out" class="hidden"></pre></div>`;check()}}
let ct;function check(){clearTimeout(ct);ct=setTimeout(async()=>{try{const r=await api(`/api/apps/${cur.a.id}/check`,{method:'POST',body:{compose:$('#compose').value,uiPort:$('#uiPort').value}});$('#issues').innerHTML=r.issues.map(x=>`<div class="msg bad">⚠ ${esc(x)}</div>`).join('')||'<div class="msg ok">No port conflicts</div>'}catch(e){$('#issues').innerHTML=`<div class="msg bad">${esc(e.message)}</div>`}},300)}
async function saveApp(force=false){const o=$('#out');o.classList.remove('hidden');o.textContent='Committing…'
  try{const r=await api(`/api/apps/${cur.a.id}/save`,{method:'POST',body:{compose:$('#compose').value,uiPort:$('#uiPort').value,note:$('#note').value,force}})
  if(!r.ok){if(confirm('Port conflicts:\n'+r.issues.join('\n')+'\n\nSave anyway?'))return saveApp(true);o.textContent='Not saved.';return}
  o.textContent=`Committed v${r.version} (${(r.commit||'').slice(0,8)}).\n${r.autoUpdate?'Harbormaster will apply the update as soon as umbrelOS sees the new version (≤5 min).':'umbrelOS will offer an Update for this app within ~5 min. Click Update in umbrelOS to apply it.'}`;data=null}catch(e){o.textContent='Error: '+e.message}}
async function adoptApp(){const o=$('#out');o.classList.remove('hidden');try{o.textContent=JSON.stringify(await api(`/api/apps/${cur.a.id}/adopt`,{method:'POST'}),null,2)}catch(e){o.textContent=e.message}}
$('#drawer').onclick=e=>{if(e.target.id==='drawer')$('#drawer').classList.add('hidden')}
render();setInterval(()=>{if(view==='apps'&&$('#drawer').classList.contains('hidden')){data=null;render()}},30000)
