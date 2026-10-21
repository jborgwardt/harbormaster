// Harbormaster: settings, secrets & ports manager for umbrelOS.
// Writes go through umbreld's own MCP API (set_app_settings -> settings.yml +
// docker-compose.umbrel-user-settings.yml, which umbreld re-applies on every
// start/update). Reads of ports/status come from the Docker socket.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

const PORT = Number(process.env.PORT || 8080)
const DATA = process.env.DATA_DIR || '/data'
const CFG_FILE = path.join(DATA, 'config.json')
const DOCKER = process.env.DOCKER_SOCK || '/var/run/docker.sock'
const SELF = process.env.APP_ID || 'heilss-harbormaster'
const RELAY_IMAGE = process.env.RELAY_IMAGE || 'alpine/socat:1.8.0.3'
const DEFAULTS = {
  umbrelMcpUrl: process.env.UMBREL_MCP_URL || 'http://host.docker.internal/mcp',
  umbrelToken: '',
  giteaUrl: process.env.GITEA_URL || 'http://gitea_server_1:8085',
  giteaToken: '', giteaRepo: process.env.GITEA_REPO || '',
  schemaBaseUrl: process.env.SCHEMA_BASE_URL || 'https://raw.githubusercontent.com/jborgwardt/heil-store-studio/main',
  autoRestore: true,
}
fs.mkdirSync(DATA, {recursive: true})
const loadCfg = () => { try { return {...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))} } catch { return {...DEFAULTS} } }
const saveCfg = (c) => { fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2), {mode: 0o600}); fs.chmodSync(CFG_FILE, 0o600) }
const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---------- Docker (unix socket) ----------
function docker(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request({socketPath: DOCKER, path: p, method, headers: data ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(data)} : {}}, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`docker ${p}: ${res.statusCode} ${b}`))
        try { resolve(b ? JSON.parse(b) : null) } catch { resolve(b) }
      })
    })
    req.on('error', reject); if (data) req.write(data); req.end()
  })
}
async function containers() {
  try { return await docker('GET', '/containers/json?all=1') } catch (e) { log('docker unavailable', e.message); return [] }
}
function usedPorts(list) {
  const m = new Map()
  for (const c of list) for (const p of c.Ports || []) if (p.PublicPort) {
    const owner = c.Labels?.['com.docker.compose.project'] || c.Labels?.['harbormaster.relay.app'] || c.Names[0].slice(1)
    m.set(`${p.PublicPort}/${p.Type}`, owner)
  }
  return m
}

// ---------- umbreld MCP client (streamable HTTP, JSON-RPC) ----------
let mcpSession = null, rpcId = 1
async function mcpPost(cfg, msg) {
  const headers = {'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${cfg.umbrelToken}`}
  if (mcpSession) headers['mcp-session-id'] = mcpSession
  const r = await fetch(cfg.umbrelMcpUrl, {method: 'POST', headers, body: JSON.stringify(msg)})
  const sid = r.headers.get('mcp-session-id'); if (sid) mcpSession = sid
  const text = await r.text()
  if (r.status === 401) throw new Error('Umbrel rejected the MCP token (401)')
  if (!r.ok && r.status !== 202) throw new Error(`MCP HTTP ${r.status}: ${text.slice(0, 200)}`)
  if (!text) return null
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
    return datas.find((d) => d.id === msg.id) || datas.at(-1)
  }
  return JSON.parse(text)
}
async function mcpInit(cfg) {
  mcpSession = null
  const r = await mcpPost(cfg, {jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'harbormaster', version: '0.1.0'}}})
  if (r?.error) throw new Error(r.error.message)
  await mcpPost(cfg, {jsonrpc: '2.0', method: 'notifications/initialized'})
}
async function tool(name, args = {}) {
  const cfg = loadCfg(); if (!cfg.umbrelToken) throw new Error('Umbrel MCP token not configured (Setup tab)')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!mcpSession) await mcpInit(cfg)
      const r = await mcpPost(cfg, {jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: {name, arguments: args}})
      if (r?.error) throw new Error(r.error.message)
      const txt = (r.result?.content || []).map((c) => c.text || '').join('')
      if (r.result?.isError) throw new Error(txt)
      try { return JSON.parse(txt) } catch { return txt }
    } catch (e) { if (attempt) throw e; mcpSession = null }
  }
}

