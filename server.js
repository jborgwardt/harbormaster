// Harbormaster 0.2 — Arcane/Portainer-style manager for umbrelOS.
// Reads: Docker socket (containers, ports, env, logs) + optional umbreld MCP API (state, version, update).
// Writes (private store apps): commit compose/manifest to the Gitea store repo, bump version,
// then umbreld picks up the store change (polls every 5 min) and the app is updated via
// umbreld (MCP update_app if a token is configured, otherwise the Update button in umbrelOS).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

const PORT = Number(process.env.PORT || 8080)
const DATA = process.env.DATA_DIR || '/data'
const CFG_FILE = path.join(DATA, 'config.json')
const DOCKER = process.env.DOCKER_SOCK || '/var/run/docker.sock'
const PRIV_PREFIX = process.env.PRIVATE_PREFIX || 'heilpriv-'
const ENV_DEFAULTS = {
  umbrelMcpUrl: process.env.UMBREL_MCP_URL || 'http://host.docker.internal/mcp',
  umbrelToken: process.env.UMBREL_MCP_TOKEN || '',
  giteaUrl: process.env.GITEA_URL || 'http://gitea_server_1:8085',
  giteaToken: process.env.GITEA_TOKEN || '',
  storeRepo: process.env.STORE_REPO || 'heil/heilpriv-store',
  storeBranch: process.env.STORE_BRANCH || 'main',
  publicStoreRaw: process.env.PUBLIC_STORE_RAW || 'https://raw.githubusercontent.com/jborgwardt/heil-store-studio/main',
  publicPrefix: process.env.PUBLIC_PREFIX || 'heilss-',
}
fs.mkdirSync(DATA, {recursive: true})
const cfg = () => { let f = {}; try { f = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch {} ; const c = {...ENV_DEFAULTS}; for (const [k, v] of Object.entries(f)) if (v) c[k] = v; return c }
const saveCfg = (patch) => { let f = {}; try { f = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch {} ; fs.writeFileSync(CFG_FILE, JSON.stringify({...f, ...patch}, null, 2), {mode: 0o600}) }
const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---------- Docker ----------
function docker(method, p, body, raw = false) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request({socketPath: DOCKER, path: p, method, headers: data ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(data)} : {}}, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
        const b = Buffer.concat(chunks)
        if (res.statusCode >= 400) return reject(new Error(`docker ${p}: ${res.statusCode} ${b.toString().slice(0, 200)}`))
        if (raw) return resolve(b)
        try { resolve(b.length ? JSON.parse(b) : null) } catch { resolve(b.toString()) }
      })
    })
    req.on('error', reject); if (data) req.write(data); req.end()
  })
}
const listContainers = () => docker('GET', '/containers/json?all=1').catch((e) => { log('docker', e.message); return [] })
function demux(buf) { // docker log stream framing
  let out = '', i = 0
  while (i + 8 <= buf.length) { const len = buf.readUInt32BE(i + 4); out += buf.slice(i + 8, i + 8 + len).toString(); i += 8 + len }
  return out || buf.toString()
}
const projectOf = (c) => c.Labels?.['com.docker.compose.project']
function publishedPorts(list) {
  const out = []
  for (const c of list) for (const p of c.Ports || []) if (p.PublicPort && (p.IP === '0.0.0.0' || p.IP === '' || !p.IP))
    out.push({port: p.PublicPort, proto: p.Type, app: projectOf(c) || c.Names[0].slice(1), container: c.Names[0].slice(1), target: p.PrivatePort})
  return [...new Map(out.map((p) => [`${p.port}/${p.proto}/${p.app}`, p])).values()]
}

