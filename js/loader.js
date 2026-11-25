/*
 * YSM 模型包讀取：資料夾 / .zip / 模型包（多模型）
 * 支援 2.x 的 ysm.json 格式與 1.x 舊版（main.json + arm.json + 貼圖）格式。
 * .ysm 為官方加密格式，無法讀取。
 */
(function (global) {
  'use strict';

  // ---------- 虛擬檔案系統 ----------
  class VFS {
    constructor() { this.files = new Map(); } // path -> { text(), blob(), size }
    add(path, entry) { this.files.set(normPath(path), entry); }
    has(path) { return this.files.has(normPath(path)); }
    get(path) { return this.files.get(normPath(path)); }
    list() { return [...this.files.keys()]; }
  }

  function normPath(p) {
    const parts = [];
    for (const seg of String(p).replace(/\\/g, '/').split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop(); else parts.push(seg);
    }
    return parts.join('/');
  }
  function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function basename(p) { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function join(a, b) { return normPath(a ? a + '/' + b : b); }

  function fileEntry(file) {
    return { text: () => file.text(), blob: () => Promise.resolve(file), size: file.size };
  }

  function decodeZipName(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) {
      try { return new TextDecoder('gbk').decode(bytes); } catch (e2) { return new TextDecoder('utf-8').decode(bytes); }
    }
  }

  async function addZip(vfs, blob, prefix, warnings, depth = 0) {
    let zip;
    try { zip = await JSZip.loadAsync(blob, { decodeFileName: decodeZipName }); }
    catch (e) { warnings.push(`無法解壓縮：${prefix || 'zip'}（${e.message}）`); return; }
    const jobs = [];
    zip.forEach((rel, entry) => {
      if (entry.dir) return;
      const path = join(prefix, rel);
      const lower = path.toLowerCase();
      if (lower.endsWith('.zip') && depth < 2) {
        jobs.push(entry.async('blob').then((b) => addZip(vfs, b, path.slice(0, -4), warnings, depth + 1)));
        return;
      }
      vfs.add(path, {
        text: () => entry.async('string'),
        blob: () => entry.async('blob'),
        size: entry._data ? entry._data.uncompressedSize : 0,
      });
    });
    await Promise.all(jobs);
  }

  /** 從 File 清單（含 webkitRelativePath 或自訂 path）建立 VFS */
  async function buildVFS(items) {
    const vfs = new VFS();
    const warnings = [];
    for (const { file, path } of items) {
      const lower = path.toLowerCase();
      if (lower.endsWith('.zip')) await addZip(vfs, file, path.slice(0, -4), warnings);
      else if (lower.endsWith('.ysm')) {
        warnings.push(`「${basename(path)}」是加密的 .ysm 檔，官方設計上無法還原，無法預覽。請使用資料夾或 .zip 格式的模型。`);
      } else if (lower.endsWith('.7z')) {
        warnings.push(`「${basename(path)}」是 .7z 壓縮檔，請先解壓縮成資料夾後再拖入。`);
      } else vfs.add(path, fileEntry(file));
    }
    return { vfs, warnings };
  }

  /** 讀取拖放的 DataTransfer（支援資料夾） */
  async function itemsFromDataTransfer(dt) {
    const out = [];
    const entries = [];
    if (dt.items) {
      for (const it of dt.items) {
        const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (en) entries.push(en);
        else if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push({ file: f, path: f.name }); }
      }
    } else {
      for (const f of dt.files) out.push({ file: f, path: f.name });
    }
    async function walk(entry, prefix) {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, path: join(prefix, entry.name) });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          all.push(...batch);
        }
        for (const e of all) await walk(e, join(prefix, entry.name));
      }
    }
    for (const e of entries) await walk(e, '');
    return out;
  }

  // ---------- JSON（容忍 BOM、註解與尾逗號） ----------
  function parseJSONLoose(text) {
    text = text.replace(/^﻿/, '');
    try { return JSON.parse(text); } catch (e) { /* 再試寬鬆模式 */ }
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        let j = i + 1;
        while (j < n && text[j] !== '"') { if (text[j] === '\\') j++; j++; }
        out += text.slice(i, j + 1);
        i = j + 1;
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
      } else { out += c; i++; }
    }
    out = out.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(out);
  }

  async function readJSON(vfs, path) {
    const e = vfs.get(path);
    if (!e) return null;
    try { return parseJSONLoose(await e.text()); }
    catch (err) { throw new Error(`JSON 解析失敗：${path}（${err.message}）`); }
  }

  function isGeometry(json) {
    if (!json || typeof json !== 'object') return false;
    if (Array.isArray(json['minecraft:geometry'])) return true;
    return Object.keys(json).some((k) => k.startsWith('geometry.'));
  }

  // ---------- 模型探索 ----------
  /**
   * 找出 VFS 中所有模型根目錄
   * 回傳 [{ root, kind: 'v2' | 'legacy' }]
   */
  function discoverModels(vfs) {
    const paths = vfs.list();
    const found = [];
    const v2Roots = new Set();
    for (const p of paths) if (basename(p).toLowerCase() === 'ysm.json') v2Roots.add(dirname(p));
    for (const r of v2Roots) found.push({ root: r, kind: 'v2' });
    const isUnderV2 = (p) => [...v2Roots].some((r) => r === '' || p === r || p.startsWith(r + '/'));
    const legacyRoots = new Set();
    for (const p of paths) {
      if (basename(p).toLowerCase() === 'main.json' && !isUnderV2(p)) legacyRoots.add(dirname(p));
    }
    for (const r of legacyRoots) found.push({ root: r, kind: 'legacy' });
    found.sort((a, b) => a.root.localeCompare(b.root));
    return found;
  }

  function filesUnder(vfs, root) {
    return vfs.list().filter((p) => root === '' || p.startsWith(root + '/'));
  }

  const LEGACY_ANIMS = ['main', 'arm', 'extra', 'tac', 'carryon', 'parcool', 'swem', 'slashblade', 'tlm', 'fp.arm', 'arrow'];

  /**
   * 讀取一個模型（不含 3D 建構）
   * 回傳 {
   *   id, root, kind, name, meta, properties,
   *   targets: [{ key, label, modelPath, textures: [path], animations: [{key, path}] }],
   *   allTextures: [path], allAnimations: [path], warnings: []
   * }
   */
  async function loadModelInfo(vfs, desc) {
    const { root, kind } = desc;
    const warnings = [];
    const under = filesUnder(vfs, root);
    const rel = (p) => (root ? p.slice(root.length + 1) : p);
    const pngs = under.filter((p) => /\.png$/i.test(p));
    const animFiles = under.filter((p) => /\.animation\.json$/i.test(p));
    const info = {
      id: root || '(根目錄)',
      root, kind,
      name: basename(root) || '模型',
      meta: null, properties: {}, targets: [], warnings,
      allTextures: pngs, allAnimations: animFiles,
    };

    if (kind === 'v2') {
      const ysm = await readJSON(vfs, join(root, 'ysm.json'));
      info.meta = ysm.metadata || {};
      info.properties = ysm.properties || {};
      if (info.meta.name) info.name = info.meta.name;
      const files = ysm.files || {};
      const player = files.player || {};
      const model = player.model || {};
      const anim = player.animation || {};
      const texList = (player.texture || []).map((t) => (typeof t === 'string' ? t : t && t.uv)).filter(Boolean).map((t) => join(root, t));
      const animList = Object.entries(anim).filter(([, v]) => typeof v === 'string').map(([k, v]) => ({ key: k, path: join(root, v) }));
      const animKeysFor = (keys) => animList.filter((a) => keys.includes(a.key));
      if (model.main) {
        info.targets.push({
          key: 'main', label: '玩家模型（main）', modelPath: join(root, model.main), textures: texList,
          animations: animList.filter((a) => !['arm', 'fp_arm'].includes(a.key)),
        });
      }
      if (model.arm) {
        info.targets.push({
          key: 'arm', label: '第一人稱手臂（arm）', modelPath: join(root, model.arm), textures: texList,
          animations: animKeysFor(['arm', 'fp_arm']),
        });
      }
      const extraList = (list, label) => {
        if (!list) return;
        let arr;
        if (Array.isArray(list)) arr = list;
        else if (list.model) arr = [list]; // 2.2~2.4 的 arrow 物件
        else arr = Object.entries(list).map(([k, v]) => Object.assign({ match: [k] }, v)); // 2.5.0/2.5.1 以實體 id 為鍵
        arr.forEach((e, i) => {
          if (!e || !e.model) return;
          const m = Array.isArray(e.match) ? e.match.join(', ') : (e.match || '');
          const tex = typeof e.texture === 'string' ? [join(root, e.texture)] : (Array.isArray(e.texture) ? e.texture.map((t) => join(root, typeof t === 'string' ? t : t.uv)) : []);
          info.targets.push({
            key: label + i, label: `${label === 'projectile' ? '投射物' : '載具'}：${m || basename(e.model)}`,
            modelPath: join(root, e.model), textures: tex,
            animations: e.animation ? [{ key: label, path: join(root, e.animation) }] : [],
          });
        });
      };
      extraList(files.projectiles || files.arrow, 'projectile');
      extraList(files.vehicles, 'vehicle');
    } else {
      // 舊版格式
      const has = (n) => vfs.has(join(root, n));
      const anims = LEGACY_ANIMS.filter((n) => has(n + '.animation.json')).map((n) => ({ key: n, path: join(root, n + '.animation.json') }));
      const textures = pngs.filter((p) => dirname(p) === root && basename(p).toLowerCase() !== 'arrow.png');
      const mainGeo = await readJSON(vfs, join(root, 'main.json'));
      const desc0 = mainGeo && mainGeo['minecraft:geometry'] && mainGeo['minecraft:geometry'][0] && mainGeo['minecraft:geometry'][0].description;
      if (desc0 && desc0.ysm_extra_info) {
        const x = desc0.ysm_extra_info;
        info.meta = {
          name: x.name, tips: x.tips,
          license: x.license ? { type: x.license } : undefined,
          authors: (x.authors || []).map((a) => (typeof a === 'string' ? { name: a } : a)),
        };
        if (x.name) info.name = x.name;
      }
      if (has('info.json')) {
        try {
          const j = await readJSON(vfs, join(root, 'info.json'));
          info.meta = Object.assign(info.meta || {}, {
            name: j.name || (info.meta && info.meta.name),
            tips: j.tips || (info.meta && info.meta.tips),
            authors: (j.authors || []).map((a) => (typeof a === 'string' ? { name: a } : a)),
            license: j.license ? { type: typeof j.license === 'string' ? j.license : j.license.type } : undefined,
          });
          if (j.name) info.name = j.name;
        } catch (e) { warnings.push(e.message); }
      }
      info.targets.push({ key: 'main', label: '玩家模型（main）', modelPath: join(root, 'main.json'), textures, animations: anims.filter((a) => !['arm', 'fp.arm', 'arrow'].includes(a.key)) });
      if (has('arm.json')) info.targets.push({ key: 'arm', label: '第一人稱手臂（arm）', modelPath: join(root, 'arm.json'), textures, animations: anims.filter((a) => a.key === 'arm' || a.key === 'fp.arm') });
      if (has('arrow.json')) {
        const at = pngs.filter((p) => basename(p).toLowerCase() === 'arrow.png');
        info.targets.push({ key: 'arrow', label: '箭矢（arrow）', modelPath: join(root, 'arrow.json'), textures: at.length ? at : textures, animations: anims.filter((a) => a.key === 'arrow') });
      }
    }

    // 補上不在設定中的其他幾何檔
    const listed = new Set(info.targets.map((t) => t.modelPath));
    for (const p of under) {
      if (!/\.json$/i.test(p) || /\.animation\.json$/i.test(p) || listed.has(p)) continue;
      const lb = basename(p).toLowerCase();
      if (['ysm.json', 'info.json', 'ysm-pack.json'].includes(lb) || /(^|\/)lang\//.test(rel(p)) || /controller/i.test(p)) continue;
      try {
        const j = await readJSON(vfs, p);
        if (isGeometry(j)) info.targets.push({ key: 'other:' + p, label: '其他幾何：' + rel(p), modelPath: p, textures: info.allTextures, animations: [] });
      } catch (e) { /* 略過 */ }
    }

    // 驗證貼圖存在
    for (const t of info.targets) {
      const missing = t.textures.filter((x) => !vfs.has(x));
      if (missing.length) warnings.push(`找不到貼圖：${missing.map(rel).join(', ')}`);
      t.textures = t.textures.filter((x) => vfs.has(x));
      if (!t.textures.length) t.textures = info.allTextures.slice();
      t.animations = t.animations.filter((a) => vfs.has(a.path));
    }
    if (!info.targets.length) warnings.push('找不到任何模型幾何檔。');
    return info;
  }

  global.YSMLoader = {
    VFS, buildVFS, itemsFromDataTransfer, discoverModels, loadModelInfo, readJSON, parseJSONLoose,
    normPath, dirname, basename, join, isGeometry,
  };
})(window);
