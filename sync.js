/* ============================================================
 * Recordable 가계부 · 동기화 엔진 (sync.js)
 *
 * 구조
 *   [화면 index.html] ──save()──▶ [엔진: 로컬 우선 + outbox] ──▶ [어댑터] ──▶ 서버
 *
 *   - 엔진: 서버 종류를 모름. 로컬 데이터 ↔ "행(row)" 변환, 변경분 계산, 재시도만 담당
 *   - 어댑터: 서버와 대화하는 부분. 아래 5개 함수만 있으면 어떤 서버든 교체 가능
 *       signIn(email, password) / signOut() / session()
 *       getLedgerId()                       → 공용 가계부 id
 *       pull(ledgerId, since, limit)        → [{kind,id,data,deleted,updated_at}] (updated_at 오름차순)
 *       push(ledgerId, rows)                → rows = [{kind,id,data,deleted}] 저장(있으면 덮어쓰기)
 *   - 기본 어댑터 'postgrest' 는 Supabase 와 자체 호스팅 PostgREST 서버 모두에서 동작
 * ============================================================ */
(function (root) {
  'use strict';

  var KEY = 'recordable-ledger-v1';
  var K = {
    base: KEY + '-sync-base',     // 마지막으로 알고 있는 행 상태 (key → 정규화된 JSON)
    outbox: KEY + '-sync-outbox', // 아직 서버에 못 보낸 변경
    meta: KEY + '-sync-meta',     // 커서, 가계부 id, 마지막 동기화 시각 등
    auth: KEY + '-sync-auth'      // 로그인 토큰 (어댑터가 사용)
  };
  var PAGE = 1000, PUSH_BATCH = 500, OVERLAP_MS = 120000;

  var MSG = {
    ko: { login: '동기화하려면 로그인이 필요해요 (setup.html)', noLedger: '이 계정에 연결된 공용 가계부가 없어요', synced: '다른 기기의 변경을 불러왔어요' },
    zh: { login: '需要登录才能同步（setup.html）', noLedger: '这个账号还没有关联共用账本', synced: '已同步其他设备的修改' },
    en: { login: 'Sign in to sync (setup.html)', noLedger: 'No shared ledger is linked to this account', synced: 'Changes from another device loaded' }
  };

  /* ---------------- 공통 도구 ---------------- */
  function stable(v) { // 키 순서를 고정한 JSON (서버 jsonb 가 키 순서를 바꿔도 같은 값으로 인식)
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function splitKey(k) { var i = k.indexOf(':'); return { kind: k.slice(0, i), id: k.slice(i + 1) }; }
  function tsMax(a, b) { if (!a) return b; if (!b) return a; return Date.parse(b) > Date.parse(a) ? b : a; }

  function SyncError(code, message) { var e = new Error(message || code); e.code = code; return e; }

  /* ---------------- 앱 데이터 ↔ 행 변환 ---------------- */
  var LISTS = [['entries', 'entry'], ['recurring', 'rec'], ['income', 'inc'], ['incomeRec', 'increc']];
  // 한 값짜리 공용 설정: 설정 id → 앱 데이터 필드
  var SETTINGS = { currency: 'currency', budget: 'budget', lastBackup: 'lastBackup' };

  // 버전 호환 보호: 이 버전이 "아는" 행만 삭제 판정 대상.
  // 더 새로운 버전이 추가한 종류/설정은 이 버전 데이터에 없어도 지우지 않고 그대로 둔다.
  function isManaged(k) {
    var kk = splitKey(k);
    if (kk.kind === 'cat') return true;
    for (var i = 0; i < LISTS.length; i++) if (LISTS[i][1] === kk.kind) return true;
    if (kk.kind === 'setting') return SETTINGS.hasOwnProperty(kk.id) || kk.id.indexOf('name:') === 0;
    return false;
  }

  function toRows(d) {
    var m = {};
    (d.cats || []).forEach(function (c, i) {
      if (!c || c._fresh) return; // 아직 저장 안 된 새 분류는 제외
      var o = {}; Object.keys(c).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = c[k]; });
      o._ord = i; // 분류 순서
      m['cat:' + c.id] = { kind: 'cat', id: String(c.id), data: o };
    });
    LISTS.forEach(function (p) {
      (d[p[0]] || []).forEach(function (e) { if (e && e.id != null) m[p[1] + ':' + e.id] = { kind: p[1], id: String(e.id), data: e }; });
    });
    Object.keys(SETTINGS).forEach(function (id) {
      var v = d[SETTINGS[id]];
      if (v !== undefined && v !== null && v !== '' && v !== 0) m['setting:' + id] = { kind: 'setting', id: id, data: { value: v } }; // 0/빈 값 = 행 삭제(해제)
    });
    Object.keys(d.names || {}).forEach(function (em) { // 작성자 표시 이름 (계정 이메일 → 이름)
      if (d.names[em]) m['setting:name:' + em] = { kind: 'setting', id: 'name:' + em, data: { value: d.names[em] } };
    });
    return m;
  }

  function fromRows(base, prev) {
    var d = { v: prev.v, lang: prev.lang, currency: prev.currency, budget: 0, lastBackup: null, names: {}, cats: [], entries: [], recurring: [], income: [], incomeRec: [] };
    var listOf = { entry: 'entries', rec: 'recurring', inc: 'income', increc: 'incomeRec' };
    Object.keys(base).forEach(function (k) {
      var kk = splitKey(k), o = JSON.parse(base[k]);
      if (kk.kind === 'cat') d.cats.push(o);
      else if (listOf[kk.kind]) d[listOf[kk.kind]].push(o);
      else if (kk.kind === 'setting' && SETTINGS.hasOwnProperty(kk.id) && o && o.value !== undefined && o.value !== null) d[SETTINGS[kk.id]] = o.value;
      else if (kk.kind === 'setting' && kk.id.indexOf('name:') === 0 && o && o.value) d.names[kk.id.slice(5)] = o.value;
    });
    d.cats.sort(function (a, b) { return (a._ord || 0) - (b._ord || 0); });
    d.cats.forEach(function (c) { delete c._ord; });
    ['entries', 'recurring', 'income', 'incomeRec'].forEach(function (n) {
      d[n].sort(function (a, b) { return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0; });
    });
    (prev.cats || []).forEach(function (c) { if (c && c._fresh) d.cats.push(c); }); // 편집 중인 새 분류 유지
    if (!d.cats.length && prev.cats && prev.cats.length) d.cats = prev.cats; // 안전장치: 분류가 0개가 되지 않게
    return d;
  }

  /* ---------------- 어댑터: PostgREST (Supabase / 자체 호스팅) ---------------- */
  function PostgrestAdapter(cfg, env) {
    var url = String(cfg.url || '').replace(/\/+$/, '');
    var key = cfg.key || '';
    var rest = url + (cfg.restPath || '/rest/v1');
    var authBase = url + (cfg.authPath || '/auth/v1');
    var fetchFn = env.fetch, store = env.store;

    function load() { return store.get(K.auth); }
    function saveTok(j, email) {
      var a = { access_token: j.access_token, refresh_token: j.refresh_token,
        expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000, email: email || (load() || {}).email || '', url: url };
      store.set(K.auth, a); return a;
    }
    function errText(j, r) { return (j && (j.error_description || j.msg || j.message || j.error)) || ('HTTP ' + r.status); }

    function tokenReq(grant, body) {
      return fetchFn(authBase + '/token?grant_type=' + grant, {
        method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j.access_token) throw SyncError(r.status >= 500 ? 'server' : 'auth', errText(j, r));
          return j;
        });
      });
    }
    var refreshing = null;
    function refresh() {
      var a = load();
      if (!a || !a.refresh_token) return Promise.reject(SyncError('login'));
      if (!refreshing) {
        refreshing = tokenReq('refresh_token', { refresh_token: a.refresh_token })
          .then(function (j) { return saveTok(j); })
          .catch(function (e) { if (e.code === 'auth') { store.del(K.auth); throw SyncError('login'); } throw e; })
          .then(function (v) { refreshing = null; return v; }, function (e) { refreshing = null; throw e; });
      }
      return refreshing;
    }
    function token() {
      var a = load();
      if (!a || !a.access_token || (a.url && a.url !== url)) return Promise.reject(SyncError('login'));
      if (a.expires_at - 60000 < Date.now()) return refresh().then(function (x) { return x.access_token; });
      return Promise.resolve(a.access_token);
    }
    function req(method, path, body, extra, retried) {
      return token().then(function (tk) {
        var h = { apikey: key, Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' };
        Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
        return fetchFn(rest + path, { method: method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
      }).then(function (r) {
        if (r.status === 401 && !retried) return refresh().then(function () { return req(method, path, body, extra, true); });
        if (!r.ok) return r.text().then(function (t) { throw SyncError(r.status === 401 ? 'login' : r.status >= 500 ? 'server' : 'request', 'HTTP ' + r.status + ' ' + t.slice(0, 200)); });
        return r.status === 204 ? null : r.text().then(function (t) { return t ? JSON.parse(t) : null; });
      });
    }

    return {
      name: 'postgrest',
      identity: url,
      signIn: function (email, password) { return tokenReq('password', { email: email, password: password }).then(function (j) { return saveTok(j, email); }); },
      signOut: function () { store.del(K.auth); return Promise.resolve(); },
      session: function () { var a = load(); return a && a.url === url ? { email: a.email } : null; },
      getLedgerId: function () {
        return req('GET', '/ledger_members?select=ledger_id&limit=1').then(function (rows) {
          if (!rows || !rows.length) throw SyncError('noLedger');
          return rows[0].ledger_id;
        });
      },
      pull: function (ledgerId, since, limit) {
        var q = '/ledger_rows?select=kind,id,data,deleted,updated_at&ledger_id=eq.' + encodeURIComponent(ledgerId) +
          (since ? '&updated_at=gt.' + encodeURIComponent(since) : '') + '&order=updated_at.asc&limit=' + limit;
        return req('GET', q);
      },
      push: function (ledgerId, rows) {
        var body = rows.map(function (r) { return { ledger_id: ledgerId, kind: r.kind, id: r.id, data: r.deleted ? null : r.data, deleted: !!r.deleted }; });
        return req('POST', '/ledger_rows?on_conflict=ledger_id,kind,id', body, { Prefer: 'resolution=merge-duplicates,return=minimal' });
      }
    };
  }

  var ADAPTERS = { postgrest: PostgrestAdapter, supabase: PostgrestAdapter };

  /* ---------------- 엔진 ---------------- */
  function makeStore(ls) {
    return {
      get: function (k) { try { var v = ls.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
      set: function (k, v) { try { ls.setItem(k, JSON.stringify(v)); } catch (e) {} },
      del: function (k) { try { ls.removeItem(k); } catch (e) {} }
    };
  }

  function createEngine(opts) {
    var cfg = opts.config || {};
    var env = { fetch: opts.fetch, store: makeStore(opts.storage) };
    var store = env.store;
    var host = null, adapter = null, timer = null, running = false, again = false, started = false;
    var failures = 0, loginToastShown = false, lastError = null;
    var S = {
      base: store.get(K.base) || {},
      outbox: store.get(K.outbox) || {},
      meta: store.get(K.meta) || { n: 0, cursor: null, ledgerId: null, identity: null, bootstrapped: false, lastSync: null }
    };

    var configured = !!(cfg.url && cfg.key);
    if (configured) {
      var A = opts.adapter || ADAPTERS[cfg.adapter || 'postgrest'];
      adapter = typeof A === 'function' ? A(cfg, env) : A;
    }

    function persist() { store.set(K.base, S.base); store.set(K.outbox, S.outbox); store.set(K.meta, S.meta); }
    function msg(k) { var l = host && host.lang ? host.lang() : 'ko'; return (MSG[l] || MSG.ko)[k]; }
    function resetFor(identity) {
      S.base = {}; S.outbox = {}; // 로컬 데이터(index.html 쪽)는 그대로. 부트스트랩이 다시 합침
      S.meta = { n: S.meta.n || 0, cursor: null, ledgerId: null, identity: identity, bootstrapped: false, lastSync: null };
      persist();
    }

    function queue(k, data, deleted) {
      var kk = splitKey(k);
      S.meta.n = (S.meta.n || 0) + 1;
      S.outbox[k] = { kind: kk.kind, id: kk.id, data: deleted ? null : data, deleted: !!deleted, n: S.meta.n };
    }

    function diffLocal(d) {
      var rows = toRows(d), changed = false;
      Object.keys(rows).forEach(function (k) {
        var j = stable(rows[k].data);
        if (S.base[k] !== j) { S.base[k] = j; queue(k, rows[k].data, false); changed = true; }
      });
      Object.keys(S.base).forEach(function (k) {
        if (!rows[k] && isManaged(k)) { delete S.base[k]; queue(k, null, true); changed = true; }
      });
      return changed;
    }

    function applyRemote(rows) {
      var changed = false;
      rows.forEach(function (r) {
        var k = r.kind + ':' + r.id;
        if (S.outbox[k]) return; // 이 기기에 아직 안 보낸 수정이 있으면 그쪽이 우선 (곧 서버로 감)
        if (r.deleted) { if (k in S.base) { delete S.base[k]; changed = true; } }
        else { var j = stable(r.data); if (S.base[k] !== j) { S.base[k] = j; changed = true; } }
      });
      return changed;
    }

    function pullAll(since, onPage) {
      var cursor = null;
      function page(s) {
        return adapter.pull(S.meta.ledgerId, s, PAGE).then(function (rows) {
          rows = rows || [];
          rows.forEach(function (r) { cursor = tsMax(cursor, r.updated_at); });
          onPage(rows);
          if (rows.length >= PAGE) return page(rows[rows.length - 1].updated_at);
        });
      }
      return page(since).then(function () { return cursor; });
    }

    function pushAll() {
      var rounds = 0;
      function once() {
        var items = Object.keys(S.outbox).slice(0, PUSH_BATCH).map(function (k) { return S.outbox[k]; });
        if (!items.length || rounds++ > 50) return Promise.resolve();
        return adapter.push(S.meta.ledgerId, items).then(function () {
          items.forEach(function (it) {
            var k = it.kind + ':' + it.id;
            if (S.outbox[k] && S.outbox[k].n === it.n) delete S.outbox[k]; // 보내는 사이 또 바뀐 건 남김
          });
          persist();
          return once();
        });
      }
      return once();
    }

    function bootstrap() {
      // 처음 연결(또는 서버/계정이 바뀐 직후): 서버 전체를 받고, 서버에 없는 로컬 기록만 올림
      var server = {}, tomb = {};
      return pullAll(null, function (rows) {
        rows.forEach(function (r) {
          var k = r.kind + ':' + r.id;
          if (r.deleted) { tomb[k] = true; delete server[k]; } else { server[k] = stable(r.data); delete tomb[k]; }
        });
      }).then(function (cursor) {
        if (host.isBusy && host.isBusy()) { again = 'busy'; return; }
        var local = toRows(host.getData());
        S.base = server; S.outbox = {};
        Object.keys(local).forEach(function (k) {
          if (S.base[k] === undefined && !tomb[k]) { S.base[k] = stable(local[k].data); queue(k, local[k].data, false); }
        });
        S.meta.cursor = cursor; S.meta.bootstrapped = true;
        persist();
        host.replaceData(fromRows(S.base, host.getData()));
        return pushAll();
      });
    }

    function incremental() {
      return pushAll().then(function () {
        if (host.isBusy && host.isBusy()) { again = 'busy'; return; }
        var since = S.meta.cursor ? new Date(Date.parse(S.meta.cursor) - OVERLAP_MS).toISOString() : null;
        var got = [];
        return pullAll(since, function (rows) { got = got.concat(rows); }).then(function (cursor) {
          // 받는 사이 사용자가 입력을 시작했으면 이번 결과는 버리고 나중에 다시 받음 (화면·입력 보호)
          if (host.isBusy && host.isBusy()) { again = 'busy'; return; }
          var changed = applyRemote(got);
          S.meta.cursor = tsMax(S.meta.cursor, cursor);
          persist();
          if (changed) host.replaceData(fromRows(S.base, host.getData()));
        });
      });
    }

    function run() {
      timer = null;
      if (!configured || !host) return Promise.resolve();
      if (running) { again = true; return Promise.resolve(); }
      running = true; again = false;
      var online = typeof navigator === 'undefined' || navigator.onLine !== false;
      var p = !online ? Promise.reject(SyncError('offline')) : Promise.resolve().then(function () {
        if (!adapter.session()) throw SyncError('login');
        return adapter.getLedgerId();
      }).then(function (lid) {
        var identity = adapter.identity + '|' + lid;
        if (S.meta.identity !== identity) resetFor(identity);
        S.meta.ledgerId = lid;
        if (!S.meta.bootstrapped) {
          if (host.isBusy && host.isBusy()) { again = 'busy'; return; }
          return bootstrap();
        }
        return incremental();
      });
      return p.then(function () {
        failures = 0; lastError = null; S.meta.lastSync = new Date().toISOString(); persist();
      }, function (e) {
        lastError = e && (e.code || e.message) || 'error';
        if (e && e.code === 'login' && !loginToastShown && host.toast) { loginToastShown = true; host.toast(msg('login')); }
        if (e && e.code === 'noLedger' && !loginToastShown && host.toast) { loginToastShown = true; host.toast(msg('noLedger')); }
        if (!(e && (e.code === 'offline' || e.code === 'login'))) failures++;
      }).then(function () {
        running = false;
        if (lastError === 'login' || lastError === 'noLedger') return; // 로그인 전에는 자동 재시도 안 함
        var wait = again === 'busy' ? 5000 : again ? 0 :
          lastError ? Math.min(300000, 5000 * Math.pow(2, Math.min(failures, 6))) :
          (typeof document !== 'undefined' && document.hidden ? 300000 : 60000);
        schedule(wait);
      });
    }

    function schedule(ms) {
      if (!configured) return;
      if (running) { if (!again) again = true; return; } // 끝나면 바로 한 번 더
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, ms);
    }

    return {
      start: function (h) {
        host = h;
        if (started) return; started = true;
        if (!configured) return;
        if (typeof window !== 'undefined') {
          window.addEventListener('online', function () { schedule(0); });
          document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(0); });
          window.addEventListener('focus', function () { schedule(500); });
        }
        schedule(0);
      },
      onLocalSave: function (d) {
        if (!configured || !S.meta.bootstrapped) return; // 첫 연결 전 변경은 부트스트랩이 한꺼번에 처리
        if (diffLocal(d)) { persist(); schedule(1500); }
      },
      syncNow: function () { if (timer) clearTimeout(timer); return run(); },
      signIn: function (email, pw) { loginToastShown = false; return adapter.signIn(email, pw); },
      signOut: function () { return adapter.signOut(); },
      check: function () { return adapter.getLedgerId(); }, // 로그인 후 연결 확인용 (setup.html)
      status: function () {
        return {
          configured: configured, adapter: adapter ? adapter.name : null, server: cfg.url || null,
          session: adapter ? adapter.session() : null, ledgerId: S.meta.ledgerId,
          pending: Object.keys(S.outbox).length, lastSync: S.meta.lastSync, lastError: lastError,
          bootstrapped: !!S.meta.bootstrapped
        };
      },
      _state: S // 테스트용
    };
  }

  var api = { createEngine: createEngine, toRows: toRows, fromRows: fromRows, isManaged: isManaged, stable: stable, adapters: ADAPTERS, KEYS: K };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    root.LedgerSyncLib = api;
    root.LedgerSync = createEngine({
      config: root.LEDGER_SYNC_CONFIG || {},
      storage: root.localStorage,
      fetch: root.fetch ? root.fetch.bind(root) : null
    });
  }
})(typeof window !== 'undefined' ? window : this);
