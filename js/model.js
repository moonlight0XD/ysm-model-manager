/*
 * 基岩版幾何 (Bedrock geometry) -> three.js
 * 座標轉換與 Blockbench 一致：X 軸鏡像，旋轉 X/Y 取負、Euler 順序 ZYX。
 * 單位為像素（16 像素 = 1 方塊），外層再縮放 1/16。
 */
(function (global) {
  'use strict';
  const DEG = Math.PI / 180;

  function vec3(a, d = 0) {
    if (Array.isArray(a)) return [Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0];
    if (typeof a === 'number') return [a, a, a];
    return [d, d, d];
  }

  /** 取出第一個幾何定義，統一成 { texW, texH, bones } */
  function readGeometry(json) {
    let geo = null;
    if (Array.isArray(json['minecraft:geometry'])) geo = json['minecraft:geometry'][0];
    else {
      const k = Object.keys(json).find((x) => x.startsWith('geometry.'));
      if (k) {
        const g = json[k];
        geo = { description: { identifier: k, texture_width: g.texturewidth, texture_height: g.textureheight }, bones: g.bones };
      }
    }
    if (!geo) throw new Error('不是有效的基岩版幾何檔');
    const d = geo.description || {};
    return {
      identifier: d.identifier || '',
      texW: d.texture_width || 64,
      texH: d.texture_height || 64,
      bones: geo.bones || [],
    };
  }

  // 每個面的四個角（從外面看：左上、右上、左下、右下），以 from/to 的 0/1 選擇表示
  // 依 Blockbench 空間：north=-Z（模型正面）、east=+X、up=+Y
  const FACES = {
    north: { n: [0, 0, -1], c: [[1, 1, 0], [0, 1, 0], [1, 0, 0], [0, 0, 0]] },
    south: { n: [0, 0, 1], c: [[0, 1, 1], [1, 1, 1], [0, 0, 1], [1, 0, 1]] },
    east: { n: [1, 0, 0], c: [[1, 1, 1], [1, 1, 0], [1, 0, 1], [1, 0, 0]] },
    west: { n: [-1, 0, 0], c: [[0, 1, 0], [0, 1, 1], [0, 0, 0], [0, 0, 1]] },
    up: { n: [0, 1, 0], c: [[1, 1, 1], [0, 1, 1], [1, 1, 0], [0, 1, 0]] },
    down: { n: [0, -1, 0], c: [[1, 0, 1], [0, 0, 1], [1, 0, 0], [0, 0, 0]] },
  };

  /** 方塊 UV（box uv）展開成各面 {uv:[u,v], size:[w,h]} */
  function boxUV(uv, size, mirror) {
    const [u, v] = uv;
    const w = Math.floor(size[0] + 0.0000001), h = Math.floor(size[1] + 0.0000001), d = Math.floor(size[2] + 0.0000001);
    const f = {
      east: { uv: [u, v + d], size: [d, h] },
      north: { uv: [u + d, v + d], size: [w, h] },
      west: { uv: [u + d + w, v + d], size: [d, h] },
      south: { uv: [u + d + w + d, v + d], size: [w, h] },
      up: { uv: [u + d, v], size: [w, d] },
      down: { uv: [u + d + w, v + d], size: [w, -d] },
    };
    if (mirror) {
      const e = f.east; f.east = f.west; f.west = e;
      for (const k in f) { f[k].uv = [f[k].uv[0] + f[k].size[0], f[k].uv[1]]; f[k].size = [-f[k].size[0], f[k].size[1]]; }
    }
    return f;
  }

  function perFaceUV(uvObj) {
    const f = {};
    for (const k of Object.keys(FACES)) {
      const face = uvObj[k];
      if (!face) continue;
      const uv = face.uv || [0, 0];
      const size = face.uv_size || [0, 0];
      f[k] = { uv: [Number(uv[0]) || 0, Number(uv[1]) || 0], size: [Number(size[0]) || 0, Number(size[1]) || 0] };
    }
    return f;
  }

  /**
   * 建立模型
   * 回傳 { root: THREE.Group, bones: Map<name, BoneNode>, texW, texH, setTexture(tex), dispose() }
   * BoneNode = { name, group, restPos:Vector3, restRot:Euler, children, glow }
   */
  function buildModel(json, options = {}) {
    const THREE = global.THREE;
    const g = readGeometry(json);
    const texW = g.texW, texH = g.texH;

    const matNormal = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, transparent: true, alphaTest: 0.05 });
    const matGlow = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, alphaTest: 0.05 });
    const materials = [matNormal, matGlow];

    const root = new THREE.Group();
    root.name = 'YSMModelRoot';
    const bones = new Map();
    const lowerMap = new Map();

    // 先建立所有骨骼節點
    for (const b of g.bones) {
      if (!b || !b.name) continue;
      const pivot = vec3(b.pivot);
      const rot = vec3(b.rotation);
      const node = {
        name: b.name,
        def: b,
        parentName: b.parent || null,
        pivot: [-pivot[0], pivot[1], pivot[2]],
        group: new THREE.Group(),
        restPos: new THREE.Vector3(),
        restRot: new THREE.Euler(-rot[0] * DEG, -rot[1] * DEG, rot[2] * DEG, 'ZYX'),
        children: [],
        glow: false,
        cubeCount: 0,
      };
      node.group.name = b.name;
      node.group.rotation.copy(node.restRot);
      bones.set(b.name, node);
      if (!lowerMap.has(b.name.toLowerCase())) lowerMap.set(b.name.toLowerCase(), node);
    }

    // 接上父子關係
    for (const node of bones.values()) {
      const parent = node.parentName ? (bones.get(node.parentName) || lowerMap.get(node.parentName.toLowerCase())) : null;
      const pp = parent ? parent.pivot : [0, 0, 0];
      node.restPos.set(node.pivot[0] - pp[0], node.pivot[1] - pp[1], node.pivot[2] - pp[2]);
      node.group.position.copy(node.restPos);
      if (parent && parent !== node) { parent.group.add(node.group); parent.children.push(node); node.parent = parent; }
      else root.add(node.group);
    }

    // 發光骨骼（名稱以 ysmGlow 開頭，連同子骨骼）
    const markGlow = (n, on) => { n.glow = on || /^ysmglow/i.test(n.name); n.children.forEach((c) => markGlow(c, n.glow)); };
    for (const n of bones.values()) if (!n.parent) markGlow(n, false);

    // 建立方塊網格（每根骨骼合併成一個 mesh）
    const tmpM = new THREE.Matrix4();
    const tmpV = new THREE.Vector3();
    const tmpN = new THREE.Vector3();
    const nMat = new THREE.Matrix3();
    let totalCubes = 0;

    for (const node of bones.values()) {
      const b = node.def;
      const cubes = b.cubes || [];
      if (!cubes.length) continue;
      const pos = [], nor = [], uvs = [], idx = [];
      for (const c of cubes) {
        const origin = vec3(c.origin);
        const size = vec3(c.size);
        const inflate = Number(c.inflate !== undefined ? c.inflate : (b.inflate || 0)) || 0;
        const mirror = c.mirror !== undefined ? !!c.mirror : !!b.mirror;
        const from = [-(origin[0] + size[0]) - inflate, origin[1] - inflate, origin[2] - inflate];
        const to = [-origin[0] + inflate, origin[1] + size[1] + inflate, origin[2] + size[2] + inflate];

        let faces;
        if (c.uv && !Array.isArray(c.uv) && typeof c.uv === 'object') faces = perFaceUV(c.uv);
        else faces = boxUV(Array.isArray(c.uv) ? [Number(c.uv[0]) || 0, Number(c.uv[1]) || 0] : [0, 0], size, mirror);

        // 方塊自身旋轉
        let mat = null;
        const crot = c.rotation ? vec3(c.rotation) : null;
        if (crot && (crot[0] || crot[1] || crot[2])) {
          const cp = vec3(c.pivot);
          const piv = new THREE.Vector3(-cp[0], cp[1], cp[2]);
          const e = new THREE.Euler(-crot[0] * DEG, -crot[1] * DEG, crot[2] * DEG, 'ZYX');
          mat = new THREE.Matrix4().makeTranslation(piv.x, piv.y, piv.z)
            .multiply(tmpM.makeRotationFromEuler(e))
            .multiply(new THREE.Matrix4().makeTranslation(-piv.x, -piv.y, -piv.z));
          nMat.getNormalMatrix(mat);
        }

        for (const fname of Object.keys(FACES)) {
          const fuv = faces[fname];
          if (!fuv) continue;
          const def = FACES[fname];
          const base = pos.length / 3;
          const u0 = fuv.uv[0] / texW, v0 = fuv.uv[1] / texH;
          const u1 = (fuv.uv[0] + fuv.size[0]) / texW, v1 = (fuv.uv[1] + fuv.size[1]) / texH;
          const cornerUV = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]];
          for (let i = 0; i < 4; i++) {
            const s = def.c[i];
            tmpV.set(s[0] ? to[0] : from[0], s[1] ? to[1] : from[1], s[2] ? to[2] : from[2]);
            tmpN.set(def.n[0], def.n[1], def.n[2]);
            if (mat) { tmpV.applyMatrix4(mat); tmpN.applyMatrix3(nMat).normalize(); }
            pos.push(tmpV.x - node.pivot[0], tmpV.y - node.pivot[1], tmpV.z - node.pivot[2]);
            nor.push(tmpN.x, tmpN.y, tmpN.z);
            uvs.push(cornerUV[i][0], cornerUV[i][1]);
          }
          idx.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
        }
        totalCubes++;
        node.cubeCount++;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geom.setIndex(idx);
      geom.computeBoundingSphere();
      const mesh = new THREE.Mesh(geom, node.glow ? matGlow : matNormal);
      mesh.name = node.name + ':mesh';
      mesh.userData.bone = node;
      node.mesh = mesh;
      node.group.add(mesh);
    }

    const scaleGroup = new THREE.Group();
    scaleGroup.scale.setScalar(1 / 16);
    scaleGroup.add(root);

    return {
      object: scaleGroup,
      root,
      bones,
      lowerMap,
      texW, texH,
      identifier: g.identifier,
      boneCount: bones.size,
      cubeCount: totalCubes,
      materials,
      findBone(name) { return bones.get(name) || lowerMap.get(String(name).toLowerCase()); },
      setTexture(tex) {
        for (const m of materials) { m.map = tex; m.needsUpdate = true; }
      },
      setCutout(cutout) {
        for (const m of materials) {
          m.transparent = !cutout;
          m.alphaTest = cutout ? 0.5 : 0.05;
          m.needsUpdate = true;
        }
      },
      setLighting(on) {
        // 關閉光照時用 Basic 材質呈現原色
        for (const n of bones.values()) if (n.mesh && !n.glow) n.mesh.material = on ? matNormal : matGlow;
      },
      setWireframe(on) { for (const m of materials) { m.wireframe = on; m.needsUpdate = true; } },
      resetPose() {
        for (const n of bones.values()) {
          n.group.position.copy(n.restPos);
          n.group.rotation.copy(n.restRot);
          n.group.scale.set(1, 1, 1);
          n.group.visible = true;
        }
      },
      dispose() {
        scaleGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
        for (const m of materials) m.dispose();
      },
    };
  }

  global.YSMModel = { buildModel, readGeometry };
})(window);