// ---------- umbreld MCP (optional) ----------
let session = null, rid = 1
async function mcpPost(c, msg) {
  const h = {'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${c.umbrelToken}`}
  if (session) h['mcp-session-id'] = session
  const r = await fetch(c.umbrelMcpUrl, {method: 'POST', headers: h, body: JSON.stringify(msg), signal: AbortSignal.timeout(20000)})
  const s = r.headers.get('mcp-session-id'); if (s) session = s
  const t = await r.text()
  if (r.status === 401) throw new Error('umbrelOS rejected the MCP token')
  if (!r.ok && r.status !== 202) throw new Error(`MCP ${r.status}`)
  if (!t) return null
  if ((r.headers.get('content-type') || '').includes('event-stream')) { const ds = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))); return ds.find((d) => d.id === msg.id) || ds.at(-1) }
  return JSON.parse(t)
}
async function tool(name, args = {}) {
  const c = cfg(); if (!c.umbrelToken) throw new Error('no-umbrel-token')
  for (let a = 0; a < 2; a++) {
    try {
      if (!session) { const r = await mcpPost(c, {jsonrpc: '2.0', id: rid++, method: 'initialize', params: {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'harbormaster', version: '0.2.1'}}}); if (r?.error) throw new Error(r.error.message); await mcpPost(c, {jsonrpc: '2.0', method: 'notifications/initialized'}) }
      const r = await mcpPost(c, {jsonrpc: '2.0', id: rid++, method: 'tools/call', params: {name, arguments: args}})
      if (r?.error) throw new Error(r.error.message)
      const txt = (r.result?.content || []).map((x) => x.text || '').join('')
      if (r.result?.isError) throw new Error(txt)
      try { return JSON.parse(txt) } catch { return txt }
    } catch (e) { if (a || e.message === 'no-umbrel-token') throw e; session = null }
  }
}

// ---------- Gitea store repo ----------
async function gitea(method, p, body) {
  const c = cfg(); if (!c.giteaToken) throw new Error('Gitea token not configured')
  const r = await fetch(`${c.giteaUrl}/api/v1${p}`, {method, headers: {authorization: `token ${c.giteaToken}`, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000)})
  if (r.status === 404 && method === 'GET') return null
  const t = await r.text(); if (!r.ok) throw new Error(`Gitea ${r.status}: ${t.slice(0, 200)}`)
  return t ? JSON.parse(t) : null
}
async function storeFile(file) {
  const c = cfg(); const f = await gitea('GET', `/repos/${c.storeRepo}/contents/${file}?ref=${c.storeBranch}`)
  return f ? {sha: f.sha, text: Buffer.from(f.content, 'base64').toString()} : null
}
async function storeApps() {
  const c = cfg(); try { const l = await gitea('GET', `/repos/${c.storeRepo}/contents/?ref=${c.storeBranch}`); return new Set((l || []).filter((x) => x.type === 'dir').map((x) => x.name)) } catch (e) { log('store', e.message); return new Set() }
}
async function commitFiles(files, message) {
  const c = cfg()
  return gitea('POST', `/repos/${c.storeRepo}/contents`, {branch: c.storeBranch, message, files: files.map((f) => ({operation: f.sha ? 'update' : 'create', path: f.path, sha: f.sha, content: Buffer.from(f.text).toString('base64')}))})
}
const manifestCache = new Map()
async function manifestFor(id, privSet) {
  if (manifestCache.has(id) && Date.now() - manifestCache.get(id).t < 120000) return manifestCache.get(id).m
  let m = null
  try {
    if (privSet.has(id)) { const f = await storeFile(`${id}/umbrel-app.yml`); m = f && YAML.parse(f.text) }
    else if (id.startsWith(cfg().publicPrefix)) { const r = await fetch(`${cfg().publicStoreRaw}/${id}/umbrel-app.yml`); if (r.ok) m = YAML.parse(await r.text()) }
    else { const r = await fetch(`https://raw.githubusercontent.com/getumbrel/umbrel-apps/master/${id}/umbrel-app.yml`); if (r.ok) { m = YAML.parse(await r.text()); m.icon ||= `https://getumbrel.github.io/umbrel-apps-gallery/${id}/icon.svg` } }
  } catch {}
  manifestCache.set(id, {t: Date.now(), m}); return m
}

// ---------- pending updates (commit -> store refresh -> update) ----------
const pending = new Map() // appId -> {version, commit, since, status}
async function pendingLoop() {
  for (const [id, p] of pending) {
    if (p.status === 'done' || p.status === 'failed') continue
    if (!cfg().umbrelToken) { p.status = 'waiting-for-user'; continue }
    try {
      const apps = await tool('list_apps'); const a = apps.find((x) => x.id === id)
      if (a?.version === p.version && a.state === 'ready') { p.status = 'done'; continue }
      if (a?.updateAvailable && a.state === 'ready' && p.status !== 'updating') { await tool('update_app', {appId: id}); p.status = 'updating'; log('update triggered', id) }
      else if (!a?.updateAvailable && p.status !== 'updating') p.status = 'waiting-for-store-refresh'
      if (Date.now() - p.since > 20 * 60000) p.status = 'failed'
    } catch (e) { p.error = e.message }
  }
}
setInterval(pendingLoop, 15000)

