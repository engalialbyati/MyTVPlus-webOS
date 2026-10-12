'use strict';
/* webOS TV bridge: reimplements the Electron preload surface (window.mytv)
   with plain fetch (webOS packaged apps are not CORS-restricted),
   IndexedDB for the large catalog caches and localStorage for profiles.
   Also wires D-pad navigation: tabindex on interactive elements, Enter to
   click, and the Magic Remote Back key mapped to in-app back behavior. */

(function () {
  const APP_VERSION = '3.15.1';
  const HOSTS = ['https://androidapi.appmytv.com', 'https://androidapi.mtvapp.net'];
  const API_ROOT = '/android/v2';
  const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

  const SEED = '9z_z%C*F-JaNdWgU';
  const IV = CryptoJS.enc.Utf8.parse('t2w!W%u&F(J@McWf');

  let activeHostIdx = 0;
  let state = null;

  const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return (v === null || v === undefined) ? d : v; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('ls full', k, e); } };

  function decryptPayload(s) {
    const mid = Math.floor(s.length / 2);
    const rot = parseInt(s[mid], 10);
    const body = s.slice(0, mid) + s.slice(mid + 1);
    const keyStr = rot === 0 ? SEED : SEED.slice(SEED.length - rot) + SEED.slice(0, SEED.length - rot);
    const dec = CryptoJS.AES.decrypt(body, CryptoJS.enc.Utf8.parse(keyStr), { iv: IV, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
    return dec.toString(CryptoJS.enc.Utf8);
  }

  async function apiPost(pathname, body, timeoutMs = 25000) {
    let lastErr;
    for (let attempt = 0; attempt < HOSTS.length; attempt++) {
      const idx = (activeHostIdx + attempt) % HOSTS.length;
      const url = HOSTS[idx] + API_ROOT + '/' + pathname.replace(/^\/+/, '');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        activeHostIdx = idx;
        return await res.text();
      } catch (e) { clearTimeout(t); lastErr = e; }
    }
    throw lastErr || new Error('all API hosts failed');
  }

  function componentRequest() {
    return { appVersion: APP_VERSION, deviceType: 'Android', uuid: state.uuid, userId: state.userId || '', country: 'IQ' };
  }

  const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

  async function bootstrap() {
    state = lsGet('mytv_state', null);
    if (state && state.userId) return { ...state };
    state = state || { uuid: (crypto.randomUUID ? crypto.randomUUID() : uuidv4()), userId: null, createdAt: Date.now() };
    const resp = JSON.parse(await apiPost('users/saveUser.php', {
      deviceType: 'Android', uuid: state.uuid,
      joinDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
      appVersion: APP_VERSION, osVersion: 'webOS', macAddress: '02:00:00:00:00:00',
      serialNumber: 'N/A', fcmToken: '', deviceModel: 'LG TV', deviceManufacturer: 'LG',
      imsi: '', age: '', gender: '',
    }));
    if (!resp.state || !resp.userId) throw new Error('saveUser failed');
    state.userId = String(resp.userId);
    lsSet('mytv_state', state);
    return { ...state };
  }

  // ---- catalog cache: IndexedDB (catalogs are tens of MB) ----
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('mytv', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('cache');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const idbTx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction('cache', mode);
      const out = fn(tx.objectStore('cache'));
      tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      tx.onerror = () => rej(tx.error);
    });
  };
  async function cacheGet(name, maxAge) {
    try {
      const raw = await idbTx('readonly', (s) => s.get('cache-' + name));
      const obj = raw && raw.result !== undefined ? raw.result : raw;
      const parsed = typeof obj === 'string' ? JSON.parse(obj) : obj;
      if (!parsed || Date.now() - parsed.fetchedAt > maxAge) return null;
      return parsed.data;
    } catch { return null; }
  }
  async function cacheSet(name, data) {
    try {
      await idbTx('readwrite', (s) => s.put(JSON.stringify({ fetchedAt: Date.now(), data }), 'cache-' + name));
    } catch (e) { console.warn('cache write failed', name, e); }
  }

  async function fetchCatalog(name, pathname, opts = {}) {
    const cached = await cacheGet(name, CATALOG_TTL_MS);
    if (cached) return cached;
    let text = await apiPost(pathname, componentRequest());
    if (opts.encrypted) text = decryptPayload(text.trim());
    const data = JSON.parse(text);
    cacheSet(name, data);
    return data;
  }

  // ---- profiles (localStorage, same shape as other platforms) ----
  const PKEY = 'mytv_profiles';
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const emptyData = () => ({
    favorites: { channel: {}, movie: {}, series: {} },
    watchlater: { channel: {}, movie: {}, series: {} },
    progress: {}, history: [],
  });
  const profilesMap = () => lsGet(PKEY, {});

  const api = {
    bootstrap,
    channels: () => fetchCatalog('channels', 'channels/getChannelsDetail_local.php', { encrypted: true }),
    movies: () => fetchCatalog('movies', 'movies/getMoviesDetail_local.php'),
    series: () => fetchCatalog('series', 'series/getSeriesDetail_local.php'),
    movieCategories: () => fetchCatalog('movieCategories', 'movies/getMoviesCategory.php'),
    movieCategoryConnections: () => fetchCatalog('movieCategoryConnections', 'movies/getMoviesCategoryConnection.php'),
    seasons: async (seriesId) => JSON.parse(await apiPost('series/getSeriesSeasonDetail.php', { id: String(seriesId), userId: state.userId })),
    episodes: async (seasonId) => JSON.parse(await apiPost('series/getSeriesEpisodeDetail.php', { id: String(seasonId), userId: state.userId, uuid: state.userId })),
    subtitle: async (url) => (await fetch(url)).text(),
    proxyUrl: async (url) => url,   // webOS native pipeline handles redirects/ranges
    info: () => ({ version: APP_VERSION, ua: navigator.userAgent, platform: 'webos' }),

    profilesList: async () => Object.values(profilesMap()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
    profileCreate: async (name, avatar) => {
      const m = profilesMap();
      const p = { id: newId(), name: String(name || 'User').slice(0, 24), avatar: String(avatar || '🙂'), createdAt: Date.now() };
      m[p.id] = p; lsSet(PKEY, m);
      return p;
    },
    profileDelete: async (id) => {
      const m = profilesMap(); delete m[id];
      localStorage.removeItem('mytv_pdata_' + id);
      lsSet(PKEY, m);
    },
    profileLoad: async (id) => {
      const m = profilesMap();
      if (!m[id]) throw new Error('profile not found');
      return { profile: m[id], data: lsGet('mytv_pdata_' + id, emptyData()) };
    },
    profileSave: async (id, data) => lsSet('mytv_pdata_' + id, data),

    // series release-year index (same design as the mobile shim)
    seriesYears: async () => ({
      years: lsGet('mytv_series_years', {}),
      crawl: lsGet('mytv_years_crawl', { running: false, done: true, have: 0, total: 0 }),
    }),
    seriesYearsStart: async () => {
      const meta = lsGet('mytv_years_meta', { fetchedAt: 0 });
      if (Date.now() - meta.fetchedAt < 3 * 24 * 60 * 60 * 1000 && meta.done) return { cached: true };
      if (lsGet('mytv_years_crawl', { running: false }).running) return { cached: false };
      lsSet('mytv_years_crawl', { running: true, done: false, have: 0, total: 0 });
      (async () => {
        try {
          const series = await fetchCatalog('series', 'series/getSeriesDetail_local.php');
          const years = lsGet('mytv_series_years', {});
          const attempted = lsGet('mytv_years_attempted', {});
          const queue = series.map(x => String(x.id)).filter(id => !attempted[id]);
          lsSet('mytv_years_crawl', { running: true, done: false, have: Object.keys(years).length, total: series.length });
          let idx = 0, active = 0;
          await new Promise((resolve) => {
            const next = () => {
              while (active < 6 && idx < queue.length) {
                const id = queue[idx++];
                active++;
                apiPost('series/getSeriesSeasonDetail.php', { id, userId: state.userId })
                  .then(text => {
                    const seasons = JSON.parse(text);
                    const ys = (Array.isArray(seasons) ? seasons : [])
                      .map(x => parseInt(x.year, 10)).filter(Number.isFinite);
                    if (ys.length) years[id] = Math.min(...ys);
                  })
                  .catch(() => { delete attempted[id]; })
                  .finally(() => {
                    attempted[id] = 1;
                    active--;
                    if (idx % 250 === 0) {
                      lsSet('mytv_series_years', years); lsSet('mytv_years_attempted', attempted);
                      lsSet('mytv_years_crawl', { running: true, done: false, have: Object.keys(years).length, total: queue.length });
                    }
                    if (idx >= queue.length && active === 0) resolve();
                    else next();
                  });
              }
              if (queue.length === 0) resolve();
            };
            next();
          });
          lsSet('mytv_series_years', years); lsSet('mytv_years_attempted', attempted);
          lsSet('mytv_years_meta', { fetchedAt: Date.now(), done: true });
          lsSet('mytv_years_crawl', { running: false, done: true, have: Object.keys(years).length, total: queue.length });
        } catch (e) {
          lsSet('mytv_years_crawl', { running: false, done: false, have: 0, total: 0 });
        }
      })();
      return { cached: false };
    },
  };

  try {
    Object.defineProperty(window, 'mytv', { value: api, configurable: false });
  } catch (e) {
    console.warn('window.mytv already defined (dev context) — web shim inactive');
  }

  // ---- D-pad / remote support ----
  // Make interactive rows focusable so the TV's spatial navigation can move
  // between them, map Enter to click (some engines only fire keydown), and
  // route the Magic Remote Back key (461 / 10009) through the app's own
  // Escape handling.
  const FOCUSABLE = '.chan, .card, .tab, .chip, .ep-row, .corner-btn, .close-btn, .cc-btn, button, input, select';
  function addTabindex(root) {
    root.querySelectorAll(FOCUSABLE).forEach((n) => {
      if (!n.hasAttribute('tabindex') && n.tabIndex < 0) n.setAttribute('tabindex', '0');
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    addTabindex(document);
    new MutationObserver(() => addTabindex(document)).observe(document.body, { childList: true, subtree: true });
  });
  const tvOn = () => {
    try { return localStorage.getItem('mytv_tv_controls') !== '0'; } catch { return true; }
  };
  document.addEventListener('keydown', (e) => {
    if (e.keyCode === 461 || e.keyCode === 10009) {
      e.preventDefault();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    // TV controls (Settings toggle): CH +/-, seek, OK = pause while playing.
    // Volume keys stay with the TV system volume — webOS gives apps no say.
    if (tvOn()) {
      const TV_KEYS = {
        427: 'ch+', 428: 'ch-',          // LG channel up/down
        417: 'ff', 412: 'rew',           // media fast-forward / rewind
      };
      const playerOpen = !document.getElementById('player-overlay').classList.contains('hidden');
      if (TV_KEYS[e.keyCode]) {
        e.preventDefault();
        if (typeof window.__tvKey === 'function') window.__tvKey(TV_KEYS[e.keyCode]);
        return;
      }
      if ((e.key === 'Enter' || e.keyCode === 13) && playerOpen) {
        e.preventDefault();
        if (typeof window.__tvKey === 'function') window.__tvKey('ok');
        return;
      }
    }
    if (e.key === 'Enter') {
      const a = document.activeElement;
      if (a && a !== document.body && typeof a.click === 'function') { e.preventDefault(); a.click(); }
    }
  });
})();
