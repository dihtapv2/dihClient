const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path'), fs = require('fs'), crypto = require('crypto'), zlib = require('zlib');
const { spawnSync } = require('child_process');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const UA = { 'User-Agent': 'BlockHubLauncher/1.1 (hobby project)' };
const MR = 'https://api.modrinth.com/v2';
const META = { fabric: 'https://meta.fabricmc.net/v2', quilt: 'https://meta.quiltmc.org/v3' };
const FOLDER = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const DEF_THEME = { accent: '#3b82f6', bgMode: 'preset', preset: 0, bgUrl: '', bgFile: '', blur: 0, dim: 45, glass: true };

let win, ROOT, MC, INST, JAVA, CFG_FILE, cfg = {}, logs = [], current = null;
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);
const J = async (u) => { const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error(`Fehler ${r.status}: ${u}`); return r.json(); };
const saveCfg = () => fs.writeFileSync(CFG_FILE, JSON.stringify(cfg));
const theme = () => ({ ...DEF_THEME, ...(cfg.theme || {}) });
const pushLog = (t) => { const s = String(t).trimEnd(); if (!s) return; logs.push(s); if (logs.length > 3000) logs.splice(0, 500); send('log', s); };

async function getBuf(url, sha1) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha1 && crypto.createHash('sha1').update(buf).digest('hex') !== sha1) throw new Error('Hash-Fehler: ' + url.split('/').pop());
  return buf;
}
async function download(url, dest, sha1) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, await getBuf(url, sha1));
}
async function pool(items, n, fn) {
  let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) await fn(items[k++]); }));
}
function safeJoin(base, rel) {
  const b = path.resolve(base), p = path.resolve(b, rel);
  if (p !== b && !p.startsWith(b + path.sep)) throw new Error('Ungültiger Pfad im Modpack');
  return p;
}

// ---------- Minimaler ZIP-Leser (für .mrpack, ohne Zusatzpakete) ----------
function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Ungültige ZIP-Datei');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const list = [];
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    list.push({ name, data: () => {
      const s = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const raw = buf.subarray(s, s + csize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    } });
    p += 46 + nl + xl + cl;
  }
  return list;
}

// ---------- Java (wird automatisch geladen) ----------
function findJava(dir) {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (e.name === exe && path.basename(d) === 'bin') return p;
    }
  };
  return walk(dir);
}
async function ensureJava(mc) {
  const [, minor = 0, patch = 0] = mc.split('.').map(Number);
  const major = (minor > 20 || (minor === 20 && patch >= 5)) ? 21 : minor >= 17 ? 17 : 8;
  const dir = path.join(JAVA, String(major));
  let j = findJava(dir);
  if (j) return j;
  send('status', `Lade Java ${major} ...`);
  const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const zip = process.platform === 'win32';
  const file = path.join(JAVA, `jre${major}.${zip ? 'zip' : 'tar.gz'}`);
  await download(`https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`, file);
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('tar', ['-xf', file, '-C', dir]);
  fs.unlinkSync(file);
  j = findJava(dir);
  if (!j) throw new Error('Java-Installation fehlgeschlagen');
  if (!zip) fs.chmodSync(j, 0o755);
  return j;
}

// ---------- Fabric / Quilt ----------
async function ensureLoader(i) {
  const base = META[i.loader];
  const lv = i.loaderVersion || (await J(`${base}/versions/loader/${i.mc}`))[0].loader.version;
  const id = `${i.loader}-loader-${lv}-${i.mc}`;
  const f = path.join(MC, 'versions', id, `${id}.json`);
  if (!fs.existsSync(f)) {
    send('status', `Lade ${i.loader === 'quilt' ? 'Quilt' : 'Fabric'} ...`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(await J(`${base}/versions/loader/${i.mc}/${lv}/profile/json`)));
  }
  return id;
}

// ---------- Instanzen ----------
const iDir = (id) => path.join(INST, path.basename(id));
const readInst = (id) => JSON.parse(fs.readFileSync(path.join(iDir(id), 'instance.json')));
const writeInst = (i) => fs.writeFileSync(path.join(iDir(i.id), 'instance.json'), JSON.stringify(i));
const listInst = () => fs.readdirSync(INST).filter((d) => fs.existsSync(path.join(INST, d, 'instance.json'))).map((d) => readInst(d));
function makeInst({ name, mc, loader, ram = 4096, loaderVersion }) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'instanz';
  const id = `${slug}-${Date.now().toString(36)}`;
  Object.values(FOLDER).forEach((f) => fs.mkdirSync(path.join(iDir(id), f), { recursive: true }));
  const inst = { id, name, mc, loader, ram, playtime: 0 };
  if (loaderVersion) inst.loaderVersion = loaderVersion;
  writeInst(inst);
  return inst;
}
ipcMain.handle('versions:list', async () =>
  (await J('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')).versions.filter((v) => v.type === 'release').map((v) => v.id));