// ---------- overview ----------
async function overview() {
  const [list, priv] = await Promise.all([listContainers(), storeApps()])
  let umbrelApps = null, umbrelError = null
  try { umbrelApps = await tool('list_apps') } catch (e) { umbrelError = e.message === 'no-umbrel-token' ? null : e.message }
  const ids = new Set(list.map(projectOf).filter(Boolean)); umbrelApps?.forEach((a) => ids.add(a.id))
  const ports = publishedPorts(list)
  for (const id of ids) { const m = await manifestFor(id, priv); if (m?.port && !ports.some((p) => p.port === Number(m.port) && p.app === id)) ports.push({port: Number(m.port), proto: 'tcp', app: id, container: 'umbrelOS app proxy', target: 'UI'}) }
  const byPort = {}; for (const p of ports) (byPort[`${p.port}/${p.proto}`] ||= []).push(p.app)
  const conflicts = Object.entries(byPort).filter(([, a]) => new Set(a).size > 1).map(([k, a]) => ({port: k, apps: [...new Set(a)]}))
  const apps = []
  for (const id of [...ids].sort()) {
    const cs = list.filter((c) => projectOf(c) === id)
    const u = umbrelApps?.find((a) => a.id === id)
    const m = await manifestFor(id, priv)
    const running = cs.filter((c) => c.State === 'running' || /^Exited \(0\)/.test(c.Status)).length
    apps.push({id, name: u?.name || m?.name || id, version: u?.version || m?.version || '', state: u?.state || (cs.length ? (running === cs.length ? 'running' : running ? 'partial' : 'stopped') : 'unknown'),
      updateAvailable: u?.updateAvailable || false, icon: m?.icon || null, uiPort: m?.port || null, private: priv.has(id),
      source: priv.has(id) ? 'private' : id.startsWith(cfg().publicPrefix) ? 'heilss' : u || m ? 'umbrel' : 'other',
      containers: cs.map((c) => ({name: c.Names[0].slice(1), service: c.Labels['com.docker.compose.service'], state: c.State, status: c.Status, image: c.Image})),
      ports: ports.filter((p) => p.app === id), pending: pending.get(id) || null})
  }
  return {apps, conflicts, ports, umbrel: {configured: !!cfg().umbrelToken, error: umbrelError}, gitea: {configured: !!cfg().giteaToken, repo: cfg().storeRepo}}
}
async function appInfo(id) {
  const list = (await listContainers()).filter((c) => projectOf(c) === id)
  const containers = []
  for (const c of list) {
    const ins = await docker('GET', `/containers/${c.Id}/json`).catch(() => null)
    const env = (ins?.Config?.Env || []).map((e) => { const i = e.indexOf('='); const k = e.slice(0, i); const v = e.slice(i + 1); return {k, v: /SECRET|TOKEN|PASS|KEY|SEED/i.test(k) ? '••••••' : v} })
    containers.push({name: c.Names[0].slice(1), service: c.Labels['com.docker.compose.service'], image: c.Image, state: c.State, status: c.Status, env, mounts: (ins?.Mounts || []).map((m) => `${m.Source} → ${m.Destination}`), restartCount: ins?.RestartCount})
  }
  const priv = await storeApps(); let compose = null, manifest = null
  if (priv.has(id)) { compose = (await storeFile(`${id}/docker-compose.yml`))?.text; manifest = (await storeFile(`${id}/umbrel-app.yml`))?.text }
  return {id, private: priv.has(id), containers, compose, manifest, pending: pending.get(id) || null}
}
async function logs(id, lines = 200) {
  const list = (await listContainers()).filter((c) => projectOf(c) === id)
  let out = ''
  for (const c of list) { const b = await docker('GET', `/containers/${c.Id}/logs?stdout=1&stderr=1&tail=${lines}&timestamps=0`, null, true).catch(() => Buffer.from('')); out += `===== ${c.Names[0].slice(1)} =====\n${demux(b)}\n` }
  return out
}