// ---------- Gitea private repo (contents API) ----------
async function gitea(method, p, body) {
  const cfg = loadCfg(); if (!cfg.giteaToken || !cfg.giteaRepo) throw new Error('Gitea not configured (Setup tab)')
  const r = await fetch(`${cfg.giteaUrl}/api/v1${p}`, {method, headers: {authorization: `token ${cfg.giteaToken}`, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined})
  if (r.status === 404 && method === 'GET') return null
  const t = await r.text(); if (!r.ok) throw new Error(`Gitea ${method} ${p}: ${r.status} ${t.slice(0, 200)}`)
  return t ? JSON.parse(t) : null
}
async function repoGet(file) {
  const cfg = loadCfg(); const f = await gitea('GET', `/repos/${cfg.giteaRepo}/contents/${file}`)
  return f ? {sha: f.sha, text: Buffer.from(f.content, 'base64').toString('utf8')} : null
}
async function repoPut(file, text, message) {
  const cfg = loadCfg(); const cur = await repoGet(file)
  if (cur && cur.text === text) return false
  await gitea(cur ? 'PUT' : 'POST', `/repos/${cfg.giteaRepo}/contents/${file}`, {content: Buffer.from(text).toString('base64'), message, sha: cur?.sha})
  return true
}
async function repoList(dir) {
  const cfg = loadCfg(); const r = await gitea('GET', `/repos/${cfg.giteaRepo}/contents/${dir}`); return Array.isArray(r) ? r : []
}

// secret.env: "service.KEY=value" lines (values escaped as JSON strings when needed)
const encVal = (v) => (/^[A-Za-z0-9_\-.:/@+=,]*$/.test(v) ? v : JSON.stringify(v))
const decVal = (v) => (v.startsWith('"') ? JSON.parse(v) : v)
function toSecretEnv(appId, custom) {
  return `# ${appId} - managed by Harbormaster. PRIVATE: never push to a public remote.\n` +
    custom.map((e) => `${e.serviceName}.${e.name}=${encVal(e.value)}`).join('\n') + '\n'
}
function fromSecretEnv(text) {
  return text.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='), k = l.slice(0, i), d = k.indexOf('.')
    return {serviceName: k.slice(0, d), name: k.slice(d + 1), value: decVal(l.slice(i + 1))}
  })
}
async function snapshot(appId, reason) {
  const d = await tool('get_app_details', {appId})
  const custom = d.settings?.environment?.custom || []
  const exposed = (d.settings?.environment?.exposed || []).filter((e) => e.value !== undefined && e.value !== e.default).map((e) => ({name: e.name, value: e.value}))
  const settings = {appId, version: d.version, appProxyAuthEnabled: d.settings?.appProxyAuth?.override ?? null,
    environment: exposed, portAliases: loadCfg().portAliases?.[appId] || [], updatedAt: new Date().toISOString()}
  const a = await repoPut(`apps/${appId}/secret.env`, toSecretEnv(appId, custom), `${appId}: ${reason} (secret.env)`)
  const b = await repoPut(`apps/${appId}/settings.json`, JSON.stringify(settings, null, 2) + '\n', `${appId}: ${reason} (settings)`)
  return a || b
}

// ---------- Port aliases (durable, re-applied relay containers) ----------
const relayName = (appId, hostPort) => `harbormaster-relay-${appId}-${hostPort}`
async function ensureRelay(appId, a) {
  const name = relayName(appId, a.hostPort)
  try { const c = await docker('GET', `/containers/${name}/json`); if (c.State.Running) return; await docker('POST', `/containers/${name}/start`); return } catch {}
  try { await docker('POST', `/images/create?fromImage=${encodeURIComponent(RELAY_IMAGE)}`) } catch (e) { log('pull', e.message) }
  await docker('POST', `/containers/create?name=${name}`, {Image: RELAY_IMAGE,
    Cmd: [`TCP-LISTEN:${a.hostPort},fork,reuseaddr`, `TCP:${a.target}`],
    Labels: {'harbormaster.relay.app': appId}, ExposedPorts: {[`${a.hostPort}/tcp`]: {}},
    HostConfig: {PortBindings: {[`${a.hostPort}/tcp`]: [{HostPort: String(a.hostPort)}]}, RestartPolicy: {Name: 'unless-stopped'}, NetworkMode: 'umbrel_main_network'}})
  await docker('POST', `/containers/${name}/start`)
}
async function removeRelay(appId, hostPort) { try { await docker('DELETE', `/containers/${relayName(appId, hostPort)}?force=1`) } catch {} }
async function reconcileRelays() {
  const cfg = loadCfg()
  for (const [appId, list] of Object.entries(cfg.portAliases || {})) for (const a of list) {
    try { await ensureRelay(appId, a) } catch (e) { log('relay', appId, e.message) }
  }
}

// ---------- Public schemas (field names only, never values) ----------
const schemaCache = new Map()
async function schemaFor(appId) {
  if (schemaCache.has(appId) && Date.now() - schemaCache.get(appId).t < 300000) return schemaCache.get(appId).s
  let s = null
  try { const r = await fetch(`${loadCfg().schemaBaseUrl}/${appId}/harbormaster.schema.json`); if (r.ok) s = await r.json() } catch {}
  schemaCache.set(appId, {t: Date.now(), s}); return s
}

