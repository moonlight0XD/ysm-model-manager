/*
 * 簡易 Molang 直譯器
 * 支援：數字、字串、變數 (variable./v. temp./t. query./q. ysm. math. context./c.)、
 * 函式呼叫、四則運算、比較、邏輯、??、三元/二元條件、賦值、多語句、return、{}、loop()
 * 未知的查詢與函式一律回傳 0，讓動畫盡量能播放。
 */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  // ---------- math.* ----------
  const MATH = {
    abs: Math.abs,
    sin: (a) => Math.sin(a * DEG),
    cos: (a) => Math.cos(a * DEG),
    asin: (a) => Math.asin(a) * RAD,
    acos: (a) => Math.acos(a) * RAD,
    atan: (a) => Math.atan(a) * RAD,
    atan2: (y, x) => Math.atan2(y, x) * RAD,
    ceil: Math.ceil,
    floor: Math.floor,
    round: Math.round,
    trunc: Math.trunc,
    sqrt: Math.sqrt,
    pow: Math.pow,
    exp: Math.exp,
    ln: Math.log,
    sign: Math.sign,
    mod: (a, b) => a % b,
    min: Math.min,
    max: Math.max,
    clamp: (v, a, b) => Math.min(Math.max(v, a), b),
    lerp: (a, b, t) => a + (b - a) * t,
    inverse_lerp: (a, b, v) => (b === a ? 0 : (v - a) / (b - a)),
    lerprotate: (a, b, t) => {
      const norm = (x) => { x = ((x + 180) % 360 + 360) % 360 - 180; return x; };
      a = norm(a); b = norm(b);
      let d = b - a;
      if (d > 180) d -= 360; else if (d < -180) d += 360;
      return a + d * t;
    },
    min_angle: (a) => { a = ((a + 180) % 360 + 360) % 360 - 180; return a; },
    hermite_blend: (t) => 3 * t * t - 2 * t * t * t,
    random: (a = 0, b = 1) => a + Math.random() * (b - a),
    random_integer: (a = 0, b = 1) => Math.floor(a + Math.random() * (b - a + 1)),
    die_roll: (n, a, b) => { let s = 0; for (let i = 0; i < n; i++) s += a + Math.random() * (b - a); return s; },
    die_roll_integer: (n, a, b) => { let s = 0; for (let i = 0; i < n; i++) s += Math.floor(a + Math.random() * (b - a + 1)); return s; },
    // 常見 easing
    ease_in_quad: (a, b, t) => a + (b - a) * t * t,
    ease_out_quad: (a, b, t) => a + (b - a) * (1 - (1 - t) * (1 - t)),
    ease_in_out_sine: (a, b, t) => a + (b - a) * (-(Math.cos(Math.PI * t) - 1) / 2),
  };
  const MATH_CONST = { pi: Math.PI, e: Math.E };

  // ---------- Tokenizer ----------
  const OPS = ['??', '==', '!=', '<=', '>=', '&&', '||', '->', '!', '<', '>', '+', '-', '*', '/', '?', ':', '=', '(', ')', '{', '}', ',', ';', '[', ']'];

  function tokenize(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      // 數字
      if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        let j = i;
        while (j < n && /[0-9.]/.test(src[j])) j++;
        if (src[j] === 'e' || src[j] === 'E') {
          let k = j + 1;
          if (src[k] === '+' || src[k] === '-') k++;
          if (/[0-9]/.test(src[k] || '')) { j = k; while (j < n && /[0-9]/.test(src[j])) j++; }
        }
        out.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
        if (src[j] === 'f' || src[j] === 'F') j++;
        i = j;
        continue;
      }
      // 字串
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== c) j++;
        out.push({ t: 'str', v: src.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      // 識別字（含點）
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_.]/.test(src[j])) j++;
        out.push({ t: 'id', v: src.slice(i, j).toLowerCase() });
        i = j;
        continue;
      }
      let matched = false;
      for (const op of OPS) {
        if (src.startsWith(op, i)) { out.push({ t: 'op', v: op }); i += op.length; matched = true; break; }
      }
      if (!matched) throw new Error('Molang：無法識別的字元 ' + c);
    }
    out.push({ t: 'eof' });
    return out;
  }

  // ---------- 名稱正規化 ----------
  function normName(name) {
    const dot = name.indexOf('.');
    if (dot < 0) return name;
    const head = name.slice(0, dot);
    const rest = name.slice(dot + 1);
    switch (head) {
      case 'q': return 'query.' + rest;
      case 'v': return 'variable.' + rest;
      case 't': return 'temp.' + rest;
      case 'c': return 'context.' + rest;
      default: return name;
    }
  }

  // ---------- 控制流訊號 ----------
  class ReturnSignal { constructor(v) { this.v = v; } }
  const BREAK = { brk: true };
  const CONTINUE = { cont: true };

  // ---------- Parser -> closures ----------
  function compile(src) {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const isOp = (v) => toks[p].t === 'op' && toks[p].v === v;
    const expectOp = (v) => { if (!isOp(v)) throw new Error('Molang：預期 ' + v); p++; };

    function parseStatements(endOp) {
      const stmts = [];
      let hadSemicolon = false;
      while (!(peek().t === 'eof' || (endOp && isOp(endOp)))) {
        if (isOp(';')) { p++; hadSemicolon = true; continue; }
        stmts.push(parseStatement());
        if (isOp(';')) { p++; hadSemicolon = true; }
      }
      return { stmts, hadSemicolon };
    }

    function parseStatement() {
      const t = peek();
      if (t.t === 'id' && t.v === 'return') { p++; const e = parseExpr(); return (ctx) => { throw new ReturnSignal(e(ctx)); }; }
      if (t.t === 'id' && t.v === 'break') { p++; return () => { throw BREAK; }; }
      if (t.t === 'id' && t.v === 'continue') { p++; return () => { throw CONTINUE; }; }
      return parseExpr();
    }

    function parseExpr() { return parseAssign(); }

    function parseAssign() {
      const start = p;
      const t = peek();
      if (t.t === 'id' && toks[p + 1].t === 'op' && toks[p + 1].v === '=') {
        const name = normName(t.v);
        p += 2;
        const rhs = parseAssign();
        return (ctx) => { const v = rhs(ctx); ctx.set(name, v); return v; };
      }
      p = start;
      return parseConditional();
    }

    function parseConditional() {
      const cond = parseNullish();
      if (isOp('?')) {
        p++;
        const a = parseAssign();
        if (isOp(':')) {
          p++;
          const b = parseAssign();
          return (ctx) => (truthy(cond(ctx)) ? a(ctx) : b(ctx));
        }
        return (ctx) => (truthy(cond(ctx)) ? a(ctx) : 0);
      }
      return cond;
    }

    function parseNullish() {
      let left = parseOr();
      while (isOp('??')) {
        p++;
        const right = parseOr();
        const l = left;
        left = (ctx) => { const v = l(ctx, true); return v === undefined || v === null ? right(ctx) : v; };
      }
      return left;
    }

    function binLevel(sub, ops, fn) {
      return function () {
        let left = sub();
        while (peek().t === 'op' && ops.includes(peek().v)) {
          const op = next().v;
          const right = sub();
          const l = left;
          left = fn(op, l, right);
        }
        return left;
      };
    }

    const parseUnary = function () {
      if (isOp('-')) { p++; const e = parseUnary(); return (ctx) => -num(e(ctx)); }
      if (isOp('+')) { p++; return parseUnary(); }
      if (isOp('!')) { p++; const e = parseUnary(); return (ctx) => (truthy(e(ctx)) ? 0 : 1); }
      return parsePrimary();
    };
    const parseMul = binLevel(parseUnary, ['*', '/'], (op, l, r) =>
      op === '*' ? (ctx) => num(l(ctx)) * num(r(ctx)) : (ctx) => { const d = num(r(ctx)); return d === 0 ? 0 : num(l(ctx)) / d; });
    const parseAdd = binLevel(parseMul, ['+', '-'], (op, l, r) =>
      op === '+' ? (ctx) => num(l(ctx)) + num(r(ctx)) : (ctx) => num(l(ctx)) - num(r(ctx)));
    const parseCmp = binLevel(parseAdd, ['<', '<=', '>', '>='], (op, l, r) => {
      switch (op) {
        case '<': return (ctx) => (num(l(ctx)) < num(r(ctx)) ? 1 : 0);
        case '<=': return (ctx) => (num(l(ctx)) <= num(r(ctx)) ? 1 : 0);
        case '>': return (ctx) => (num(l(ctx)) > num(r(ctx)) ? 1 : 0);
        default: return (ctx) => (num(l(ctx)) >= num(r(ctx)) ? 1 : 0);
      }
    });
    const parseEq = binLevel(parseCmp, ['==', '!='], (op, l, r) =>
      op === '==' ? (ctx) => (eq(l(ctx), r(ctx)) ? 1 : 0) : (ctx) => (eq(l(ctx), r(ctx)) ? 0 : 1));
    const parseAnd = binLevel(parseEq, ['&&'], (op, l, r) => (ctx) => (truthy(l(ctx)) && truthy(r(ctx)) ? 1 : 0));
    const parseOr = binLevel(parseAnd, ['||'], (op, l, r) => (ctx) => (truthy(l(ctx)) || truthy(r(ctx)) ? 1 : 0));

    function parseArgs() {
      const args = [];
      expectOp('(');
      while (!isOp(')')) {
        if (isOp('{')) args.push(parseBlock());
        else args.push(parseExpr());
        if (isOp(',')) p++;
        else break;
      }
      expectOp(')');
      return args;
    }

    function parseBlock() {
      expectOp('{');
      const { stmts } = parseStatements('}');
      expectOp('}');
      return (ctx) => { for (const s of stmts) s(ctx); return 0; };
    }

    function parsePrimary() {
      const t = next();
      if (t.t === 'num') { const v = t.v; return () => v; }
      if (t.t === 'str') { const v = t.v; return () => v; }
      if (t.t === 'op' && t.v === '(') {
        const e = parseExpr();
        expectOp(')');
        return e;
      }
      if (t.t === 'op' && t.v === '{') { p--; return parseBlock(); }
      if (t.t === 'id') {
        const raw = t.v;
        if (raw === 'true') return () => 1;
        if (raw === 'false') return () => 0;
        if (raw === 'this') return (ctx) => ctx.thisValue || 0;
        // loop(n, {…})
        if (raw === 'loop' && isOp('(')) {
          const args = parseArgs();
          return (ctx) => {
            const n = Math.min(1024, Math.max(0, Math.floor(num(args[0](ctx)))));
            for (let i = 0; i < n; i++) {
              try { args[1] && args[1](ctx); } catch (e) { if (e === BREAK) break; if (e === CONTINUE) continue; throw e; }
            }
            return 0;
          };
        }
        if (raw === 'for_each' && isOp('(')) { parseArgs(); return () => 0; }
        const name = normName(raw);
        if (isOp('(')) {
          const args = parseArgs();
          if (name.startsWith('math.')) {
            const fn = MATH[name.slice(5)];
            if (!fn) return () => 0;
            return (ctx) => num(fn.apply(null, args.map((a) => num(a(ctx)))));
          }
          return (ctx) => ctx.call(name, args.map((a) => a(ctx)));
        }
        // 陣列索引 v.arr[0] —— 不支援，吃掉並回傳 0
        if (isOp('[')) { p++; parseExpr(); expectOp(']'); return () => 0; }
        if (name.startsWith('math.')) {
          const c = MATH_CONST[name.slice(5)];
          return () => (c === undefined ? 0 : c);
        }
        return (ctx, raw0) => ctx.get(name, raw0);
      }
      throw new Error('Molang：語法錯誤');
    }

    const { stmts, hadSemicolon } = parseStatements(null);
    if (peek().t !== 'eof') throw new Error('Molang：多餘的內容');
    if (stmts.length === 0) return () => 0;
    if (stmts.length === 1 && !hadSemicolon) {
      const only = stmts[0];
      return (ctx) => {
        try { return only(ctx); } catch (e) { if (e instanceof ReturnSignal) return e.v; throw e; }
      };
    }
    // 複合語句：需要 return，否則為 0（但單一非賦值語句以分號結尾時取其值）
    return (ctx) => {
      let last = 0;
      try {
        for (const s of stmts) last = s(ctx);
      } catch (e) {
        if (e instanceof ReturnSignal) return e.v;
        if (e === BREAK || e === CONTINUE) return 0;
        throw e;
      }
      return stmts.length === 1 ? last : 0;
    };
  }

  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (v === undefined || v === null) return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') return 0;
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function truthy(v) { return typeof v === 'string' ? v.length > 0 : num(v) !== 0; }
  function eq(a, b) {
    if (typeof a === 'string' || typeof b === 'string') return String(a) === String(b);
    return num(a) === num(b);
  }

  const cache = new Map();
  function getCompiled(src) {
    let fn = cache.get(src);
    if (fn === undefined) {
      try { fn = compile(src); } catch (e) { console.warn('[Molang] 無法解析：', src, e.message); fn = () => 0; }
      cache.set(src, fn);
    }
    return fn;
  }

  /** 計算 Molang；數字直接回傳 */
  function evaluate(expr, ctx) {
    if (typeof expr === 'number') return expr;
    if (typeof expr === 'boolean') return expr ? 1 : 0;
    if (typeof expr !== 'string') return 0;
    const s = expr.trim();
    if (s === '') return 0;
    const quick = Number(s);
    if (!isNaN(quick)) return quick;
    try { return num(getCompiled(s)(ctx)); } catch (e) { return 0; }
  }

  /** Molang 執行環境 */
  class MolangContext {
    constructor() {
      this.variables = Object.create(null); // variable.*
      this.temps = Object.create(null);     // temp.*
      this.queries = Object.create(null);   // query.* / ysm.* 等外部值
      this.functions = Object.create(null); // 可呼叫的查詢函式
    }
    get(name, rawForNullish) {
      if (name.startsWith('variable.')) {
        const v = this.variables[name];
        return v === undefined ? (rawForNullish ? undefined : 0) : v;
      }
      if (name.startsWith('temp.')) {
        const v = this.temps[name];
        return v === undefined ? (rawForNullish ? undefined : 0) : v;
      }
      const q = this.queries[name];
      if (typeof q === 'function') return q();
      if (q === undefined) return rawForNullish ? undefined : 0;
      return q;
    }
    set(name, value) {
      if (name.startsWith('temp.')) this.temps[name] = value;
      else if (name.startsWith('variable.') || name.startsWith('context.')) this.variables[name] = value;
      else this.variables[name] = value;
    }
    call(name, args) {
      const f = this.functions[name];
      if (f) return f.apply(null, args);
      const q = this.queries[name];
      if (typeof q === 'function') return q.apply(null, args);
      if (typeof q === 'number') return q;
      return 0;
    }
    clearTemps() { this.temps = Object.create(null); }
    reset() { this.variables = Object.create(null); this.temps = Object.create(null); }
  }

  global.Molang = { evaluate, MolangContext, compile };
})(window);
