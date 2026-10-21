const $ = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d }
const api = async (p, o = {}) => { const r = await fetch(p, {headers: {'content-type': 'application/json'}, ...o, body: o.body ? JSON.stringify(o.body) : undefined}); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]))
const main = document.getElementById('main')
let used = {}
async function show(view) { main.innerHTML = 'Loading…'; try { view === 'setup' ? await setup() : await apps() } catch (e) { main.innerHTML = `<p class="err">${esc(e.message)}</p>` } }
async function apps() {
  const o = await api('/api/overview'); used = o.usedPorts
  document.getElementById('status').innerHTML = `Umbrel API: ${o.configured.umbrel ? '✅' : '⚠️'} · Gitea backup: ${o.configured.gitea ? '✅' : '⚠️'}`
  main.innerHTML = (o.umbrelError ? `<p class="warn">Umbrel API: ${esc(o.umbrelError)} — open Setup.</p>` : '') +
   `<p><button onclick="backupAll()">Back up all to Gitea</button> <button onclick="restoreAll()">Restore missing from Gitea</button></p>
   <table><tr><th>App</th><th>Status</th><th>Host ports</th><th>Containers</th><th></th></tr>${o.apps.map((a) => `<tr>
   <td><b>${esc(a.name)}</b><br><small>${esc(a.id)} ${a.version ? '· ' + esc(a.version) : ''}</small>${a.schema ? '<br><span class="pill">schema</span>' : ''}</td>
   <td><span class="pill ${a.state === 'ready' ? 'ready' : ''}">${esc(a.state)}</span></td>
   <td>${a.ports.map((p) => `${p.host}→${p.container}/${p.proto}`).join('<br>') || '<small>none (proxy only)</small>'}${a.aliases.map((x) => `<br><small>alias ${x.hostPort}→${esc(x.target)}</small>`).join('')}</td>
   <td>${a.containers.map((c) => `<small>${esc(c.service)}: ${esc(c.status)}</small>`).join('<br>')}</td>
   <td><button onclick="edit('${a.id}')">Edit</button></td></tr>`).join('')}</table>`
}
function envRow(e = {}, services = []) {
  return `<div class="row"><input list="svc" placeholder="service" value="${esc(e.serviceName || services[0] || '')}" class="svc"><input placeholder="NAME" value="${esc(e.name || '')}" class="nm">
  <input type="password" placeholder="value" value="${esc(e.value || '')}" class="val" onfocus="this.type='text'" onblur="this.type='password'"><button onclick="this.parentNode.remove()">✕</button></div>`
}
function aliasRow(a = {}) { return `<div class="row"><input placeholder="host port" value="${esc(a.hostPort || '')}" class="hp" oninput="chk(this)"><input placeholder="target container:port" value="${esc(a.target || '')}" class="tg"><small class="cf"></small><button onclick="this.parentNode.remove()">✕</button></div>` }
let cur
function chk(el) { const o = used[`${el.value}/tcp`]; el.parentNode.querySelector('.cf').innerHTML = o && o !== cur ? `<span class="err">in use by ${esc(o)}</span>` : '' }
async function edit(id) {
  cur = id; const d = await api(`/api/apps/${id}`); const env = d.environment; const svcs = env.services || []
  const custom = [...(env.custom || [])]
  for (const f of d.schema?.fields || []) if (!custom.some((e) => e.name === f.name)) custom.push({serviceName: f.service || svcs[0], name: f.name, value: ''})
  const docs = Object.fromEntries((d.schema?.fields || []).map((f) => [f.name, f]))
  main.innerHTML = `<h2>${esc(d.name)} <small>${esc(d.id)} · ${esc(d.state)}</small></h2>
  ${d.missing.length ? `<p class="warn">Required by schema but not set: ${d.missing.map((f) => esc(f.name)).join(', ')}</p>` : ''}
  <datalist id="svc">${svcs.map((s) => `<option>${esc(s)}</option>`).join('')}</datalist>
  <div class="card"><h3>Secrets & environment (stored by umbrelOS, survive updates)</h3><small>Services: ${svcs.map(esc).join(', ')}</small>
  <div id="env">${custom.map((e) => envRow(e, svcs) + (docs[e.name] ? `<small>${esc(docs[e.name].description || '')}</small>` : '')).join('')}</div><button onclick="document.getElementById('env').append($(envRow({}, ${esc(JSON.stringify(svcs))})))">+ variable</button>
  ${(env.exposed || []).length ? `<h4>App-declared settings</h4><div id="exp">${env.exposed.map((x) => `<div class="row"><b>${esc(x.name)}</b><small>default ${esc(x.default)}</small><input data-n="${esc(x.name)}" value="${esc(x.value ?? x.default ?? '')}"></div>`).join('')}</div>` : ''}</div>
  <div class="card"><h3>Extra host ports</h3><small>umbrelOS has no host-port override; Harbormaster publishes durable relay ports (re-applied every 5 min and on start) to a target inside the app.</small>
  <div id="al">${d.aliases.map(aliasRow).join('')}</div><button onclick="document.getElementById('al').append($(aliasRow()))">+ port</button></div>
  <p><input id="msg" placeholder="commit message (optional)"></p>
  <button class="primary" onclick="save('${id}')">Save, restart & commit</button> <button onclick="post('${id}','restore')">Restore from Gitea</button> <button onclick="post('${id}','restart')">Restart</button> <button onclick="show('apps')">Back</button>
  <pre id="out"></pre>`
}
async function save(id, force = false) {
  const customEnvironment = [...document.querySelectorAll('#env .row')].map((r) => ({serviceName: r.querySelector('.svc').value, name: r.querySelector('.nm').value.trim(), value: r.querySelector('.val').value})).filter((e) => e.name)
  const environment = [...document.querySelectorAll('#exp input')].map((i) => ({name: i.dataset.n, value: i.value}))
  const aliases = [...document.querySelectorAll('#al .row')].map((r) => ({hostPort: r.querySelector('.hp').value, target: r.querySelector('.tg').value})).filter((a) => a.hostPort)
  const out = document.getElementById('out'); out.textContent = 'Saving…'
  try {
    const r = await api(`/api/apps/${id}`, {method: 'POST', body: {customEnvironment, environment: environment.length ? environment : undefined, aliases, force, message: document.getElementById('msg').value}})
    if (!r.ok) { if (confirm('Port conflicts:\n' + r.conflicts.join('\n') + '\n\nSave anyway?')) return save(id, true); out.textContent = 'Not saved: ' + r.conflicts.join('; '); return }
    out.textContent = `Saved. umbrelOS is restarting the app. Gitea commit: ${r.commitError ? 'FAILED ' + r.commitError : r.committed ? 'yes' : 'no change'}`
  } catch (e) { out.textContent = 'Error: ' + e.message }
}
async function post(id, what) { const out = document.getElementById('out'); try { out.textContent = JSON.stringify(await api(`/api/apps/${id}/${what}`, {method: 'POST'}), null, 2) } catch (e) { out.textContent = e.message } }
async function backupAll() { alert(JSON.stringify(await api('/api/backup', {method: 'POST'}), null, 1)) }
async function restoreAll() { await api('/api/restore', {method: 'POST'}); alert('Restore pass done') }
async function setup() {
  const c = await api('/api/config')
  main.innerHTML = `<div class="card"><h3>umbrelOS API (MCP)</h3><small>In umbrelOS Settings → MCP / AI agents, enable MCP, grant <b>all apps</b>, and create a token labelled “Harbormaster”. Paste it here. Stored only in this app's data dir (chmod 600).</small>
  <p>Endpoint <input id="umbrelMcpUrl" value="${esc(c.umbrelMcpUrl)}"></p><p>Token <input id="umbrelToken" type="password" value="${esc(c.umbrelToken)}"></p></div>
  <div class="card"><h3>Private Gitea backup repo</h3><p>Gitea URL <input id="giteaUrl" value="${esc(c.giteaUrl)}"></p><p>Repo (owner/name) <input id="giteaRepo" value="${esc(c.giteaRepo)}"></p><p>Access token (repo read/write) <input id="giteaToken" type="password" value="${esc(c.giteaToken)}"></p>
  <p><label><input type="checkbox" id="autoRestore" style="width:auto" ${c.autoRestore ? 'checked' : ''}> Auto-restore missing secrets after (re)install</label></p></div>
  <div class="card"><h3>Public schemas</h3><p>Base URL <input id="schemaBaseUrl" value="${esc(c.schemaBaseUrl)}"></p><small>Reads &lt;base&gt;/&lt;app-id&gt;/harbormaster.schema.json (field names only).</small></div>
  <button class="primary" onclick="saveCfg()">Save & test</button><pre id="out"></pre>`
}
async function saveCfg() {
  const b = {}; for (const k of ['umbrelMcpUrl', 'umbrelToken', 'giteaUrl', 'giteaRepo', 'giteaToken', 'schemaBaseUrl']) b[k] = document.getElementById(k).value
  b.autoRestore = document.getElementById('autoRestore').checked
  document.getElementById('out').textContent = JSON.stringify(await api('/api/config', {method: 'POST', body: b}), null, 2)
}
show('apps')
