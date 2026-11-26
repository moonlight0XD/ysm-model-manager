/* YSM 模型預覽器 — 主程式 */
(function () {
  'use strict';
  I18N.translatePage();
  const $ = (id) => document.getElementById(id);
  const L = window.YSMLoader;
  if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');

  // 模型資訊中的外部連結：開啟前先警告。內嵌在管理器時交給管理器處理（用系統瀏覽器開啟）
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('a[href]');
    if (!a || !/^https?:/i.test(a.href)) return;
    ev.preventDefault();
    try {
      if (window.parent !== window && typeof window.parent.ysmOpenLink === 'function') {
        window.parent.ysmOpenLink(a.href, a.textContent.trim());
        return;
      }
    } catch (e) { /* 不同來源時無法存取 parent */ }
    const host = new URL(a.href).host;
    if (window.confirm(__('即將開啟外部連結：\n{0}\n{1}\n\n⚠ 這是模型作者提供的連結，無法確認是否安全。\n不要在不熟悉的網站輸入密碼或付款資訊，也不要下載執行來路不明的檔案。\n\n確定要前往嗎？', host, a.href))) {
      window.open(a.href, '_blank', 'noopener');
    }
  });

  // ---------------- three.js 場景 ----------------
  const canvas = $('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color($('bgColor').value);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 500);
  camera.position.set(-1.8, 1.6, -3.6);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.target.set(0, 0.9, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.55);
  sun.position.set(-3, 6, -4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.25);
  fill.position.set(4, 2, 5);
  scene.add(fill);

  const grid = new THREE.GridHelper(8, 32, 0x4a505c, 0x30343c);
  scene.add(grid);
  const modelHolder = new THREE.Group();
  scene.add(modelHolder);

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / Math.max(1, r.height);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();

  // ---------------- 狀態 ----------------
  const state = {
    vfs: null,
    models: [],          // discoverModels 結果
    modelIdx: -1,
    info: null,          // loadModelInfo 結果
    target: null,
    built: null,         // buildModel 結果
    animator: null,
    animFiles: [],       // [{key, path, anims:[...] }]
    mainAnim: null,
    parallelAnims: [],
    playing: true,
    mainTime: 0,
    globalTime: 0,
    speed: 1,
    hidden: new Set(),
    textureCache: new Map(),
    blobUrls: [],
    walkDist: 0,
    loadToken: 0,
  };
  const ctx = new Molang.MolangContext();

  // ---------------- 訊息 ----------------
  function setWarnings(list) {
    const ul = $('warnList');
    ul.innerHTML = '';
    for (const w of list) { const li = document.createElement('li'); li.textContent = w; ul.appendChild(li); }
    $('warnSection').hidden = list.length === 0;
  }
  function addWarning(w) {
    const li = document.createElement('li'); li.textContent = w; $('warnList').appendChild(li);
    $('warnSection').hidden = false;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function blobURL(blob) { const u = URL.createObjectURL(blob); state.blobUrls.push(u); return u; }
  function showLoading(on) { $('loading').hidden = !on; }

  // ---------------- 載入 ----------------
  async function handleItems(items) {
    if (!items.length) return;
    showLoading(true);
    try {
      for (const u of state.blobUrls) URL.revokeObjectURL(u);
      state.blobUrls = [];
      state.textureCache.forEach((t) => t.dispose());
      state.textureCache.clear();
      const { vfs, warnings } = await L.buildVFS(items);
      state.vfs = vfs;
      state.models = L.discoverModels(vfs);
      setWarnings(warnings);
      renderModelList();
      if (state.models.length) {
        $('drop').classList.add('hidden');
        await selectModel(0);
      } else {
        clearModel();
        $('drop').classList.remove('hidden');
        if (!warnings.length) addWarning(__('沒有找到 YSM 模型（需要 ysm.json，或舊版的 main.json）。'));
      }
    } catch (e) {
      console.error(e);
      addWarning(__('載入失敗：') + e.message);
    } finally { showLoading(false); }
  }

  function renderModelList() {
    const ul = $('modelList');
    ul.innerHTML = '';
    if (!state.models.length) { ul.innerHTML = `<li class="empty">${__('尚未載入模型')}</li>`; return; }
    state.models.forEach((m, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="nm">${esc(L.basename(m.root) || __('（根目錄）'))}</span><span class="sub">${m.kind === 'v2' ? __('2.x 格式') : __('1.x 舊版格式')}${m.root ? ' · ' + esc(m.root) : ''}</span>`;
      li.onclick = () => selectModel(i);
      ul.appendChild(li);
    });
  }

  async function selectModel(i) {
    const token = ++state.loadToken;
    state.modelIdx = i;
    [...$('modelList').children].forEach((li, j) => li.classList.toggle('active', j === i));
    const desc = state.models[i];
    showLoading(true);
    try {
      const info = await L.loadModelInfo(state.vfs, desc);
      if (token !== state.loadToken) return;
      state.info = info;
      const nameEl = $('modelList').children[i].querySelector('.nm');
      if (nameEl && info.name) nameEl.textContent = info.name;
      info.warnings.forEach(addWarning);
      renderInfo(info);
      const sel = $('selTarget');
      sel.innerHTML = '';
      info.targets.forEach((t, j) => { const o = document.createElement('option'); o.value = j; o.textContent = t.label; sel.appendChild(o); });
      ctx.reset();
      if (info.targets.length) await selectTarget(0, true);
      else clearModel();
    } catch (e) {
      console.error(e);
      addWarning(e.message);
    } finally { if (token === state.loadToken) showLoading(false); }
  }

  function renderInfo(info) {
    const box = $('modelInfo');
    const m = info.meta || {};
    let html = `<div class="name">${esc(m.name || info.name)}</div>`;
    if (m.tips) html += `<div class="tips">${esc(m.tips)}</div>`;
    html += '<div class="kv">';
    if (m.license) html += `<span>${__('授權')}</span><span>${esc(m.license.type || m.license)}${m.license.desc ? '（' + esc(m.license.desc) + '）' : ''}</span>`;
    html += `<span>${__('格式')}</span><span>${info.kind === 'v2' ? 'ysm.json（2.x）' : __('舊版（1.x）')}</span>`;
    if (info.properties && info.properties.origin_ver) html += `<span>${__('版本')}</span><span>${esc(info.properties.origin_ver)}</span>`;
    if (info.properties && info.properties.free) html += `<span>${__('授權')}</span><span>${__('免費模型（不可授權）')}</span>`;
    html += '</div>';
    const authors = Array.isArray(m.authors) ? m.authors : [];
    if (authors.length) {
      html += '<div class="authors">';
      authors.forEach((a, idx) => {
        a = typeof a === 'string' ? { name: a } : (a || {});
        const links = a.contact && typeof a.contact === 'object'
          ? Object.entries(a.contact).map(([k, v]) => /^https?:\/\//.test(String(v)) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(k)}</a>` : `<span class="role">${esc(k)}: ${esc(v)}</span>`).join('')
          : '';
        html += `<div class="author"><span class="ph" data-avatar="${idx}"></span><div class="meta"><div>${esc(a.name)} ${a.role ? `<span class="role">· ${esc(a.role)}</span>` : ''}</div>${a.comment ? `<div class="cm" title="${esc(a.comment)}">${esc(a.comment)}</div>` : ''}<div>${links}</div></div></div>`;
      });
      html += '</div>';
    }
    if (m.link) {
      html += '<div class="kv">';
      if (m.link.home) html += `<span>${__('主頁')}</span><span><a href="${esc(m.link.home)}" target="_blank" rel="noopener">${esc(m.link.home)}</a></span>`;
      if (m.link.donate) html += `<span>${__('贊助')}</span><span><a href="${esc(m.link.donate)}" target="_blank" rel="noopener">${esc(m.link.donate)}</a></span>`;
      html += '</div>';
    }
    box.innerHTML = html;
    $('infoSection').hidden = false;
    // 頭像
    authors.forEach(async (a, idx) => {
      if (!a || !a.avatar) return;
      const p = L.join(info.root, a.avatar);
      const e = state.vfs.get(p);
      if (!e) return;
      const img = document.createElement('img');
      img.src = blobURL(await e.blob());
      img.alt = '';
      img.onerror = () => img.remove();
      const ph = box.querySelector(`[data-avatar="${idx}"]`);
      if (ph) ph.replaceWith(img);
    });
  }

  function clearModel() {
    if (state.built) { modelHolder.remove(state.built.object); state.built.dispose(); }
    state.built = null; state.animator = null; state.mainAnim = null; state.parallelAnims = [];
    $('animList').innerHTML = '';
    $('boneList').innerHTML = '';
    $('stats').textContent = '';
  }

  async function selectTarget(j, isFirst) {
    const info = state.info;
    const t = info.targets[j];
    state.target = t;
    $('selTarget').value = String(j);
    clearModel();
    try {
      const geoJson = await L.readJSON(state.vfs, t.modelPath);
      if (!geoJson) throw new Error(__('找不到模型檔：') + t.modelPath);
      const built = YSMModel.buildModel(geoJson);
      state.built = built;
      modelHolder.add(built.object);
      state.animator = new YSMAnim.Animator(built, ctx);
      applyViewOptions();
      state.hidden.clear();
      renderBoneList();
      $('stats').textContent = __('{0} · {1} 骨骼 · {2} 方塊 · 貼圖 {3}×{4}', L.basename(t.modelPath), built.boneCount, built.cubeCount, built.texW, built.texH);
    } catch (e) {
      console.error(e);
      addWarning(e.message);
      return;
    }

    // 貼圖
    const selTex = $('selTexture');
    selTex.innerHTML = '';
    t.textures.forEach((p) => { const o = document.createElement('option'); o.value = p; o.textContent = L.basename(p); selTex.appendChild(o); });
    let defTex = t.textures[0];
    const dt = info.properties && info.properties.default_texture;
    if (dt) {
      const found = t.textures.find((p) => p === L.join(info.root, dt) || L.basename(p) === dt || L.basename(p).replace(/\.png$/i, '') === dt);
      if (found) defTex = found;
    }
    if (defTex) { selTex.value = defTex; await setTexture(defTex); }
    else { $('texPreview').innerHTML = ''; addWarning(__('這個模型沒有貼圖。')); }

    // 動畫
    state.animFiles = [];
    for (const a of t.animations) {
      try {
        const json = await L.readJSON(state.vfs, a.path);
        state.animFiles.push({ key: a.key, path: a.path, anims: YSMAnim.parseAnimationFile(json) });
      } catch (e) { addWarning(e.message); }
    }
    renderAnimList();
    const all = state.animFiles.flatMap((f) => f.anims);
    // 預設播放 idle（preview_animation 常為 gui，是給選單用、帶縮放的姿勢）
    const pref = info.properties && info.properties.preview_animation;
    const first = all.find((a) => a.name === 'idle') || all.find((a) => a.name === pref) || all.find((a) => !isParallel(a.name)) || null;
    selectAnim(first);
    frameModel();
  }

  async function setTexture(path) {
    let tex = state.textureCache.get(path);
    const entry = state.vfs.get(path);
    if (!entry) return;
    const url = blobURL(await entry.blob());
    if (!tex) {
      tex = await new Promise((res, rej) => new THREE.TextureLoader().load(url, res, undefined, () => rej(new Error(__('貼圖讀取失敗：') + path))));
      tex.flipY = false;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.encoding = THREE.sRGBEncoding;
      tex.needsUpdate = true;
      state.textureCache.set(path, tex);
    }
    if (state.built) state.built.setTexture(tex);
    const img = tex.image;
    $('texPreview').innerHTML = `<img src="${url}" alt=""><div class="dim">${img.width}×${img.height}</div>`;
  }

  // ---------------- 動畫 ----------------
  const isParallel = (n) => /^(pre_)?parallel\d*$/i.test(n);

  function renderAnimList() {
    const box = $('animList');
    const filter = $('animFilter').value.trim().toLowerCase();
    const extraNames = (state.info && state.info.properties && state.info.properties.extra_animation) || {};
    box.innerHTML = '';
    let count = 0;
    for (const f of state.animFiles) {
      const items = f.anims.filter((a) => !filter || a.name.toLowerCase().includes(filter) || String(extraNames[a.name] || '').toLowerCase().includes(filter));
      if (!items.length) continue;
      const g = document.createElement('div');
      g.className = 'anim-group';
      g.textContent = `${f.key} · ${L.basename(f.path)}`;
      box.appendChild(g);
      for (const a of items) {
        const d = document.createElement('div');
        d.className = 'anim-item' + (a === state.mainAnim ? ' active' : '');
        let tag = '';
        if (isParallel(a.name)) tag = __('並行');
        else if (typeof extraNames[a.name] === 'string' && !extraNames[a.name].startsWith('#')) tag = extraNames[a.name];
        d.innerHTML = `<span>${esc(a.name)} ${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</span><span class="len">${a.length ? a.length.toFixed(2) + 's' : '—'}${a.loop === true ? ' ↻' : ''}</span>`;
        d.onclick = () => selectAnim(a);
        d._anim = a;
        box.appendChild(d);
        count++;
      }
    }
    if (!count) box.innerHTML = `<div class="anim-empty">${state.animFiles.length ? __('沒有符合的動畫') : __('這個模型沒有動畫檔')}</div>`;
  }

  function collectParallels() {
    // 主模型使用 main 動畫檔中的並行動畫；其他目標使用自身檔案中的
    const preferKeys = state.target && state.target.key === 'main' ? ['main'] : null;
    const files = preferKeys ? state.animFiles.filter((f) => preferKeys.includes(f.key)) : state.animFiles;
    const pre = [], post = [];
    const seen = new Set();
    for (const f of files) for (const a of f.anims) {
      if (seen.has(a.name)) continue;
      if (/^pre_parallel\d*$/i.test(a.name)) { pre.push(a); seen.add(a.name); }
      else if (/^parallel\d*$/i.test(a.name)) { post.push(a); seen.add(a.name); }
    }
    const byNum = (x, y) => (parseInt(x.name.replace(/\D/g, '')) || 0) - (parseInt(y.name.replace(/\D/g, '')) || 0);
    return { pre: pre.sort(byNum), post: post.sort(byNum) };
  }

  function rebuildLayers() {
    if (!state.animator) return;
    const layers = [];
    if ($('chkParallel').checked) {
      const { pre, post } = collectParallels();
      layers.push(...pre.filter((a) => a !== state.mainAnim));
      if (state.mainAnim) layers.push(state.mainAnim);
      layers.push(...post.filter((a) => a !== state.mainAnim));
    } else if (state.mainAnim) layers.push(state.mainAnim);
    state.animator.setLayers(layers);
  }

  function selectAnim(a) {
    state.mainAnim = a;
    state.mainTime = 0;
    state.playing = true;
    updatePlayBtn();
    for (const el of $('animList').querySelectorAll('.anim-item')) el.classList.toggle('active', el._anim === a);
    rebuildLayers();
  }

  function updatePlayBtn() { $('btnPlay').textContent = state.playing ? '❚❚' : '▶'; }

  // ---------------- 骨骼清單 ----------------
  function renderBoneList() {
    const box = $('boneList');
    box.innerHTML = '';
    if (!state.built) return;
    const filter = $('boneFilter').value.trim().toLowerCase();
    const walk = (node, depth) => {
      if (!filter || node.name.toLowerCase().includes(filter)) {
        const row = document.createElement('label');
        row.className = 'bone-item';
        row.style.paddingLeft = (6 + (filter ? 0 : depth * 10)) + 'px';
        row.innerHTML = `<input type="checkbox" ${state.hidden.has(node.name) ? '' : 'checked'}><span class="n" title="${esc(node.name)}">${esc(node.name)}</span><span class="c">${node.cubeCount || ''}</span>`;
        row.querySelector('input').onchange = (ev) => {
          if (ev.target.checked) state.hidden.delete(node.name); else state.hidden.add(node.name);
        };
        box.appendChild(row);
      }
      node.children.forEach((c) => walk(c, depth + 1));
    };
    for (const n of state.built.bones.values()) if (!n.parent) walk(n, 0);
  }

  // ---------------- 檢視 ----------------
  function applyViewOptions() {
    grid.visible = $('chkGrid').checked;
    if (!state.built) return;
    state.built.setLighting($('chkLight').checked);
    const cut = $('chkCutout').checked || !!(state.info && state.info.properties && state.info.properties.all_cutout);
    state.built.setCutout(cut);
    state.built.setWireframe($('chkWire').checked);
  }

  let frameInfo = { center: new THREE.Vector3(0, 0.9, 0), dist: 4 };
  function frameModel() {
    if (!state.built) return;
    state.built.resetPose();
    modelHolder.rotation.y = 0;
    modelHolder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(state.built.object);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z) * 0.5;
    const dist = Math.max(0.3, r / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.05);
    frameInfo = { center, dist };
    setView('default');
  }

  function setView(kind) {
    const { center, dist } = frameInfo;
    let dir;
    switch (kind) {
      case 'front': dir = new THREE.Vector3(0, 0.08, -1); break;
      case 'back': dir = new THREE.Vector3(0, 0.08, 1); break;
      case 'side': dir = new THREE.Vector3(1, 0.08, 0); break;
      default: dir = new THREE.Vector3(-0.45, 0.25, -0.86);
    }
    dir.normalize();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = Math.max(0.005, dist / 200);
    camera.far = dist * 50;
    camera.updateProjectionMatrix();
    controls.update();
  }

  // ---------------- Molang 查詢 ----------------
  function updateQueries(dt) {
    const q = ctx.queries;
    const pitch = Number($('headPitch').value), yaw = Number($('headYaw').value);
    const gs = Number($('groundSpeed').value);
    state.walkDist += gs * dt;
    const sneak = $('chkSneak').checked ? 1 : 0;
    const mh = $('chkMainhand').checked ? 1 : 0, oh = $('chkOffhand').checked ? 1 : 0;
    Object.assign(q, {
      'query.life_time': state.globalTime,
      'query.time_stamp': Math.floor(state.globalTime * 20),
      'query.delta_time': dt,
      'query.ground_speed': gs,
      'query.modified_move_speed': gs / 4.3,
      'query.walk_distance': state.walkDist,
      'query.modified_distance_moved': state.walkDist,
      'query.vertical_speed': 0,
      'query.yaw_speed': 0,
      'query.is_sneaking': sneak,
      'query.is_jumping': 0,
      'query.is_on_ground': 1,
      'query.is_alive': 1,
      'query.is_first_person': state.target && state.target.key === 'arm' ? 1 : 0,
      'query.health': 20,
      'query.max_health': 20,
      'query.head_x_rotation': pitch,
      'query.head_y_rotation': yaw,
      'query.body_x_rotation': 0,
      'query.body_y_rotation': 0,
      'query.time_of_day': 0.25,
      'query.moon_phase': 0,
      'query.is_in_water': 0,
      'query.is_riding': 0,
      'query.is_sleeping': 0,
      'ysm.head_pitch': pitch,
      'ysm.head_yaw': yaw,
      'ysm.ground_speed2': gs * gs,
      'ysm.has_mainhand': mh,
      'ysm.has_offhand': oh,
      'ysm.food_level': 20,
      'ysm.is_close_eyes': 0,
      'ysm.elytra_rot_z': 0,
    });
  }

  // ---------------- 主迴圈 ----------------
  const clock = new THREE.Clock();
  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.1);
    const step = state.playing ? dt * state.speed : 0;
    state.globalTime += step;
    const a = state.mainAnim;
    if (state.playing && a) {
      state.mainTime += step;
      const loop = a.loop === true || $('chkLoop').checked;
      if (a.length > 0) {
        if (loop) state.mainTime %= a.length;
        else if (state.mainTime >= a.length) state.mainTime = a.length;
      }
    }
    if (state.built && state.animator) {
      updateQueries(step);
      let t = state.mainTime;
      if (a && a.length > 0 && t > a.length) t = a.length;
      try {
        state.animator.apply(state.globalTime, t, a, {
          headBone: state.target && state.target.key === 'main' ? state.built.findBone('Head') : null,
          headPitch: Number($('headPitch').value),
          headYaw: Number($('headYaw').value),
        });
      } catch (e) { console.warn(e); }
      for (const name of state.hidden) { const n = state.built.bones.get(name); if (n) n.group.visible = false; }
      if (a && a.length > 0) {
        $('seek').value = String(Math.min(1, t / a.length));
        $('timeText').textContent = `${t.toFixed(2)} / ${a.length.toFixed(2)} s`;
      } else $('timeText').textContent = a ? __('{0} s（無長度）', state.globalTime.toFixed(2)) : __('未選擇動畫');
    }
    if ($('chkRotate').checked) modelHolder.rotation.y += dt * 0.6;
    controls.update();
    renderer.render(scene, camera);
  }
  tick();

  // ---------------- 事件 ----------------
  $('pickDir').onchange = (e) => {
    const files = [...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
    e.target.value = '';
    handleItems(files);
  };
  $('pickZip').onchange = (e) => {
    const files = [...e.target.files].map((f) => ({ file: f, path: f.name }));
    e.target.value = '';
    handleItems(files);
  };
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').classList.remove('hidden'); $('drop').classList.add('over'); });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('over'); if (state.built) $('drop').classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop').classList.remove('over');
    const items = await L.itemsFromDataTransfer(e.dataTransfer);
    if (state.built) $('drop').classList.add('hidden');
    handleItems(items);
  });

  $('selTarget').onchange = (e) => selectTarget(Number(e.target.value));
  $('selTexture').onchange = (e) => setTexture(e.target.value).catch((err) => addWarning(err.message));
  $('animFilter').oninput = renderAnimList;
  $('boneFilter').oninput = renderBoneList;
  $('chkParallel').onchange = () => { ctx.reset(); rebuildLayers(); };
  $('speed').oninput = (e) => { state.speed = Number(e.target.value); $('speedVal').textContent = state.speed.toFixed(2) + '×'; };
  for (const [id, unit] of [['headPitch', '°'], ['headYaw', '°'], ['groundSpeed', '']]) {
    $(id).oninput = (e) => { $(id + 'Val').textContent = e.target.value + unit; };
  }
  for (const id of ['chkGrid', 'chkLight', 'chkCutout', 'chkWire']) $(id).onchange = applyViewOptions;
  $('bgColor').oninput = (e) => { scene.background = new THREE.Color(e.target.value); };
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => { if (b.dataset.view === 'reset') { modelHolder.rotation.y = 0; frameModel(); } else setView(b.dataset.view); };
  });
  $('btnPlay').onclick = () => {
    const a = state.mainAnim;
    if (!state.playing && a && a.length && a.loop !== true && !$('chkLoop').checked && state.mainTime >= a.length) state.mainTime = 0;
    state.playing = !state.playing; updatePlayBtn();
  };
  $('btnRestart').onclick = () => { state.mainTime = 0; state.globalTime = 0; ctx.reset(); state.playing = true; updatePlayBtn(); };
  $('seek').oninput = (e) => {
    const a = state.mainAnim;
    if (!a || !a.length) return;
    state.playing = false; updatePlayBtn();
    state.mainTime = Number(e.target.value) * a.length;
  };
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
    if (e.code === 'Space') { e.preventDefault(); $('btnPlay').click(); }
  });
  $('btnShot').onclick = () => {
    renderer.render(scene, camera);
    canvas.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      const name = (state.info && state.info.name ? state.info.name : 'ysm').replace(/[\\/:*?"<>|]/g, '_');
      a.download = `${name}_${state.mainAnim ? state.mainAnim.name.replace(/[\\/:*?"<>|]/g, '_') : 'model'}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  };

  // 供除錯用
  // 透明背景擷取（給縮圖用，之後可批量換背景）
  function captureTransparent() {
    const bg = scene.background;
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.render(scene, camera);
    const url = canvas.toDataURL('image/png');
    scene.background = bg;
    renderer.render(scene, camera);
    return url;
  }
  window.YSMApp = { state, ctx, handleItems, scene, camera, controls, setView, captureTransparent };
})();