// ---------- Restore from Gitea ----------
async function restoreApp(appId, {force = false} = {}) {
  const f = await repoGet(`apps/${appId}/secret.env`); if (!f) return {appId, skipped: 'nothing in repo'}
  const wanted = fromSecretEnv(f.text)
  const d = await tool('get_app_details', {appId})
  const cur = d.settings?.environment?.custom || []
  const key = (e) => `${e.serviceName}.${e.name}`
  const merged = new Map(cur.map((e) => [key(e), e]))
  let changed = false
  for (const w of wanted) { const c = merged.get(key(w)); if (!c || (force ? c.value !== w.value : !c.value)) { merged.set(key(w), w); changed = true } }
  const sf = await repoGet(`apps/${appId}/settings.json`)
  const st = sf ? JSON.parse(sf.text) : {}
  if (st.portAliases?.length) { const cfg = loadCfg(); cfg.portAliases = {...(cfg.portAliases || {}), [appId]: st.portAliases}; saveCfg(cfg) }
  if (!changed) return {appId, skipped: 'already up to date'}
  const args = {appId, customEnvironment: [...merged.values()]}
  if (st.environment?.length) args.environment = st.environment
  await tool('set_app_settings', args)
  return {appId, restored: wanted.length}
}
async function autoRestore() {
  const cfg = loadCfg(); if (!cfg.autoRestore || !cfg.umbrelToken || !cfg.giteaToken) return
  try {
    const apps = await tool('list_apps'); const ids = new Set(apps.filter((a) => a.state === 'ready').map((a) => a.id))
    for (const d of await repoList('apps')) if (d.type === 'dir' && ids.has(d.name) && d.name !== SELF) {
      try { const r = await restoreApp(d.name); if (r.restored) log('auto-restored', r) } catch (e) { log('restore', d.name, e.message) }
    }
  } catch (e) { log('autoRestore', e.message) }
}

// ---------- API ----------
async function overview() {
  const cfg = loadCfg(); const list = await containers(); const used = usedPorts(list)
  let apps = [], umbrelError = null
  try { apps = await tool('list_apps') } catch (e) { umbrelError = e.message }
  if (!apps.length) { // docker-only fallback
    const ids = [...new Set(list.map((c) => c.Labels?.['com.docker.compose.project']).filter(Boolean))]
    apps = ids.map((id) => ({id, name: id, state: 'unknown (no Umbrel token)'}))
  }
  const out = []
  for (const a of apps) {
    const cs = list.filter((c) => c.Labels?.['com.docker.compose.project'] === a.id)
    const ports = cs.flatMap((c) => (c.Ports || []).filter((p) => p.PublicPort).map((p) => ({host: p.PublicPort, container: p.PrivatePort, proto: p.Type, service: c.Labels['com.docker.compose.service']})))
    const uniq = [...new Map(ports.map((p) => [`${p.host}/${p.proto}`, p])).values()]
    const schema = await schemaFor(a.id)
    out.push({...a, ports: uniq, aliases: cfg.portAliases?.[a.id] || [], containers: cs.map((c) => ({name: c.Names[0].slice(1), state: c.State, status: c.Status, service: c.Labels['com.docker.compose.service']})), schema: schema ? true : false})
  }
  return {apps: out, umbrelError, configured: {umbrel: !!cfg.umbrelToken, gitea: !!(cfg.giteaToken && cfg.giteaRepo)}, usedPorts: Object.fromEntries(used)}
}
async function appDetail(appId) {
  const d = await tool('get_app_details', {appId}); const schema = await schemaFor(appId)
  const env = d.settings?.environment || {}
  const missing = (schema?.fields || []).filter((f) => f.required && !(env.custom || []).some((e) => e.name === f.name && e.value))
  return {id: d.id, name: d.name, state: d.state, url: d.url, environment: env, appProxyAuth: d.settings?.appProxyAuth, schema, missing, aliases: loadCfg().portAliases?.[appId] || []}
}
async function saveApp(appId, body) {
  const cfg = loadCfg(); const list = await containers(); const used = usedPorts(list)
  // port conflict check
  const aliases = (body.aliases || []).map((a) => ({hostPort: Number(a.hostPort), target: String(a.target)}))
  const conflicts = []
  for (const a of aliases) {
    if (!(a.hostPort > 0 && a.hostPort < 65536)) conflicts.push(`${a.hostPort}: invalid port`)
    const owner = used.get(`${a.hostPort}/tcp`)
    if (owner && owner !== appId) conflicts.push(`${a.hostPort}/tcp already used by ${owner}`)
    if (!/^[\w.-]+:\d+$/.test(a.target)) conflicts.push(`${a.target}: target must be host:port`)
  }
  if (aliases.length !== new Set(aliases.map((a) => a.hostPort)).size) conflicts.push('duplicate host port')
  if (conflicts.length && !body.force) return {ok: false, conflicts}
  const args = {appId}
  if (body.customEnvironment) args.customEnvironment = body.customEnvironment.filter((e) => e.name && e.serviceName).map((e) => ({serviceName: e.serviceName, name: e.name, value: String(e.value ?? '')}))
  if (body.environment) args.environment = body.environment
  if (args.customEnvironment || args.environment) await tool('set_app_settings', args)
  const old = cfg.portAliases?.[appId] || []
  for (const o of old) if (!aliases.some((a) => a.hostPort === o.hostPort && a.target === o.target)) await removeRelay(appId, o.hostPort)
  cfg.portAliases = {...(cfg.portAliases || {}), [appId]: aliases}; if (!aliases.length) delete cfg.portAliases[appId]; saveCfg(cfg)
  for (const a of aliases) await ensureRelay(appId, a)
  let committed = null, commitError = null
  try { committed = await snapshot(appId, body.message || 'update via Harbormaster') } catch (e) { commitError = e.message }
  return {ok: true, committed, commitError}
}
async function testConnections() {
  const res = {}
  try { const a = await tool('list_apps'); res.umbrel = `ok (${a.length} apps)` } catch (e) { res.umbrel = e.message }
  try { const cfg = loadCfg(); const r = await gitea('GET', `/repos/${cfg.giteaRepo}`); res.gitea = r ? `ok (${r.full_name}, private=${r.private})` : 'repo not found' } catch (e) { res.gitea = e.message }
  try { await docker('GET', '/_ping'); res.docker = 'ok' } catch (e) { res.docker = e.message }
  return res
}

