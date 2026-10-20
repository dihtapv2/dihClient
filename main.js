const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const UA = { 'User-Agent': 'BlockHubLauncher/1.0 (hobby project)' };
const MR = 'https://api.modrinth.com/v2';
let win, ROOT, MC, INST, JAVA, CFG_FILE, cfg = {};
const send = (ch, d) => win && win.webContents.send(ch, d);
const J = async (u) => { const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error(`Fehler ${r.status}: ${u}`); return r.json(); };
const saveCfg = () => fs.writeFileSync(CFG_FILE, JSON.stringify(cfg));

async function download(url, dest, sha1) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha1 && crypto.createHash('sha1').update(buf).digest('hex') !== sha1) throw new Error('Hash-Fehler: ' + path.basename(dest));
  fs.writeFileSync(dest, buf);
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

// ---------- Fabric ----------
async function ensureFabric(mc) {
  const lv = (await J(`https://meta.fabricmc.net/v2/versions/loader/${mc}`))[0].loader.version;
  const id = `fabric-loader-${lv}-${mc}`;
  const f = path.join(MC, 'versions', id, `${id}.json`);
  if (!fs.existsSync(f)) {
    send('status', 'Lade Fabric ...');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(await J(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${lv}/profile/json`)));
  }
  return id;
}

// ---------- Instanzen ----------
const iDir = (id) => path.join(INST, id);
const readInst = (id) => JSON.parse(fs.readFileSync(path.join(iDir(id), 'instance.json')));
const listInst = () => fs.readdirSync(INST).filter((d) => fs.existsSync(path.join(INST, d, 'instance.json'))).map(readInst);

ipcMain.handle('versions:list', async () =>
  (await J('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')).versions.filter((v) => v.type === 'release').map((v) => v.id));
ipcMain.handle('inst:list', () => listInst());
ipcMain.handle('inst:create', (e, { name, mc, loader, ram }) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'instanz';
  const id = `${slug}-${Date.now().toString(36)}`;
  fs.mkdirSync(path.join(iDir(id), 'mods'), { recursive: true });
  const inst = { id, name, mc, loader, ram };
  fs.writeFileSync(path.join(iDir(id), 'instance.json'), JSON.stringify(inst));
  return inst;
});
ipcMain.handle('inst:delete', (e, id) => fs.rmSync(iDir(id), { recursive: true, force: true }));

// ---------- Mods (Modrinth) ----------
ipcMain.handle('mods:search', async (e, { id, q }) => {
  const i = readInst(id);
  const facets = [['project_type:mod'], [`versions:${i.mc}`], ['categories:fabric']];
  const p = new URLSearchParams({ query: q || '', facets: JSON.stringify(facets), limit: 30, index: q ? 'relevance' : 'downloads' });
  return (await J(`${MR}/search?${p}`)).hits;
});
async function installMod(pid, i, done = new Set(), top = true) {
  if (done.has(pid)) return [];
  done.add(pid);
  const p = new URLSearchParams({ game_versions: JSON.stringify([i.mc]), loaders: JSON.stringify(['fabric']) });
  const vs = await J(`${MR}/project/${pid}/version?${p}`);
  if (!vs.length) throw new Error('Keine passende Version gefunden');
  const f = vs[0].files.find((x) => x.primary) || vs[0].files[0];
  await download(f.url, path.join(iDir(i.id), 'mods', f.filename), f.hashes.sha1);
  let out = [f.filename];
  for (const d of vs[0].dependencies)
    if (d.dependency_type === 'required' && d.project_id)
      try { out = out.concat(await installMod(d.project_id, i, done, false)); } catch {}
  return out;
}
ipcMain.handle('mods:install', (e, { id, pid }) => installMod(pid, readInst(id)));
ipcMain.handle('mods:list', (e, id) => fs.readdirSync(path.join(iDir(id), 'mods')).filter((f) => f.endsWith('.jar')));
ipcMain.handle('mods:remove', (e, { id, file }) => fs.rmSync(path.join(iDir(id), 'mods', path.basename(file)), { force: true }));

// ---------- Account (Microsoft) ----------
ipcMain.handle('auth:get', () => (cfg.account ? { name: cfg.account.name } : null));
ipcMain.handle('auth:logout', () => { delete cfg.account; saveCfg(); });
ipcMain.handle('auth:login', async () => {
  const xbox = await new Auth('select_account').launch('electron');
  const t = await xbox.getMinecraft();
  cfg.account = { name: t.profile.name, refresh: xbox.save() };
  saveCfg();
  return { name: t.profile.name };
});
async function freshAuth() {
  const xbox = await new Auth('select_account').refresh(cfg.account.refresh);
  const t = await xbox.getMinecraft();
  cfg.account.refresh = xbox.save();
  saveCfg();
  return t.mclc();
}

// ---------- Spielen ----------
ipcMain.handle('game:play', async (e, id) => {
  const i = readInst(id);
  send('status', 'Anmeldung ...');
  const authorization = await freshAuth();
  const javaPath = await ensureJava(i.mc);
  const version = { number: i.mc, type: 'release' };
  if (i.loader === 'fabric') version.custom = await ensureFabric(i.mc);
  const l = new Client();
  l.on('progress', (p) => send('progress', Math.round((p.task / p.total) * 100)));
  l.on('package-extract', () => send('status', 'Entpacke Dateien ...'));
  l.on('download-status', () => send('status', 'Lade Spieldateien ...'));
  l.on('close', (c) => send('closed', c));
  const proc = await l.launch({
    authorization, root: MC, javaPath, version,
    memory: { max: `${i.ram}M`, min: '512M' },
    overrides: { gameDirectory: iDir(id) },
  });
  if (!proc) throw new Error('Start fehlgeschlagen');
  send('status', 'Spiel läuft');
});

app.whenReady().then(() => {
  ROOT = app.getPath('userData');
  MC = path.join(ROOT, 'minecraft'); INST = path.join(ROOT, 'instances'); JAVA = path.join(ROOT, 'java');
  CFG_FILE = path.join(ROOT, 'config.json');
  [MC, INST, JAVA].forEach((d) => fs.mkdirSync(d, { recursive: true }));
  try { cfg = JSON.parse(fs.readFileSync(CFG_FILE)); } catch {}
  win = new BrowserWindow({
    width: 1180, height: 720, minWidth: 980, minHeight: 620, title: 'BlockHub',
    backgroundColor: '#0b0c10', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
