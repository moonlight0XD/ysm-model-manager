/* YSM 模型管理器 — 介面 */
(function () {
  'use strict';
  I18N.translatePage();
  const $ = (id) => document.getElementById(id);
  const TOKEN = new URLSearchParams(location.search).get('t') || '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, ...args) {
    const r = await fetch('/api/call?t=' + encodeURIComponent(TOKEN), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || __('發生錯誤'));
    return j.result;
  }
  const tq = 't=' + encodeURIComponent(TOKEN);

  let toastTimer;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 5000 : 2500);
  }
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { console.error(e); toast(e.message, true); } };

  // ---------------- 確認視窗 ----------------
  // body 是 HTML（呼叫端要自己 esc）；input 有值時顯示文字輸入框。回傳 { ok, remember, value }
  let askResolve = null;
  function ask({ title, body, ok = __('確定'), cancel = __('取消'), danger = false, remember = '', input = null }) {
    return new Promise((resolve) => {
      if (askResolve) askResolve({ ok: false, remember: false, value: '' });
      askResolve = resolve;
      $('askTitle').textContent = title;
      $('askBody').innerHTML = body;
      $('askInput').hidden = input === null;
      $('askInput').value = input === null ? '' : input;
      $('askYes').textContent = ok;
      $('askNo').textContent = cancel;
      $('askYes').classList.toggle('danger', danger);
      $('askRememberRow').hidden = !remember;
      $('askRemember').checked = false;
      $('askRememberText').textContent = remember;
      $('askModal').hidden = false;
      if (input !== null) { $('askInput').focus(); $('askInput').select(); } else $('askNo').focus();
    });
  }
  function finishAsk(ok) {
    const r = askResolve;
    askResolve = null;
    $('askModal').hidden = true;
    if (r) r({ ok, remember: ok && $('askRemember').checked, value: ok ? $('askInput').value.trim() : '' });
  }
  $('askYes').onclick = () => finishAsk(true);
  $('askNo').onclick = () => finishAsk(false);
  $('askInput').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); finishAsk(true); } };
  // 取代瀏覽器內建的 confirm()／prompt()
  const confirmBox = async (title, text, opts = {}) => (await ask({ title, body: esc(text), ...opts })).ok;
  const promptBox = async (title, text, value = '') => {
    const r = await ask({ title, body: esc(text), input: value });
    return r.ok ? r.value : null;
  };

  // 硬連結做不到時，問要不要改用複製
  async function confirmCopy(sizeText) {
    if (S.settings && S.settings.confirm_copy === false) return true;
    const r = await ask({
      title: __('無法使用硬連結'),
      body: `${__('倉庫和這個遊戲實例不在同一個 NTFS 磁碟（例如倉庫在 exFAT 格式的外接硬碟、遊戲在 C:），所以沒辦法用硬連結。\n\n要改用<b>複製</b>嗎？複製會在遊戲資料夾多佔一份空間{0}。', sizeText ? __('（約 {0}）', esc(sizeText)) : '')}`,
      ok: __('改用複製'),
      remember: __('以後不要再問，直接複製（可在設定中改回）'),
    });
    if (r.remember) S.settings = await api('set_settings', { confirm_copy: false });
    return r.ok;
  }

  // ---------------- 狀態 ----------------
  const S = {
    roots: [],
    instances: [],
    repo: '',
    linkMode: 'hardlink',
    loc: 'all',
    entries: [],
    sel: null,
    status: 'all',
    kind: 'all',
    tag: null,
    search: '',
    sort: 'name',
    folder: null, // null＝不限；''＝倉庫最上層；'a/b'＝倉庫子資料夾（含其下的子資料夾）
    folders: [],
    picked: new Set(), // 勾選的模型 id（批量安裝 / 移動）
    pickedFolders: new Set(), // 勾選的倉庫子資料夾
    lastPick: null,
  };

  const displayName = (e) => (e.user && e.user.display_name) || (e.meta && e.meta.name) || e.filename;
  const authorText = (e) => ((e.meta && e.meta.authors) || []).map((a) => a.name).filter(Boolean).join('、');
  const thumbURL = (e) => (e.user && e.user.thumb ? `/api/thumb/${encodeURIComponent(e.user.thumb)}?${tq}` : '');
  const kindLabel = { ysm: '.ysm', folder: __('資料夾'), zip: 'zip', '7z': '7z' };
  const fmtSize = (n) => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; };
  const fmtDate = (t) => new Date(t * 1000).toLocaleString(I18N.locale, { hour12: false });

  // ---------------- 資料夾 ----------------
  let firstState = true;
  function applyState(st) {
    // 有倉庫時預設只看倉庫，避免同一個模型在各實例重複出現
    if (firstState && st.repo) { S.loc = 'repo'; S.folder = ''; }
    firstState = false;
    S.roots = st.roots;
    S.instances = st.instances || [];
    S.repo = st.repo || '';
    S.linkMode = st.link_mode || 'hardlink';
    $('linkMode').value = S.linkMode;
    renderRepo();
    renderRoots();
  }
  const instName = (root) => (S.instances.find((i) => i.root === root) || {}).name || root;

  function renderRepo() {
    const box = $('repoBox');
    if (!S.repo) {
      box.innerHTML = `<span class="st">${__('尚未設定。倉庫是集中存放所有模型的資料夾，再從這裡安裝到各個遊戲實例。')}</span>`;
    } else {
      const n = S.entries.filter((e) => e.location === 'repo').length;
      box.innerHTML = `<div title="${esc(S.repo)}">${esc(S.repo)}</div><div class="st">${__('{0} 個模型', n)}</div>`;
    }
    $('btnRepo').textContent = S.repo ? __('更換倉庫資料夾') : __('設定倉庫資料夾');
    $('btnImportAll').disabled = !S.repo;
  }

  $('btnRepo').onclick = guard(async () => {
    const r = await api('pick_folder');
    let path = r && r.path;
    if (r && r.unsupported) path = await promptBox(__('倉庫資料夾'), __('輸入倉庫資料夾路徑（例如 D:\\YSM倉庫）：'), S.repo);
    if (!path) return;
    applyState(await api('set_repo', path));
    toast(__('倉庫：') + S.repo);
    await rescan();
  });
  $('linkMode').onchange = guard(async (ev) => {
    applyState(await api('set_link_mode', ev.target.value));
    toast(S.linkMode === 'hardlink' ? __('安裝方式：硬連結（倉庫與遊戲需在同一磁碟）') : __('安裝方式：複製'));
  });
  $('btnImportAll').onclick = guard(async () => {
    const n = S.entries.filter((e) => e.location !== 'repo' && !e.repo_id).length;
    if (!n) { toast(__('實例中的模型都已經在倉庫裡了')); return; }
    if (!(await confirmBox(__('加入倉庫'), __('把 {0} 個還不在倉庫的模型複製進倉庫？{1}\n原本的模型不會被刪除。', n, S.linkMode === 'hardlink' ? __('\n\n完成後，實例中的檔案會換成指向倉庫的硬連結，不會多佔空間。') : ''), { ok: __('加入倉庫') }))) return;
    $('btnImportAll').disabled = true;
    try {
      const res = await api('import_all');
      toast(__('已加入 {0} 個模型{1}{2}', res.done, res.linked ? __('，{0} 個已換成硬連結', res.linked) : '', res.errors.length ? __('；{0} 個失敗：{1}', res.errors.length, res.errors[0]) : ''), res.errors.length > 0);
    } finally { $('btnImportAll').disabled = false; }
    await rescan();
  });

  function renderRoots() {
    const ul = $('roots');
    ul.innerHTML = '';
    if (!S.roots.length) ul.innerHTML = `<li><span class="p muted">${__('尚未加入資料夾')}</span></li>`;
    for (const r of S.roots) {
      const inst = S.instances.find((i) => i.root === r) || { name: r, is_instance: false };
      const li = document.createElement('li');
      li.innerHTML = `<span class="nmw"><b title="${esc(r)}">${esc(inst.name)}</b><span class="p" title="${esc(r)}">${esc(r)}</span></span>${S.repo && inst.is_instance ? `<button class="inst-pick" data-root="${esc(r)}">${__('安裝選取')}</button>` : ''}<button title="${__('開啟資料夾')}">📂</button><button title="${__('從清單移除（不會刪除檔案）')}">✕</button>`;
      const btns = [...li.querySelectorAll('button')];
      if (S.repo && inst.is_instance) btns.shift().onclick = () => installPicked(r);
      const [bOpen, bDel] = btns;
      bOpen.onclick = guard(() => api('open_dir', r));
      bDel.onclick = guard(async () => {
        if (!(await confirmBox(__('從清單移除'), __('從清單移除這個資料夾？\n（只是不再顯示，不會刪除任何檔案）\n\n') + r, { ok: __('移除') }))) return;
        S.roots = (await api('remove_root', r)).roots;
        renderRoots();
        await rescan();
      });
      ul.appendChild(li);
    }
    updateSelUI();
  }

  const addRoot = guard(async (path) => {
    const res = await api('add_root', path);
    S.roots = res.roots;
    renderRoots();
    toast(__('已加入：') + res.root);
    await rescan();
  });

  $('btnAddRoot').onclick = guard(async () => {
    const r = await api('pick_folder');
    let path = r && r.path;
    if (r && r.unsupported) path = await promptBox(__('新增資料夾'), __('輸入資料夾路徑（.minecraft、實例資料夾、yes_steve_model 或 custom）：'));
    if (path) await addRoot(path);
  });

  $('btnDetect').onclick = guard(async () => {
    const box = $('detectBox');
    box.hidden = false;
    box.innerHTML = `<span class="muted">${__('搜尋中…')}</span>`;
    const found = (await api('detect_roots')).filter((it) => !S.roots.some((r) => r.toLowerCase() === it.path.toLowerCase()));
    if (!found.length) { box.innerHTML = `<span class="muted">${__('沒有找到新的 yes_steve_model 資料夾。可以用「新增資料夾」手動選擇。')}</span>`; return; }
    box.innerHTML = `<div class="d-head"><span class="muted">${__('找到 {0} 個', found.length)}</span>${found.length > 1 ? `<button class="btn small ghost" id="detAll">${__('全部加入')}</button>` : ''}<button class="btn small ghost" id="detClose" title="${__('關閉')}">✕</button></div>`;
    $('detClose').onclick = () => { box.hidden = true; };
    if ($('detAll')) $('detAll').onclick = guard(async () => {
      box.hidden = true;
      for (const it of found) await api('add_root', it.path);
      S.roots = (await api('get_state')).roots;
      renderRoots();
      toast(__('已加入 {0} 個遊戲實例', found.length));
      await rescan();
    });
    for (const it of found) {
      const d = document.createElement('div');
      d.className = 'd';
      d.title = it.path;
      d.innerHTML = `<span class="dn"><b>${esc(it.name)}</b><small>${esc(it.launcher)} · ${it.models ? __('{0} 個模型', it.models) : __('沒有模型')}</small></span><button class="btn small">${__('加入')}</button>`;
      d.querySelector('button').onclick = async () => { d.remove(); await addRoot(it.path); if (!box.querySelector('.d')) box.hidden = true; };
      box.appendChild(d);
    }
  });

  // ---------------- 掃描 ----------------
  let scanning = false;
  async function rescan() {
    if (scanning) return;
    scanning = true;
    $('btnRescan').disabled = true;
    $('count').textContent = __('掃描中…');
    try {
      // 模型的 id 由路徑決定，移動或改名後會變；用內容識別碼把勾選和選取的模型對回來
      const keyOf = (id) => { const e = S.entries.find((x) => x.id === id); return e ? e.location + '|' + e.key : null; };
      const pickedKeys = new Set([...S.picked].map(keyOf).filter(Boolean));
      const selKey = S.sel ? keyOf(S.sel) : null;
      S.entries = await api('scan');
      S.folders = await api('repo_folders');
      applyState(await api('get_state'));
      S.picked = new Set(S.entries.filter((e) => pickedKeys.has(e.location + '|' + e.key)).map((e) => e.id));
      if (selKey && !S.entries.some((e) => e.id === S.sel)) S.sel = (S.entries.find((e) => e.location + '|' + e.key === selKey) || {}).id || null;
      if (S.folder && !S.folders.includes(S.folder)) S.folder = null;
      for (const f of [...S.pickedFolders]) if (!S.folders.includes(f)) S.pickedFolders.delete(f);
      if (S.loc !== 'all' && S.loc !== 'repo' && !S.roots.includes(S.loc)) S.loc = 'all';
      renderAll();
    } catch (e) { toast(e.message, true); }
    finally { scanning = false; $('btnRescan').disabled = false; }
  }
  $('btnRescan').onclick = rescan;

  // ---------------- 篩選與排序 ----------------
  // 「全部」裡，倉庫有同一個模型（內容相同）的實例副本不另外顯示：倉庫那張卡已經標示「已裝」。
  // 篩選停用狀態時照常顯示，免得實例中停用的那份被藏起來
  let repoKeyCache = { list: null, keys: null };
  function dupOfRepo(e) {
    if (e.location === 'repo') return false;
    if (repoKeyCache.list !== S.entries) repoKeyCache = { list: S.entries, keys: new Set(S.entries.filter((x) => x.location === 'repo').map((x) => x.key)) };
    return repoKeyCache.keys.has(e.key);
  }
  // 卡片左上角：這個模型在哪裡（倉庫、以及有裝這個模型的遊戲實例）
  function placesOf(e) {
    const insts = e.location === 'repo'
      ? (e.installs || []).map((i) => i.instance || instName(i.root))
      : S.entries.filter((x) => x.location !== 'repo' && x.key === e.key).map((x) => instName(x.root));
    return [...(e.location === 'repo' ? [__('倉庫')] : []), ...new Set(insts)];
  }
  function filtered() {
    const q = S.search.trim().toLowerCase();
    let list = S.entries.filter((e) => {
      if (S.loc !== 'all' && e.location !== S.loc) return false;
      if (S.loc === 'all' && S.status === 'all' && dupOfRepo(e)) return false;
      // 瀏覽資料夾時只顯示這一層的模型（子資料夾以資料夾卡片顯示）；搜尋時包含所有子資料夾
      if (S.folder !== null && !(q ? inFolder(e, S.folder) : shownInFolder(e, S.folder))) return false;
      if (S.status === 'enabled' && !e.enabled) return false;
      if (S.status === 'disabled' && e.enabled) return false;
      if (S.kind !== 'all' && e.kind !== S.kind) return false;
      if (S.tag && !(e.user.tags || []).includes(S.tag)) return false;
      if (q) {
        const hay = [displayName(e), e.filename, e.meta && e.meta.name, authorText(e), (e.user.tags || []).join(' '), e.user.notes, e.rel].join('\n').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const cmp = {
      name: (a, b) => displayName(a).localeCompare(displayName(b), 'zh-Hant'),
      mtime: (a, b) => b.mtime - a.mtime,
      added: (a, b) => (b.user.added || 0) - (a.user.added || 0),
      rating: (a, b) => (b.user.rating || 0) - (a.user.rating || 0) || displayName(a).localeCompare(displayName(b), 'zh-Hant'),
      size: (a, b) => b.size - a.size,
    }[S.sort];
    return list.sort(cmp);
  }

  function renderLoc() {
    const box = $('fLoc');
    const opts = [['all', __('全部'), S.entries.filter((e) => !dupOfRepo(e)).length]];
    if (S.repo) opts.push(['repo', __('倉庫'), S.entries.filter((e) => e.location === 'repo').length]);
    for (const r of S.roots) opts.push([r, instName(r), S.entries.filter((e) => e.location === r).length]);
    box.innerHTML = '';
    for (const [v, label, n] of opts) {
      const b = document.createElement('button');
      b.className = 'chip' + (S.loc === v ? ' on' : '');
      b.title = v === 'all' || v === 'repo' ? label : v;
      b.innerHTML = `${esc(label)}<span class="n">${n}</span>`;
      b.onclick = () => { S.loc = v; S.folder = v === 'repo' ? '' : null; renderLoc(); renderGrid(); };
      box.appendChild(b);
    }
  }

  function renderTags() {
    const counts = new Map();
    for (const e of S.entries) for (const t of e.user.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    const box = $('fTags');
    box.innerHTML = '';
    if (!counts.size) { box.innerHTML = `<span class="muted">${__('尚無標籤')}</span>`; S.tag = null; }
    const tags = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    if (S.tag && !counts.has(S.tag)) S.tag = null;
    for (const t of tags) {
      const b = document.createElement('button');
      b.className = 'chip' + (S.tag === t ? ' on' : '');
      b.innerHTML = `${esc(t)}<span class="n">${counts.get(t)}</span>`;
      b.onclick = () => { S.tag = S.tag === t ? null : t; renderAll(); };
      box.appendChild(b);
    }
    $('tagList').innerHTML = tags.map((t) => `<option value="${esc(t)}">`).join('');
  }

  // ---------------- 倉庫子資料夾 ----------------
  // f 為 ''（倉庫最上層）時包含整個倉庫
  function inFolder(e, f) { return e.location === 'repo' && (f === '' || e.group === f || (e.group || '').startsWith(f + '/')); }
  // 「模型資料夾」：沒有子資料夾、裡面只有一個角色（一個模型或同角色的多個版本）。
  // 這種資料夾不顯示成資料夾卡片，而是把模型卡片直接放在上一層。
  const parentOf = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
  let modelDirMemo = { entries: null, folders: null, set: new Set() };
  function modelFolders() {
    if (modelDirMemo.entries === S.entries && modelDirMemo.folders === S.folders) return modelDirMemo.set;
    const direct = new Map();
    for (const e of S.entries) {
      if (e.location !== 'repo' || !e.group) continue;
      if (!direct.has(e.group)) direct.set(e.group, new Set());
      direct.get(e.group).add(verInfo(e).base);
    }
    const hasSub = new Set(S.folders.filter((f) => f.includes('/')).map(parentOf));
    const set = new Set();
    for (const [f, bases] of direct) if (bases.size === 1 && !hasSub.has(f)) set.add(f);
    modelDirMemo = { entries: S.entries, folders: S.folders, set };
    return set;
  }
  function shownInFolder(e, f) {
    if (e.location !== 'repo') return false;
    const g = e.group || '';
    return g === f || (modelFolders().has(g) && parentOf(g) === f);
  }
  function folderLabel(f) { return f ? f.split('/').join(' / ') : __('（最上層）'); }
  function repoPicked() { return S.entries.filter((e) => S.picked.has(e.id) && e.location === 'repo'); }
  // 批量安裝 / 刪除的對象：勾選的倉庫模型，加上勾選資料夾（含子資料夾）中的所有模型
  function pickedModels() {
    const fs = [...S.pickedFolders];
    return S.entries.filter((e) => e.location === 'repo' && (S.picked.has(e.id) || fs.some((f) => inFolder(e, f))));
  }
  // 勾選的資料夾中，去掉已經被另一個勾選資料夾包含的
  function topPickedFolders() {
    const fs = [...S.pickedFolders];
    return fs.filter((f) => !fs.some((g) => g !== f && f.startsWith(g + '/')));
  }

  const newFolder = guard(async (parent) => {
    const name = await promptBox(__('新增資料夾'), __('在「{0}」中新增資料夾，名稱：', folderLabel(parent || '')));
    if (!name) return;
    S.folders = await api('create_folder', parent || '', name);
    updateSelUI(); renderGrid();
    toast(__('已新增資料夾：') + name);
  });

  const installedIn = (list) => list.reduce((a, e) => a + (e.installs || []).length, 0);

  const renameFolder = guard(async (f) => {
    const old = f.split('/').pop();
    const name = await promptBox(__('重新命名資料夾'), __('「{0}」的新名稱：', folderLabel(f)), old);
    if (!name || name === old) return;
    const inside = S.entries.filter((e) => inFolder(e, f));
    const n = installedIn(inside);
    if (n && !(await confirmBox(__('重新命名資料夾'), __('這個資料夾中的模型有 {0} 份已安裝到遊戲，遊戲中的檔案也會一起改到新的資料夾，模型 ID 會跟著改變（例如「{1}/角色.ysm」→「{2}/角色.ysm」）。\n\n已經套用在玩家身上的模型可能需要重新選一次。', n, old, name), { ok: __('重新命名') }))) return;
    const res = await api('rename_folder', f, name);
    if (S.folder === f || (S.folder || '').startsWith(f + '/')) S.folder = (f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '') + name + (S.folder || '').slice(f.length);
    toast(__('已重新命名{0}{1}', res.moved ? __('，遊戲中 {0} 份也已移動', res.moved) : '', res.errors.length ? __('；{0} 個問題：{1}', res.errors.length, res.errors[0]) : ''), res.errors.length > 0);
    await rescan();
  });

  const deleteFolder = guard(async (f) => {
    const inside = S.entries.filter((e) => inFolder(e, f));
    if (!inside.length) {
      if (!(await confirmBox(__('刪除資料夾'), __('刪除空的資料夾「{0}」？', folderLabel(f)), { ok: __('刪除'), danger: true }))) return;
      S.folders = await api('delete_folder', f);
    } else {
      if (!(await confirmDelete({ folders: [f], models: inside }))) return;
      const res = await api('delete_folder_all', f);
      toast(__('已刪除資料夾「{0}」與其中 {1} 個模型{2}', folderLabel(f), res.models, res.recycled ? __('（已移到資源回收筒）') : __('（永久刪除）')));
    }
    S.pickedFolders.delete(f);
    if (S.folder === f || (S.folder || '').startsWith(f + '/')) S.folder = parentOf(f);
    await rescan();
  });

  // 從倉庫刪除前的確認（第二次確認可在設定中關閉）
  async function confirmDelete({ folders = [], models = [] }) {
    const size = models.reduce((a, e) => a + (e.size || 0), 0);
    const installed = models.filter((e) => e.installs && e.installs.length).length;
    const info = models.length ? await api('delete_info', models[0].id) : { recycle: true };
    const fate = info.recycle
      ? `${__('檔案會移到<b>資源回收筒</b>，需要時可以還原。')}`
      : `<span class="warn">${__('倉庫所在的磁碟沒有資源回收筒，刪除後無法復原！')}</span>`;
    const lines = folders.map((f) => '📁 ' + esc(folderLabel(f)))
      .concat(models.filter((e) => !folders.some((f) => inFolder(e, f))).map((e) => '・' + esc(displayName(e))));
    const names = lines.slice(0, 10).join('\n') + (lines.length > 10 ? `\n${__('…還有 {0} 項', lines.length - 10)}` : '');
    const what = [folders.length ? __('{0} 個資料夾', folders.length) : '', __('{0} 個模型', models.length)].filter(Boolean).join('、');
    const r1 = await ask({
      title: __('從倉庫刪除'),
      body: `${__('要從倉庫刪除 <b>{0}</b> 嗎？（共 {1}）{2}\n\n{3}', what, fmtSize(size), folders.length ? __('\n資料夾會連同裡面所有的子資料夾和模型一起刪除。') : '', names)}`
        + (installed ? `\n\n${__('其中 {0} 個已安裝到遊戲實例，<b>實例中的那份不會被刪除</b>，遊戲仍可使用。', installed)}` : '')
        + `\n\n${fate}`,
      ok: __('刪除'), danger: true,
    });
    if (!r1.ok) return false;
    if (!S.settings || S.settings.confirm_delete_twice !== false) {
      const r2 = await ask({ title: __('再次確認'), body: `${__('真的要從倉庫刪除 <b>{0}</b> 嗎？\n\n{1}', what, fate)}`, ok: __('確定刪除'), cancel: __('不要刪除'), danger: true });
      if (!r2.ok) return false;
    }
    return true;
  }

  const moveModels = guard(async (ids, folder) => {
    const list = S.entries.filter((e) => ids.includes(e.id) && e.location === 'repo' && (e.group || '') !== folder);
    if (!list.length) { toast(ids.length ? __('選取的倉庫模型已經在這個資料夾了') : __('沒有選取倉庫中的模型')); return; }
    const n = installedIn(list);
    if (n && !(await confirmBox(__('移動模型'), __('把 {0} 個模型移到「{1}」？\n\n其中有 {2} 份已安裝到遊戲，遊戲中的檔案也會一起移到同名資料夾，模型 ID 會跟著改變（例如「角色.ysm」→「{3}角色.ysm」）。已經套用在玩家身上的模型可能需要重新選一次。', list.length, folderLabel(folder), n, folder ? folder + '/' : ''), { ok: __('移動') }))) return;
    const res = await api('move_models', list.map((e) => e.id), folder);
    toast(__('已移動 {0} 個到「{1}」{2}{3}', res.done, folderLabel(folder), res.moved_installs ? __('，遊戲中 {0} 份也已移動', res.moved_installs) : '', res.errors.length ? __('；{0} 個問題：{1}', res.errors.length, res.errors[0]) : ''), res.errors.length > 0);
    await rescan();
  });

  // ---- 右側網格中的資料夾（像檔案總管一樣一層一層進入）----
  function browsingFolders() { return S.repo && S.loc === 'repo' && S.folder !== null && !S.search.trim(); }
  function childFolders(parent) {
    return S.folders.filter((f) => (parent ? f.startsWith(parent + '/') && !f.slice(parent.length + 1).includes('/') : !f.includes('/')));
  }
  function openFolder(f) { S.folder = f; S.loc = 'repo'; renderLoc(); renderGrid(); }
  function makeDropTarget(el, f) {
    el.ondragover = (ev) => { if (ev.dataTransfer.types.includes('text/ysm-ids')) { ev.preventDefault(); el.classList.add('drop'); } };
    el.ondragleave = () => el.classList.remove('drop');
    el.ondrop = (ev) => {
      ev.preventDefault();
      el.classList.remove('drop');
      moveModels(JSON.parse(ev.dataTransfer.getData('text/ysm-ids') || '[]'), f);
    };
  }

  function renderCrumbs() {
    const box = $('crumbs');
    box.hidden = !(S.repo && S.loc === 'repo' && S.folder !== null);
    if (box.hidden) return;
    const parts = S.folder ? S.folder.split('/') : [];
    const items = [['', __('🗃 倉庫')]].concat(parts.map((p, i) => [parts.slice(0, i + 1).join('/'), p]));
    box.innerHTML = '';
    items.forEach(([f, label], i) => {
      if (i) box.insertAdjacentHTML('beforeend', '<span class="sep">›</span>');
      const b = document.createElement('button');
      b.className = 'crumb' + (i === items.length - 1 ? ' on' : '');
      b.textContent = label;
      b.title = i === items.length - 1 ? __('目前位置') : __('回到這一層（也可以把模型拖到這裡）');
      b.onclick = () => openFolder(f);
      makeDropTarget(b, f);
      box.appendChild(b);
    });
    box.insertAdjacentHTML('beforeend', S.search.trim()
      ? `<span class="muted crumb-note">${__('搜尋中：包含所有子資料夾')}</span>`
      : `<span class="muted crumb-note">${__('在空白處按右鍵可新增資料夾')}</span>`);
  }

  function folderCards(frag) {
    for (const f of childFolders(S.folder).filter((x) => !modelFolders().has(x))) {
      const inside = S.entries.filter((e) => inFolder(e, f));
      const thumbs = [...new Set(inside.map(thumbURL).filter(Boolean))].slice(0, 4);
      const subs = childFolders(f).length;
      const c = document.createElement('div');
      c.className = 'card folder-card' + (S.pickedFolders.has(f) ? ' picked' : '');
      c.title = __('{0}\n點一下開啟；右鍵可重新命名、刪除；可以把模型拖到這裡', folderLabel(f));
      c.innerHTML = `<div class="thumb fthumb">${thumbs.length
        ? `<div class="mosaic n${thumbs.length}">${thumbs.map((t) => `<i style="background-image:url('${t}')"></i>`).join('')}</div>`
        : '<span class="ficon">📁</span>'}
          <span class="badge fbadge">${__('📁 資料夾')}</span>
          <span class="pick" title="${__('勾選（也可以 Ctrl / Shift + 點擊，或在空白處拖曳框選）')}">✓</span></div>
        <div class="meta"><div class="nm">${esc(f.split('/').pop())}</div>
          <div class="au">${__('{0} 個模型{1}', inside.length, subs ? __('・{0} 個子資料夾', subs) : '')}</div></div>`;
      c.onclick = (ev) => {
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.target.closest('.pick')) {
          togglePickFolder(f);
          return;
        }
        openFolder(f);
      };
      c.dataset.folder = f;
      makeDropTarget(c, f);
      frag.appendChild(c);
    }
  }

  // ---- 右鍵選單 ----
  const ctx = document.createElement('div');
  ctx.id = 'ctxMenu';
  ctx.hidden = true;
  document.body.appendChild(ctx);
  function hideMenu() { ctx.hidden = true; }
  function showMenu(x, y, items) {
    ctx.innerHTML = '';
    for (const it of items) {
      if (it === '-') { ctx.insertAdjacentHTML('beforeend', '<hr>'); continue; }
      const b = document.createElement('button');
      b.textContent = it.label;
      if (it.danger) b.className = 'danger';
      b.onclick = () => { hideMenu(); it.run(); };
      ctx.appendChild(b);
    }
    ctx.hidden = false;
    const r = ctx.getBoundingClientRect();
    ctx.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    ctx.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  }
  window.addEventListener('mousedown', (ev) => { if (!ctx.contains(ev.target)) hideMenu(); });
  window.addEventListener('blur', hideMenu);
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideMenu(); });
  $('grid').addEventListener('scroll', hideMenu);

  // ---- 左側欄可拖曳右邊界調整寬度（雙擊還原），寬度會記住 ----
  (() => {
    const app = $('app');
    const h = document.createElement('div');
    h.id = 'sideResize';
    h.title = __('拖曳調整左側欄寬度（雙擊還原）');
    document.body.appendChild(h);
    const MIN = 200, MAX = 520, DEF = 240;
    const clamp = (w) => Math.max(MIN, Math.min(MAX, Math.min(w, innerWidth - 560)));
    const apply = (w) => { app.style.setProperty('--side-w', w + 'px'); h.style.left = w + 'px'; };
    let w = DEF;
    try { w = Number(localStorage.getItem('ysmgr.sideW')) || DEF; } catch (e) { /* 忽略 */ }
    apply(clamp(w));
    const save = (v) => { try { localStorage.setItem('ysmgr.sideW', String(v)); } catch (e) { /* 忽略 */ } };
    h.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      h.classList.add('drag'); document.body.classList.add('resizing');
      const move = (e) => { w = clamp(e.clientX); apply(w); };
      const up = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        h.classList.remove('drag'); document.body.classList.remove('resizing'); save(w);
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    h.addEventListener('dblclick', () => { w = DEF; apply(w); save(w); });
    window.addEventListener('resize', () => apply(clamp(w)));
  })();

  // ---- 框選：在卡片之間的空白處按住左鍵拖曳，框到的卡片會被勾選（Ctrl = 反轉勾選）；只點一下空白處則取消勾選 ----
  (() => {
    const grid = $('grid');
    const box = document.createElement('div');
    box.id = 'marquee';
    box.hidden = true;
    document.body.appendChild(box);
    let st = null;
    const pt = (ev) => { const r = grid.getBoundingClientRect(); return { x: ev.clientX - r.left + grid.scrollLeft, y: ev.clientY - r.top + grid.scrollTop }; };
    function update() {
      const r = grid.getBoundingClientRect();
      const x1 = Math.min(st.a.x, st.b.x), x2 = Math.max(st.a.x, st.b.x);
      const y1 = Math.min(st.a.y, st.b.y), y2 = Math.max(st.a.y, st.b.y);
      if (!st.moved && x2 - x1 < 5 && y2 - y1 < 5) return;
      st.moved = true;
      // 畫框（限制在網格可見範圍內）
      const L = Math.max(r.left, r.left + x1 - grid.scrollLeft), R = Math.min(r.right, r.left + x2 - grid.scrollLeft);
      const T = Math.max(r.top, r.top + y1 - grid.scrollTop), B = Math.min(r.bottom, r.top + y2 - grid.scrollTop);
      Object.assign(box.style, { left: L + 'px', top: T + 'px', width: Math.max(0, R - L) + 'px', height: Math.max(0, B - T) + 'px' });
      box.hidden = false;
      S.picked = new Set(st.ids);
      S.pickedFolders = new Set(st.folders);
      for (const c of grid.querySelectorAll('.card')) {
        const cr = c.getBoundingClientRect();
        const cx1 = cr.left - r.left + grid.scrollLeft, cy1 = cr.top - r.top + grid.scrollTop;
        if (cx1 > x2 || cx1 + cr.width < x1 || cy1 > y2 || cy1 + cr.height < y1) continue;
        const set = c.dataset.folder !== undefined ? S.pickedFolders : S.picked;
        const k = c.dataset.folder !== undefined ? c.dataset.folder : c.dataset.id;
        if (st.toggle && set.has(k)) set.delete(k); else set.add(k);
      }
      refreshPicks();
    }
    grid.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('.card')) return;
      if (ev.offsetX >= grid.clientWidth || ev.offsetY >= grid.clientHeight) return; // 點在捲軸上
      ev.preventDefault();
      const p = pt(ev);
      st = { a: p, b: p, mx: ev.clientY, toggle: ev.ctrlKey || ev.metaKey, menu: !ctx.hidden, ids: [...S.picked], folders: [...S.pickedFolders], moved: false };
      // 拖到網格上下邊緣時自動捲動
      st.timer = setInterval(() => {
        const r = grid.getBoundingClientRect();
        const d = st.mx < r.top + 30 ? -18 : st.mx > r.bottom - 30 ? 18 : 0;
        if (d) { grid.scrollTop += d; st.b = { x: st.b.x, y: Math.max(0, Math.min(grid.scrollHeight, st.b.y + d)) }; update(); }
      }, 30);
    });
    window.addEventListener('mousemove', (ev) => {
      if (!st) return;
      st.mx = ev.clientY;
      st.b = pt(ev);
      update();
    });
    window.addEventListener('mouseup', () => {
      if (!st) return;
      clearInterval(st.timer);
      box.hidden = true;
      // 沒有拖曳、只是點一下空白處 → 取消全部勾選（Ctrl 點不算）
      if (!st.moved && !st.toggle && !st.menu && (S.picked.size || S.pickedFolders.size)) {
        S.picked.clear(); S.pickedFolders.clear(); refreshPicks();
      }
      st = null;
    });
  })();
  $('grid').addEventListener('contextmenu', (ev) => {
    if (!(S.repo && S.loc === 'repo' && S.folder !== null)) return;
    ev.preventDefault();
    const here = S.folder;
    const addHere = { label: __('＋ 新增資料夾{0}', here ? __('（在「{0}」中）', here.split('/').pop()) : ''), run: () => newFolder(here) };
    const fc = ev.target.closest('.folder-card');
    const card = ev.target.closest('.card[data-id]');
    let items;
    if (fc) {
      const f = fc.dataset.folder;
      items = [
        { label: __('📂 開啟'), run: () => openFolder(f) },
        { label: S.pickedFolders.has(f) ? __('取消勾選') : __('✓ 勾選'), run: () => togglePickFolder(f) },
        ...S.instances.filter((i) => i.is_instance && S.roots.includes(i.root))
          .map((i) => ({ label: __('⬇ 整個資料夾安裝到「{0}」', i.name), run: () => installPicked(i.root, f) })),
        '-',
        { label: __('＋ 在裡面新增資料夾'), run: () => newFolder(f) },
        { label: __('✎ 重新命名'), run: () => renameFolder(f) },
        { label: __('✕ 刪除資料夾'), danger: true, run: () => deleteFolder(f) },
        '-', addHere,
      ];
    } else if (card) {
      const id = card.dataset.id;
      items = [
        { label: S.picked.has(id) ? __('取消勾選') : __('✓ 勾選'), run: () => { togglePick(id); S.lastPick = id; refreshPicks(); } },
        '-', addHere,
      ];
    } else {
      items = [addHere];
      if (here) {
        const insts = S.instances.filter((i) => i.is_instance && S.roots.includes(i.root));
        if (insts.length) items.push('-', ...insts.map((i) => ({ label: __('⬇ 這個資料夾整個安裝到「{0}」', i.name), run: () => installPicked(i.root, here) })));
      }
    }
    if (here) items.push({ label: __('↑ 回上一層'), run: () => openFolder(here.includes('/') ? here.slice(0, here.lastIndexOf('/')) : '') });
    showMenu(ev.clientX, ev.clientY, items);
  });

  // ---------------- 勾選與批量操作 ----------------
  function updateSelUI() {
    const nf = S.pickedFolders.size;
    const n = S.picked.size + nf;
    const rp = pickedModels();
    const anyRepo = rp.length > 0 || nf > 0;
    $('selBar').hidden = n === 0;
    $('grid').classList.toggle('picking', n > 0);
    $('selN').textContent = nf ? __('{0} 個模型、{1} 個資料夾', S.picked.size, nf) : String(S.picked.size);
    const outside = S.picked.size - repoPicked().length;
    $('selNote').textContent = (nf ? __('（共 {0} 個模型）', rp.length) : '') + (outside > 0 ? __('（{0} 個在遊戲實例中，安裝、移動時會略過）', outside) : '');
    $('selDelInst').hidden = outside <= 0;
    $('selDelInst').textContent = __('從實例刪除（{0}）', outside);
    const insts = S.instances.filter((i) => i.is_instance && S.roots.includes(i.root));
    const keepI = $('selInst').value;
    $('selInst').innerHTML = insts.map((i) => `<option value="${esc(i.root)}">${esc(i.name)}</option>`).join('') || `<option value="">${__('（沒有遊戲實例）')}</option>`;
    if (insts.some((i) => i.root === keepI)) $('selInst').value = keepI;
    const keepF = $('selFolder').value;
    $('selFolder').innerHTML = ['', ...S.folders].map((f) => `<option value="${esc(f)}">${esc(folderLabel(f))}</option>`).join('') + `<option value="\u0000new">${__('＋ 新資料夾…')}</option>`;
    if (['', ...S.folders].includes(keepF)) $('selFolder').value = keepF;
    $('selInstall').disabled = !rp.length || !insts.length;
    $('selMove').disabled = !anyRepo;
    const nt = thumbPicked().length;
    $('selThumbDel').disabled = !nt;
    $('selThumbBg').disabled = !nt;
    $('selThumbBg').textContent = nt ? __('換背景（{0}）', nt) : __('換背景');
    $('selThumbDel').textContent = nt ? __('刪除縮圖（{0}）', nt) : __('刪除縮圖');
    $('selDelete').disabled = !anyRepo;
    $('selDelete').textContent = anyRepo ? __('從倉庫刪除（{0}）', rp.length) : __('從倉庫刪除');
    document.querySelectorAll('.inst-pick').forEach((b) => {
      b.textContent = rp.length ? __('安裝選取（{0}）', rp.length) : __('安裝選取');
      b.disabled = !rp.length;
      b.title = rp.length ? __('把勾選的 {0} 個倉庫模型安裝到這個實例（資料夾會照結構安裝）', rp.length) : __('先在右邊勾選倉庫中的模型或資料夾（點卡片右上角，或 Ctrl / Shift + 點擊）');
    });
  }

  function togglePickFolder(f) {
    if (S.pickedFolders.has(f)) S.pickedFolders.delete(f); else S.pickedFolders.add(f);
    refreshPicks();
  }
  function togglePick(id, on) {
    if (on === undefined ? !S.picked.has(id) : on) S.picked.add(id); else S.picked.delete(id);
  }
  function refreshPicks() {
    document.querySelectorAll('#grid .card').forEach((c) => c.classList.toggle('picked', c.dataset.folder !== undefined ? S.pickedFolders.has(c.dataset.folder) : S.picked.has(c.dataset.id)));
    updateSelUI();
  }

  // folder 有值時：安裝這個倉庫資料夾（含所有子資料夾）中的全部模型，否則安裝勾選的模型
  const installPicked = guard(async (root, folder) => {
    const name = instName(root);
    const isFolder = typeof folder === 'string';
    const rp = isFolder ? S.entries.filter((e) => inFolder(e, folder)) : pickedModels();
    const todo = rp.filter((e) => !e.installs.some((i) => i.root === root));
    if (!rp.length) { toast(isFolder ? __('這個資料夾裡沒有模型') : __('請先勾選倉庫中的模型（點卡片右上角的方框，或 Ctrl / Shift + 點擊卡片）')); return; }
    if (!todo.length) { toast(isFolder ? __('這個資料夾中的模型都已經安裝在「{0}」了', name) : __('選取的模型都已經安裝在「{0}」了', name)); return; }
    const skip = rp.length - todo.length;
    const inSub = todo.filter((e) => e.group).length;
    const what = isFolder ? __('資料夾「{0}」中的 {1} 個模型', folderLabel(folder), todo.length) : __('{0} 個模型', todo.length);
    const where = isFolder
      ? `\n\n${__('會照倉庫的資料夾結構放進遊戲：custom\\{0}\\…', folder.split('/').join('\\'))}`
      : (inSub ? `\n\n${__('其中 {0} 個在倉庫的子資料夾中，會放進遊戲中同名的資料夾。', inSub)}` : '');
    if (!(await confirmBox(isFolder ? __('安裝整個資料夾') : __('安裝選取的模型'), __('把{0}安裝到「{1}」？{2}{3}', what, name, skip ? `\n${__('（另外 {0} 個已經安裝過，會略過）', skip)}` : '', where), { ok: __('安裝') }))) return;
    const ids = todo.map((e) => e.id);
    let res = await api('install_many', ids, root);
    if (res.need_copy) {
      if (await confirmCopy(fmtSize(todo.reduce((a, e) => a + (e.size || 0), 0)))) {
        const more = await api('install_many', ids, root, true);
        res = { done: res.done + more.done, copied: res.copied + more.copied, errors: res.errors.concat(more.errors) };
      } else {
        toast(__('已安裝 {0} 個；其餘的需要改用複製，已取消', res.done));
        await rescan();
        return;
      }
    }
    toast(__('已安裝 {0} 個到「{1}」{2}{3}', res.done, name, res.copied ? __('（其中 {0} 個用複製）', res.copied) : '', res.errors.length ? __('；{0} 個失敗：{1}', res.errors.length, res.errors[0]) : ''), res.errors.length > 0);
    await rescan();
  });

  $('selInstall').onclick = () => { if ($('selInst').value) installPicked($('selInst').value); };
  $('selMove').onclick = guard(async () => {
    let f = $('selFolder').value;
    if (f === '\u0000new') {
      const name = await promptBox(__('新資料夾'), __('在倉庫最上層新增資料夾並把選取的模型移進去，名稱：'));
      if (!name) { updateSelUI(); return; }
      S.folders = await api('create_folder', '', name);
      f = name.trim();
    }
    const folders = topPickedFolders();
    if (folders.length) {
      const affected = S.entries.filter((e) => folders.some((x) => inFolder(e, x)));
      const n = installedIn(affected);
      if (!(await confirmBox(__('移動資料夾'), __('把 {0} 個資料夾移到「{1}」底下？{2}', folders.length, folderLabel(f), n ? `\n\n${__('裡面有 {0} 份已安裝到遊戲，遊戲中的檔案也會照新的結構移動，模型 ID 會跟著改變。', n)}` : ''), { ok: __('移動') }))) return;
      let moved = 0;
      const errors = [];
      for (const x of folders) {
        try { moved += (await api('move_folder', x, f)).moved; } catch (err) { errors.push(`${folderLabel(x)}：${err.message}`); }
      }
      S.pickedFolders.clear();
      toast(__('已移動 {0} 個資料夾{1}{2}', folders.length - errors.length, moved ? __('，遊戲中 {0} 份也已移動', moved) : '', errors.length ? __('；{0} 個失敗：{1}', errors.length, errors[0]) : ''), errors.length > 0);
      if (!S.picked.size) { await rescan(); return; }
    }
    await moveModels([...S.picked], f);
  });
  $('selDelete').onclick = guard(async () => {
    const folders = topPickedFolders();
    const models = pickedModels();
    if (!folders.length && !models.length) { toast(__('沒有勾選倉庫中的模型或資料夾')); return; }
    if (!(await confirmDelete({ folders, models }))) return;
    let done = 0, recycled = 0, fdone = 0;
    const errors = [];
    for (const f of folders) {
      try {
        const r = await api('delete_folder_all', f);
        fdone++; done += r.models; if (r.recycled) recycled += r.models;
      } catch (err) { errors.push(`${folderLabel(f)}：${err.message}`); }
    }
    const rest = models.filter((e) => !folders.some((f) => inFolder(e, f)));
    if (rest.length) {
      const r = await api('delete_many', rest.map((e) => e.id));
      done += r.done; recycled += r.recycled; errors.push(...r.errors);
    }
    S.picked.clear(); S.pickedFolders.clear();
    if (S.sel && models.some((e) => e.id === S.sel)) S.sel = null;
    if (S.folder && folders.some((f) => S.folder === f || S.folder.startsWith(f + '/'))) S.folder = '';
    toast(__('已刪除 {0}{1} 個模型{2}{3}', fdone ? __('{0} 個資料夾、', fdone) : '', done, done ? (recycled === done ? __('（已移到資源回收筒）') : recycled ? __('（{0} 個移到資源回收筒）', recycled) : __('（永久刪除）')) : '', errors.length ? __('；{0} 個失敗：{1}', errors.length, errors[0]) : ''), errors.length > 0);
    await rescan();
  });
  // 批量刪除遊戲實例中的模型（倉庫中的那份不受影響）
  $('selDelInst').onclick = guard(async () => {
    const list = S.entries.filter((e) => S.picked.has(e.id) && e.location !== 'repo');
    if (!list.length) { toast(__('沒有勾選遊戲實例中的模型')); return; }
    const info = await api('delete_info', list[0].id);
    const fate = info.recycle
      ? `${__('檔案會移到<b>資源回收筒</b>，需要時可以還原。')}`
      : `<span class="warn">${__('遊戲實例所在的磁碟沒有資源回收筒，刪除後無法復原！')}</span>`;
    const repoKeys = new Set(S.entries.filter((e) => e.location === 'repo').map((e) => e.key));
    const noBackup = list.filter((e) => !repoKeys.has(e.key)).length;
    const lines = list.map((e) => `・${esc(displayName(e))}　<span class="muted">${esc(instName(e.root))}</span>`);
    const names = lines.slice(0, 10).join('\n') + (lines.length > 10 ? `\n${__('…還有 {0} 個', lines.length - 10)}` : '');
    const size = list.reduce((a, e) => a + (e.size || 0), 0);
    const r1 = await ask({
      title: __('從遊戲實例刪除'),
      body: `${__('要從遊戲實例刪除 <b>{0} 個模型</b>嗎？（共 {1}）\n刪除後遊戲中就不能再使用這些模型；倉庫中的那份不受影響。\n\n{2}', list.length, fmtSize(size), names)}`
        + (noBackup ? `\n\n<span class="warn">${__('其中 {0} 個倉庫中沒有備份。', noBackup)}</span>` : __('\n\n倉庫中都有備份，之後可以再安裝回來。'))
        + `\n\n${fate}`,
      ok: __('刪除'), danger: true,
    });
    if (!r1.ok) return;
    if (!S.settings || S.settings.confirm_delete_twice !== false) {
      const r2 = await ask({ title: __('再次確認'), body: `${__('真的要從遊戲實例刪除 <b>{0} 個模型</b>嗎？\n\n{1}', list.length, fate)}`, ok: __('確定刪除'), cancel: __('不要刪除'), danger: true });
      if (!r2.ok) return;
    }
    const r = await api('delete_many', list.map((e) => e.id), 'instance');
    for (const e of list) S.picked.delete(e.id);
    if (S.sel && list.some((e) => e.id === S.sel)) S.sel = null;
    toast(__('已從遊戲實例刪除 {0} 個模型{1}{2}', r.done, r.done ? (r.recycled === r.done ? __('（已移到資源回收筒）') : r.recycled ? __('（{0} 個移到資源回收筒）', r.recycled) : __('（永久刪除）')) : '', r.errors.length ? __('；{0} 個失敗：{1}', r.errors.length, r.errors[0]) : ''), r.errors.length > 0);
    await rescan();
  });

  // 勾選的模型（任何位置）加上勾選資料夾中的模型，有縮圖的，依模型 key 去重
  function thumbPicked() {
    const fs = [...S.pickedFolders];
    const seen = new Set();
    return S.entries.filter((e) => (S.picked.has(e.id) || fs.some((f) => inFolder(e, f))) && e.user && e.user.thumb && !seen.has(e.key) && seen.add(e.key));
  }
  $('selThumbDel').onclick = guard(async () => {
    const list = thumbPicked();
    if (!list.length) { toast(__('勾選的模型都沒有縮圖')); return; }
    if (!(await confirmBox(__('刪除縮圖'), __('刪除 {0} 個模型的縮圖？\n\n只會刪除縮圖圖片，模型檔案不受影響。刪除後無法復原，需要時可以重新產生。', list.length), { ok: __('刪除縮圖'), danger: true }))) return;
    const r = await api('clear_thumbs', list.map((e) => e.key));
    for (const [k, rec] of Object.entries(r.users)) applyUser(k, rec);
    toast(__('已刪除 {0} 張縮圖', r.removed));
    renderGrid(); renderDetail(); updateSelUI();
  });
  // ---- 批量換背景：只處理透明背景的縮圖，原圖會保留（thumb_src），可以再換或還原 ----
  const BG = { mode: 'solid', img: null, list: [] };
  const BG_PRESETS = [
    { n: __('深色'), mode: 'solid', c1: '#23272f' }, { n: __('淺灰'), mode: 'solid', c1: '#e9ecf1' },
    { n: __('天空'), mode: 'grad', g1: '#7ec8ff', g2: '#e3f4ff' }, { n: __('草地'), mode: 'grad', g1: '#9fd6ff', g2: '#5fae4c' },
    { n: __('夕陽'), mode: 'grad', g1: '#ffb36b', g2: '#ff6f91' }, { n: __('星空'), mode: 'grad', g1: '#0b0f1e', g2: '#2a3a78' },
  ];
  const srcURL = (e) => {
    const n = e.user && (e.user.thumb_src || e.user.thumb);
    return n ? `/api/thumb/${encodeURIComponent(n)}?${tq}` : '';
  };
  const loadImg = (url) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error(__('讀不到縮圖'))); i.src = url; });
  function hasAlpha(img) {
    const c = document.createElement('canvas');
    const w = c.width = Math.min(img.naturalWidth, 160), h = c.height = Math.round(img.naturalHeight * w / img.naturalWidth) || 1;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
  }
  function composeBg(img) {
    const c = document.createElement('canvas');
    const W = c.width = img.naturalWidth, H = c.height = img.naturalHeight;
    const x = c.getContext('2d');
    if (BG.mode === 'solid') { x.fillStyle = $('bgC1').value; x.fillRect(0, 0, W, H); }
    else if (BG.mode === 'grad') {
      const g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, $('bgG1').value); g.addColorStop(1, $('bgG2').value);
      x.fillStyle = g; x.fillRect(0, 0, W, H);
    } else if (BG.mode === 'image' && BG.img) {
      const s = Math.max(W / BG.img.naturalWidth, H / BG.img.naturalHeight);  // 填滿、置中裁切
      const w = BG.img.naturalWidth * s, h = BG.img.naturalHeight * s;
      x.drawImage(BG.img, (W - w) / 2, (H - h) / 2, w, h);
    }
    x.drawImage(img, 0, 0);
    return c;
  }
  function setBgMode(m) {
    BG.mode = m;
    $('bgMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    document.querySelectorAll('#bgModal .bg-row').forEach((r) => { r.hidden = r.dataset.for !== m; });
    bgPreview();
  }
  let bgPrevImg = null;
  function bgPreview() {
    const box = $('bgPrev');
    if (!bgPrevImg) { box.style.backgroundImage = ''; return; }
    const url = BG.mode === 'none' ? bgPrevImg.src : composeBg(bgPrevImg).toDataURL('image/png');
    box.style.backgroundImage = `url('${url}')`;
  }
  $('bgPresets').innerHTML = BG_PRESETS.map((p, i) => `<button class="bg-pre" data-i="${i}" title="${p.n}" style="background:${p.mode === 'solid' ? p.c1 : `linear-gradient(${p.g1}, ${p.g2})`}"><span>${p.n}</span></button>`).join('');
  $('bgPresets').onclick = (ev) => {
    const b = ev.target.closest('.bg-pre'); if (!b) return;
    const p = BG_PRESETS[+b.dataset.i];
    if (p.mode === 'solid') $('bgC1').value = p.c1; else { $('bgG1').value = p.g1; $('bgG2').value = p.g2; }
    setBgMode(p.mode);
  };
  $('bgMode').onclick = (ev) => { const b = ev.target.closest('button'); if (b) setBgMode(b.dataset.m); };
  for (const id of ['bgC1', 'bgG1', 'bgG2']) $(id).oninput = bgPreview;
  $('bgPick').onclick = () => $('bgFile').click();
  $('bgFile').onchange = guard(async () => {
    const f = $('bgFile').files[0]; if (!f) return;
    const url = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
    BG.img = await loadImg(url);
    $('bgImgName').textContent = f.name;
    bgPreview();
  });
  $('selThumbBg').onclick = guard(async () => {
    BG.list = thumbPicked();
    if (!BG.list.length) { toast(__('勾選的模型都沒有縮圖')); return; }
    bgPrevImg = null;
    const withSrc = BG.list.filter((e) => e.user.thumb_src).length;
    $('bgInfo').textContent = __('{0} 個模型有縮圖{1}', BG.list.length, withSrc ? __('，其中 {0} 個換過背景', withSrc) : '');
    $('bgModal').hidden = false;
    // 預覽用第一張透明背景的縮圖
    for (const e of BG.list.slice(0, 30)) {
      try { const im = await loadImg(srcURL(e)); if (hasAlpha(im)) { bgPrevImg = im; $('bgPrevName').textContent = displayName(e); break; } } catch (err) { /* 略過 */ }
    }
    if (!bgPrevImg) $('bgPrevName').textContent = __('前幾個都不是透明背景的縮圖');
    bgPreview();
  });
  $('bgApply').onclick = guard(async () => {
    const list = BG.list;
    if (BG.mode === 'image' && !BG.img) { toast(__('請先選擇背景圖片'), true); return; }
    closeModal($('bgModal'));
    if (BG.mode === 'none') {
      const r = await api('restore_thumb_bg', list.map((e) => e.key));
      for (const [k, rec] of Object.entries(r.users)) applyUser(k, rec);
      toast(r.restored ? __('已還原 {0} 張縮圖的原本背景', r.restored) : __('勾選的縮圖都沒有換過背景'));
    } else {
      let done = 0, skip = 0, fail = 0;
      for (const [i, e] of list.entries()) {
        toast(__('換背景中… {0} / {1}', i + 1, list.length));
        try {
          const im = await loadImg(srcURL(e));
          if (!hasAlpha(im)) { skip++; continue; }
          const rec = await api('set_thumb_bg', e.key, composeBg(im).toDataURL('image/png'));
          applyUser(e.key, rec);
          done++;
        } catch (err) { fail++; }
      }
      toast(__('已換 {0} 張縮圖的背景{1}{2}', done, skip ? __('，略過 {0} 張（不是透明背景，例如沒有去除背景的遊戲截圖）', skip) : '', fail ? __('，{0} 張失敗', fail) : ''), fail > 0);
    }
    renderGrid(); renderDetail(); updateSelUI();
  });
  $('selFolder').onchange =() => { if ($('selFolder').value === '\u0000new') $('selMove').click(); };
  $('selNone').onclick = () => { S.picked.clear(); S.pickedFolders.clear(); refreshPicks(); };
  // 全選目前篩選結果的所有模型（包含其他分頁、合併在同一張卡裡的所有版本），瀏覽資料夾時連同這一層的子資料夾
  $('selPage').onclick = () => {
    for (const it of groupVersions(filtered())) for (const v of versionsOf(it.e)) S.picked.add(v.id);
    if (browsingFolders()) for (const f of childFolders(S.folder).filter((x) => !modelFolders().has(x))) S.pickedFolders.add(f);
    refreshPicks();
  };
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && (S.picked.size || S.pickedFolders.size) && !document.querySelector('.modal:not([hidden])')) { S.picked.clear(); S.pickedFolders.clear(); refreshPicks(); }
  });

  // ---- 分頁 ----
  const PAGE = { size: 48, page: 0, sig: '', reveal: false };
  try {
    const v = localStorage.getItem('ysmgr.pageSize');
    if (v !== null && [24, 48, 96, 0].includes(Number(v))) PAGE.size = Number(v);
  } catch (e) { /* 忽略 */ }

  function renderPager(total, pages) {
    const p = $('pager');
    p.hidden = total === 0;
    const btn = (label, to, opts = {}) => `<button class="pg${opts.on ? ' on' : ''}" ${opts.dis ? 'disabled' : ''} data-to="${to}" title="${opts.title || ''}">${label}</button>`;
    let nums = '';
    if (pages > 1) {
      const cur = PAGE.page, set = new Set([0, pages - 1, cur - 2, cur - 1, cur, cur + 1, cur + 2]);
      let last = -1;
      for (let i = 0; i < pages; i++) {
        if (!set.has(i)) continue;
        if (last >= 0 && i - last > 1) nums += '<span class="gap">…</span>';
        nums += btn(i + 1, i, { on: i === cur });
        last = i;
      }
    }
    const from = total ? (PAGE.size ? PAGE.page * PAGE.size + 1 : 1) : 0;
    const to = PAGE.size ? Math.min(total, (PAGE.page + 1) * PAGE.size) : total;
    p.innerHTML = `<span class="muted">${__('第 {0}–{1} 個，共 {2} 個', from, to, total)}</span>
      <span class="pg-nums">${pages > 1 ? btn('‹', PAGE.page - 1, { dis: PAGE.page === 0, title: __('上一頁（PageUp）') }) + nums + btn('›', PAGE.page + 1, { dis: PAGE.page >= pages - 1, title: __('下一頁（PageDown）') }) : ''}</span>
      <label class="muted">${__('每頁')}<select id="pageSize">${[24, 48, 96, 0].map((n) => `<option value="${n}" ${n === PAGE.size ? 'selected' : ''}>${n || __('全部')}</option>`).join('')}</select></label>`;
    p.querySelectorAll('button[data-to]').forEach((b) => { b.onclick = () => gotoPage(Number(b.dataset.to)); });
    $('pageSize').onchange = () => {
      PAGE.size = Number($('pageSize').value);
      try { localStorage.setItem('ysmgr.pageSize', String(PAGE.size)); } catch (e) { /* 忽略 */ }
      PAGE.reveal = true;
      renderGrid();
    };
  }
  function gotoPage(n) { PAGE.page = n; renderGrid(); $('grid').scrollTop = 0; }
  window.addEventListener('keydown', (ev) => {
    if (!['PageUp', 'PageDown'].includes(ev.key) || document.querySelector('.modal:not([hidden])')) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
    const pages = PAGE.size ? Math.ceil(groupVersions(filtered()).length / PAGE.size) : 1;
    const n = PAGE.page + (ev.key === 'PageDown' ? 1 : -1);
    if (n >= 0 && n < pages) { ev.preventDefault(); gotoPage(n); }
  });

  // ---- 同角色多版本：檔名去掉結尾的版本號後相同的，合併成一張卡 ----
  function verInfo(e) {
    if (e._ver) return e._ver;
    let stem = e.kind === 'folder' ? e.filename : e.filename.replace(/\.(ysm|zip|7z)$/i, '');
    const m = stem.match(/[\s_\-·]*[vV]?(\d+(?:\.\d+)*)$/);
    let ver = '';
    if (m && m.index > 0) { ver = m[1]; stem = stem.slice(0, m.index); }
    // 忽略大小寫、分隔符號與字的順序（「芙宁娜Lv.999-白」＝「芙宁娜·白Lv.999」）
    const norm = stem.toLowerCase().replace(/[\s_\-·・.()（）[\]【】]/g, '');
    e._ver = { base: norm ? [...norm].sort().join('') : e.id, ver };
    return e._ver;
  }
  const cmpVer = (a, b) => {
    // 兩段式（1.12、1.4）照模型作者的習慣當小數比：1.12 < 1.4；三段以上照一般版本號比
    if (/^\d+\.\d+$/.test(a) && /^\d+\.\d+$/.test(b)) return parseFloat(a) - parseFloat(b);
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  };
  const newerFirst = (a, b) => {
    const va = verInfo(a).ver, vb = verInfo(b).ver;
    const byVer = va && vb ? cmpVer(vb, va) : (va ? -1 : vb ? 1 : 0);
    return byVer || b.mtime - a.mtime;
  };
  // 同名但作者完全不同的（例如兩位作者各做的「胡桃」）不合併；作者有重疊的視為同一系列。
  // 沒有作者資訊的：同名只有一個作者系列時併進去，否則自成一組
  const authorSet = (e) => new Set(((e.meta && e.meta.authors) || []).map((a) => String(a.name || '').trim().toLowerCase()).filter(Boolean));
  function groupKey(e) {
    if (e._gk) return e._gk;
    const base = e.location + '|' + verInfo(e).base;
    const same = S.entries.filter((x) => x.location + '|' + verInfo(x).base === base);
    const clusters = []; // [{ names: Set, members: [] }]
    const unknown = [];
    for (const x of same) {
      const names = authorSet(x);
      if (!names.size) { unknown.push(x); continue; }
      const hit = clusters.filter((c) => [...names].some((n) => c.names.has(n)));
      const c = hit[0] || { names: new Set(), members: [] };
      if (!hit.length) clusters.push(c);
      for (const o of hit.slice(1)) { o.names.forEach((n) => c.names.add(n)); c.members.push(...o.members); clusters.splice(clusters.indexOf(o), 1); }
      names.forEach((n) => c.names.add(n));
      c.members.push(x);
    }
    clusters.forEach((c, i) => c.members.forEach((x) => { x._gk = base + '|' + i; }));
    unknown.forEach((x) => { x._gk = base + '|' + (clusters.length === 1 ? 0 : '?'); });
    return e._gk || (e._gk = base + '|?');
  }
  const grouping = () => !S.settings || S.settings.group_versions !== false;
  function versionsOf(e) {
    if (!grouping()) return [e];
    const k = groupKey(e);
    return S.entries.filter((x) => groupKey(x) === k).sort(newerFirst);
  }
  // 回傳 [{ k, e: 代表（選取中的版本，否則最新版）, members }]
  function groupVersions(list) {
    if (!grouping()) return list.map((e) => ({ k: e.id, e, members: [e] }));
    const groups = new Map();
    for (const e of list) {
      const k = groupKey(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const out = [];
    for (const [k, g] of groups) {
      g.sort(newerFirst);
      out.push({ k, e: g.find((x) => x.id === S.sel) || g[0], members: g });
    }
    // 維持原本的排序：以群組中排最前面的成員的位置為準
    const pos = new Map(list.map((e, i) => [e.id, i]));
    out.sort((a, b) => Math.min(...a.members.map((m) => pos.get(m.id))) - Math.min(...b.members.map((m) => pos.get(m.id))));
    return out;
  }

  function renderGrid() {
    const files = filtered();
    const all = groupVersions(files);
    // 篩選/搜尋/排序改變時回到第一頁；若選取的模型還在清單中，跳到它所在的那一頁
    const sig = S.loc + '#' + S.folder + '#' + all.map((it) => it.k).join('|');
    if (sig !== PAGE.sig || PAGE.reveal) {
      const idx = S.sel ? all.findIndex((it) => it.members.some((m) => m.id === S.sel)) : -1;
      PAGE.page = idx >= 0 && PAGE.size ? Math.floor(idx / PAGE.size) : 0;
      if (sig !== PAGE.sig) $('grid').scrollTop = 0;
      PAGE.sig = sig;
      PAGE.reveal = false;
    }
    const pages = PAGE.size ? Math.max(1, Math.ceil(all.length / PAGE.size)) : 1;
    PAGE.page = Math.max(0, Math.min(PAGE.page, pages - 1));
    const list = PAGE.size ? all.slice(PAGE.page * PAGE.size, (PAGE.page + 1) * PAGE.size) : all;
    renderPager(all.length, pages);
    const grid = $('grid');
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    renderCrumbs();
    if (browsingFolders() && PAGE.page === 0) folderCards(frag);
    for (const it of list) {
      const e = it.e;
      const c = document.createElement('div');
      c.className = 'card' + (e.id === S.sel ? ' sel' : '') + (e.enabled ? '' : ' off') + (S.picked.has(e.id) ? ' picked' : '');
      c.dataset.id = e.id;
      // 這個版本沒有縮圖時，借用同角色其他版本的
      const th = thumbURL(e) || thumbURL(it.members.find((m) => m.user.thumb) || e);
      const stars = e.user.rating ? '★'.repeat(e.user.rating) : '';
      c.innerHTML = `<div class="thumb" ${th ? `style="background-image:url('${th}')"` : ''}>${th ? '' : `<span class="ph">${esc(kindLabel[e.kind] || '?')}</span>`}<span class="pick" title="${__('勾選（也可以 Ctrl / Shift + 點擊卡片，或在卡片之間的空白處拖曳框選）')}">✓</span>
          <span class="badge${e.location === 'repo' ? ' repo' : ''}" title="${esc(placesOf(e).join('、'))}">${esc(placesOf(e).join('＋'))}${placesOf(e).length ? ' · ' : ''}${esc(kindLabel[e.kind] || e.kind)}</span>${e.kind === 'ysm' ? `<span class="badge lock">${__('加密')}</span>` : ''}${e.enabled ? '' : `<span class="badge offb">${__('已停用')}</span>`}${it.members.length > 1 ? `<span class="badge ver" title="${__('同一個角色有 {0} 個版本，點開可切換', it.members.length)}">${__('{0} 個版本', it.members.length)}</span>` : ''}
          ${e.location === 'repo' ? `<span class="badge inst">${__('已裝 {0}/{1}', e.installs.length, S.instances.filter((i) => i.is_instance).length)}</span>` : (S.repo && !e.repo_id ? `<span class="badge norepo">${__('未入庫')}</span>` : '')}</div>
        <div class="meta"><div class="nm" title="${esc(displayName(e))}">${esc(displayName(e))}</div>
          <div class="au">${esc(authorText(e) || e.filename)}</div>
          ${e.location !== 'repo' && S.roots.length > 1 ? `<div class="au" title="${esc(e.root)}">📁 ${esc(e.instance)}</div>` : ''}
          ${e.location === 'repo' && e.group && S.folder !== e.group && !(S.folder !== null && parentOf(e.group) === S.folder && modelFolders().has(e.group)) ?`<div class="au" title="${__('倉庫資料夾')}">📂 ${esc(folderLabel(e.group))}</div>` : ''}
          <div class="stars">${stars}</div>
          <div class="tg">${(e.user.tags || []).slice(0, 4).map((t) => `<span>${esc(t)}</span>`).join('')}</div></div>`;
      c.onclick = (ev) => {
        if (ev.shiftKey && S.lastPick) {
          // 範圍勾選：本頁中從上次勾選的卡片到這張
          const ids = list.map((x) => x.e.id);
          const a = ids.indexOf(S.lastPick), b = ids.indexOf(e.id);
          if (a >= 0 && b >= 0) {
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.picked.add(ids[i]);
            refreshPicks();
            return;
          }
        }
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.target.closest('.pick')) {
          togglePick(e.id);
          S.lastPick = e.id;
          refreshPicks();
          return;
        }
        S.sel = e.id; renderGrid(); renderDetail();
      };
      if (e.location === 'repo') {
        c.draggable = true;
        c.ondragstart = (ev) => {
          const ids = S.picked.has(e.id) ? [...S.picked] : [e.id];
          ev.dataTransfer.setData('text/ysm-ids', JSON.stringify(ids));
          ev.dataTransfer.effectAllowed = 'move';
        };
      }
      c.ondblclick = () => { if (e.previewable) openPreview(e); };
      frag.appendChild(c);
    }
    grid.appendChild(frag);
    $('count').textContent = all.length === files.length
      ? __('{0} / {1} 個模型', files.length, S.entries.length)
      : __('{0} 張卡（{1} / {2} 個檔案）', all.length, files.length, S.entries.length);
    $('emptyState').hidden = S.entries.length > 0;
  }

  function renderAll() {
    renderLoc();
    updateSelUI();
    renderRepo();
    renderTags();
    renderGrid();
    renderDetail();
    const on = S.entries.filter((e) => e.enabled).length;
    $('footInfo').textContent = S.entries.length ? __('共 {0} 個，啟用 {1}，停用 {2}', S.entries.length, on, S.entries.length - on) : '';
  }

  for (const [id, key] of [['fStatus', 'status'], ['fKind', 'kind']]) {
    $(id).addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      S[key] = b.dataset.v;
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      renderGrid();
    });
  }
  $('search').oninput = (e) => { S.search = e.target.value; renderGrid(); };
  $('sort').onchange = (e) => { S.sort = e.target.value; renderGrid(); };

  // ---------------- 詳細資料 ----------------
  const cur = () => S.entries.find((e) => e.id === S.sel);

  function applyUser(key, rec) {
    for (const e of S.entries) if (e.key === key) e.user = rec;
  }
  const saveUser = guard(async (e, fields) => {
    const rec = await api('update_user', e.key, fields);
    applyUser(e.key, rec);
    renderTags();
    renderGrid();
  });

  function installSection(e) {
    if (!S.repo) return '';
    if (e.location === 'repo') {
      const rows = S.instances.filter((i) => i.is_instance).map((inst) => {
        const ins = e.installs.find((x) => x.root === inst.root);
        const state = ins
          ? `<span class="s ok">${__('已安裝 · {0}{1}', ins.link === 'hardlink' ? __('硬連結') : __('複製'), ins.enabled ? '' : __(' · 停用中'))}</span>`
          : `<span class="s">${__('未安裝')}</span>`;
        const btn = ins
          ? `<button class="btn small ghost" data-un="${esc(ins.id)}">${__('移除')}</button>`
          : `<button class="btn small" data-in="${esc(inst.root)}">${__('安裝')}</button>`;
        return `<div class="inst-row"><span class="n"><b title="${esc(inst.root)}">${esc(inst.name)}</b>${state}</span>${btn}</div>`;
      }).join('');
      return `<div class="d-sec"><h3>${__('安裝到遊戲實例')}</h3><div class="inst-list" id="dInst">${rows || `<span class="muted">${__('尚未加入遊戲實例')}</span>`}</div></div>`;
    }
    if (e.repo_id) {
      return `<div class="d-sec"><h3>${__('倉庫')}</h3><div class="inst-row"><span class="n"><span class="s ok">${__('倉庫中已有這個模型')}</span></span><button class="btn small ghost" data-goto="${esc(e.repo_id)}">${__('查看倉庫項目')}</button></div></div>`;
    }
    return `<div class="d-sec"><h3>${__('倉庫')}</h3><div class="inst-row"><span class="n"><span class="s">${__('還沒加入倉庫')}</span></span><button class="btn small" data-import="1">${__('加入倉庫')}</button></div></div>`;
  }

  function bindInstallSection(box, e) {
    box.querySelectorAll('[data-in]').forEach((b) => {
      b.onclick = guard(async () => {
        b.disabled = true;
        let res = await api('install', e.id, b.dataset.in);
        if (res.need_copy) {
          if (!(await confirmCopy(fmtSize(e.size || 0)))) { b.disabled = false; return; }
          res = await api('install', e.id, b.dataset.in, true);
        }
        toast(__('已安裝到「{0}」{1}', instName(b.dataset.in), res.fallback ? __('（用複製）') : ''));
        await rescan();
      });
    });
    box.querySelectorAll('[data-un]').forEach((b) => {
      b.onclick = guard(async () => {
        const ins = e.installs.find((x) => x.id === b.dataset.un);
        if (!(await confirmBox(__('從實例移除'), __('從「{0}」移除這個模型？\n倉庫中的檔案會保留，之後可以再安裝。', ins ? ins.instance : ''), { ok: __('移除') }))) return;
        await api('uninstall', b.dataset.un);
        toast(__('已從實例移除'));
        await rescan();
      });
    });
    const g = box.querySelector('[data-goto]');
    if (g) g.onclick = () => { S.sel = g.dataset.goto; PAGE.reveal = true; if (S.loc !== 'all' && S.loc !== 'repo') S.loc = 'all'; renderLoc(); renderGrid(); renderDetail(); };
    const im = box.querySelector('[data-import]');
    if (im) im.onclick = guard(async () => {
      im.disabled = true;
      const res = await api('import_to_repo', e.id);
      toast(res.linked ? __('已加入倉庫，實例中的檔案已換成硬連結') : __('已加入倉庫（複製）'));
      await rescan();
    });
  }

  // ---- 模型資訊中的連結：每個連結一個「前往」按鈕，開啟前先警告 ----
  const URL_RE = /https?:\/\/[^\s<>"'）)】」』，。、；]+/gi;
  function modelLinks(e) {
    const out = [...((e.meta && e.meta.links) || [])];
    const add = (label, text) => {
      for (let u of String(text || '').match(URL_RE) || []) {
        u = u.replace(/[.,;:!?]+$/, '');
        if (!out.some((x) => x.url === u)) out.push({ label, url: u });
      }
    };
    add(__('說明中的連結'), e.meta && e.meta.tips);
    add(__('檔頭公開資訊中的連結'), e.summary && e.summary.text);
    return out.slice(0, 20);
  }
  const hostOf = (u) => { try { return new URL(u).host; } catch (err) { return ''; } };
  // 常見網站：只在網域完全相同或是它的子網域時才算（bilibili.com.xxx.com 這種不算）
  const SITES = [
    { d: ['bilibili.com', 'b23.tv', 'bilibili.tv'], name: __('B站'), color: '#fb7299', key: 'bilibili' },
    { d: ['afdian.com', 'afdian.net', 'ifdian.net'], name: __('愛發電'), color: '#946ce6', key: 'afdian' },
    { d: ['mianbaoduo.com', 'mbd.pub'], name: __('麵包多'), color: '#f5a623', key: 'mianbaoduo' },
    { d: ['github.com', 'github.io'], name: 'GitHub', color: '#8b949e', key: 'github' },
    { d: ['gitee.com'], name: 'Gitee', color: '#c71d23', key: 'gitee' },
    { d: ['youtube.com', 'youtu.be'], name: 'YouTube', color: '#ff3d3d', key: 'youtube' },
    { d: ['twitter.com', 'x.com'], name: 'X（Twitter）', color: '#9aa1ad', key: 'twitter' },
    { d: ['weibo.com', 'weibo.cn'], name: __('微博'), color: '#e6162d', key: 'weibo' },
    { d: ['xiaohongshu.com', 'xhslink.com'], name: __('小紅書'), color: '#ff2442', key: 'xiaohongshu' },
    { d: ['douyin.com'], name: __('抖音'), color: '#25f4ee', key: 'douyin' },
    { d: ['qq.com'], name: 'QQ', color: '#12b7f5', key: 'qq' },
    { d: ['kookapp.cn', 'kook.top'], name: 'KOOK', color: '#7dd321', key: 'kook' },
    { d: ['discord.gg', 'discord.com'], name: 'Discord', color: '#5865f2', key: 'discord' },
    { d: ['patreon.com'], name: 'Patreon', color: '#ff424d', key: 'patreon' },
    { d: ['ko-fi.com'], name: 'Ko-fi', color: '#29abe0', key: 'ko-fi' },
    { d: ['pixiv.net'], name: 'pixiv', color: '#0096fa', key: 'pixiv' },
    { d: ['booth.pm'], name: 'BOOTH', color: '#fc4d50', key: 'booth' },
    { d: ['taobao.com', 'tb.cn', 'tmall.com'], name: __('淘寶'), color: '#ff5000', key: 'taobao' },
    { d: ['mcmod.cn'], name: __('MC 百科'), color: '#5fcf8a', key: 'mcmod' },
    { d: ['curseforge.com'], name: 'CurseForge', color: '#f16436', key: 'curseforge' },
    { d: ['modrinth.com'], name: 'Modrinth', color: '#1bd96a', key: 'modrinth' },
    { d: ['mcbbs.net', 'mcbbs.co'], name: 'MCBBS', color: '#c9a063', key: 'mcbbs' },
  ];
  function siteOf(url) {
    const h = hostOf(url).toLowerCase().replace(/:\d+$/, '');
    if (!h) return null;
    const hit = SITES.find((s) => s.d.some((d) => h === d || h.endsWith('.' + d)));
    if (hit) {
      // 依網址再細分（B站個人空間、影片…）
      let sub = '';
      if (hit.key === 'bilibili') sub = h.startsWith('space.') ? __('個人空間') : /\/video\//.test(url) || h === 'b23.tv' ? __('影片') : '';
      if (hit.key === 'qq') sub = h.startsWith('qm.') || /jq\.qq\.com/.test(h) ? __('加群') : '';
      if (hit.key === 'afdian') sub = __('贊助頁');
      return { ...hit, label: hit.name + (sub ? ' · ' + sub : ''), fake: false };
    }
    // 網域裡有知名網站的名字、但不是官方網域：疑似仿冒
    const look = SITES.find((s) => (s.key.length >= 5 && h.includes(s.key)) ||s.d.some((d) => h.includes(d.split('.')[0]) && d.split('.')[0].length >= 5));
    return look ? { name: look.name, color: '#f0b35a', label: __('不是{0}官方網址', look.name), fake: true } : null;
  }
  const siteChip = (s) => (s ? `<span class="site${s.fake ? ' fake' : ''}" style="--c:${s.color}">${s.fake ? '⚠ ' : ''}${esc(s.label)}</span>` : '');
  function linksSection(e) {
    const links = modelLinks(e);
    if (!links.length) return '';
    const rows = links.map((l) => `<div class="link-row">
        <span class="n"><b>${siteChip(siteOf(l.url))}${esc(l.label)}</b><small title="${esc(l.url)}">${esc(l.url)}</small></span>
        <button class="btn small ghost" data-url="${esc(l.url)}" data-label="${esc(l.label)}">${__('前往 ↗')}</button>
      </div>`).join('');
    return `<div class="d-sec"><h3>${__('連結（{0}）', links.length)}</h3><div class="link-list">${rows}</div>
      <div class="muted small-note">${__('這些連結由模型作者提供，管理器無法確認是否安全，開啟前會再提醒一次。')}</div></div>`;
  }
  async function openExternal(url, label) {
    const host = hostOf(url);
    if (!host || !/^https?:$/i.test(new URL(url).protocol)) { toast(__('只能開啟 http 或 https 連結'), true); return; }
    const site = siteOf(url);
    const r = await ask({
      title: __('即將開啟外部連結'),
      body: `${__('{0}網站：{1}\n<small>{2}</small>', label ? esc(label) + '\n' : '', site && !site.fake ? `<b>${esc(site.label)}</b>（${esc(host)}）` : `<b>${esc(host)}</b>`, esc(url))}\n\n`
        + (site && site.fake ? `<span class="warn">${__('⚠⚠ 這個網址看起來像「{0}」，但不是它的官方網域，很可能是仿冒網站！', esc(site.name))}</span>\n` : '')
        + `<span class="warn">${__('⚠ 這是模型作者提供的連結，管理器無法確認它是否安全。')}</span>\n`
        + __('・確認網址是你預期的網站，小心仿冒網址\n')
        + __('・不要在不熟悉的網站輸入密碼、帳號或付款資訊\n')
        + __('・不要下載或執行來路不明的檔案')
        + (/^http:/i.test(url) ? `\n・<span class="warn">${__('這個連結沒有加密（http），傳送的資料可能被看到')}</span>` : ''),
      ok: __('在瀏覽器開啟'), cancel: __('不要開啟'), danger: true,
    });
    if (r.ok) await api('open_url', url);
  }
  // 讓內嵌的 3D 預覽器（iframe）也走同一個警告
  window.ysmOpenLink = guard(openExternal);

  function versionsSection(e) {
    const vs = versionsOf(e);
    if (vs.length < 2) return '';
    const rows = vs.map((v, i) => {
      const ver = verInfo(v).ver;
      const dir = v.rel.includes('/') ? v.rel.slice(0, v.rel.lastIndexOf('/')) : '';
      return `<button class="ver-row${v.id === e.id ? ' on' : ''}" data-ver="${esc(v.id)}" title="${esc(v.rel)}">
        <span class="v">${ver ? 'v' + esc(ver) : __('（無版本號）')}</span>
        <span class="f">${esc(v.filename)}${dir ? `<small>${esc(dir)}</small>` : ''}</span>
        <span class="t">${i === 0 ? `${__('<i class="new">最新</i>')}` : ''}${v.location === 'repo' && v.installs.length ? `${__('<i>已裝 {0}</i>', v.installs.length)}` : ''}${fmtSize(v.size || 0)}</span>
      </button>`;
    }).join('');
    return `<div class="d-sec"><h3>${__('版本（{0}）', vs.length)}</h3><div class="ver-list">${rows}</div>
      <div class="muted small-note">${__('點選切換；安裝、刪除、縮圖等操作都只針對目前選取的版本。')}</div></div>`;
  }

  function renderDetail() {
    const e = cur();
    $('app').classList.toggle('no-detail', !e);
    const box = $('detailBody');
    if (!e) { box.innerHTML = ''; return; }
    const m = e.meta || {};
    const th = thumbURL(e);
    const authors = (m.authors || []).map((a) => `<div class="author-line">${esc(a.name)}${a.role ? ` <span class="r">· ${esc(a.role)}</span>` : ''}</div>`).join('');
    box.innerHTML = `
      <button class="d-close" id="dClose" title="${__('關閉')}">✕</button>
      <div class="d-thumb ${th ? 'has' : ''}" id="dThumb" ${th ? `style="background-image:url('${th}')"` : ''}>
        <div class="hint">${__('把圖片拖到這裡、按 Ctrl+V 貼上，<br>或用下方按鈕設定縮圖')}</div>
      </div>
      <div class="row">
        <button class="btn small ghost" id="bShot">${__('從遊戲截圖選')}</button>
        <button class="btn small ghost" id="bImg">${__('選擇圖片')}</button>
        ${th ? `<button class="btn small danger" id="bClr">${__('清除')}</button>` : ''}
      </div>
      <div class="d-title">${esc(displayName(e))}</div>
      <div class="d-sub">${esc(e.filename)}</div>
      ${versionsSection(e)}
      <div class="row">
        ${e.previewable ? `<button class="btn" id="bPrev">${__('3D 預覽')}</button>` : ''}
        ${e.source ? `<button class="btn ghost" id="bToggle">${e.enabled ? __('停用') : __('啟用')}</button>` : ''}
        <button class="btn ghost" id="bReveal">${__('在檔案總管中顯示')}</button>
        <button class="btn ghost" id="bRename">${__('重新命名')}</button>
        <button class="btn danger" id="bDelModel">${e.location === 'repo' ? __('從倉庫刪除') : __('刪除')}</button>
      </div>
      ${installSection(e)}
      ${e.kind === 'ysm' ? `<div class="d-sec note">${__('這是加密的 .ysm 模型，只能在遊戲內的 YSM 選單預覽 3D。建議在遊戲中截圖，再用「從遊戲截圖選」設為縮圖。')}</div>` : ''}
      ${e.error ? `<div class="d-sec note" style="color:var(--warn)">${esc(e.error)}</div>` : ''}

      <div class="d-sec"><h3>${__('評分')}</h3><div class="stars-edit" id="dStars">${[1, 2, 3, 4, 5].map((i) => `<button data-v="${i}" class="${(e.user.rating || 0) >= i ? 'on' : ''}">★</button>`).join('')}</div></div>
      <div class="d-sec"><h3>${__('標籤')}</h3><div class="tags-edit" id="dTags">${(e.user.tags || []).map((t) => `<span class="t">${esc(t)}<button data-t="${esc(t)}">✕</button></span>`).join('')}<input id="dTagIn" list="tagList" placeholder="${__('輸入後按 Enter')}"></div></div>
      <div class="d-sec"><h3>${__('顯示名稱（只改清單中的名稱，不改檔名）')}</h3><input id="dName" type="text" class="field-full" placeholder="${esc((m.name) || e.filename)}" value="${esc(e.user.display_name || '')}"></div>
      <div class="d-sec"><h3>${__('備註')}</h3><textarea id="dNotes" placeholder="${__('購買來源、價格、授權條件、使用伺服器…')}">${esc(e.user.notes || '')}</textarea></div>

      <div class="d-sec"><h3>${__('模型資訊')}</h3><div class="kv">
        <span>${__('格式')}</span><span>${esc(m.format || kindLabel[e.kind])}</span>
        ${m.name ? `<span>${__('名稱')}</span><span>${esc(m.name)}</span>` : ''}
        ${m.license ? `<span>${__('授權')}</span><span>${esc(m.license)}</span>` : ''}
        ${m.pack_count ? `<span>${__('模型數')}</span><span>${m.pack_count}</span>` : ''}
        <span>${__('狀態')}</span><span>${e.enabled ? `<span style="color:var(--ok)">${__('已啟用')}</span>` : __('已停用')}${e.source ? '（' + esc(e.source) + '）' : ''}</span>
        <span>${__('大小')}</span><span>${fmtSize(e.size)}</span>
        <span>${__('修改')}</span><span>${fmtDate(e.mtime)}</span>
        <span>${__('位置')}</span><span>${esc(e.path)}</span>
      </div></div>
      ${authors ? `<div class="d-sec"><h3>${__('作者')}</h3>${authors}</div>` : ''}
      ${m.tips ? `<div class="d-sec"><h3>${__('說明')}</h3><div class="note" style="white-space:pre-wrap">${esc(m.tips)}</div></div>` : ''}
      ${e.kind === 'ysm' ? `<div class="d-sec"><h3>${__('檔頭公開資訊')}</h3>${e.summary && e.summary.text ? `<div class="summary">${esc(e.summary.text)}</div>` : `<div class="muted" style="font-size:12px">${__('這個檔案沒有可讀的公開摘要。')}</div>`}</div>` : ''}
      ${linksSection(e)}
    `;

    const q = (id) => box.querySelector('#' + id);
    bindInstallSection(box, e);
    q('bShot').onclick = () => openShots();
    q('bImg').onclick = () => $('imgPick').click();
    q('dClose').onclick = () => { S.sel = null; renderGrid(); renderDetail(); };
    if (q('bClr')) q('bClr').onclick = guard(async () => { applyUser(e.key, await api('clear_thumb', e.key)); renderGrid(); renderDetail(); });
    if (q('bPrev')) q('bPrev').onclick = () => openPreview(e);
    if (q('bToggle')) q('bToggle').onclick = guard(async () => {
      await api('set_enabled', e.id, !e.enabled);
      toast(e.enabled ? __('已停用（移到 ysm_manager_disabled，遊戲不會載入）') : __('已啟用'));
      const keepKey = e.key;
      await rescan();
      // 同一個模型可能倉庫和實例都有，優先選回同一個位置的那份
      const again = S.entries.find((x) => x.key === keepKey && x.enabled !== e.enabled && x.location === e.location)
        || S.entries.find((x) => x.key === keepKey && x.enabled !== e.enabled);
      if (again) { S.sel = again.id; renderGrid(); renderDetail(); }
    });
    q('bReveal').onclick = guard(() => api('reveal', e.id));
    box.querySelectorAll('[data-url]').forEach((b) => {
      b.onclick = guard(() => openExternal(b.dataset.url, b.dataset.label));
    });
    box.querySelectorAll('[data-ver]').forEach((b) => {
      b.onclick = () => { if (S.sel === b.dataset.ver) return; S.sel = b.dataset.ver; renderGrid(); renderDetail(); };
    });
    q('bDelModel').onclick = guard(async () => {
      const info = await api('delete_info', e.id);
      let where;
      if (info.in_repo) {
        where = info.installs.length
          ? `\n\n${__('已安裝在：{0}。\n<b>實例中的那份不會被刪除</b>，遊戲仍可使用。', info.installs.map(esc).join('、'))}`
          : '';
      } else {
        where = `\n\n${__('只會從「{0}」刪除，遊戲中就不能再使用這個模型。', esc(info.instance))}`
          + (info.backup ? __('\n倉庫中有這個模型，之後可以再安裝回來。') : `\n<span class="warn">${__('倉庫中沒有這個模型的備份。')}</span>`)
          + (info.installs.length ? `\n${__('{0} 中的那份不受影響。', info.installs.map(esc).join('、'))}` : '');
      }
      const fate = info.recycle
        ? `${__('檔案會移到<b>資源回收筒</b>，需要時可以還原。')}`
        : `<span class="warn">${__('這個磁碟沒有資源回收筒，刪除後無法復原！')}</span>`;
      const r1 = await ask({
        title: info.in_repo ? __('從倉庫刪除模型') : __('刪除遊戲實例中的模型'),
        body: `${__('要刪除「<b>{0}</b>」嗎？\n{1}（{2}）{3}\n\n{4}', esc(displayName(e)), esc(info.name), esc(info.size), where, fate)}`,
        ok: __('刪除'), danger: true,
      });
      if (!r1.ok) return;
      if (!S.settings || S.settings.confirm_delete_twice !== false) {
        const r2 = await ask({
          title: __('再次確認'),
          body: `${__('真的要刪除「<b>{0}</b>」嗎？\n\n{1}', esc(displayName(e)), fate)}`,
          ok: __('確定刪除'), cancel: __('不要刪除'), danger: true,
        });
        if (!r2.ok) return;
      }
      const res = await api('delete_model', e.id);
      toast(res.recycled ? __('已刪除（已移到資源回收筒）') : __('已永久刪除'));
      S.sel = null;
      await rescan();
    });
    q('bRename').onclick = guard(async () => {
      const base = e.kind === 'folder' ? e.filename : e.filename.replace(/\.[^.]+$/, '');
      const n = await promptBox(__('重新命名'), __('新的檔名（遊戲中的模型 ID 會隨之改變）：'), base);
      if (!n || n === base) return;
      const res = await api('rename', e.id, n);
      toast(__('已重新命名'));
      await rescan();
      const again = S.entries.find((x) => x.path === res.path);
      if (again) { S.sel = again.id; renderGrid(); renderDetail(); }
    });
    q('dStars').onclick = (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      const v = Number(b.dataset.v);
      saveUser(e, { rating: e.user.rating === v ? 0 : v }).then(renderDetail);
    };
    q('dTags').onclick = (ev) => {
      const b = ev.target.closest('button[data-t]');
      if (!b) return;
      saveUser(e, { tags: (e.user.tags || []).filter((t) => t !== b.dataset.t) }).then(renderDetail);
    };
    q('dTagIn').onkeydown = (ev) => {
      if (ev.key !== 'Enter') return;
      const parts = ev.target.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return;
      saveUser(e, { tags: [...(e.user.tags || []), ...parts] }).then(() => { renderDetail(); const inp = $('detailBody').querySelector('#dTagIn'); if (inp) inp.focus(); });
    };
    q('dName').onchange = (ev) => saveUser(e, { display_name: ev.target.value.trim() });
    q('dNotes').onchange = (ev) => saveUser(e, { notes: ev.target.value });

    const dt = q('dThumb');
    dt.ondragover = (ev) => { ev.preventDefault(); dt.classList.add('drag'); };
    dt.ondragleave = () => dt.classList.remove('drag');
    dt.ondrop = (ev) => {
      ev.preventDefault();
      dt.classList.remove('drag');
      const f = [...ev.dataTransfer.files].find((x) => x.type.startsWith('image/'));
      if (f) openCropFromBlob(f);
    };
  }

  $('imgPick').onchange = (ev) => { const f = ev.target.files[0]; ev.target.value = ''; if (f) openCropFromBlob(f); };
  window.addEventListener('paste', (ev) => {
    if (!cur() || /input|textarea/i.test(document.activeElement.tagName)) return;
    const item = [...(ev.clipboardData || {}).items || []].find((i) => i.type.startsWith('image/'));
    if (item) { ev.preventDefault(); openCropFromBlob(item.getAsFile()); }
  });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => ev.preventDefault());

  // ---------------- 模態視窗 ----------------
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (ev) => { if (ev.target === m || ev.target.closest('[data-close]')) closeModal(m); });
  });
  function closeModal(m) {
    if (m.id === 'askModal') { finishAsk(false); return; }
    if (m.id === 'gameModal' && G.running) { G.stop = true; G.paused = false; }
    m.hidden = true;
    if (m.id === 'previewModal') $('previewFrame').src = 'about:blank';
  }
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!$('askModal').hidden) { finishAsk(false); return; }
    document.querySelectorAll('.modal:not([hidden])').forEach(closeModal);
  });

  // ---------------- 設定 ----------------
  function renderSettings() {
    const st = S.settings || {};
    $('setLang').value = st.lang || 'auto';
    $('setGroupVer').checked = st.group_versions !== false;
    $('setConfirmCopy').checked = st.confirm_copy !== false;
    $('setConfirmDel').checked = st.confirm_delete_twice !== false;
    $('setRepoPath').textContent = S.repo || __('尚未設定');
    $('setRepoChange').textContent = S.repo ? __('更換…') : __('設定…');
    $('setRepoOpen').disabled = !S.repo;
    $('setDataPath').textContent = st.data_dir_now || '';
    $('setDataReset').disabled = !st.data_dir;
    $('aboutVer').textContent = st.version ? 'v' + st.version : '';
    $('btnGithub').title = st.github || '';
  }
  $('btnSettings').onclick = guard(async () => {
    S.settings = await api('get_settings');
    renderSettings();
    $('settingsModal').hidden = false;
  });
  const saveSetting = (patch) => guard(async () => { S.settings = await api('set_settings', patch()); renderSettings(); toast(__('已儲存設定')); });
  // 換語言：存好設定後帶著新語言重新載入頁面
  $('setLang').onchange = guard(async () => {
    S.settings = await api('set_settings', { lang: $('setLang').value });
    const q = new URLSearchParams(location.search);
    if (S.settings.lang_effective === I18N.lang) { renderSettings(); toast(__('已儲存設定')); return; }
    q.set('lang', S.settings.lang_effective);
    location.search = q.toString();
  });
  $('setConfirmCopy').onchange = saveSetting(() => ({ confirm_copy: $('setConfirmCopy').checked }));
  $('setGroupVer').onchange = guard(async () => {
    S.settings = await api('set_settings', { group_versions: $('setGroupVer').checked });
    renderSettings();
    PAGE.reveal = true;
    renderGrid();
    renderDetail();
  });
  $('setConfirmDel').onchange = saveSetting(() => ({ confirm_delete_twice: $('setConfirmDel').checked }));
  $('setRepoChange').onclick = async () => { await $('btnRepo').onclick(); renderSettings(); };
  $('setRepoOpen').onclick = guard(() => api('open_special_dir', 'repo'));
  $('btnGithub').onclick = guard(() => api('open_project_page', 'home'));
  $('btnGithubTop').onclick = guard(() => api('open_project_page', 'home'));
  $('btnReleases').onclick = guard(() => api('open_project_page', 'releases'));
  $('setDataOpen').onclick = guard(() => api('open_special_dir', 'data'));
  async function moveData(target) {
    const r = await ask({
      title: __('搬移管理器資料'),
      body: `${__('把標籤、評分、備註和縮圖搬到：\n<b>{0}</b>\n\n會先複製到新位置，成功後才刪除舊位置的檔案。', esc(target))}`,
      ok: __('搬移'),
    });
    if (!r.ok) return;
    S.settings = await api('move_data_dir', target);
    renderSettings();
    toast(__('已搬移到 {0}', S.settings.data_dir_now));
  }
  $('setDataChange').onclick = guard(async () => {
    const r = await api('pick_folder');
    let path = r && r.path;
    if (r && r.unsupported) path = await promptBox(__('搬移管理器資料'), __('輸入新的資料夾路徑：'), S.settings.data_dir_now);
    if (!path) return;
    await moveData(path);
  });
  $('setDataReset').onclick = guard(async () => { await moveData(S.settings.data_dir_default); });

  // ---- 解除安裝管理器 ----
  async function renderUninstall() {
    try {
      const u = await api('uninstall_info');
      $('unRestoreText').textContent = u.disabled
        ? __('把 {0} 個停用的模型移回原位（否則遊戲不會讀取它們）', u.disabled)
        : __('把停用的模型移回原位（目前沒有停用的模型）');
      $('unModText').textContent = u.mod_instances.length
        ? __('同時移除遊戲實例中的 YSM Shot MOD（{0}）', u.mod_instances.join('、'))
        : __('同時移除各遊戲實例中的 YSM Shot MOD（目前沒有安裝）');
    } catch (e) { /* 忽略 */ }
  }
  $('btnSettings').addEventListener('click', renderUninstall);
  $('btnUninstall').onclick = guard(async () => {
    const u = await api('uninstall_info');
    const restore = $('unRestore').checked, mod = $('unMod').checked;
    const steps = [];
    if (restore && u.disabled) steps.push(__('把 {0} 個停用的模型移回原位', u.disabled));
    if (mod && u.mod_instances.length) steps.push(__('從 {0} 移除 YSM Shot MOD', u.mod_instances.map(esc).join('、')));
    steps.push(__('關閉管理器'));
    steps.push(`${__('刪除管理器的資料（設定、標籤、評分、備註、縮圖）\n　<small>{0}</small>', esc(u.data_dir))}`);
    if (u.exe) steps.push(`${__('刪除程式本身\n　<small>{0}</small>', esc(u.exe))}`);
    const r1 = await ask({
      title: __('解除安裝 YSM 模型管理器'),
      body: `${__('將會：\n{0}\n\n<b>遊戲、倉庫和所有模型檔案都不會被刪除。</b>', steps.map((s, i) => `${i + 1}. ${s}`).join('\n'))}`
        + (!restore && u.disabled ? `\n<span class="warn">${__('你選擇不移回停用的模型：那 {0} 個模型會留在 ysm_manager_disabled 資料夾，遊戲不會讀取。', u.disabled)}</span>` : ''),
      ok: __('解除安裝'), danger: true,
    });
    if (!r1.ok) return;
    const r2 = await ask({
      title: __('再次確認'),
      body: `${__('確定要解除安裝嗎？\n標籤、評分、備註和縮圖刪除後')}<span class="warn">${__('無法復原')}</span>。`,
      ok: __('確定解除安裝'), cancel: __('不要'), danger: true,
    });
    if (!r2.ok) return;
    await api('uninstall_app', restore, mod);
    document.body.innerHTML = `<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-size:16px;color:#aaa">${__('已解除安裝，管理器即將關閉…')}</div>`;
  });

  // ---------------- 截圖挑選 ----------------
  const openShots = guard(async () => {
    const shots = await api('list_screenshots');
    const g = $('shotGrid');
    g.innerHTML = '';
    $('shotDir').textContent = shots.length ? __('最近 {0} 張（依時間排序）', shots.length) : '';
    if (!shots.length) g.innerHTML = `<div class="muted" style="padding:20px">${__('找不到遊戲截圖資料夾或沒有截圖。在遊戲中按 F2 截圖後再試一次，或改用「選擇圖片」。')}</div>`;
    for (const s of shots) {
      const f = document.createElement('figure');
      f.innerHTML = `<img loading="lazy" src="/api/shot?p=${encodeURIComponent(s.path)}&${tq}" alt=""><figcaption>${esc(s.name)}</figcaption>`;
      f.onclick = async () => {
        closeModal($('shotModal'));
        const b = await (await fetch(`/api/shot?p=${encodeURIComponent(s.path)}&${tq}`)).blob();
        openCropFromBlob(b);
      };
      g.appendChild(f);
    }
    $('shotModal').hidden = false;
  });

  // ---------------- 裁切 ----------------
  const crop = { img: null, x: 0, y: 0, h: 0, scale: 1, onOk: null };
  const ASPECT = 3 / 4;

  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(__('圖片讀取失敗'))); i.src = src; });
  }

  const openCropFromBlob = guard(async (blob) => {
    const url = URL.createObjectURL(blob);
    const img = await loadImage(url);
    openCrop(img);
  });

  /** onOk(rect) 有給時改由呼叫者處理裁切結果；initRel 為初始框（相對座標） */
  function openCrop(img, onOk, initRel) {
    crop.img = img;
    crop.onOk = onOk || null;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    crop.h = Math.min(ih, iw / ASPECT);
    crop.x = (iw - crop.h * ASPECT) / 2;
    crop.y = (ih - crop.h) / 2;
    if (initRel) { crop.x = initRel.fx * iw; crop.y = initRel.fy * ih; crop.h = initRel.fh * ih; clampCrop(); }
    const cv = $('cropCanvas');
    const maxW = Math.min(window.innerWidth * 0.85, 680), maxH = window.innerHeight * 0.62;
    crop.scale = Math.min(maxW / iw, maxH / ih, 1);
    cv.width = Math.round(iw * crop.scale);
    cv.height = Math.round(ih * crop.scale);
    $('cropModal').hidden = false;
    drawCrop();
  }

  function clampCrop() {
    const iw = crop.img.naturalWidth, ih = crop.img.naturalHeight;
    crop.h = Math.max(32, Math.min(crop.h, ih, iw / ASPECT));
    crop.x = Math.max(0, Math.min(crop.x, iw - crop.h * ASPECT));
    crop.y = Math.max(0, Math.min(crop.y, ih - crop.h));
  }

  function drawCrop() {
    const cv = $('cropCanvas'), g = cv.getContext('2d'), s = crop.scale;
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(crop.img, 0, 0, cv.width, cv.height);
    g.fillStyle = 'rgba(0,0,0,.55)';
    const x = crop.x * s, y = crop.y * s, w = crop.h * ASPECT * s, h = crop.h * s;
    g.fillRect(0, 0, cv.width, y);
    g.fillRect(0, y + h, cv.width, cv.height - y - h);
    g.fillRect(0, y, x, h);
    g.fillRect(x + w, y, cv.width - x - w, h);
    g.strokeStyle = '#6cb6ff';
    g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }

  (function bindCrop() {
    const cv = $('cropCanvas');
    let drag = null;
    cv.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, cx: crop.x, cy: crop.y }; cv.setPointerCapture(ev.pointerId); });
    cv.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const k = 1 / crop.scale * (cv.width / cv.getBoundingClientRect().width);
      crop.x = drag.cx + (ev.clientX - drag.x) * k;
      crop.y = drag.cy + (ev.clientY - drag.y) * k;
      clampCrop(); drawCrop();
    });
    cv.addEventListener('pointerup', () => { drag = null; });
    cv.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const cx = crop.x + crop.h * ASPECT / 2, cy = crop.y + crop.h / 2;
      crop.h *= ev.deltaY > 0 ? 1.08 : 1 / 1.08;
      clampCrop();
      crop.x = cx - crop.h * ASPECT / 2; crop.y = cy - crop.h / 2;
      clampCrop(); drawCrop();
    }, { passive: false });
  })();

  function cropToDataURL(img, sx, sy, sh) {
    const out = document.createElement('canvas');
    const H = Math.min(800, Math.round(sh));
    out.height = H;
    out.width = Math.round(H * ASPECT);
    const g = out.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, sx, sy, sh * ASPECT, sh, 0, 0, out.width, out.height);
    // 有透明部分（3D 預覽擷取）就存 PNG，之後才能換背景；不透明的（遊戲畫面）維持 JPEG 省空間
    const d = g.getImageData(0, 0, out.width, out.height).data;
    for (let i = 3; i < d.length; i += 16) if (d[i] < 250) return out.toDataURL('image/png');
    return out.toDataURL('image/jpeg', 0.9);
  }

  async function saveThumbFor(e, dataURL) {
    const rec = await api('set_thumb', e.key, dataURL);
    applyUser(e.key, rec);
    renderGrid();
    if (cur() === e) renderDetail();
  }

  $('cropOk').onclick = guard(async () => {
    if (crop.onOk) {
      const fn = crop.onOk;
      crop.onOk = null;
      closeModal($('cropModal'));
      await fn({ x: crop.x, y: crop.y, h: crop.h, img: crop.img });
      return;
    }
    const e = cur();
    if (!e || !crop.img) return;
    await saveThumbFor(e, cropToDataURL(crop.img, crop.x, crop.y, crop.h));
    closeModal($('cropModal'));
    toast(__('縮圖已更新'));
  });

  // ---------------- 3D 預覽 ----------------
  let previewEntry = null;
  function frameReady(ifr) {
    return new Promise((res) => {
      const check = () => {
        const w = ifr.contentWindow;
        if (w && w.YSMApp && w.document.readyState === 'complete') res(w); else setTimeout(check, 50);
      };
      check();
    });
  }

  async function loadIntoViewer(e, ifr) {
    // 重新載入預覽頁，等新頁面 load 完成，避免拿到上一個模型的舊頁面
    await new Promise((res) => {
      ifr.addEventListener('load', res, { once: true });
      ifr.src = 'index.html?embed=1&n=' + Date.now();
    });
    const w = await frameReady(ifr);
    const info = await api('model_files', e.id);
    const items = [];
    for (const rel of info.files) {
      const url = `/api/model?id=${encodeURIComponent(e.id)}&p=${encodeURIComponent(rel)}&${tq}`;
      const b = await (await fetch(url)).blob();
      const path = info.kind === 'zip' ? info.name : `${info.name}/${rel}`;
      items.push({ file: new w.File([b], path.split('/').pop()), path });
    }
    await w.YSMApp.handleItems(items);
    return w;
  }

  const openPreview = guard(async (e) => {
    previewEntry = e;
    $('btnCapture').hidden = false;
    $('previewTitle').textContent = displayName(e);
    $('previewStatus').textContent = __('載入中…');
    $('previewModal').hidden = false;
    await loadIntoViewer(e, $('previewFrame'));
    $('previewStatus').textContent = __('左鍵旋轉、右鍵平移、滾輪縮放；調好角度後可設為縮圖');
  });

  // 獨立的模型預覽器（和網頁版 index.html 相同）：可拖入任何資料夾 / .zip，不需要先加入倉庫
  $('btnViewer').onclick = () => {
    previewEntry = null;
    $('btnCapture').hidden = true;
    $('previewTitle').textContent = __('YSM 模型預覽器');
    $('previewStatus').textContent = __('把模型資料夾或 .zip 拖進來，或用右上角的「開啟資料夾」「開啟 .zip」');
    $('previewModal').hidden = false;
    $('previewFrame').src = 'index.html?n=' + Date.now();
  };

  function captureViewer(w) {
    const app = w.YSMApp;
    if (app && app.captureTransparent) return loadImage(app.captureTransparent());
    const cv = w.document.getElementById('canvas');
    return loadImage(cv.toDataURL('image/png'));
  }

  $('btnCapture').onclick = guard(async () => {
    if (!previewEntry) return;
    const w = $('previewFrame').contentWindow;
    const img = await captureViewer(w);
    if (S.sel !== previewEntry.id) { S.sel = previewEntry.id; PAGE.reveal = true; renderGrid(); renderDetail(); }
    closeModal($('previewModal'));
    openCrop(img);
  });

  // ---------------- 批次縮圖 ----------------
  $('btnBatch').onclick = guard(async () => {
    const todo = S.entries.filter((e) => e.previewable && !e.user.thumb);
    if (!todo.length) { toast(__('所有可預覽的模型都已經有縮圖了（加密 .ysm 需在遊戲中截圖）')); return; }
    if (!(await confirmBox(__('批次產生縮圖'), __('將為 {0} 個可預覽的模型自動產生縮圖，繼續？', todo.length), { ok: __('開始') }))) return;
    const ifr = $('previewFrame');
    $('previewModal').hidden = false;
    let done = 0;
    for (const e of todo) {
      if ($('previewModal').hidden) break; // 使用者中止
      $('previewTitle').textContent = __('批次產生縮圖 {0} / {1}', done + 1, todo.length);
      $('previewStatus').textContent = displayName(e);
      try {
        const w = await loadIntoViewer(e, ifr);
        const grid = w.document.getElementById('chkGrid');
        grid.checked = false; grid.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 900));
        const img = await captureViewer(w);
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const h = Math.min(ih, iw / ASPECT);
        await saveThumbFor(e, cropToDataURL(img, (iw - h * ASPECT) / 2, (ih - h) / 2, h));
        done++;
      } catch (err) { console.warn(err); }
    }
    closeModal($('previewModal'));
    toast(__('已產生 {0} 張縮圖', done));
  });

  // ---------------- 遊戲內截圖 ----------------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('ysmgr.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ysmgr.' + k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } },
  };
  const DEFAULT_CMD = '/ysm model set @s {id} {tex} true';
  const G = { rows: [], running: false };

  // YSM 的模型 ID = 相對於 custom 資料夾的路徑（用 /，檔案保留副檔名），例如 "分類/角色.ysm"
  // 倉庫模型以「目前選的遊戲實例中實際安裝的位置」為準（倉庫的子資料夾可能和遊戲中不同）
  const defaultModelId = (e) => {
    const ins = e.location === 'repo' && $('gInst') ? (e.installs || []).find((i) => i.root === $('gInst').value) : null;
    return (ins && ins.rel) || e.rel || e.filename;
  };
  const modelIdOf = (e) => {
    const v = LS.get('ids', {})[e.key];
    // 舊版預設用「檔名去掉副檔名」，那樣的記錄是錯的，忽略
    if (!v || v === e.filename.replace(/\.(ysm|zip|7z)$/i, '')) return defaultModelId(e);
    return v;
  };
  // 遊戲中實際存在的模型 ID（按「檢查連線」時從遊戲讀取）
  const unquote = (s) => (/^".*"$/.test(s) ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s);
  function markIds() {
    for (const r of G.rows) {
      const bad = !!G.ids && !G.ids.has(unquote(r.idIn.value.trim()));
      r.idIn.classList.toggle('bad', bad);
      r.idIn.title = bad ? __('遊戲中沒有這個模型 ID（可能是 YSM 沒有載入這個檔案，或 ID 要修改）') : __('模型 ID');
    }
  }

  function gStatus(msg, err) { const s = $('gStatus'); s.textContent = msg; s.className = 'g-status' + (err ? ' err' : ''); }
  function gCropInfo() {
    const c = LS.get('crop', null);
    $('gCropInfo').textContent = c ? __('已設定縮圖範圍（試拍可重新設定）') : __('尚未設定縮圖範圍：請先「試拍第一個」');
  }

  const refreshWindows = guard(async () => {
    const wins = await api('game_windows');
    const sel = $('gWin');
    const prev = sel.value;
    sel.innerHTML = wins.length ? '' : `<option value="">${__('找不到遊戲視窗，請先開啟遊戲')}</option>`;
    for (const w of wins) { const o = document.createElement('option'); o.value = w.hwnd; o.textContent = w.title; sel.appendChild(o); }
    if (wins.some((w) => String(w.hwnd) === prev)) sel.value = prev;
  });

  function renderGameList() {
    const root = $('gInst').value;
    const onlyNew = $('gOnlyNew').checked;
    const list = S.entries.filter((e) => e.location === root && e.enabled && e.kind !== '7z')
      .sort((a, b) => displayName(a).localeCompare(displayName(b), 'zh-Hant'));
    G.rows = list.map((e) => ({ e, checked: !onlyNew || !e.user.thumb }));
    const box = $('gList');
    box.innerHTML = '';
    if (!list.length) box.innerHTML = `<div class="muted" style="padding:12px">${__('這個實例中沒有已啟用的模型。')}</div>`;
    for (const r of G.rows) {
      const th = thumbURL(r.e);
      const row = document.createElement('div');
      row.className = 'g-row';
      row.innerHTML = `<input type="checkbox" ${r.checked ? 'checked' : ''}><span class="th" ${th ? `style="background-image:url('${th}')"` : ''}></span>
        <span class="nm"><b>${esc(displayName(r.e))}</b><span>${esc(r.e.rel)}</span></span>
        <input type="text" spellcheck="false" value="${esc(modelIdOf(r.e))}" title="${__('模型 ID')}">`;
      const [cb, idIn] = row.querySelectorAll('input');
      cb.onchange = () => { r.checked = cb.checked; gCount(); };
      idIn.onchange = () => {
        const ids = LS.get('ids', {});
        const v = idIn.value.trim();
        if (!v || v === defaultModelId(r.e)) delete ids[r.e.key]; else ids[r.e.key] = v;
        LS.set('ids', ids);
        markIds();
      };
      r.el = row;
      r.idIn = idIn;
      box.appendChild(row);
    }
    markIds();
    gCount();
  }
  function gCount() { $('gCount').textContent = __('已選 {0} / {1}', G.rows.filter((r) => r.checked).length, G.rows.length); }

  $('btnGame').onclick = async () => {
    const insts = S.instances.filter((i) => i.is_instance);
    if (!insts.length) { toast(__('請先加入遊戲實例（左側「遊戲實例」）'), true); return; }
    const sel = $('gInst');
    sel.innerHTML = insts.map((i) => `<option value="${esc(i.root)}">${esc(i.name)}</option>`).join('');
    const last = LS.get('inst', '');
    if (insts.some((i) => i.root === last)) sel.value = last;
    $('gCmd').value = LS.get('cmd', DEFAULT_CMD);
    $('gWait').value = LS.get('waitSec', 1);
    $('gZoom').value = LS.get('zoom', 1);
    $('gYaw').value = String(LS.get('yaw', 0));
    zoomLabel();
    renderGameList();
    $('gameModal').hidden = false;
    setMode(LS.get('gmode', 'mod'));
  };
  $('gWinRefresh').onclick = refreshWindows;
  $('gInst').onchange = () => { LS.set('inst', $('gInst').value); G.ids = null; renderGameList(); };
  $('gOnlyNew').onchange = renderGameList;
  $('gCmd').onchange = () => LS.set('cmd', $('gCmd').value.trim() || DEFAULT_CMD);
  $('gWait').onchange = () => LS.set('waitSec', Number($('gWait').value) || 1);
  $('gAll').onclick = () => { G.rows.forEach((r) => { r.checked = true; r.el.querySelector('input').checked = true; }); gCount(); };
  $('gNone').onclick = () => { G.rows.forEach((r) => { r.checked = false; r.el.querySelector('input').checked = false; }); gCount(); };

  // Minecraft 指令中不加引號的參數只能有英數字和 _ - . +；含中文、空白等字元時要用雙引號包起來
  function cmdArg(s) {
    if (/^".*"$/.test(s) || /^[0-9A-Za-z_\-.+]+$/.test(s)) return s;
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  function buildCmd(r) {
    const tpl = $('gCmd').value.trim() || DEFAULT_CMD;
    const id = cmdArg(r.idIn.value.trim() || defaultModelId(r.e));
    return tpl.replace(/\{id\}/g, () => id).replace(/\{tex\}/g, '-');
  }

  // ---- 配套 MOD 模式 ----
  function setMode(m) {
    G.mode = m;
    LS.set('gmode', m);
    $('gameModal').dataset.mode = m;
    $('gMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    if (m === 'keys') { gCropInfo(); refreshWindows(); } else $('gCropInfo').textContent = '';
    gStatus('');
  }
  $('gMode').querySelectorAll('button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  const zoomLabel = () => { $('gZoomV').textContent = Math.round(Number($('gZoom').value) * 100) + '%'; };
  $('gZoom').oninput = () => { zoomLabel(); LS.set('zoom', Number($('gZoom').value)); };
  $('gYaw').onchange = () => LS.set('yaw', Number($('gYaw').value));
  $('gInstallMod').onclick = guard(async () => {
    const res = await api('install_bridge_mod', $('gInst').value);
    gStatus(__('已安裝 YSM Shot 到 {0}{1}。這個實例還需要 Forge 1.20.1 和 YSM，重新啟動遊戲後生效。', res.path, res.removed.length ? __('（已移除舊版 {0}）', res.removed.join('、')) : ''));
  });
  async function loadIds() {
    G.ids = new Set(await api('bridge_ids', $('gInst').value));
    markIds();
    return G.ids.size;
  }
  $('gPing').onclick = guard(async () => {
    gStatus(__('連線中…'));
    try {
      const s = await api('bridge_status', $('gInst').value);
      if (!s.inWorld) gStatus(__('已連上 YSM Shot（Minecraft {0}），但還沒進入世界。請進入單人世界。', s.mc), true);
      else if (s.paused) gStatus(__('已連上，但遊戲目前暫停中。請關閉選單，並按 F3+P 關閉「失去焦點時暫停」。'), true);
      else {
        const n = await loadIds();
        const bad = G.rows.filter((r) => r.idIn.classList.contains('bad')).length;
        gStatus(__('已連上 YSM Shot：Minecraft {0}，玩家 {1}，遊戲中有 {2} 個模型{3}{4}', s.mc, s.player, n, bad ? __('；清單中 {0} 個的 ID 在遊戲中找不到（紅框），批次截圖時會略過', bad) : '', s.pauseOnLostFocus ? __('。提醒：切到其他視窗時遊戲會暫停，建議在遊戲中按 F3+P 關閉') : '。'));
      }
    } catch (e) { gStatus(e.message, true); }
  });

  /** 依不透明像素找出角色範圍，留邊後裁成 3:4，保留透明背景。 */
  function autoCrop(img) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = iw; c.height = ih;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, iw, ih).data;
    let x0 = iw, y0 = ih, x1 = -1, y1 = -1;
    for (let y = 0; y < ih; y++) {
      for (let x = 0; x < iw; x++) {
        if (px[(y * iw + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) throw Object.assign(new Error(__('畫面是空的：沒有拍到角色（角色可能隱形或模型還沒載入，可把等待秒數調長）')), { empty: true });
    const pad = 0.06;
    let w = x1 - x0 + 1, h = y1 - y0 + 1;
    let H = Math.max(h, w / ASPECT) * (1 + pad * 2);
    const W = H * ASPECT;
    const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
    const out = document.createElement('canvas');
    out.height = Math.min(800, Math.round(H));
    out.width = Math.round(out.height * ASPECT);
    const og = out.getContext('2d');
    og.imageSmoothingQuality = 'high';
    const k = out.height / H;
    // 把原圖平移縮放，讓 (cx - W/2, cy - H/2) 對齊輸出左上角；超出原圖的部分保持透明
    og.drawImage(img, -(cx - W / 2) * k, -(cy - H / 2) * k, iw * k, ih * k);
    return { url: out.toDataURL('image/png'), clipped: x0 === 0 || y0 === 0 || x1 === iw - 1 || y1 === ih - 1 };
  }

  async function shootMod(r) {
    const res = await api('bridge_shot', $('gInst').value, buildCmd(r), Number($('gWait').value) || 1,
      768, Number($('gZoom').value) || 1, Number($('gYaw').value) || 0);
    const img = await loadImage('data:image/png;base64,' + res.png);
    return { ...autoCrop(img), messages: res.messages || [] };
  }

  function showMsgs(r, shot) {
    r.el.querySelector('.msg')?.remove();
    const notes = [...shot.messages];
    if (shot.clipped) notes.push(__('角色超出畫面，請把「角色大小」調小'));
    if (!notes.length) return false;
    const m = document.createElement('span');
    m.className = 'msg';
    m.textContent = __('遊戲訊息：') + notes.join('／');
    r.el.appendChild(m);
    return true;
  }

  async function modOne(r) {
    const shot = await shootMod(r);
    await saveThumbFor(r.e, shot.url);
    r.el.querySelector('.th').style.backgroundImage = `url('${thumbURL(r.e)}')`;
    r.checked = false;
    r.el.querySelector('input').checked = false;
    setRowState(r, showMsgs(r, shot) ? 'warn' : 'done');
    return shot;
  }

  async function gameShot(cmds, wait) {
    const hwnd = $('gWin').value;
    if (!hwnd) throw new Error(__('請先選擇遊戲視窗（開啟遊戲後按「重新整理」）'));
    const res = await api('game_shot', hwnd, $('gInst').value, cmds, wait);
    const blob = await (await fetch(`/api/shot?p=${encodeURIComponent(res.path)}&${tq}`)).blob();
    return loadImage(URL.createObjectURL(blob));
  }
  // 去背：先隱形拍一張空背景（G.plate），之後的第一張截圖順便解除隱形
  const INVIS_ON = '/effect give @s minecraft:invisibility 999999 0 true';
  const INVIS_OFF = '/effect clear @s minecraft:invisibility';
  const cutoutOn = () => $('gCutout').checked;
  $('gCutout').checked = LS.get('cutout', true);
  $('gCutout').onchange = () => LS.set('cutout', $('gCutout').checked);
  async function takePlate() {
    G.plate = null;
    gStatus(__('去背準備：先讓角色隱形，拍一張空背景…（請不要動鍵盤滑鼠）'));
    G.plate = await gameShot([INVIS_ON], 1);
    G.invis = true;
  }
  async function shootOne(r) {
    const cmds = [buildCmd(r)];
    if (G.invis) cmds.unshift(INVIS_OFF);
    const img = await gameShot(cmds, Number($('gWait').value) || 1);
    G.invis = false;
    return img;
  }
  /** 縮圖：有空背景就去背（透明 PNG），否則照原本裁切 */
  function gameThumb(img, x, y, h) {
    const p = G.plate;
    if (!cutoutOn() || !p || p.naturalWidth !== img.naturalWidth || p.naturalHeight !== img.naturalHeight) return cropToDataURL(img, x, y, h);
    return cutoutToDataURL(img, p, x, y, h);
  }

  /**
   * 和空背景比對去背：差異大的像素算角色，像「變暗但顏色相同」的算影子（當背景），
   * 再去掉零碎雜點、補上角色內部的小洞、邊緣柔化。
   */
  function cutoutToDataURL(img, plate, sx, sy, sh) {
    const H = Math.min(800, Math.round(sh)), W = Math.round(H * ASPECT);
    const grab = (im) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(im, sx, sy, sh * ASPECT, sh, 0, 0, W, H);
      return [c, g, g.getImageData(0, 0, W, H)];
    };
    const [out, og, A] = grab(img);
    const B = grab(plate)[2];
    const a = A.data, b = B.data, N = W * H;
    const fg = new Uint8Array(N);
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const r1 = a[j], g1 = a[j + 1], b1 = a[j + 2], r0 = b[j], g0 = b[j + 1], b0 = b[j + 2];
      const d = Math.max(Math.abs(r1 - r0), Math.abs(g1 - g0), Math.abs(b1 - b0));
      if (d < 28) continue;
      // 影子：比背景暗、但色調相同
      const s1 = r1 + g1 + b1 + 1, s0 = r0 + g0 + b0 + 1, k = s1 / s0;
      if (k > 0.4 && k < 0.97 && Math.abs(r1 / s1 - r0 / s0) + Math.abs(g1 / s1 - g0 / s0) + Math.abs(b1 / s1 - b0 / s0) < 0.05 + 24 / s1) continue;
      fg[i] = 1;
    }
    // 連通區域（4 鄰接）
    const lab = new Int32Array(N), stack = new Int32Array(N);
    function regions(val) {
      lab.fill(0);
      const sizes = [0];
      for (let s = 0; s < N; s++) {
        if (fg[s] !== val || lab[s]) continue;
        const id = sizes.length; let n = 0, top = 0;
        stack[top++] = s; lab[s] = id;
        while (top) {
          const p = stack[--top]; n++;
          const x = p % W;
          if (x > 0 && fg[p - 1] === val && !lab[p - 1]) { lab[p - 1] = id; stack[top++] = p - 1; }
          if (x < W - 1 && fg[p + 1] === val && !lab[p + 1]) { lab[p + 1] = id; stack[top++] = p + 1; }
          if (p >= W && fg[p - W] === val && !lab[p - W]) { lab[p - W] = id; stack[top++] = p - W; }
          if (p < N - W && fg[p + W] === val && !lab[p + W]) { lab[p + W] = id; stack[top++] = p + W; }
        }
        sizes.push(n);
      }
      return sizes;
    }
    // 去掉零碎雜點（小於畫面 0.15%）
    let sizes = regions(1);
    const minFg = N * 0.0015;
    for (let i = 0; i < N; i++) if (fg[i] && sizes[lab[i]] < minFg) fg[i] = 0;
    if (!fg.some((v) => v)) throw new Error(__('去背失敗：截圖和空背景幾乎一樣。可能是模型沒有切換、隱形時模型仍然顯示，或視角有移動；可以取消勾選「去除遊戲背景」'));
    // 補洞：被角色包住（沒碰到邊緣）、又不太大的背景區塊，視為角色內部和背景同色的部分
    sizes = regions(0);
    const touch = new Uint8Array(sizes.length);
    for (let x = 0; x < W; x++) { touch[lab[x]] = 1; touch[lab[N - W + x]] = 1; }
    for (let y = 0; y < H; y++) { touch[lab[y * W]] = 1; touch[lab[y * W + W - 1]] = 1; }
    let fgN = 0; for (let i = 0; i < N; i++) fgN += fg[i];
    const maxHole = Math.max(N * 0.004, fgN * 0.5);
    for (let i = 0; i < N; i++) if (!fg[i] && !touch[lab[i]] && sizes[lab[i]] < maxHole) fg[i] = 1;
    // 邊緣柔化（3×3 平均）
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W) continue;
            s += fg[yy * W + xx]; c++;
          }
        }
        a[(y * W + x) * 4 + 3] = Math.round(255 * s / c);
      }
    }
    og.putImageData(A, 0, 0);
    return out.toDataURL('image/png');
  }

  function relToAbs(img, rel) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    let h = Math.min(rel.fh * ih, ih, iw / ASPECT);
    let x = Math.max(0, Math.min(rel.fx * iw, iw - h * ASPECT));
    let y = Math.max(0, Math.min(rel.fy * ih, ih - h));
    return { x, y, h };
  }

  function setRowState(r, cls) { r.el.classList.remove('done', 'err', 'warn'); if (cls) r.el.classList.add(cls); }

  $('gTest').onclick = guard(async () => {
    if (G.running) return;
    const r = G.rows.find((x) => x.checked) || G.rows[0];
    if (!r) { toast(__('沒有可截圖的模型'), true); return; }
    G.running = true;
    if (G.mode === 'mod') {
      gStatus(__('試拍：{0}…', displayName(r.e)));
      try {
        const shot = await modOne(r);
        gStatus(__('拍好了，已存成「{0}」的縮圖。請確認是正確的模型{1}，再「開始批次截圖」。', displayName(r.e), shot.messages.length ? __('，並看看下方的遊戲訊息') : ''));
      } catch (e) { setRowState(r, 'err'); gStatus(e.message, true); } finally { G.running = false; }
      return;
    }
    try {
      if (cutoutOn()) await takePlate(); else G.plate = null;
      gStatus(__('試拍：{0}…（請不要動鍵盤滑鼠）', displayName(r.e)));
      const img = await shootOne(r);
      gStatus(__('拍好了。請確認畫面中的模型已切換成「{0}」，再框出縮圖範圍。', displayName(r.e)));
      openCrop(img, async (rect) => {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        LS.set('crop', { fx: rect.x / iw, fy: rect.y / ih, fh: rect.h / ih });
        await saveThumbFor(r.e, gameThumb(img, rect.x, rect.y, rect.h));
        setRowState(r, 'done');
        r.el.querySelector('.th').style.backgroundImage = `url('${thumbURL(r.e)}')`;
        gCropInfo();
        gStatus(__('已設定縮圖範圍並存好第一張。可以「開始批次截圖」了。'));
      }, LS.get('crop', null));
    } catch (e) {
      setRowState(r, 'err');
      gStatus(e.message, true);
    } finally { G.running = false; }
  });

  $('gStart').onclick = guard(async () => {
    if (G.running) return;
    const rel = LS.get('crop', null);
    if (G.mode === 'keys' && !rel) { toast(__('請先「試拍第一個」並設定縮圖範圍'), true); return; }
    const todo = G.rows.filter((r) => r.checked);
    if (!todo.length) { toast(__('請勾選要截圖的模型'), true); return; }
    G.running = true;
    G.stop = false;
    G.paused = false;
    setBatchUI(true);
    let done = 0;
    try {
      if (G.mode === 'mod') {
        let warned = 0, failed = 0, skipped = 0;
        if (!G.ids) await loadIds();
        for (const r of todo) {
          if (r.idIn.classList.contains('bad')) { setRowState(r, 'err'); skipped++; continue; }
          if (await checkpoint(done, todo.length)) { gStatus(__('已停止：完成 {0} 個，還有 {1} 個沒拍（仍保持勾選，可再按「開始批次截圖」繼續）。', done, todo.length - done - failed - skipped)); return; }
          gStatus(__('截圖中 {0} / {1}：{2}', done + failed + skipped + 1, todo.length, displayName(r.e)));
          try {
            const shot = await modOne(r);
            if (shot.messages.length || shot.clipped) warned++;
            done++;
          } catch (e) {
            setRowState(r, 'err');
            failed++;
            // 連線或遊戲狀態問題會讓後面全部失敗，直接停止
            if (!e.empty) { gStatus(__('已完成 {0} 個，在「{1}」停止：{2}', done, displayName(r.e), e.message), true); return; }
          }
        }
        gStatus(__('完成 {0} 個{1}{2}{3}。', done, skipped ? __('，略過 {0} 個遊戲中找不到 ID 的（紅框）', skipped) : '', failed ? __('，{0} 個沒拍到角色', failed) : '', warned ? __('，{0} 個有遊戲訊息（黃色），請檢查模型 ID 是否正確', warned) : ''), failed > 0 || skipped > 0);
        return;
      }
      if (cutoutOn()) {
        try { await takePlate(); } catch (e) { gStatus(e.message, true); return; }
      } else G.plate = null;
      for (const r of todo) {
        if (await checkpoint(done, todo.length)) { gStatus(__('已停止：完成 {0} 個，還有 {1} 個沒拍（仍保持勾選，可再按「開始批次截圖」繼續）。', done, todo.length - done)); return; }
        gStatus(__('截圖中 {0} / {1}：{2}（切換到其他視窗即可停止）', done + 1, todo.length, displayName(r.e)));
        try {
          const img = await shootOne(r);
          const a = relToAbs(img, rel);
          await saveThumbFor(r.e, gameThumb(img, a.x, a.y, a.h));
          r.el.querySelector('.th').style.backgroundImage = `url('${thumbURL(r.e)}')`;
          r.checked = false;
          r.el.querySelector('input').checked = false;
          setRowState(r, 'done');
          done++;
        } catch (e) {
          setRowState(r, 'err');
          gStatus(__('已完成 {0} 個，在「{1}」停止：{2}', done, displayName(r.e), e.message), true);
          return;
        }
      }
      gStatus(__('全部完成，共 {0} 個。可以把模型切回你原本用的，並按 F1 恢復介面。', done));
    } finally {
      G.running = false;
      G.paused = false;
      setBatchUI(false);
      gCount();
    }
  });

  // ---- 暫停／停止（在兩個模型之間生效，正在拍的那一個會先完成）----
  function setBatchUI(running) {
    $('gStart').disabled = $('gTest').disabled = running;
    $('gPause').hidden = $('gStop').hidden = !running;
    $('gStop').disabled = false;
    $('gPause').textContent = __('暫停');
  }
  async function checkpoint(done, total) {
    if (G.paused && !G.stop) {
      gStatus(__('已暫停（完成 {0} / {1}）。按「繼續」接著拍，或「停止」結束。', done, total));
      while (G.paused && !G.stop) await new Promise((res) => setTimeout(res, 200));
    }
    return G.stop;
  }
  $('gPause').onclick = () => {
    if (!G.running) return;
    G.paused = !G.paused;
    $('gPause').textContent = G.paused ? __('繼續') : __('暫停');
    if (G.paused) gStatus(__('暫停中…目前這個模型拍完後就會暫停。'));
  };
  $('gStop').onclick = () => {
    if (!G.running) return;
    G.stop = true;
    $('gStop').disabled = true;
    gStatus(__('停止中…目前這個模型拍完後就會停止。'));
  };

  // ---------------- 啟動 ----------------
  (async () => {
    try {
      applyState(await api('get_state'));
      S.settings = await api('get_settings');
      $('footInfo').textContent = '';
      if (S.roots.length) await rescan();
      else { renderAll(); $('btnDetect').click(); }
    } catch (e) { toast(__('無法連線到程式後端：') + e.message, true); }
  })();
})();
