/* YSM 模型管理器 — 介面 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TOKEN = new URLSearchParams(location.search).get('t') || '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, ...args) {
    const r = await fetch('/api/call?t=' + encodeURIComponent(TOKEN), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '發生錯誤');
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
  function ask({ title, body, ok = '確定', cancel = '取消', danger = false, remember = '', input = null }) {
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
      title: '無法使用硬連結',
      body: `倉庫和這個遊戲實例不在同一個 NTFS 磁碟（例如倉庫在 exFAT 格式的外接硬碟、遊戲在 C:），所以沒辦法用硬連結。\n\n要改用<b>複製</b>嗎？複製會在遊戲資料夾多佔一份空間${sizeText ? `（約 ${esc(sizeText)}）` : ''}。`,
      ok: '改用複製',
      remember: '以後不要再問，直接複製（可在設定中改回）',
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
    lastPick: null,
  };

  const displayName = (e) => (e.user && e.user.display_name) || (e.meta && e.meta.name) || e.filename;
  const authorText = (e) => ((e.meta && e.meta.authors) || []).map((a) => a.name).filter(Boolean).join('、');
  const thumbURL = (e) => (e.user && e.user.thumb ? `/api/thumb/${encodeURIComponent(e.user.thumb)}?${tq}` : '');
  const kindLabel = { ysm: '.ysm', folder: '資料夾', zip: 'zip', '7z': '7z' };
  const fmtSize = (n) => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; };
  const fmtDate = (t) => new Date(t * 1000).toLocaleString('zh-TW', { hour12: false });

  // ---------------- 資料夾 ----------------
  let firstState = true;
  function applyState(st) {
    // 有倉庫時預設只看倉庫，避免同一個模型在各實例重複出現
    if (firstState && st.repo) S.loc = 'repo';
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
      box.innerHTML = '<span class="st">尚未設定。倉庫是集中存放所有模型的資料夾，再從這裡安裝到各個遊戲實例。</span>';
    } else {
      const n = S.entries.filter((e) => e.location === 'repo').length;
      box.innerHTML = `<div title="${esc(S.repo)}">${esc(S.repo)}</div><div class="st">${n} 個模型</div>`;
    }
    $('btnRepo').textContent = S.repo ? '更換倉庫資料夾' : '設定倉庫資料夾';
    $('btnImportAll').disabled = !S.repo;
  }

  $('btnRepo').onclick = guard(async () => {
    const r = await api('pick_folder');
    let path = r && r.path;
    if (r && r.unsupported) path = await promptBox('倉庫資料夾', '輸入倉庫資料夾路徑（例如 D:\\YSM倉庫）：', S.repo);
    if (!path) return;
    applyState(await api('set_repo', path));
    toast('倉庫：' + S.repo);
    await rescan();
  });
  $('linkMode').onchange = guard(async (ev) => {
    applyState(await api('set_link_mode', ev.target.value));
    toast(S.linkMode === 'hardlink' ? '安裝方式：硬連結（倉庫與遊戲需在同一磁碟）' : '安裝方式：複製');
  });
  $('btnImportAll').onclick = guard(async () => {
    const n = S.entries.filter((e) => e.location !== 'repo' && !e.repo_id).length;
    if (!n) { toast('實例中的模型都已經在倉庫裡了'); return; }
    if (!(await confirmBox('加入倉庫', `把 ${n} 個還不在倉庫的模型複製進倉庫？${S.linkMode === 'hardlink' ? '\n\n完成後，實例中的檔案會換成指向倉庫的硬連結，不會多佔空間。' : ''}\n原本的模型不會被刪除。`, { ok: '加入倉庫' }))) return;
    $('btnImportAll').disabled = true;
    try {
      const res = await api('import_all');
      toast(`已加入 ${res.done} 個模型${res.linked ? `，${res.linked} 個已換成硬連結` : ''}${res.errors.length ? `；${res.errors.length} 個失敗：${res.errors[0]}` : ''}`, res.errors.length > 0);
    } finally { $('btnImportAll').disabled = false; }
    await rescan();
  });

  function renderRoots() {
    const ul = $('roots');
    ul.innerHTML = '';
    if (!S.roots.length) ul.innerHTML = '<li><span class="p muted">尚未加入資料夾</span></li>';
    for (const r of S.roots) {
      const inst = S.instances.find((i) => i.root === r) || { name: r, is_instance: false };
      const li = document.createElement('li');
      li.innerHTML = `<span class="nmw"><b title="${esc(r)}">${esc(inst.name)}</b><span class="p" title="${esc(r)}">${esc(r)}</span></span>${S.repo && inst.is_instance ? `<button class="inst-pick" data-root="${esc(r)}">安裝選取</button>` : ''}<button title="開啟資料夾">📂</button><button title="從清單移除（不會刪除檔案）">✕</button>`;
      const btns = [...li.querySelectorAll('button')];
      if (S.repo && inst.is_instance) btns.shift().onclick = () => installPicked(r);
      const [bOpen, bDel] = btns;
      bOpen.onclick = guard(() => api('open_dir', r));
      bDel.onclick = guard(async () => {
        if (!(await confirmBox('從清單移除', '從清單移除這個資料夾？\n（只是不再顯示，不會刪除任何檔案）\n\n' + r, { ok: '移除' }))) return;
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
    toast('已加入：' + res.root);
    await rescan();
  });

  $('btnAddRoot').onclick = guard(async () => {
    const r = await api('pick_folder');
    let path = r && r.path;
    if (r && r.unsupported) path = await promptBox('新增資料夾', '輸入資料夾路徑（.minecraft、實例資料夾、yes_steve_model 或 custom）：');
    if (path) await addRoot(path);
  });

  $('btnDetect').onclick = guard(async () => {
    const box = $('detectBox');
    box.hidden = false;
    box.innerHTML = '<span class="muted">搜尋中…</span>';
    const found = (await api('detect_roots')).filter((p) => !S.roots.some((r) => r.toLowerCase() === p.toLowerCase()));
    if (!found.length) { box.innerHTML = '<span class="muted">沒有找到新的 yes_steve_model 資料夾。可以用「新增資料夾」手動選擇。</span>'; return; }
    box.innerHTML = '';
    for (const p of found) {
      const d = document.createElement('div');
      d.className = 'd';
      d.innerHTML = `<span title="${esc(p)}">${esc(p)}</span><button class="btn small">加入</button>`;
      d.querySelector('button').onclick = async () => { d.remove(); await addRoot(p); if (!box.children.length) box.hidden = true; };
      box.appendChild(d);
    }
  });

  // ---------------- 掃描 ----------------
  let scanning = false;
  async function rescan() {
    if (scanning) return;
    scanning = true;
    $('btnRescan').disabled = true;
    $('count').textContent = '掃描中…';
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
      if (S.loc !== 'all' && S.loc !== 'repo' && !S.roots.includes(S.loc)) S.loc = 'all';
      renderAll();
    } catch (e) { toast(e.message, true); }
    finally { scanning = false; $('btnRescan').disabled = false; }
  }
  $('btnRescan').onclick = rescan;

  // ---------------- 篩選與排序 ----------------
  function filtered() {
    const q = S.search.trim().toLowerCase();
    let list = S.entries.filter((e) => {
      if (S.loc !== 'all' && e.location !== S.loc) return false;
      if (S.folder !== null && !inFolder(e, S.folder)) return false;
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
    const opts = [['all', '全部', S.entries.length]];
    if (S.repo) opts.push(['repo', '倉庫', S.entries.filter((e) => e.location === 'repo').length]);
    for (const r of S.roots) opts.push([r, instName(r), S.entries.filter((e) => e.location === r).length]);
    box.innerHTML = '';
    for (const [v, label, n] of opts) {
      const b = document.createElement('button');
      b.className = 'chip' + (S.loc === v ? ' on' : '');
      b.title = v === 'all' || v === 'repo' ? label : v;
      b.innerHTML = `${esc(label)}<span class="n">${n}</span>`;
      b.onclick = () => { S.loc = v; if (v !== 'repo') S.folder = null; renderLoc(); renderFolders(); renderGrid(); };
      box.appendChild(b);
    }
  }

  function renderTags() {
    const counts = new Map();
    for (const e of S.entries) for (const t of e.user.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    const box = $('fTags');
    box.innerHTML = '';
    if (!counts.size) { box.innerHTML = '<span class="muted">尚無標籤</span>'; S.tag = null; }
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
  function inFolder(e, f) { return e.location === 'repo' && (f === '' ? !e.group : e.group === f || (e.group || '').startsWith(f + '/')); }
  function folderLabel(f) { return f ? f.split('/').join(' / ') : '（最上層）'; }
  function repoPicked() { return S.entries.filter((e) => S.picked.has(e.id) && e.location === 'repo'); }

  function renderFolders() {
    $('folderSec').hidden = !S.repo;
    const ul = $('folders');
    ul.innerHTML = '';
    if (!S.repo) return;
    const repoN = S.entries.filter((e) => e.location === 'repo').length;
    const rows = [[null, '全部', repoN, 0], ['', '（最上層）', S.entries.filter((e) => inFolder(e, '')).length, 0]];
    for (const f of S.folders) rows.push([f, f.split('/').pop(), S.entries.filter((e) => inFolder(e, f)).length, f.split('/').length]);
    for (const [f, label, n, depth] of rows) {
      const li = document.createElement('li');
      li.className = 'fd' + (S.folder === f && (f !== null || S.loc === 'repo') ? ' on' : '');
      li.style.paddingLeft = 6 + Math.max(0, depth - 1) * 14 + 'px';
      li.title = f === null ? '倉庫中所有模型' : folderLabel(f);
      li.innerHTML = `<span class="fn">${f === null ? '🗃' : '📁'} ${esc(label)}</span><span class="n">${n}</span>${f ? '<span class="fa"><button data-a="sub" title="在這裡新增子資料夾">＋</button><button data-a="ren" title="重新命名">✎</button><button data-a="del" title="刪除資料夾">✕</button></span>' : ''}`;
      li.onclick = (ev) => {
        const a = ev.target.closest('button')?.dataset.a;
        if (a === 'sub') return newFolder(f);
        if (a === 'ren') return renameFolder(f);
        if (a === 'del') return deleteFolder(f);
        S.folder = f; S.loc = 'repo';
        renderLoc(); renderFolders(); renderGrid();
      };
      if (f !== null) {
        li.ondragover = (ev) => { if (ev.dataTransfer.types.includes('text/ysm-ids')) { ev.preventDefault(); li.classList.add('drop'); } };
        li.ondragleave = () => li.classList.remove('drop');
        li.ondrop = (ev) => {
          ev.preventDefault();
          li.classList.remove('drop');
          const ids = JSON.parse(ev.dataTransfer.getData('text/ysm-ids') || '[]');
          moveModels(ids, f);
        };
      }
      ul.appendChild(li);
    }
  }

  const newFolder = guard(async (parent) => {
    const name = await promptBox('新增資料夾', `在「${folderLabel(parent || '')}」中新增資料夾，名稱：`);
    if (!name) return;
    S.folders = await api('create_folder', parent || '', name);
    renderFolders(); updateSelUI();
    toast('已新增資料夾：' + name);
  });
  $('btnNewFolder').onclick = () => newFolder('');

  const installedIn = (list) => list.reduce((a, e) => a + (e.installs || []).length, 0);

  const renameFolder = guard(async (f) => {
    const old = f.split('/').pop();
    const name = await promptBox('重新命名資料夾', `「${folderLabel(f)}」的新名稱：`, old);
    if (!name || name === old) return;
    const inside = S.entries.filter((e) => inFolder(e, f));
    const n = installedIn(inside);
    if (n && !(await confirmBox('重新命名資料夾', `這個資料夾中的模型有 ${n} 份已安裝到遊戲，遊戲中的檔案也會一起改到新的資料夾，模型 ID 會跟著改變（例如「${old}/角色.ysm」→「${name}/角色.ysm」）。\n\n已經套用在玩家身上的模型可能需要重新選一次。`, { ok: '重新命名' }))) return;
    const res = await api('rename_folder', f, name);
    if (S.folder === f || (S.folder || '').startsWith(f + '/')) S.folder = (f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '') + name + (S.folder || '').slice(f.length);
    toast(`已重新命名${res.moved ? `，遊戲中 ${res.moved} 份也已移動` : ''}${res.errors.length ? `；${res.errors.length} 個問題：${res.errors[0]}` : ''}`, res.errors.length > 0);
    await rescan();
  });

  const deleteFolder = guard(async (f) => {
    if (S.entries.some((e) => inFolder(e, f))) { toast('資料夾裡還有模型，請先移到其他資料夾', true); return; }
    if (!(await confirmBox('刪除資料夾', `刪除空的資料夾「${folderLabel(f)}」？`, { ok: '刪除', danger: true }))) return;
    S.folders = await api('delete_folder', f);
    if (S.folder === f || (S.folder || '').startsWith(f + '/')) S.folder = null;
    renderFolders(); updateSelUI(); renderGrid();
    toast('已刪除資料夾');
  });

  const moveModels = guard(async (ids, folder) => {
    const list = S.entries.filter((e) => ids.includes(e.id) && e.location === 'repo' && (e.group || '') !== folder);
    if (!list.length) { toast(ids.length ? '選取的倉庫模型已經在這個資料夾了' : '沒有選取倉庫中的模型'); return; }
    const n = installedIn(list);
    if (n && !(await confirmBox('移動模型', `把 ${list.length} 個模型移到「${folderLabel(folder)}」？\n\n其中有 ${n} 份已安裝到遊戲，遊戲中的檔案也會一起移到同名資料夾，模型 ID 會跟著改變（例如「角色.ysm」→「${folder ? folder + '/' : ''}角色.ysm」）。已經套用在玩家身上的模型可能需要重新選一次。`, { ok: '移動' }))) return;
    const res = await api('move_models', list.map((e) => e.id), folder);
    toast(`已移動 ${res.done} 個到「${folderLabel(folder)}」${res.moved_installs ? `，遊戲中 ${res.moved_installs} 份也已移動` : ''}${res.errors.length ? `；${res.errors.length} 個問題：${res.errors[0]}` : ''}`, res.errors.length > 0);
    await rescan();
  });

  // ---------------- 勾選與批量操作 ----------------
  function updateSelUI() {
    const n = S.picked.size;
    const rp = repoPicked();
    $('selBar').hidden = n === 0;
    $('grid').classList.toggle('picking', n > 0);
    $('selN').textContent = n;
    $('selNote').textContent = rp.length === n ? '' : `（倉庫中 ${rp.length} 個；只有倉庫的模型能安裝或移動）`;
    const insts = S.instances.filter((i) => i.is_instance && S.roots.includes(i.root));
    const keepI = $('selInst').value;
    $('selInst').innerHTML = insts.map((i) => `<option value="${esc(i.root)}">${esc(i.name)}</option>`).join('') || '<option value="">（沒有遊戲實例）</option>';
    if (insts.some((i) => i.root === keepI)) $('selInst').value = keepI;
    const keepF = $('selFolder').value;
    $('selFolder').innerHTML = ['', ...S.folders].map((f) => `<option value="${esc(f)}">${esc(folderLabel(f))}</option>`).join('') + '<option value="\u0000new">＋ 新資料夾…</option>';
    if (['', ...S.folders].includes(keepF)) $('selFolder').value = keepF;
    $('selInstall').disabled = !rp.length || !insts.length;
    $('selMove').disabled = !rp.length;
    document.querySelectorAll('.inst-pick').forEach((b) => {
      b.textContent = rp.length ? `安裝選取（${rp.length}）` : '安裝選取';
      b.disabled = !rp.length;
      b.title = rp.length ? `把勾選的 ${rp.length} 個倉庫模型安裝到這個實例` : '先在右邊勾選倉庫中的模型（點卡片左上角，或 Ctrl / Shift + 點擊）';
    });
  }

  function togglePick(id, on) {
    if (on === undefined ? !S.picked.has(id) : on) S.picked.add(id); else S.picked.delete(id);
  }
  function refreshPicks() {
    document.querySelectorAll('#grid .card').forEach((c) => c.classList.toggle('picked', S.picked.has(c.dataset.id)));
    updateSelUI();
  }

  const installPicked = guard(async (root) => {
    const name = instName(root);
    const rp = repoPicked();
    const todo = rp.filter((e) => !e.installs.some((i) => i.root === root));
    if (!rp.length) { toast('請先勾選倉庫中的模型（點卡片左上角的方框，或 Ctrl / Shift + 點擊卡片）'); return; }
    if (!todo.length) { toast(`選取的模型都已經安裝在「${name}」了`); return; }
    const skip = rp.length - todo.length;
    const inSub = todo.filter((e) => e.group).length;
    if (!(await confirmBox('安裝選取的模型', `把 ${todo.length} 個模型安裝到「${name}」？${skip ? `\n（另外 ${skip} 個已經安裝過，會略過）` : ''}${inSub ? `\n\n其中 ${inSub} 個在倉庫的子資料夾中，會放進遊戲中同名的資料夾。` : ''}`, { ok: '安裝' }))) return;
    const ids = todo.map((e) => e.id);
    let res = await api('install_many', ids, root);
    if (res.need_copy) {
      if (await confirmCopy(fmtSize(todo.reduce((a, e) => a + (e.size || 0), 0)))) {
        const more = await api('install_many', ids, root, true);
        res = { done: res.done + more.done, copied: res.copied + more.copied, errors: res.errors.concat(more.errors) };
      } else {
        toast(`已安裝 ${res.done} 個；其餘的需要改用複製，已取消`);
        await rescan();
        return;
      }
    }
    toast(`已安裝 ${res.done} 個到「${name}」${res.copied ? `（其中 ${res.copied} 個用複製）` : ''}${res.errors.length ? `；${res.errors.length} 個失敗：${res.errors[0]}` : ''}`, res.errors.length > 0);
    await rescan();
  });

  $('selInstall').onclick = () => { if ($('selInst').value) installPicked($('selInst').value); };
  $('selMove').onclick = guard(async () => {
    let f = $('selFolder').value;
    if (f === '\u0000new') {
      const name = await promptBox('新資料夾', '在倉庫最上層新增資料夾並把選取的模型移進去，名稱：');
      if (!name) { updateSelUI(); return; }
      S.folders = await api('create_folder', '', name);
      f = name.trim();
    }
    await moveModels([...S.picked], f);
  });
  $('selFolder').onchange = () => { if ($('selFolder').value === '\u0000new') $('selMove').click(); };
  $('selNone').onclick = () => { S.picked.clear(); refreshPicks(); };
  $('selPage').onclick = () => { document.querySelectorAll('#grid .card').forEach((c) => S.picked.add(c.dataset.id)); refreshPicks(); };
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && S.picked.size && !document.querySelector('.modal:not([hidden])')) { S.picked.clear(); refreshPicks(); }
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
    p.innerHTML = `<span class="muted">第 ${from}–${to} 個，共 ${total} 個</span>
      <span class="pg-nums">${pages > 1 ? btn('‹', PAGE.page - 1, { dis: PAGE.page === 0, title: '上一頁（PageUp）' }) + nums + btn('›', PAGE.page + 1, { dis: PAGE.page >= pages - 1, title: '下一頁（PageDown）' }) : ''}</span>
      <label class="muted">每頁<select id="pageSize">${[24, 48, 96, 0].map((n) => `<option value="${n}" ${n === PAGE.size ? 'selected' : ''}>${n || '全部'}</option>`).join('')}</select></label>`;
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
  const groupKey = (e) => e.location + '|' + verInfo(e).base;
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
    const sig = all.map((it) => it.k).join('|');
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
    for (const it of list) {
      const e = it.e;
      const c = document.createElement('div');
      c.className = 'card' + (e.id === S.sel ? ' sel' : '') + (e.enabled ? '' : ' off') + (S.picked.has(e.id) ? ' picked' : '');
      c.dataset.id = e.id;
      // 這個版本沒有縮圖時，借用同角色其他版本的
      const th = thumbURL(e) || thumbURL(it.members.find((m) => m.user.thumb) || e);
      const stars = e.user.rating ? '★'.repeat(e.user.rating) : '';
      c.innerHTML = `<div class="thumb" ${th ? `style="background-image:url('${th}')"` : ''}>${th ? '' : `<span class="ph">${esc(kindLabel[e.kind] || '?')}</span>`}<span class="pick" title="勾選（Ctrl / Shift + 點擊卡片也可以）">✓</span>
          <span class="badge${e.location === 'repo' ? ' repo' : ''}">${e.location === 'repo' ? '倉庫 · ' : ''}${esc(kindLabel[e.kind] || e.kind)}</span>${e.kind === 'ysm' ? '<span class="badge lock">加密</span>' : ''}${e.enabled ? '' : '<span class="badge offb">已停用</span>'}${it.members.length > 1 ? `<span class="badge ver" title="同一個角色有 ${it.members.length} 個版本，點開可切換">${it.members.length} 個版本</span>` : ''}
          ${e.location === 'repo' ? `<span class="badge inst">已裝 ${e.installs.length}/${S.instances.filter((i) => i.is_instance).length}</span>` : (S.repo && !e.repo_id ? '<span class="badge norepo">未入庫</span>' : '')}</div>
        <div class="meta"><div class="nm" title="${esc(displayName(e))}">${esc(displayName(e))}</div>
          <div class="au">${esc(authorText(e) || e.filename)}</div>
          ${e.location !== 'repo' && S.roots.length > 1 ? `<div class="au" title="${esc(e.root)}">📁 ${esc(e.instance)}</div>` : ''}
          ${e.location === 'repo' && e.group && S.folder !== e.group ? `<div class="au" title="倉庫資料夾">📂 ${esc(folderLabel(e.group))}</div>` : ''}
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
      ? `${files.length} / ${S.entries.length} 個模型`
      : `${all.length} 張卡（${files.length} / ${S.entries.length} 個檔案）`;
    $('emptyState').hidden = S.entries.length > 0;
  }

  function renderAll() {
    renderLoc();
    renderFolders();
    updateSelUI();
    renderRepo();
    renderTags();
    renderGrid();
    renderDetail();
    const on = S.entries.filter((e) => e.enabled).length;
    $('footInfo').textContent = S.entries.length ? `共 ${S.entries.length} 個，啟用 ${on}，停用 ${S.entries.length - on}` : '';
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
          ? `<span class="s ok">已安裝 · ${ins.link === 'hardlink' ? '硬連結' : '複製'}${ins.enabled ? '' : ' · 停用中'}</span>`
          : '<span class="s">未安裝</span>';
        const btn = ins
          ? `<button class="btn small ghost" data-un="${esc(ins.id)}">移除</button>`
          : `<button class="btn small" data-in="${esc(inst.root)}">安裝</button>`;
        return `<div class="inst-row"><span class="n"><b title="${esc(inst.root)}">${esc(inst.name)}</b>${state}</span>${btn}</div>`;
      }).join('');
      return `<div class="d-sec"><h3>安裝到遊戲實例</h3><div class="inst-list" id="dInst">${rows || '<span class="muted">尚未加入遊戲實例</span>'}</div></div>`;
    }
    if (e.repo_id) {
      return `<div class="d-sec"><h3>倉庫</h3><div class="inst-row"><span class="n"><span class="s ok">倉庫中已有這個模型</span></span><button class="btn small ghost" data-goto="${esc(e.repo_id)}">查看倉庫項目</button></div></div>`;
    }
    return `<div class="d-sec"><h3>倉庫</h3><div class="inst-row"><span class="n"><span class="s">還沒加入倉庫</span></span><button class="btn small" data-import="1">加入倉庫</button></div></div>`;
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
        toast('已安裝到「' + instName(b.dataset.in) + '」' + (res.fallback ? '（用複製）' : ''));
        await rescan();
      });
    });
    box.querySelectorAll('[data-un]').forEach((b) => {
      b.onclick = guard(async () => {
        const ins = e.installs.find((x) => x.id === b.dataset.un);
        if (!(await confirmBox('從實例移除', `從「${ins ? ins.instance : ''}」移除這個模型？\n倉庫中的檔案會保留，之後可以再安裝。`, { ok: '移除' }))) return;
        await api('uninstall', b.dataset.un);
        toast('已從實例移除');
        await rescan();
      });
    });
    const g = box.querySelector('[data-goto]');
    if (g) g.onclick = () => { S.sel = g.dataset.goto; PAGE.reveal = true; if (S.loc !== 'all' && S.loc !== 'repo') S.loc = 'all'; renderLoc(); renderGrid(); renderDetail(); };
    const im = box.querySelector('[data-import]');
    if (im) im.onclick = guard(async () => {
      im.disabled = true;
      const res = await api('import_to_repo', e.id);
      toast(res.linked ? '已加入倉庫，實例中的檔案已換成硬連結' : '已加入倉庫（複製）');
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
    add('說明中的連結', e.meta && e.meta.tips);
    add('檔頭公開資訊中的連結', e.summary && e.summary.text);
    return out.slice(0, 20);
  }
  const hostOf = (u) => { try { return new URL(u).host; } catch (err) { return ''; } };
  function linksSection(e) {
    const links = modelLinks(e);
    if (!links.length) return '';
    const rows = links.map((l) => `<div class="link-row">
        <span class="n"><b>${esc(l.label)}</b><small title="${esc(l.url)}">${esc(l.url)}</small></span>
        <button class="btn small ghost" data-url="${esc(l.url)}" data-label="${esc(l.label)}">前往 ↗</button>
      </div>`).join('');
    return `<div class="d-sec"><h3>連結（${links.length}）</h3><div class="link-list">${rows}</div>
      <div class="muted small-note">這些連結由模型作者提供，管理器無法確認是否安全，開啟前會再提醒一次。</div></div>`;
  }
  async function openExternal(url, label) {
    const host = hostOf(url);
    if (!host || !/^https?:$/i.test(new URL(url).protocol)) { toast('只能開啟 http 或 https 連結', true); return; }
    const r = await ask({
      title: '即將開啟外部連結',
      body: `${label ? esc(label) + '\n' : ''}網站：<b>${esc(host)}</b>\n<small>${esc(url)}</small>\n\n`
        + '<span class="warn">⚠ 這是模型作者提供的連結，管理器無法確認它是否安全。</span>\n'
        + '・確認網址是你預期的網站，小心仿冒網址\n'
        + '・不要在不熟悉的網站輸入密碼、帳號或付款資訊\n'
        + '・不要下載或執行來路不明的檔案'
        + (/^http:/i.test(url) ? '\n・<span class="warn">這個連結沒有加密（http），傳送的資料可能被看到</span>' : ''),
      ok: '在瀏覽器開啟', cancel: '不要開啟', danger: true,
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
        <span class="v">${ver ? 'v' + esc(ver) : '（無版本號）'}</span>
        <span class="f">${esc(v.filename)}${dir ? `<small>${esc(dir)}</small>` : ''}</span>
        <span class="t">${i === 0 ? '<i class="new">最新</i>' : ''}${v.location === 'repo' && v.installs.length ? `<i>已裝 ${v.installs.length}</i>` : ''}${fmtSize(v.size || 0)}</span>
      </button>`;
    }).join('');
    return `<div class="d-sec"><h3>版本（${vs.length}）</h3><div class="ver-list">${rows}</div>
      <div class="muted small-note">點選切換；安裝、刪除、縮圖等操作都只針對目前選取的版本。</div></div>`;
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
      <div class="d-thumb ${th ? 'has' : ''}" id="dThumb" ${th ? `style="background-image:url('${th}')"` : ''}>
        <div class="hint">把圖片拖到這裡、按 Ctrl+V 貼上，<br>或用下方按鈕設定縮圖</div>
      </div>
      <div class="row">
        <button class="btn small ghost" id="bShot">從遊戲截圖選</button>
        <button class="btn small ghost" id="bImg">選擇圖片</button>
        ${th ? '<button class="btn small danger" id="bClr">清除</button>' : ''}
      </div>
      <div class="d-title">${esc(displayName(e))}</div>
      <div class="d-sub">${esc(e.filename)}</div>
      ${versionsSection(e)}
      <div class="row">
        ${e.previewable ? '<button class="btn" id="bPrev">3D 預覽</button>' : ''}
        ${e.source ? `<button class="btn ghost" id="bToggle">${e.enabled ? '停用' : '啟用'}</button>` : ''}
        <button class="btn ghost" id="bReveal">在檔案總管中顯示</button>
        <button class="btn ghost" id="bRename">重新命名</button>
        <button class="btn danger" id="bDelModel">${e.location === 'repo' ? '從倉庫刪除' : '刪除'}</button>
      </div>
      ${installSection(e)}
      ${e.kind === 'ysm' ? '<div class="d-sec note">這是加密的 .ysm 模型，只能在遊戲內的 YSM 選單預覽 3D。建議在遊戲中截圖，再用「從遊戲截圖選」設為縮圖。</div>' : ''}
      ${e.error ? `<div class="d-sec note" style="color:var(--warn)">${esc(e.error)}</div>` : ''}

      <div class="d-sec"><h3>評分</h3><div class="stars-edit" id="dStars">${[1, 2, 3, 4, 5].map((i) => `<button data-v="${i}" class="${(e.user.rating || 0) >= i ? 'on' : ''}">★</button>`).join('')}</div></div>
      <div class="d-sec"><h3>標籤</h3><div class="tags-edit" id="dTags">${(e.user.tags || []).map((t) => `<span class="t">${esc(t)}<button data-t="${esc(t)}">✕</button></span>`).join('')}<input id="dTagIn" list="tagList" placeholder="輸入後按 Enter"></div></div>
      <div class="d-sec"><h3>顯示名稱（只改清單中的名稱，不改檔名）</h3><input id="dName" type="text" class="field-full" placeholder="${esc((m.name) || e.filename)}" value="${esc(e.user.display_name || '')}"></div>
      <div class="d-sec"><h3>備註</h3><textarea id="dNotes" placeholder="購買來源、價格、授權條件、使用伺服器…">${esc(e.user.notes || '')}</textarea></div>

      <div class="d-sec"><h3>模型資訊</h3><div class="kv">
        <span>格式</span><span>${esc(m.format || kindLabel[e.kind])}</span>
        ${m.name ? `<span>名稱</span><span>${esc(m.name)}</span>` : ''}
        ${m.license ? `<span>授權</span><span>${esc(m.license)}</span>` : ''}
        ${m.pack_count ? `<span>模型數</span><span>${m.pack_count}</span>` : ''}
        <span>狀態</span><span>${e.enabled ? '<span style="color:var(--ok)">已啟用</span>' : '已停用'}${e.source ? '（' + esc(e.source) + '）' : ''}</span>
        <span>大小</span><span>${fmtSize(e.size)}</span>
        <span>修改</span><span>${fmtDate(e.mtime)}</span>
        <span>位置</span><span>${esc(e.path)}</span>
      </div></div>
      ${authors ? `<div class="d-sec"><h3>作者</h3>${authors}</div>` : ''}
      ${m.tips ? `<div class="d-sec"><h3>說明</h3><div class="note" style="white-space:pre-wrap">${esc(m.tips)}</div></div>` : ''}
      ${e.kind === 'ysm' ? `<div class="d-sec"><h3>檔頭公開資訊</h3>${e.summary && e.summary.text ? `<div class="summary">${esc(e.summary.text)}</div>` : '<div class="muted" style="font-size:12px">這個檔案沒有可讀的公開摘要。</div>'}</div>` : ''}
      ${linksSection(e)}
    `;

    const q = (id) => box.querySelector('#' + id);
    bindInstallSection(box, e);
    q('bShot').onclick = () => openShots();
    q('bImg').onclick = () => $('imgPick').click();
    if (q('bClr')) q('bClr').onclick = guard(async () => { applyUser(e.key, await api('clear_thumb', e.key)); renderGrid(); renderDetail(); });
    if (q('bPrev')) q('bPrev').onclick = () => openPreview(e);
    if (q('bToggle')) q('bToggle').onclick = guard(async () => {
      await api('set_enabled', e.id, !e.enabled);
      toast(e.enabled ? '已停用（移到 ysm_manager_disabled，遊戲不會載入）' : '已啟用');
      const keepKey = e.key;
      await rescan();
      const again = S.entries.find((x) => x.key === keepKey && x.enabled !== e.enabled);
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
          ? `\n\n已安裝在：${info.installs.map(esc).join('、')}。\n<b>實例中的那份不會被刪除</b>，遊戲仍可使用。`
          : '';
      } else {
        where = `\n\n只會從「${esc(info.instance)}」刪除，遊戲中就不能再使用這個模型。`
          + (info.backup ? '\n倉庫中有這個模型，之後可以再安裝回來。' : '\n<span class="warn">倉庫中沒有這個模型的備份。</span>')
          + (info.installs.length ? `\n${info.installs.map(esc).join('、')} 中的那份不受影響。` : '');
      }
      const fate = info.recycle
        ? '檔案會移到<b>資源回收筒</b>，需要時可以還原。'
        : '<span class="warn">這個磁碟沒有資源回收筒，刪除後無法復原！</span>';
      const r1 = await ask({
        title: info.in_repo ? '從倉庫刪除模型' : '刪除遊戲實例中的模型',
        body: `要刪除「<b>${esc(displayName(e))}</b>」嗎？\n${esc(info.name)}（${esc(info.size)}）${where}\n\n${fate}`,
        ok: '刪除', danger: true,
      });
      if (!r1.ok) return;
      if (!S.settings || S.settings.confirm_delete_twice !== false) {
        const r2 = await ask({
          title: '再次確認',
          body: `真的要刪除「<b>${esc(displayName(e))}</b>」嗎？\n\n${fate}`,
          ok: '確定刪除', cancel: '不要刪除', danger: true,
        });
        if (!r2.ok) return;
      }
      const res = await api('delete_model', e.id);
      toast(res.recycled ? '已刪除（已移到資源回收筒）' : '已永久刪除');
      S.sel = null;
      await rescan();
    });
    q('bRename').onclick = guard(async () => {
      const base = e.kind === 'folder' ? e.filename : e.filename.replace(/\.[^.]+$/, '');
      const n = await promptBox('重新命名', '新的檔名（遊戲中的模型 ID 會隨之改變）：', base);
      if (!n || n === base) return;
      const res = await api('rename', e.id, n);
      toast('已重新命名');
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
    $('setLang').value = st.lang || 'zh-Hant';
    $('setGroupVer').checked = st.group_versions !== false;
    $('setConfirmCopy').checked = st.confirm_copy !== false;
    $('setConfirmDel').checked = st.confirm_delete_twice !== false;
    $('setRepoPath').textContent = S.repo || '尚未設定';
    $('setRepoChange').textContent = S.repo ? '更換…' : '設定…';
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
  const saveSetting = (patch) => guard(async () => { S.settings = await api('set_settings', patch()); renderSettings(); toast('已儲存設定'); });
  $('setLang').onchange = saveSetting(() => ({ lang: $('setLang').value }));
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
      title: '搬移管理器資料',
      body: `把標籤、評分、備註和縮圖搬到：\n<b>${esc(target)}</b>\n\n會先複製到新位置，成功後才刪除舊位置的檔案。`,
      ok: '搬移',
    });
    if (!r.ok) return;
    S.settings = await api('move_data_dir', target);
    renderSettings();
    toast('已搬移到 ' + S.settings.data_dir_now);
  }
  $('setDataChange').onclick = guard(async () => {
    const r = await api('pick_folder');
    let path = r && r.path;
    if (r && r.unsupported) path = await promptBox('搬移管理器資料', '輸入新的資料夾路徑：', S.settings.data_dir_now);
    if (!path) return;
    await moveData(path);
  });
  $('setDataReset').onclick = guard(async () => { await moveData(S.settings.data_dir_default); });

  // ---- 解除安裝管理器 ----
  async function renderUninstall() {
    try {
      const u = await api('uninstall_info');
      $('unRestoreText').textContent = u.disabled
        ? `把 ${u.disabled} 個停用的模型移回原位（否則遊戲不會讀取它們）`
        : '把停用的模型移回原位（目前沒有停用的模型）';
      $('unModText').textContent = u.mod_instances.length
        ? `同時移除遊戲實例中的 YSM Shot MOD（${u.mod_instances.join('、')}）`
        : '同時移除各遊戲實例中的 YSM Shot MOD（目前沒有安裝）';
    } catch (e) { /* 忽略 */ }
  }
  $('btnSettings').addEventListener('click', renderUninstall);
  $('btnUninstall').onclick = guard(async () => {
    const u = await api('uninstall_info');
    const restore = $('unRestore').checked, mod = $('unMod').checked;
    const steps = [];
    if (restore && u.disabled) steps.push(`把 ${u.disabled} 個停用的模型移回原位`);
    if (mod && u.mod_instances.length) steps.push(`從 ${u.mod_instances.map(esc).join('、')} 移除 YSM Shot MOD`);
    steps.push('關閉管理器');
    steps.push(`刪除管理器的資料（設定、標籤、評分、備註、縮圖）\n　<small>${esc(u.data_dir)}</small>`);
    if (u.exe) steps.push(`刪除程式本身\n　<small>${esc(u.exe)}</small>`);
    const r1 = await ask({
      title: '解除安裝 YSM 模型管理器',
      body: `將會：\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n<b>遊戲、倉庫和所有模型檔案都不會被刪除。</b>`
        + (!restore && u.disabled ? `\n<span class="warn">你選擇不移回停用的模型：那 ${u.disabled} 個模型會留在 ysm_manager_disabled 資料夾，遊戲不會讀取。</span>` : ''),
      ok: '解除安裝', danger: true,
    });
    if (!r1.ok) return;
    const r2 = await ask({
      title: '再次確認',
      body: '確定要解除安裝嗎？\n標籤、評分、備註和縮圖刪除後<span class="warn">無法復原</span>。',
      ok: '確定解除安裝', cancel: '不要', danger: true,
    });
    if (!r2.ok) return;
    await api('uninstall_app', restore, mod);
    document.body.innerHTML = '<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-size:16px;color:#aaa">已解除安裝，管理器即將關閉…</div>';
  });

  // ---------------- 截圖挑選 ----------------
  const openShots = guard(async () => {
    const shots = await api('list_screenshots');
    const g = $('shotGrid');
    g.innerHTML = '';
    $('shotDir').textContent = shots.length ? `最近 ${shots.length} 張（依時間排序）` : '';
    if (!shots.length) g.innerHTML = '<div class="muted" style="padding:20px">找不到遊戲截圖資料夾或沒有截圖。在遊戲中按 F2 截圖後再試一次，或改用「選擇圖片」。</div>';
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
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('圖片讀取失敗')); i.src = src; });
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
    toast('縮圖已更新');
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
    $('previewTitle').textContent = displayName(e);
    $('previewStatus').textContent = '載入中…';
    $('previewModal').hidden = false;
    await loadIntoViewer(e, $('previewFrame'));
    $('previewStatus').textContent = '左鍵旋轉、右鍵平移、滾輪縮放；調好角度後可設為縮圖';
  });

  function captureViewer(w) {
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
    if (!todo.length) { toast('所有可預覽的模型都已經有縮圖了（加密 .ysm 需在遊戲中截圖）'); return; }
    if (!(await confirmBox('批次產生縮圖', `將為 ${todo.length} 個可預覽的模型自動產生縮圖，繼續？`, { ok: '開始' }))) return;
    const ifr = $('previewFrame');
    $('previewModal').hidden = false;
    let done = 0;
    for (const e of todo) {
      if ($('previewModal').hidden) break; // 使用者中止
      $('previewTitle').textContent = `批次產生縮圖 ${done + 1} / ${todo.length}`;
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
    toast(`已產生 ${done} 張縮圖`);
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
      r.idIn.title = bad ? '遊戲中沒有這個模型 ID（可能是 YSM 沒有載入這個檔案，或 ID 要修改）' : '模型 ID';
    }
  }

  function gStatus(msg, err) { const s = $('gStatus'); s.textContent = msg; s.className = 'g-status' + (err ? ' err' : ''); }
  function gCropInfo() {
    const c = LS.get('crop', null);
    $('gCropInfo').textContent = c ? '已設定縮圖範圍（試拍可重新設定）' : '尚未設定縮圖範圍：請先「試拍第一個」';
  }

  const refreshWindows = guard(async () => {
    const wins = await api('game_windows');
    const sel = $('gWin');
    const prev = sel.value;
    sel.innerHTML = wins.length ? '' : '<option value="">找不到遊戲視窗，請先開啟遊戲</option>';
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
    if (!list.length) box.innerHTML = '<div class="muted" style="padding:12px">這個實例中沒有已啟用的模型。</div>';
    for (const r of G.rows) {
      const th = thumbURL(r.e);
      const row = document.createElement('div');
      row.className = 'g-row';
      row.innerHTML = `<input type="checkbox" ${r.checked ? 'checked' : ''}><span class="th" ${th ? `style="background-image:url('${th}')"` : ''}></span>
        <span class="nm"><b>${esc(displayName(r.e))}</b><span>${esc(r.e.rel)}</span></span>
        <input type="text" spellcheck="false" value="${esc(modelIdOf(r.e))}" title="模型 ID">`;
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
  function gCount() { $('gCount').textContent = `已選 ${G.rows.filter((r) => r.checked).length} / ${G.rows.length}`; }

  $('btnGame').onclick = async () => {
    const insts = S.instances.filter((i) => i.is_instance);
    if (!insts.length) { toast('請先加入遊戲實例（左側「遊戲實例」）', true); return; }
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
    gStatus(`已安裝 YSM Shot 到 ${res.path}${res.removed.length ? `（已移除舊版 ${res.removed.join('、')}）` : ''}。這個實例還需要 Forge 1.20.1 和 YSM，重新啟動遊戲後生效。`);
  });
  async function loadIds() {
    G.ids = new Set(await api('bridge_ids', $('gInst').value));
    markIds();
    return G.ids.size;
  }
  $('gPing').onclick = guard(async () => {
    gStatus('連線中…');
    try {
      const s = await api('bridge_status', $('gInst').value);
      if (!s.inWorld) gStatus(`已連上 YSM Shot（Minecraft ${s.mc}），但還沒進入世界。請進入單人世界。`, true);
      else if (s.paused) gStatus('已連上，但遊戲目前暫停中。請關閉選單，並按 F3+P 關閉「失去焦點時暫停」。', true);
      else {
        const n = await loadIds();
        const bad = G.rows.filter((r) => r.idIn.classList.contains('bad')).length;
        gStatus(`已連上 YSM Shot：Minecraft ${s.mc}，玩家 ${s.player}，遊戲中有 ${n} 個模型${bad ? `；清單中 ${bad} 個的 ID 在遊戲中找不到（紅框），批次截圖時會略過` : ''}${s.pauseOnLostFocus ? '。提醒：切到其他視窗時遊戲會暫停，建議在遊戲中按 F3+P 關閉' : '。'}`);
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
    if (x1 < 0) throw new Error('畫面是空的：沒有拍到角色（角色可能隱形或模型還沒載入，可把等待秒數調長）');
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
    if (shot.clipped) notes.push('角色超出畫面，請把「角色大小」調小');
    if (!notes.length) return false;
    const m = document.createElement('span');
    m.className = 'msg';
    m.textContent = '遊戲訊息：' + notes.join('／');
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

  async function shootOne(r) {
    const hwnd = $('gWin').value;
    if (!hwnd) throw new Error('請先選擇遊戲視窗（開啟遊戲後按「重新整理」）');
    const res = await api('game_shot', hwnd, $('gInst').value, buildCmd(r), Number($('gWait').value) || 1);
    const blob = await (await fetch(`/api/shot?p=${encodeURIComponent(res.path)}&${tq}`)).blob();
    return loadImage(URL.createObjectURL(blob));
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
    if (!r) { toast('沒有可截圖的模型', true); return; }
    G.running = true;
    if (G.mode === 'mod') {
      gStatus(`試拍：${displayName(r.e)}…`);
      try {
        const shot = await modOne(r);
        gStatus(`拍好了，已存成「${displayName(r.e)}」的縮圖。請確認是正確的模型${shot.messages.length ? '，並看看下方的遊戲訊息' : ''}，再「開始批次截圖」。`);
      } catch (e) { setRowState(r, 'err'); gStatus(e.message, true); } finally { G.running = false; }
      return;
    }
    gStatus(`試拍：${displayName(r.e)}…（請不要動鍵盤滑鼠）`);
    try {
      const img = await shootOne(r);
      gStatus('拍好了。請確認畫面中的模型已切換成「' + displayName(r.e) + '」，再框出縮圖範圍。');
      openCrop(img, async (rect) => {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        LS.set('crop', { fx: rect.x / iw, fy: rect.y / ih, fh: rect.h / ih });
        await saveThumbFor(r.e, cropToDataURL(img, rect.x, rect.y, rect.h));
        setRowState(r, 'done');
        r.el.querySelector('.th').style.backgroundImage = `url('${thumbURL(r.e)}')`;
        gCropInfo();
        gStatus('已設定縮圖範圍並存好第一張。可以「開始批次截圖」了。');
      }, LS.get('crop', null));
    } catch (e) {
      setRowState(r, 'err');
      gStatus(e.message, true);
    } finally { G.running = false; }
  });

  $('gStart').onclick = guard(async () => {
    if (G.running) return;
    const rel = LS.get('crop', null);
    if (G.mode === 'keys' && !rel) { toast('請先「試拍第一個」並設定縮圖範圍', true); return; }
    const todo = G.rows.filter((r) => r.checked);
    if (!todo.length) { toast('請勾選要截圖的模型', true); return; }
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
          if (await checkpoint(done, todo.length)) { gStatus(`已停止：完成 ${done} 個，還有 ${todo.length - done - failed - skipped} 個沒拍（仍保持勾選，可再按「開始批次截圖」繼續）。`); return; }
          gStatus(`截圖中 ${done + failed + skipped + 1} / ${todo.length}：${displayName(r.e)}`);
          try {
            const shot = await modOne(r);
            if (shot.messages.length || shot.clipped) warned++;
            done++;
          } catch (e) {
            setRowState(r, 'err');
            failed++;
            // 連線或遊戲狀態問題會讓後面全部失敗，直接停止
            if (!/畫面是空的/.test(e.message)) { gStatus(`已完成 ${done} 個，在「${displayName(r.e)}」停止：${e.message}`, true); return; }
          }
        }
        gStatus(`完成 ${done} 個${skipped ? `，略過 ${skipped} 個遊戲中找不到 ID 的（紅框）` : ''}${failed ? `，${failed} 個沒拍到角色` : ''}${warned ? `，${warned} 個有遊戲訊息（黃色），請檢查模型 ID 是否正確` : ''}。`, failed > 0 || skipped > 0);
        return;
      }
      for (const r of todo) {
        if (await checkpoint(done, todo.length)) { gStatus(`已停止：完成 ${done} 個，還有 ${todo.length - done} 個沒拍（仍保持勾選，可再按「開始批次截圖」繼續）。`); return; }
        gStatus(`截圖中 ${done + 1} / ${todo.length}：${displayName(r.e)}（切換到其他視窗即可停止）`);
        try {
          const img = await shootOne(r);
          const a = relToAbs(img, rel);
          await saveThumbFor(r.e, cropToDataURL(img, a.x, a.y, a.h));
          r.el.querySelector('.th').style.backgroundImage = `url('${thumbURL(r.e)}')`;
          r.checked = false;
          r.el.querySelector('input').checked = false;
          setRowState(r, 'done');
          done++;
        } catch (e) {
          setRowState(r, 'err');
          gStatus(`已完成 ${done} 個，在「${displayName(r.e)}」停止：${e.message}`, true);
          return;
        }
      }
      gStatus(`全部完成，共 ${done} 個。可以把模型切回你原本用的，並按 F1 恢復介面。`);
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
    $('gPause').textContent = '暫停';
  }
  async function checkpoint(done, total) {
    if (G.paused && !G.stop) {
      gStatus(`已暫停（完成 ${done} / ${total}）。按「繼續」接著拍，或「停止」結束。`);
      while (G.paused && !G.stop) await new Promise((res) => setTimeout(res, 200));
    }
    return G.stop;
  }
  $('gPause').onclick = () => {
    if (!G.running) return;
    G.paused = !G.paused;
    $('gPause').textContent = G.paused ? '繼續' : '暫停';
    if (G.paused) gStatus('暫停中…目前這個模型拍完後就會暫停。');
  };
  $('gStop').onclick = () => {
    if (!G.running) return;
    G.stop = true;
    $('gStop').disabled = true;
    gStatus('停止中…目前這個模型拍完後就會停止。');
  };

  // ---------------- 啟動 ----------------
  (async () => {
    try {
      applyState(await api('get_state'));
      S.settings = await api('get_settings');
      $('footInfo').textContent = '';
      if (S.roots.length) await rescan();
      else { renderAll(); $('btnDetect').click(); }
    } catch (e) { toast('無法連線到程式後端：' + e.message, true); }
  })();
})();