// ---------- edit / save ----------
function bumpVersion(v) { const s = String(v ?? '1.0.0'); const m = s.match(/^(.*?)(\d+)$/); return m ? m[1] + (Number(m[2]) + 1) : `${s}.1` }
function portsFromCompose(composeText, manifestText) {
  const out = []; const c = YAML.parse(composeText); const m = YAML.parse(manifestText)
  if (m?.port) out.push({port: Number(m.port), proto: 'tcp', where: 'app (umbrel-app.yml port)'})
  for (const [svc, s] of Object.entries(c?.services || {})) for (const p of s?.ports || []) {
    const str = typeof p === 'object' ? `${p.published}:${p.target}/${p.protocol || 'tcp'}` : String(p)
    const [main, proto = 'tcp'] = str.split('/'); const parts = main.split(':')
    if (parts.length >= 2) out.push({port: Number(parts.at(-2)), proto, where: `${svc}`})
  }
  return out
}
async function checkConflicts(id, composeText, manifestText) {
  const list = await listContainers(); const priv = await storeApps()
  const used = publishedPorts(list).filter((p) => p.app !== id)
  for (const a of new Set(list.map(projectOf).filter(Boolean))) if (a !== id) { const m = await manifestFor(a, priv); if (m?.port) used.push({port: Number(m.port), proto: 'tcp', app: a}) }
  const issues = []
  let wanted; try { wanted = portsFromCompose(composeText, manifestText) } catch (e) { return [`YAML error: ${e.message}`] }
  for (const w of wanted) {
    if (!(w.port > 0 && w.port < 65536)) { issues.push(`${w.where}: invalid port ${w.port}`); continue }
    const hit = used.find((u) => u.port === w.port && u.proto === w.proto); if (hit) issues.push(`${w.port}/${w.proto} (${w.where}) is already used by ${hit.app}`)
    if ([80, 443, 2000, 8085].includes(w.port)) issues.push(`${w.port} is reserved by umbrelOS/Gitea`)
  }
  const seen = new Set(); for (const w of wanted) { const k = `${w.port}/${w.proto}`; if (seen.has(k)) issues.push(`${k} used twice in this app`); seen.add(k) }
  return issues
}
async function save(id, body) {
  const priv = await storeApps(); if (!priv.has(id)) throw new Error('Only private-store apps can be edited. Adopt it first.')
  const [cf, mf] = await Promise.all([storeFile(`${id}/docker-compose.yml`), storeFile(`${id}/umbrel-app.yml`)])
  let composeText = body.compose ?? cf.text, manifestText = mf.text
  YAML.parse(composeText) // validate
  const mdoc = YAML.parseDocument(manifestText)
  if (body.uiPort) mdoc.set('port', Number(body.uiPort))
  const issues = await checkConflicts(id, composeText, mdoc.toString())
  if (issues.length && !body.force) return {ok: false, issues}
  const oldVersion = mdoc.get('version'); const version = bumpVersion(oldVersion)
  mdoc.set('version', version)
  if (body.note) mdoc.set('releaseNotes', String(body.note))
  manifestText = mdoc.toString()
  const files = [{path: `${id}/umbrel-app.yml`, sha: mf.sha, text: manifestText}]
  if (composeText !== cf.text) files.push({path: `${id}/docker-compose.yml`, sha: cf.sha, text: composeText})
  const r = await commitFiles(files, `${id}: ${body.note || 'edit via Harbormaster'} (v${oldVersion} -> v${version})`)
  manifestCache.delete(id)
  pending.set(id, {version, commit: r?.commit?.sha, since: Date.now(), status: cfg().umbrelToken ? 'waiting-for-store-refresh' : 'waiting-for-user'})
  pendingLoop()
  return {ok: true, version, commit: r?.commit?.sha, commitUrl: r?.commit?.html_url?.replace(cfg().giteaUrl, process.env.GITEA_PUBLIC_URL || cfg().giteaUrl), autoUpdate: !!cfg().umbrelToken}
}
async function adopt(id) {
  const c = cfg(); let base
  if (id.startsWith(c.publicPrefix)) base = `${c.publicStoreRaw}/${id}`
  else base = `https://raw.githubusercontent.com/getumbrel/umbrel-apps/master/${id}`
  const newId = PRIV_PREFIX + id.replace(c.publicPrefix, '')
  if ((await storeApps()).has(newId)) throw new Error(`${newId} already exists in the private store`)
  const get = async (f) => { const r = await fetch(`${base}/${f}`); return r.ok ? r.text() : null }
  const [compose, manifest, exports] = await Promise.all([get('docker-compose.yml'), get('umbrel-app.yml'), get('exports.sh')])
  if (!compose || !manifest) throw new Error('Could not fetch the app definition from its store')
  const rep = (t) => t.replaceAll(`${id}_`, `${newId}_`).replaceAll(`APP_${id.toUpperCase().replace(/-/g, '_')}`, `APP_${newId.toUpperCase().replace(/-/g, '_')}`)
  const mdoc = YAML.parseDocument(manifest); mdoc.set('id', newId)
  if (!id.startsWith(c.publicPrefix)) { if (!mdoc.get('icon')) mdoc.set('icon', `https://getumbrel.github.io/umbrel-apps-gallery/${id}/icon.svg`); const g = mdoc.get('gallery'); if (g?.items) mdoc.set('gallery', g.items.map((x) => `https://getumbrel.github.io/umbrel-apps-gallery/${id}/${x.value ?? x}`)) }
  const files = [{path: `${newId}/docker-compose.yml`, text: rep(compose)}, {path: `${newId}/umbrel-app.yml`, text: mdoc.toString()}]
  if (exports) files.push({path: `${newId}/exports.sh`, text: rep(exports)})
  const r = await commitFiles(files, `adopt ${id} as ${newId}`)
  return {ok: true, newId, commit: r?.commit?.sha, note: `Added ${newId} to the private store. umbrelOS sees it within ~5 min. Moving over requires uninstalling ${id} (its data is deleted) and installing ${newId}; back up first.`}
}

