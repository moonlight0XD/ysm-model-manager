/*
 * 基岩版動畫播放（Bedrock animation 1.8.0）
 * 支援：常數 / 陣列 / Molang 字串、關鍵影格 (pre/post, linear / catmullrom / step)、
 * loop (true / false / "hold_on_last_frame")、animation_length、blend_weight、多動畫疊加。
 */
(function (global) {
  'use strict';
  const DEG = Math.PI / 180;

  function isKeyframeObject(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    return Object.keys(o).some((k) => !isNaN(parseFloat(k)));
  }

  /** 預處理一個通道：回傳 { kind: 'static', value } 或 { kind: 'keys', keys: [{t, pre, post, mode}] } */
  function prepChannel(ch) {
    if (ch === undefined || ch === null) return null;
    if (isKeyframeObject(ch)) {
      const keys = Object.keys(ch).filter((k) => !isNaN(parseFloat(k))).map((k) => {
        const v = ch[k];
        let pre, post, mode = 'linear';
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          if (v.vector !== undefined) { pre = post = v.vector; }
          else {
            post = v.post !== undefined ? v.post : v.pre;
            pre = v.pre !== undefined ? v.pre : v.post;
          }
          if (v.lerp_mode) mode = String(v.lerp_mode).toLowerCase();
        } else { pre = post = v; }
        return { t: parseFloat(k), pre, post, mode };
      }).sort((a, b) => a.t - b.t);
      return { kind: 'keys', keys };
    }
    if (ch && typeof ch === 'object' && !Array.isArray(ch) && ch.vector !== undefined) return { kind: 'static', value: ch.vector };
    return { kind: 'static', value: ch };
  }

  function evalVec(v, ctx, out) {
    const E = global.Molang.evaluate;
    if (Array.isArray(v)) {
      out[0] = E(v[0], ctx); out[1] = E(v[1] !== undefined ? v[1] : v[0], ctx); out[2] = E(v[2] !== undefined ? v[2] : v[0], ctx);
    } else { const n = E(v, ctx); out[0] = out[1] = out[2] = n; }
    return out;
  }

  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0], D = [0, 0, 0];
  function sampleChannel(ch, time, ctx, out) {
    if (ch.kind === 'static') return evalVec(ch.value, ctx, out);
    const keys = ch.keys;
    if (!keys.length) { out[0] = out[1] = out[2] = 0; return out; }
    if (time <= keys[0].t) return evalVec(keys[0].pre, ctx, out);
    const last = keys[keys.length - 1];
    if (time >= last.t) return evalVec(last.post, ctx, out);
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= time) i++;
    const k0 = keys[i], k1 = keys[i + 1];
    const span = k1.t - k0.t;
    const a = span > 0 ? (time - k0.t) / span : 0;
    if (k0.mode === 'step') return evalVec(k0.post, ctx, out);
    evalVec(k0.post, ctx, B);
    evalVec(k1.pre, ctx, C);
    if (k0.mode === 'catmullrom' || k1.mode === 'catmullrom') {
      const km = keys[i - 1], kp = keys[i + 2];
      if (km) evalVec(km.post, ctx, A); else { A[0] = B[0]; A[1] = B[1]; A[2] = B[2]; }
      if (kp) evalVec(kp.pre, ctx, D); else { D[0] = C[0]; D[1] = C[1]; D[2] = C[2]; }
      for (let j = 0; j < 3; j++) out[j] = catmull(A[j], B[j], C[j], D[j], a);
      return out;
    }
    for (let j = 0; j < 3; j++) out[j] = B[j] + (C[j] - B[j]) * a;
    return out;
  }

  /** 預處理一個動畫 */
  function prepAnimation(name, def) {
    const bones = [];
    let maxT = 0;
    for (const [boneName, bd] of Object.entries(def.bones || {})) {
      if (!bd || typeof bd !== 'object') continue;
      const entry = {
        bone: boneName,
        rotation: prepChannel(bd.rotation),
        position: prepChannel(bd.position),
        scale: prepChannel(bd.scale),
      };
      for (const c of [entry.rotation, entry.position, entry.scale]) {
        if (c && c.kind === 'keys' && c.keys.length) maxT = Math.max(maxT, c.keys[c.keys.length - 1].t);
      }
      bones.push(entry);
    }
    let length = Number(def.animation_length);
    if (!isFinite(length) || length <= 0) length = maxT;
    let loop = def.loop;
    if (loop === undefined) loop = false;
    return {
      name,
      loop, // true | false | 'hold_on_last_frame'
      length,
      blendWeight: def.blend_weight,
      animTimeUpdate: def.anim_time_update,
      bones,
      hasSound: !!def.sound_effects,
    };
  }

  /** 解析動畫檔，回傳 [{name, anim}] */
  function parseAnimationFile(json) {
    const out = [];
    const anims = (json && json.animations) || {};
    for (const [name, def] of Object.entries(anims)) {
      if (!def || typeof def !== 'object') continue;
      try { out.push(prepAnimation(name, def)); } catch (e) { console.warn('動畫解析失敗', name, e); }
    }
    return out;
  }

  /**
   * 動畫播放器
   * layers: [{ anim, time, weight }]（依序疊加）
   */
  class Animator {
    constructor(model, ctx) {
      this.model = model;
      this.ctx = ctx;
      this.layers = [];
      this.acc = new Map(); // boneNode -> {rot:[], pos:[], scl:[]}
    }

    setLayers(anims) {
      this.layers = anims.map((a) => ({ anim: a, time: 0 }));
    }

    /** 主動畫時間（第一個非並行層） */
    getAnimTime(anim, t) {
      if (!anim.length) return t;
      if (anim.loop === true) return t % anim.length;
      return Math.min(t, anim.length);
    }

    apply(globalTime, mainTime, mainAnim, extra = {}) {
      const model = this.model;
      const ctx = this.ctx;
      model.resetPose();
      const acc = this.acc;
      acc.clear();
      const tmp = [0, 0, 0];
      const getAcc = (node) => {
        let a = acc.get(node);
        if (!a) { a = { rot: [0, 0, 0], pos: [0, 0, 0], scl: [1, 1, 1] }; acc.set(node, a); }
        return a;
      };

      for (const layer of this.layers) {
        const anim = layer.anim;
        const isMain = anim === mainAnim;
        const t = isMain ? mainTime : (anim.length && anim.loop === true ? globalTime % anim.length : (anim.length ? Math.min(globalTime, anim.length) : globalTime));
        ctx.queries['query.anim_time'] = t;
        ctx.clearTemps();
        let w = 1;
        if (anim.blendWeight !== undefined) w = global.Molang.evaluate(anim.blendWeight, ctx);
        for (const b of anim.bones) {
          const node = model.findBone(b.bone);
          if (!node) continue;
          const a = getAcc(node);
          if (b.rotation) { sampleChannel(b.rotation, t, ctx, tmp); a.rot[0] += tmp[0] * w; a.rot[1] += tmp[1] * w; a.rot[2] += tmp[2] * w; }
          if (b.position) { sampleChannel(b.position, t, ctx, tmp); a.pos[0] += tmp[0] * w; a.pos[1] += tmp[1] * w; a.pos[2] += tmp[2] * w; }
          if (b.scale) {
            sampleChannel(b.scale, t, ctx, tmp);
            for (let j = 0; j < 3; j++) a.scl[j] *= 1 + (tmp[j] - 1) * w;
          }
        }
      }

      // 頭部視角（YSM 會自動為 Head 骨骼加入視角旋轉）
      if (extra.headBone && (extra.headPitch || extra.headYaw)) {
        const a = getAcc(extra.headBone);
        a.rot[0] += extra.headPitch || 0;
        a.rot[1] += extra.headYaw || 0;
      }

      for (const [node, a] of acc) {
        const g = node.group;
        g.rotation.set(node.restRot.x - a.rot[0] * DEG, node.restRot.y - a.rot[1] * DEG, node.restRot.z + a.rot[2] * DEG, 'ZYX');
        g.position.set(node.restPos.x - a.pos[0], node.restPos.y + a.pos[1], node.restPos.z + a.pos[2]);
        g.scale.set(a.scl[0], a.scl[1], a.scl[2]);
        // 縮放為 0 時隱藏（常用來切換部件）
        g.visible = !(Math.abs(a.scl[0]) < 1e-6 && Math.abs(a.scl[1]) < 1e-6 && Math.abs(a.scl[2]) < 1e-6);
      }
    }
  }

  global.YSMAnim = { parseAnimationFile, Animator };
})(window);