ipcMain.handle('inst:list', () => listInst());
ipcMain.handle('inst:create', (e, a) => makeInst(a));
ipcMain.handle('inst:delete', (e, id) => fs.rmSync(iDir(id), { recursive: true, force: true }));
ipcMain.handle('inst:duplicate', (e, id) => {
  const src = readInst(id);
  const n = makeInst({ name: src.name + ' (Kopie)', mc: src.mc, loader: src.loader, ram: src.ram, loaderVersion: src.loaderVersion });
  fs.cpSync(iDir(id), iDir(n.id), { recursive: true });
  const copy = { ...readInst(id), id: n.id, name: n.name, playtime: 0 };
  writeInst(copy);
  return copy;
});
ipcMain.handle('inst:update', (e, { id, patch }) => {
  const ok = ['name', 'ram', 'jvm', 'width', 'height', 'fullscreen', 'server'];
  const i = readInst(id);
  for (const k of ok) if (k in patch) i[k] = patch[k];
  writeInst(i);
  return i;
});
ipcMain.handle('inst:folder', (e, id) => shell.openPath(iDir(id)));
ipcMain.handle('data:folder', () => shell.openPath(ROOT));

// ---------- Inhalte (Modrinth): Mods, Resourcepacks, Shader, Modpacks ----------
ipcMain.handle('content:search', async (e, { id, q, type }) => {
  const facets = [[`project_type:${type}`]];
  if (type === 'modpack') facets.push(['categories:fabric', 'categories:quilt']);
  else {
    const i = readInst(id);
    facets.push([`versions:${i.mc}`]);
    if (type === 'mod') facets.push(i.loader === 'quilt' ? ['categories:quilt', 'categories:fabric'] : ['categories:fabric']);
  }
  const p = new URLSearchParams({ query: q || '', facets: JSON.stringify(facets), limit: 30, index: q ? 'relevance' : 'downloads' });
  return (await J(`${MR}/search?${p}`)).hits;
});
async function pickVersion(pid, i, type) {
  const p = new URLSearchParams({ game_versions: JSON.stringify([i.mc]) });
  if (type === 'mod') p.set('loaders', JSON.stringify(i.loader === 'quilt' ? ['quilt', 'fabric'] : ['fabric']));
  const vs = await J(`${MR}/project/${pid}/version?${p}`);
  if (!vs.length) throw new Error('Keine passende Version für diese Minecraft-Version gefunden');
  return vs[0];
}
async function installContent(pid, i, type, done = new Set()) {
  if (done.has(pid)) return [];
  done.add(pid);
  const v = await pickVersion(pid, i, type);
  const f = v.files.find((x) => x.primary) || v.files[0];
  await download(f.url, path.join(iDir(i.id), FOLDER[type], path.basename(f.filename)), f.hashes.sha1);
  let out = [f.filename];
  if (type === 'mod')
    for (const d of v.dependencies)
      if (d.dependency_type === 'required' && d.project_id)
        try { out = out.concat(await installContent(d.project_id, i, type, done)); } catch {}
  return out;
}
ipcMain.handle('content:install', (e, { id, pid, type }) => installContent(pid, readInst(id), type));
ipcMain.handle('content:list', (e, { id, type }) => {
  const d = path.join(iDir(id), FOLDER[type]);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => fs.statSync(path.join(d, f)).isFile()) : [];
});
ipcMain.handle('content:remove', (e, { id, type, file }) => fs.rmSync(path.join(iDir(id), FOLDER[type], path.basename(file)), { force: true }));
ipcMain.handle('content:toggle', (e, { id, type, file }) => {
  const d = path.join(iDir(id), FOLDER[type]), f = path.basename(file);
  const to = f.endsWith('.disabled') ? f.slice(0, -9) : f + '.disabled';
  fs.renameSync(path.join(d, f), path.join(d, to));
  return to;
});