// ---------- HTTP ----------
const json = (res, code, o) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(o)) }
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(b ? JSON.parse(b) : {}) } catch { r({}) } }) })
const MIME = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml'}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const m = u.pathname.match(/^\/api\/apps\/([\w-]+)(?:\/(\w+))?$/)
  try {
    if (u.pathname === '/api/overview') return json(res, 200, await overview())
    if (u.pathname === '/api/settings' && req.method === 'GET') { const c = cfg(); return json(res, 200, {umbrelMcpUrl: c.umbrelMcpUrl, umbrelToken: !!c.umbrelToken, giteaToken: !!c.giteaToken, storeRepo: c.storeRepo}) }
    if (u.pathname === '/api/settings' && req.method === 'POST') {
      const b = await body(req); const p = {}
      if (b.umbrelToken) p.umbrelToken = b.umbrelToken.trim(); if (b.umbrelMcpUrl) p.umbrelMcpUrl = b.umbrelMcpUrl.trim(); if (b.giteaToken) p.giteaToken = b.giteaToken.trim()
      saveCfg(p); session = null
      const t = {}; try { t.umbrel = `ok, ${(await tool('list_apps')).length} apps` } catch (e) { t.umbrel = e.message } ; try { t.gitea = (await gitea('GET', `/repos/${cfg().storeRepo}`)) ? 'ok' : 'repo not found' } catch (e) { t.gitea = e.message }
      return json(res, 200, t)
    }
    if (m && !m[2] && req.method === 'GET') return json(res, 200, await appInfo(m[1]))
    if (m && m[2] === 'logs') { res.writeHead(200, {'content-type': 'text/plain; charset=utf-8'}); return res.end(await logs(m[1], Number(u.searchParams.get('lines') || 200))) }
    if (m && m[2] === 'check' && req.method === 'POST') { const b = await body(req); const mf = await storeFile(`${m[1]}/umbrel-app.yml`); const d = YAML.parseDocument(mf.text); if (b.uiPort) d.set('port', Number(b.uiPort)); return json(res, 200, {issues: await checkConflicts(m[1], b.compose, d.toString())}) }
    if (m && m[2] === 'save' && req.method === 'POST') return json(res, 200, await save(m[1], await body(req)))
    if (m && m[2] === 'adopt' && req.method === 'POST') return json(res, 200, await adopt(m[1]))
    if (m && ['restart', 'stop', 'start', 'update'].includes(m[2]) && req.method === 'POST') {
      try { return json(res, 200, await tool(`${m[2]}_app`, {appId: m[1]})) } catch (e) {
        if (e.message !== 'no-umbrel-token' || m[2] !== 'restart') throw e
        for (const c of (await listContainers()).filter((c) => projectOf(c) === m[1])) await docker('POST', `/containers/${c.Id}/restart`)
        return json(res, 200, {ok: true, via: 'docker'})
      }
    }
    if (u.pathname.startsWith('/api/')) return json(res, 404, {error: 'not found'})
    const f = path.join(process.cwd(), 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^\/+/, ''))
    if (f.startsWith(path.join(process.cwd(), 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, {'content-type': MIME[path.extname(f)] || 'application/octet-stream'}); return fs.createReadStream(f).pipe(res) }
    res.writeHead(404); res.end()
  } catch (e) { log('error', u.pathname, e.message); json(res, 500, {error: e.message}) }
}).listen(PORT, () => log(`Harbormaster 0.2.1 on :${PORT}`))