const json = (res, code, obj) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(obj)) }
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(b ? JSON.parse(b) : {}) } catch { r({}) } }) })
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const m = u.pathname.match(/^\/api\/apps\/([\w-]+)(\/\w+)?$/)
  try {
    if (u.pathname === '/api/overview') return json(res, 200, await overview())
    if (u.pathname === '/api/config' && req.method === 'GET') { const c = loadCfg(); return json(res, 200, {...c, umbrelToken: c.umbrelToken ? '••••' : '', giteaToken: c.giteaToken ? '••••' : ''}) }
    if (u.pathname === '/api/config' && req.method === 'POST') {
      const b = await readBody(req); const c = loadCfg()
      for (const k of ['umbrelMcpUrl', 'giteaUrl', 'giteaRepo', 'schemaBaseUrl']) if (typeof b[k] === 'string' && b[k]) c[k] = b[k].trim()
      for (const k of ['umbrelToken', 'giteaToken']) if (b[k] && b[k] !== '••••') c[k] = b[k].trim()
      if (typeof b.autoRestore === 'boolean') c.autoRestore = b.autoRestore
      saveCfg(c); mcpSession = null; return json(res, 200, await testConnections())
    }
    if (u.pathname === '/api/test') return json(res, 200, await testConnections())
    if (u.pathname === '/api/restore' && req.method === 'POST') { await autoRestore(); return json(res, 200, {ok: true}) }
    if (u.pathname === '/api/backup' && req.method === 'POST') {
      const apps = await tool('list_apps'); const out = []
      for (const a of apps) { try { const d = await tool('get_app_details', {appId: a.id}); if ((d.settings?.environment?.custom || []).length || loadCfg().portAliases?.[a.id]) out.push({id: a.id, committed: await snapshot(a.id, 'full backup')}) } catch (e) { out.push({id: a.id, error: e.message}) } }
      return json(res, 200, out)
    }
    if (m && !m[2] && req.method === 'GET') return json(res, 200, await appDetail(m[1]))
    if (m && !m[2] && req.method === 'POST') return json(res, 200, await saveApp(m[1], await readBody(req)))
    if (m && m[2] === '/restart' && req.method === 'POST') return json(res, 200, await tool('restart_app', {appId: m[1]}))
    if (m && m[2] === '/restore' && req.method === 'POST') return json(res, 200, await restoreApp(m[1], {force: true}))
    if (m && m[2] === '/logs') return json(res, 200, await tool('get_app_logs', {appId: m[1], lines: 100}))
    if (u.pathname.startsWith('/api/')) return json(res, 404, {error: 'not found'})
    const f = path.join(process.cwd(), 'public', u.pathname === '/' ? 'index.html' : path.basename(u.pathname))
    if (fs.existsSync(f)) { res.writeHead(200, {'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html'}); return fs.createReadStream(f).pipe(res) }
    res.writeHead(404); res.end()
  } catch (e) { log('error', u.pathname, e.message); json(res, 500, {error: e.message}) }
}).listen(PORT, () => log(`Harbormaster on :${PORT}`))

setTimeout(() => { reconcileRelays(); autoRestore() }, 15000)
setInterval(() => { reconcileRelays(); autoRestore() }, 5 * 60 * 1000)