ipcMain.handle('pack:install', async (e, { pid, title }) => {
  send('status', 'Lade Modpack ...');
  const vs = await J(`${MR}/project/${pid}/version`);
  if (!vs.length) throw new Error('Keine Version gefunden');
  const f = vs[0].files.find((x) => x.primary) || vs[0].files[0];
  const zip = readZip(await getBuf(f.url, f.hashes.sha1));
  const ix = zip.find((z) => z.name === 'modrinth.index.json');
  if (!ix) throw new Error('Kein gültiges Modrinth-Modpack');
  const idx = JSON.parse(ix.data().toString('utf8')), dep = idx.dependencies || {};
  const loader = dep['fabric-loader'] ? 'fabric' : dep['quilt-loader'] ? 'quilt' : null;
  if (!loader) throw new Error('Nur Fabric- und Quilt-Modpacks werden unterstützt');
  const inst = makeInst({ name: title || idx.name, mc: dep.minecraft, loader, loaderVersion: dep[loader + '-loader'] });
  const files = (idx.files || []).filter((x) => !(x.env && x.env.client === 'unsupported'));
  let n = 0;
  await pool(files, 6, async (x) => {
    await download(x.downloads[0], safeJoin(iDir(inst.id), x.path), x.hashes && x.hashes.sha1);
    send('status', `Modpack: ${++n}/${files.length} Dateien`); send('progress', Math.round((n / files.length) * 100));
  });
  for (const z of zip) {
    const m = z.name.match(/^(?:client-)?overrides\/(.+)$/);
    if (!m || z.name.endsWith('/')) continue;
    const dest = safeJoin(iDir(inst.id), m[1]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, z.data());
  }
  send('status', 'Bereit'); send('progress', 0);
  return inst;
});

// ---------- Design / Hintergrund ----------
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function bgData() {
  const t = theme();
  if (t.bgMode !== 'image' || !t.bgFile) return null;
  const f = path.join(ROOT, t.bgFile);
  if (!fs.existsSync(f)) return null;
  return `data:${MIME[path.extname(f).slice(1).toLowerCase()] || 'image/png'};base64,` + fs.readFileSync(f).toString('base64');
}
ipcMain.handle('cfg:get', () => ({ theme: theme(), bg: bgData() }));
ipcMain.handle('cfg:set', (e, patch) => { cfg.theme = { ...theme(), ...patch }; saveCfg(); return { theme: theme(), bg: bgData() }; });
ipcMain.handle('bg:pick', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Bilder', extensions: Object.keys(MIME) }], properties: ['openFile'] });
  if (r.canceled) return null;
  const ext = path.extname(r.filePaths[0]).toLowerCase(), name = 'background' + ext;
  const old = theme().bgFile; if (old && old !== name) fs.rmSync(path.join(ROOT, old), { force: true });
  fs.copyFileSync(r.filePaths[0], path.join(ROOT, name));
  cfg.theme = { ...theme(), bgMode: 'image', bgFile: name }; saveCfg();
  return { theme: theme(), bg: bgData() };
});

// ---------- News ----------
ipcMain.handle('news:get', async () => {
  const d = await J('https://launchercontent.mojang.com/v2/javaPatchNotes.json');
  const img = (e) => e.image && e.image.url ? (e.image.url.startsWith('http') ? e.image.url : 'https://launchercontent.mojang.com' + (e.image.url.startsWith('/') ? '' : '/') + e.image.url) : '';
  return (d.entries || []).slice(0, 9).map((e) => ({ title: e.title, version: e.version, type: e.type, text: e.shortText, img: img(e) }));
});
ipcMain.handle('log:get', () => logs);
ipcMain.handle('log:clear', () => { logs = []; });

// ---------- Fenster ----------
ipcMain.handle('win:min', () => win.minimize());
ipcMain.handle('win:max', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.handle('win:close', () => win.close());

// ---------- Accounts (Microsoft, mehrere) ----------
const acct = () => (cfg.accounts || []).find((a) => a.id === cfg.active);
const pubAcc = () => ({ accounts: (cfg.accounts || []).map((a) => ({ id: a.id, name: a.name })), active: cfg.active });
ipcMain.handle('auth:list', () => pubAcc());
ipcMain.handle('auth:switch', (e, id) => { cfg.active = id; saveCfg(); return pubAcc(); });
ipcMain.handle('auth:logout', (e, id) => {
  cfg.accounts = (cfg.accounts || []).filter((a) => a.id !== id);
  if (cfg.active === id) cfg.active = cfg.accounts[0] && cfg.accounts[0].id;
  saveCfg(); return pubAcc();
});
ipcMain.handle('auth:login', async () => {
  const xbox = await new Auth('select_account').launch('electron');
  const t = await xbox.getMinecraft();
  const id = t.profile.id || t.profile.name;
  cfg.accounts = (cfg.accounts || []).filter((a) => a.id !== id).concat({ id, name: t.profile.name, refresh: xbox.save() });
  cfg.active = id; saveCfg();
  return pubAcc();
});
async function freshAuth() {
  const a = acct();
  if (!a) throw new Error('Nicht angemeldet');
  const xbox = await new Auth('select_account').refresh(a.refresh);
  const t = await xbox.getMinecraft();
  a.refresh = xbox.save(); saveCfg();
  return t.mclc();
}
ipcMain.handle('skin:upload', async (e, variant) => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Skin (PNG)', extensions: ['png'] }], properties: ['openFile'] });
  if (r.canceled) return false;
  const auth = await freshAuth();
  const fd = new FormData();
  fd.append('variant', variant === 'slim' ? 'slim' : 'classic');
  fd.append('file', new Blob([fs.readFileSync(r.filePaths[0])], { type: 'image/png' }), 'skin.png');
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', { method: 'POST', headers: { Authorization: 'Bearer ' + auth.access_token }, body: fd });
  if (!res.ok) throw new Error(`Skin-Upload fehlgeschlagen (${res.status})`);
  return true;
});

// ---------- Spielen ----------
ipcMain.handle('game:play', async (e, id) => {
  if (current) throw new Error('Es läuft bereits ein Spiel');
  const i = readInst(id);
  send('status', 'Anmeldung ...');
  const authorization = await freshAuth();
  const javaPath = await ensureJava(i.mc);
  const version = { number: i.mc, type: 'release' };
  if (i.loader === 'fabric' || i.loader === 'quilt') version.custom = await ensureLoader(i);
  const opts = {
    authorization, root: MC, javaPath, version,
    memory: { max: `${i.ram}M`, min: '512M' },
    overrides: { gameDirectory: iDir(id) },
  };
  if (i.jvm && i.jvm.trim()) opts.customArgs = i.jvm.trim().split(/\s+/);
  if (i.fullscreen) opts.window = { fullscreen: true };
  else if (i.width && i.height) opts.window = { width: +i.width, height: +i.height };
  if (i.server && i.server.trim()) {
    const [, minor = 0] = i.mc.split('.').map(Number);
    if (minor >= 20) opts.customLaunchArgs = ['--quickPlayMultiplayer', i.server.trim()];
    else { const [host, port = '25565'] = i.server.trim().split(':'); opts.server = { host, port }; }
  }
  logs = [];
  const l = new Client();
  l.on('progress', (p) => send('progress', Math.round((p.task / p.total) * 100)));
  l.on('package-extract', () => send('status', 'Entpacke Dateien ...'));
  l.on('download-status', () => send('status', 'Lade Spieldateien ...'));
  l.on('debug', pushLog); l.on('data', pushLog);
  l.on('close', (c) => {
    if (current) {
      try { const x = readInst(current.id); x.playtime = (x.playtime || 0) + Math.round((Date.now() - current.start) / 60000); writeInst(x); } catch {}
    }
    current = null;
    send('closed', { code: c, insts: listInst() });
  });
  current = { id, start: Date.now() };
  const proc = await l.launch(opts).catch((err) => { current = null; throw err; });
  if (!proc) { current = null; throw new Error('Start fehlgeschlagen'); }
  send('status', 'Spiel läuft');
});

app.whenReady().then(() => {
  ROOT = app.getPath('userData');
  MC = path.join(ROOT, 'minecraft'); INST = path.join(ROOT, 'instances'); JAVA = path.join(ROOT, 'java');
  CFG_FILE = path.join(ROOT, 'config.json');
  [MC, INST, JAVA].forEach((d) => fs.mkdirSync(d, { recursive: true }));
  try { cfg = JSON.parse(fs.readFileSync(CFG_FILE)); } catch {}
  if (cfg.account && !cfg.accounts) { cfg.accounts = [{ id: cfg.account.name, name: cfg.account.name, refresh: cfg.account.refresh }]; cfg.active = cfg.account.name; delete cfg.account; saveCfg(); }
  win = new BrowserWindow({
    width: 1240, height: 760, minWidth: 1000, minHeight: 640, title: 'BlockHub',
    frame: false, backgroundColor: '#0b0c10',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenu(null);
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
