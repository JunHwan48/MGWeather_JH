// ==UserScript==
// @name         JH_Weatherinfo
// @namespace    MGWeatherHUD
// @version      1.0.0
// @description  Arie's Mod를 이용한 날씨 예보
// @author       JunHwan, ChatGPT
// @match        https://magicgarden.gg/r/*
// @match        https://magiccircle.gg/r/*
// @match        https://starweaver.org/r/*
// @match        https://1227719606223765687.discordsays.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/JunHwan48/MGWeather_JH/main/JH_Weatherinfo.user.js
// @downloadURL  https://raw.githubusercontent.com/JunHwan48/MGWeather_JH/main/JH_Weatherinfo.user.js
// ==/UserScript==

(function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  const HUD_ID = "mg-weather-hud-arie3162";
  const STYLE_ID = "mg-weather-hud-arie3162-style";
  const SETTINGS_KEY = "mg_weather_hud_arie3162_v101";

  const DEFAULT_MARGIN = 14;

  const DEFAULT_NORMAL_LIST_COUNT = 5;
  const DEFAULT_LUNAR_LIST_COUNT = 3;

  const MIN_LIST_COUNT = 1;
  const MAX_LIST_COUNT = 20;

  let gameWeatherRaw = undefined;
  let gameWeatherId = undefined;
  let gameWeatherSource = "waiting";
  let gameWeatherUpdatedAtClient = 0;

  let serverCurrentTimeMs = 0;
  let serverCurrentTimeReceivedAtClient = 0;

  let hudUpdateTimer = null;

  const settings = loadSettings();

  const QWS_NEXT_WEATHER_FORECAST = (() => {
    const SLOT_MS = 5 * 60 * 1000;
    const SLOTS_PER_DAY = 288;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const LOOKAHEAD_DAYS = 2;

    const HYDRO = {
      durationMinutes: 10,
      minFrequencyMinutes: 40,
      maxFrequencyMinutes: 60,
      dropTable: [
        { weatherId: "Rain", weight: 50 },
        { weatherId: "Frost", weight: 30 },
        { weatherId: "Thunderstorm", weight: 20 },
      ],
    };

    const LUNAR = {
      durationMinutes: 10,
      fixedTimeSlots: [0, 48, 96, 144, 192, 240],
      dropTable: [
        { weatherId: "Dawn", weight: 67 },
        { weatherId: "AmberMoon", weight: 33 },
      ],
    };

    const cache = new Map();

    function mashFactory() {
      let n = 4022871197;

      return function mash(data) {
        data = String(data);

        for (let i = 0; i < data.length; i++) {
          n += data.charCodeAt(i);

          let h = 0.02519603282416938 * n;
          n = h >>> 0;
          h -= n;
          h *= n;
          n = h >>> 0;
          h -= n;
          n += (h * 4294967296) >>> 0;
        }

        return (n >>> 0) * 2.3283064365386963e-10;
      };
    }

    function alea(seed) {
      const mash = mashFactory();

      let s0 = mash(" ");
      let s1 = mash(" ");
      let s2 = mash(" ");
      let c = 1;

      seed = String(seed);

      s0 -= mash(seed);
      if (s0 < 0) s0 += 1;

      s1 -= mash(seed);
      if (s1 < 0) s1 += 1;

      s2 -= mash(seed);
      if (s2 < 0) s2 += 1;

      return function random() {
        const t = 2091639 * s0 + c * 2.3283064365386963e-10;
        s0 = s1;
        s1 = s2;
        s2 = t - (c = t | 0);
        return s2;
      };
    }

    function pickWeighted(dropTable, rng) {
      const total = dropTable.reduce((sum, row) => sum + Number(row.weight || 0), 0);
      let roll = rng() * total;

      for (const row of dropTable) {
        roll -= Number(row.weight || 0);

        if (roll <= 0) {
          return row.weatherId;
        }
      }

      return dropTable.length ? dropTable[dropTable.length - 1].weatherId : null;
    }

    function startOfUtcDayMs(ms) {
      const d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }

    function dayKeyFromMs(ms) {
      return new Date(startOfUtcDayMs(ms)).toISOString().slice(0, 10);
    }

    function slotIndex(ms) {
      const dayStart = startOfUtcDayMs(ms);
      return Math.floor((ms - dayStart) / SLOT_MS);
    }

    function durationSlots(group) {
      return Math.max(1, Math.round(group.durationMinutes / 5));
    }

    function scheduleForDay(dayKey) {
      const hit = cache.get(dayKey);

      if (hit) {
        cache.delete(dayKey);
        cache.set(dayKey, hit);
        return hit;
      }

      const schedule = buildSchedule(dayKey);
      cache.set(dayKey, schedule);

      while (cache.size > 4) {
        const first = cache.keys().next().value;
        if (first === undefined) break;
        cache.delete(first);
      }

      return schedule;
    }

    function buildSchedule(dayKey) {
      const result = Object.create(null);
      const rng = alea(dayKey);

      const reserved = new Set();
      const lunarDuration = durationSlots(LUNAR);

      for (const fixedSlot of LUNAR.fixedTimeSlots) {
        for (let i = 0; i < lunarDuration; i++) {
          reserved.add(fixedSlot + i);
        }
      }

      const minSlots = Math.floor(HYDRO.minFrequencyMinutes / 5);
      const maxSlots = Math.floor(HYDRO.maxFrequencyMinutes / 5);
      const hydroDuration = durationSlots(HYDRO);

      let slot = Math.floor(rng() * minSlots);

      while (slot < SLOTS_PER_DAY) {
        const weatherId = pickWeighted(HYDRO.dropTable, rng);

        let canPlace = !!weatherId && slot + hydroDuration <= SLOTS_PER_DAY;

        for (let i = 0; canPlace && i < hydroDuration; i++) {
          if (reserved.has(slot + i)) {
            canPlace = false;
          }
        }

        if (canPlace) {
          for (let i = 0; i < hydroDuration; i++) {
            result[slot + i] = weatherId;
          }
        }

        slot += Math.max(
          1,
          minSlots + Math.floor((maxSlots - minSlots) * rng())
        );
      }

      for (const fixedSlot of LUNAR.fixedTimeSlots) {
        const weatherId = pickWeighted(LUNAR.dropTable, rng);

        if (!weatherId) continue;

        for (let i = 0; i < lunarDuration; i++) {
          result[fixedSlot + i] = weatherId;
        }
      }

      return result;
    }

    function lastContiguousSlot(schedule, slot, weatherId) {
      let end = slot;

      while (end < SLOTS_PER_DAY - 1 && schedule[end + 1] === weatherId) {
        end++;
      }

      return end;
    }

    function isLunar(weatherId) {
      return weatherId === "Dawn" || weatherId === "AmberMoon";
    }

    function findNext(nowMs, predicate) {
      const todayStart = startOfUtcDayMs(nowMs);
      const todayKey = dayKeyFromMs(nowMs);
      const todaySchedule = scheduleForDay(todayKey);
      const curSlot = slotIndex(nowMs);
      const curWeather = todaySchedule[curSlot] || null;

      const firstSlot = curWeather
        ? lastContiguousSlot(todaySchedule, curSlot, curWeather) + 1
        : curSlot + 1;

      for (let dayOffset = 0; dayOffset < LOOKAHEAD_DAYS; dayOffset++) {
        const dayStart = todayStart + dayOffset * DAY_MS;
        const dayKey = new Date(dayStart).toISOString().slice(0, 10);
        const schedule = scheduleForDay(dayKey);

        const start = dayOffset === 0 ? firstSlot : 0;

        for (let slot = start; slot < SLOTS_PER_DAY; slot++) {
          const weatherId = schedule[slot];

          if (!weatherId || !predicate(weatherId)) continue;

          const end = lastContiguousSlot(schedule, slot, weatherId);

          return {
            weatherId,
            startsAtMs: dayStart + slot * SLOT_MS,
            endsAtMs: dayStart + (end + 1) * SLOT_MS,
          };
        }
      }

      return null;
    }

    function displayName(value) {
      const raw = String(value ?? "").trim();
      const key = raw.toLowerCase().replace(/\s+/g, "");

      if (!key || key === "sunny" || key === "clearskies") return "Clear Skies";
      if (key === "frost" || key === "snow") return "Snow";
      if (key === "ambermoon" || key === "harvestmoon") return "Amber Moon";
      if (key === "rain") return "Rain";
      if (key === "thunderstorm" || key === "thunder") return "Thunderstorm";
      if (key === "dawn") return "Dawn";

      return raw || "Clear Skies";
    }

    function formatRemaining(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const sec = total % 60;

      return h > 0
        ? `${h}h ${m}m ${sec}s`
        : m > 0
          ? `${m}m ${sec}s`
          : `${sec}s`;
    }

    function nextEvent(nowMs = Date.now()) {
      return findNext(nowMs, () => true);
    }

    function nextLunarEvent(nowMs = Date.now()) {
      return findNext(nowMs, isLunar);
    }

    return {
      nextEvent,
      nextLunarEvent,
      displayName,
      currentName: displayName,
      formatRemaining,
      __source: "embedded Arie's Mod 3.2.162 QWS_NEXT_WEATHER_FORECAST",
    };
  })();

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function clampSettingNumber(value, min, max, fallback) {
    const n = Number(value);

    if (!Number.isFinite(n)) return fallback;

    return Math.min(Math.max(Math.round(n), min), max);
  }

  function loadSettings() {
    const defaults = {
      expanded: true,
      settingsOpen: false,

      saveHudPosition: false,

      showDataLine: false,
      showServerTimeLine: false,

      normalListCount: DEFAULT_NORMAL_LIST_COUNT,
      lunarListCount: DEFAULT_LUNAR_LIST_COUNT,

      timeOffsetSec: 0,

      left: null,
      top: null,
    };

    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      const merged = Object.assign({}, defaults, saved);

      merged.expanded =
        saved.expanded !== undefined ? !!saved.expanded : defaults.expanded;

      merged.settingsOpen =
        saved.settingsOpen !== undefined ? !!saved.settingsOpen : defaults.settingsOpen;

      merged.saveHudPosition =
        saved.saveHudPosition !== undefined
          ? !!saved.saveHudPosition
          : defaults.saveHudPosition;

      merged.showDataLine =
        saved.showDataLine !== undefined
          ? !!saved.showDataLine
          : defaults.showDataLine;

      merged.showServerTimeLine =
        saved.showServerTimeLine !== undefined
          ? !!saved.showServerTimeLine
          : defaults.showServerTimeLine;

      merged.normalListCount = clampSettingNumber(
        saved.normalListCount,
        MIN_LIST_COUNT,
        MAX_LIST_COUNT,
        defaults.normalListCount
      );

      merged.lunarListCount = clampSettingNumber(
        saved.lunarListCount,
        MIN_LIST_COUNT,
        MAX_LIST_COUNT,
        defaults.lunarListCount
      );

      merged.timeOffsetSec = Number.isFinite(Number(saved.timeOffsetSec))
        ? Number(saved.timeOffsetSec)
        : defaults.timeOffsetSec;

      if (!merged.saveHudPosition) {
        merged.left = null;
        merged.top = null;
      } else {
        merged.left = Number.isFinite(Number(saved.left)) ? Number(saved.left) : null;
        merged.top = Number.isFinite(Number(saved.top)) ? Number(saved.top) : null;
      }

      return merged;
    } catch {
      return defaults;
    }
  }

  function saveSettings() {
    const data = {
      expanded: !!settings.expanded,
      settingsOpen: !!settings.settingsOpen,
      saveHudPosition: !!settings.saveHudPosition,
      showDataLine: !!settings.showDataLine,
      showServerTimeLine: !!settings.showServerTimeLine,

      normalListCount: clampSettingNumber(
        settings.normalListCount,
        MIN_LIST_COUNT,
        MAX_LIST_COUNT,
        DEFAULT_NORMAL_LIST_COUNT
      ),

      lunarListCount: clampSettingNumber(
        settings.lunarListCount,
        MIN_LIST_COUNT,
        MAX_LIST_COUNT,
        DEFAULT_LUNAR_LIST_COUNT
      ),

      timeOffsetSec: Number(settings.timeOffsetSec) || 0,
      left: settings.saveHudPosition ? settings.left : null,
      top: settings.saveHudPosition ? settings.top : null,
    };

    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  }

  function normalizeGameWeather(value) {
    if (value == null || value === "" || value === false) return null;

    if (typeof value === "object") {
      const candidates = [
        value.weatherId,
        value.id,
        value.weather,
        value.name,
        value.type,
        value.value,
      ];

      for (const c of candidates) {
        const n = normalizeGameWeather(c);
        if (n !== undefined) return n;
      }

      return undefined;
    }

    const s = String(value).trim();

    if (!s) return null;

    if (
      /^clear$/i.test(s) ||
      /^clear\s*skies$/i.test(s) ||
      /^sunny$/i.test(s) ||
      /맑은\s*하늘/.test(s)
    ) {
      return null;
    }

    if (/^rain$/i.test(s) || s === "비") return "Rain";

    if (/^frost$/i.test(s) || /^snow$/i.test(s) || s === "눈" || s === "서리") {
      return "Frost";
    }

    if (/^thunder\s*storm$/i.test(s) || /^thunderstorm$/i.test(s) || s === "뇌우") {
      return "Thunderstorm";
    }

    if (/^dawn$/i.test(s) || s === "던" || s === "달" || s === "새벽") {
      return "Dawn";
    }

    if (
      /^amber\s*moon$/i.test(s) ||
      /^ambermoon$/i.test(s) ||
      /^harvest\s*moon$/i.test(s) ||
      s === "엠버문"
    ) {
      return "AmberMoon";
    }

    if (
      /partialstate|partial state|thunderstruck|dawnlit|amberlit|ambershine|raindance|wet|chilled|frozen|gold|rainbow|seedfinder|snowdrop|granter|charged|bound/i.test(
        s
      )
    ) {
      return undefined;
    }

    return undefined;
  }

  function isLunarId(id) {
    return id === "Dawn" || id === "AmberMoon";
  }

  function updateGameWeather(raw, source) {
    const normalized = normalizeGameWeather(raw);

    if (normalized === undefined) return;

    gameWeatherRaw = raw;
    gameWeatherId = normalized;
    gameWeatherSource = source || "Game State";
    gameWeatherUpdatedAtClient = Date.now();

    updateHud();
  }

  function setServerCurrentTime(ms) {
    if (!Number.isFinite(ms)) return;

    serverCurrentTimeMs = Number(ms);
    serverCurrentTimeReceivedAtClient = Date.now();
  }

  function getGameNowMs() {
    if (serverCurrentTimeMs && serverCurrentTimeReceivedAtClient) {
      return serverCurrentTimeMs + (Date.now() - serverCurrentTimeReceivedAtClient);
    }

    return Date.now();
  }

  function getCorrectedGameNowMs() {
    return getGameNowMs() + (Number(settings.timeOffsetSec) || 0) * 1000;
  }

  function getEffectiveNowMs() {
    return getCorrectedGameNowMs();
  }

  function processFullState(fullState) {
    try {
      const data = fullState && fullState.child && fullState.child.data;
      if (!data) return;

      if (Object.prototype.hasOwnProperty.call(data, "weather")) {
        updateGameWeather(data.weather, "Game State fullState.weather");
      }

      if (Object.prototype.hasOwnProperty.call(data, "currentTime")) {
        setServerCurrentTime(Number(data.currentTime));
      }
    } catch {
    }
  }

  function processPatch(patch) {
    if (!patch || typeof patch.path !== "string") return;

    if (patch.path === "/child/data/weather") {
      updateGameWeather(patch.value, "Game State patch weather");
      return;
    }

    if (patch.path === "/child/data/currentTime") {
      setServerCurrentTime(Number(patch.value));
      return;
    }
  }

  function processPayload(payload) {
    if (!payload || typeof payload !== "object") return;

    if (payload.fullState) processFullState(payload.fullState);
    if (payload.child && payload.child.data) processFullState(payload);

    if (Array.isArray(payload.patches)) {
      for (const patch of payload.patches) {
        processPatch(patch);
      }
    }
  }

  function installWebSocketReader() {
    if (W.__MG_WEATHER_HUD_ARIE3162_WS_INSTALLED__) return;

    const NativeWebSocket = W.WebSocket;

    if (!NativeWebSocket) {
      console.warn("[MG Weather HUD] Native WebSocket not found.");
      return;
    }

    W.__MG_WEATHER_HUD_ARIE3162_WS_INSTALLED__ = true;

    function WrappedWebSocket(...args) {
      const ws = new NativeWebSocket(...args);

      try {
        ws.addEventListener("message", function (ev) {
          try {
            if (typeof ev.data !== "string") return;

            const text = ev.data;

            if (
              !text.includes("fullState") &&
              !text.includes("/child/data/weather") &&
              !text.includes("/child/data/currentTime") &&
              !text.includes("\"weather\"") &&
              !text.includes("\"currentTime\"")
            ) {
              return;
            }

            const payload = JSON.parse(text);
            processPayload(payload);
          } catch {
          }
        });
      } catch (err) {
        console.warn("[MG Weather HUD] failed to attach WebSocket listener:", err);
      }

      return ws;
    }

    try {
      Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
      WrappedWebSocket.prototype = NativeWebSocket.prototype;

      WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
      WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
      WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
      WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;

      W.WebSocket = WrappedWebSocket;

      console.log("[MG Weather HUD] WebSocket game-state reader installed.");
    } catch (err) {
      console.warn("[MG Weather HUD] WebSocket reader install failed:", err);
    }
  }

  installWebSocketReader();

  function normalizeEvent(ev) {
    if (!ev || typeof ev !== "object") return null;

    const id = normalizeGameWeather(ev.weatherId);

    if (id === undefined) return null;

    const startsAtMs = Number(ev.startsAtMs);
    const endsAtMs = Number(ev.endsAtMs);

    if (!Number.isFinite(startsAtMs)) return null;

    return {
      raw: ev,
      id,
      weatherId: ev.weatherId,
      name: QWS_NEXT_WEATHER_FORECAST.displayName(ev.weatherId),
      startsAtMs,
      endsAtMs: Number.isFinite(endsAtMs) ? endsAtMs : null,
      inMs: startsAtMs - getEffectiveNowMs(),
      isLunar: isLunarId(id),
    };
  }

  function getNextAnyFromEngine(nowMs) {
    try {
      return normalizeEvent(QWS_NEXT_WEATHER_FORECAST.nextEvent(nowMs));
    } catch (err) {
      console.warn("[MG Weather HUD] nextEvent failed:", err);
      return null;
    }
  }

  function getNextLunarFromEngine(nowMs) {
    try {
      return normalizeEvent(QWS_NEXT_WEATHER_FORECAST.nextLunarEvent(nowMs));
    } catch (err) {
      console.warn("[MG Weather HUD] nextLunarEvent failed:", err);
      return null;
    }
  }

  function getNormalListCount() {
    return clampSettingNumber(
      settings.normalListCount,
      MIN_LIST_COUNT,
      MAX_LIST_COUNT,
      DEFAULT_NORMAL_LIST_COUNT
    );
  }

  function getLunarListCount() {
    return clampSettingNumber(
      settings.lunarListCount,
      MIN_LIST_COUNT,
      MAX_LIST_COUNT,
      DEFAULT_LUNAR_LIST_COUNT
    );
  }

  function getNextNormalList(count) {
    const out = [];
    const seen = new Set();

    let cursor = getEffectiveNowMs();

    for (let guard = 0; guard < 100 && out.length < count; guard++) {
      const ev = getNextAnyFromEngine(cursor);

      if (!ev) break;

      const key = `${ev.id}:${ev.startsAtMs}`;

      if (!seen.has(key)) {
        seen.add(key);

        if (!ev.isLunar) {
          ev.inMs = ev.startsAtMs - getEffectiveNowMs();

          if (ev.inMs > -60 * 1000) {
            out.push(ev);
          }
        }
      }

      const nextCursorBase = ev.endsAtMs || ev.startsAtMs;
      cursor = Number(nextCursorBase) + 1000;
    }

    return out.slice(0, count);
  }

  function getNextLunarList(count) {
    const out = [];
    const seen = new Set();

    let cursor = getEffectiveNowMs();

    for (let guard = 0; guard < 100 && out.length < count; guard++) {
      const ev = getNextLunarFromEngine(cursor);

      if (!ev) break;

      const key = `${ev.id}:${ev.startsAtMs}`;

      if (!seen.has(key)) {
        seen.add(key);

        ev.inMs = ev.startsAtMs - getEffectiveNowMs();

        if (ev.inMs > -60 * 1000) {
          out.push(ev);
        }
      }

      const nextCursorBase = ev.endsAtMs || ev.startsAtMs;
      cursor = Number(nextCursorBase) + 1000;
    }

    return out.slice(0, count);
  }

  /*
   * 남은 시간은 초까지 표시
   */
  function formatRemaining(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;

    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  /*
   * 발생 시각은 분까지만 표시
   */
  function formatDateTime(ms) {
    const d = new Date(ms);

    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");

    return `${month}/${day} ${hh}:${mm}`;
  }

  function weatherClass(id) {
    switch (id) {
      case "Rain":
        return "mg-nw-rain";
      case "Frost":
      case "Snow":
        return "mg-nw-snow";
      case "Thunderstorm":
        return "mg-nw-thunderstorm";
      case "Dawn":
        return "mg-nw-dawn";
      case "AmberMoon":
        return "mg-nw-amber";
      default:
        return "";
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function getSafeHudPosition(box, desiredLeft, desiredTop) {
    const width = box.offsetWidth || 360;
    const height = box.offsetHeight || 210;

    const maxLeft = Math.max(DEFAULT_MARGIN, window.innerWidth - width - DEFAULT_MARGIN);
    const maxTop = Math.max(DEFAULT_MARGIN, window.innerHeight - height - DEFAULT_MARGIN);

    const defaultLeft = maxLeft;
    const defaultTop = maxTop;

    let left = Number.isFinite(desiredLeft) ? desiredLeft : defaultLeft;
    let top = Number.isFinite(desiredTop) ? desiredTop : defaultTop;

    left = clamp(left, DEFAULT_MARGIN, maxLeft);
    top = clamp(top, DEFAULT_MARGIN, maxTop);

    return { left, top };
  }

  function applySafeHudPosition(box, desiredLeft, desiredTop, shouldSave) {
    const pos = getSafeHudPosition(box, desiredLeft, desiredTop);

    box.style.left = `${pos.left}px`;
    box.style.top = `${pos.top}px`;
    box.style.right = "auto";
    box.style.bottom = "auto";

    if (shouldSave && settings.saveHudPosition) {
      settings.left = Math.round(pos.left);
      settings.top = Math.round(pos.top);
      saveSettings();
    }

    return pos;
  }

  function reapplyCurrentHudPosition(box, shouldSave) {
    if (settings.saveHudPosition) {
      return applySafeHudPosition(box, settings.left, settings.top, shouldSave);
    }

    return applySafeHudPosition(box, null, null, false);
  }

  function resetHudPosition() {
    const box = document.getElementById(HUD_ID);

    if (!box) return;

    settings.left = null;
    settings.top = null;
    saveSettings();

    requestAnimationFrame(() => {
      reapplyCurrentHudPosition(box, false);
    });
  }

  function cleanupHudDomOnly() {
    if (hudUpdateTimer) {
      clearInterval(hudUpdateTimer);
      hudUpdateTimer = null;
    }

    const box = document.getElementById(HUD_ID);
    if (box) box.remove();

    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  function createHud() {
    cleanupHudDomOnly();

    const box = document.createElement("div");
    box.id = HUD_ID;
    box.classList.toggle("expanded", !!settings.expanded);
    box.classList.toggle("settings-open", !!settings.settingsOpen);
    box.classList.toggle("save-position", !!settings.saveHudPosition);
    box.classList.toggle("hide-data-line", !settings.showDataLine);
    box.classList.toggle("hide-server-time-line", !settings.showServerTimeLine);

    box.innerHTML = `
      <div class="mg-nw-header" id="mg-nw-drag-handle">
        <div class="mg-nw-title">날씨 예보</div>
        <div class="mg-nw-header-buttons">
          <button id="mg-nw-settings-toggle" class="mg-nw-small-btn" type="button" title="설정">⚙</button>
          <button id="mg-nw-toggle" class="mg-nw-toggle" type="button" title="펼치기 / 접기">
            ${settings.expanded ? "−" : "+"}
          </button>
        </div>
      </div>

      <div class="mg-nw-body">
        <div class="mg-nw-line">
          <span class="mg-nw-label">현재 날씨</span>
          <span id="mg-nw-current">...</span>
        </div>

        <div class="mg-nw-line">
          <span class="mg-nw-label">다음 날씨</span>
          <span id="mg-nw-next-weather">...</span>
        </div>

        <div class="mg-nw-line">
          <span class="mg-nw-label">다음 희귀 날씨</span>
          <span id="mg-nw-next-lunar">...</span>
        </div>

        <div id="mg-nw-data-line" class="mg-nw-line mg-nw-source-line">
          <span class="mg-nw-label">데이터</span>
          <span id="mg-nw-source">...</span>
        </div>

        <div id="mg-nw-server-time-line" class="mg-nw-line mg-nw-source-line">
          <span class="mg-nw-label">기준 시간</span>
          <span id="mg-nw-server-time">...</span>
        </div>

        <div id="mg-nw-settings-panel" class="mg-nw-settings-panel">
          <div class="mg-nw-settings-title">설정</div>

          <label class="mg-nw-setting-row">
            <span>데이터 표시</span>
            <input id="mg-nw-show-data-line" type="checkbox" ${settings.showDataLine ? "checked" : ""}>
          </label>

          <label class="mg-nw-setting-row">
            <span>기준 시간 표시</span>
            <input id="mg-nw-show-server-time-line" type="checkbox" ${settings.showServerTimeLine ? "checked" : ""}>
          </label>

          <label class="mg-nw-setting-row">
            <span>드래그 위치 저장</span>
            <input id="mg-nw-save-position" type="checkbox" ${settings.saveHudPosition ? "checked" : ""}>
          </label>

          <label class="mg-nw-setting-row">
            <span>다음 날씨 개수</span>
            <div class="mg-nw-offset-wrap">
              <input
                id="mg-nw-normal-list-count"
                type="number"
                min="${MIN_LIST_COUNT}"
                max="${MAX_LIST_COUNT}"
                step="1"
                value="${getNormalListCount()}"
              >
              <span>개</span>
            </div>
          </label>

          <label class="mg-nw-setting-row">
            <span>희귀 날씨 개수</span>
            <div class="mg-nw-offset-wrap">
              <input
                id="mg-nw-lunar-list-count"
                type="number"
                min="${MIN_LIST_COUNT}"
                max="${MAX_LIST_COUNT}"
                step="1"
                value="${getLunarListCount()}"
              >
              <span>개</span>
            </div>
          </label>

          <label class="mg-nw-setting-row">
            <span>시간 보정</span>
            <div class="mg-nw-offset-wrap">
              <input id="mg-nw-time-offset-sec" type="number" step="1" value="${Number(settings.timeOffsetSec) || 0}">
              <span>초</span>
            </div>
          </label>

          <div class="mg-nw-setting-help">
            시간 보정 기본값: <b>0초</b><br>
            표시 개수 기본값: 날씨 <b>${DEFAULT_NORMAL_LIST_COUNT}개</b>, 희귀 <b>${DEFAULT_LUNAR_LIST_COUNT}개</b>
          </div>

          <div class="mg-nw-setting-actions">
            <button id="mg-nw-restore-defaults" type="button">기본값 복원</button>
            <button id="mg-nw-reset-position" type="button">위치 초기화</button>
          </div>
        </div>

        <div id="mg-nw-expanded-area" class="mg-nw-expanded-area">
          <div class="mg-nw-subtitle">다음 날씨</div>
          <div id="mg-nw-weather-list" class="mg-nw-upcoming">...</div>

          <div class="mg-nw-subtitle mg-nw-lunar-title">다음 희귀 날씨</div>
          <div id="mg-nw-lunar-list" class="mg-nw-upcoming">...</div>
        </div>
      </div>
    `;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${HUD_ID} {
        position: fixed;
        right: auto;
        bottom: auto;
        z-index: 999999;
        min-width: 360px;
        max-width: min(520px, calc(100vw - 28px));
        max-height: calc(100vh - 28px);
        overflow: auto;
        border-radius: 12px;
        background: rgba(20, 20, 24, 0.92);
        color: #ffffff;
        font-family: Arial, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
        font-size: 13px;
        line-height: 1.45;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(4px);
        user-select: none;
      }

      #${HUD_ID} .mg-nw-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 9px 10px 6px 12px;
        cursor: move;
        position: sticky;
        top: 0;
        background: rgba(20, 20, 24, 0.96);
        border-radius: 12px 12px 0 0;
      }

      #${HUD_ID} .mg-nw-title {
        font-weight: 700;
        font-size: 14px;
      }

      #${HUD_ID} .mg-nw-header-buttons {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      #${HUD_ID} .mg-nw-toggle,
      #${HUD_ID} .mg-nw-small-btn {
        border: 0;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.16);
        color: #ffffff;
        font-weight: 700;
        cursor: pointer;
      }

      #${HUD_ID} .mg-nw-toggle {
        width: 24px;
        height: 24px;
        font-size: 18px;
        line-height: 20px;
      }

      #${HUD_ID} .mg-nw-small-btn {
        width: 26px;
        height: 24px;
        font-size: 13px;
        line-height: 20px;
      }

      #${HUD_ID} .mg-nw-toggle:hover,
      #${HUD_ID} .mg-nw-small-btn:hover {
        background: rgba(255, 255, 255, 0.26);
      }

      #${HUD_ID} .mg-nw-body {
        padding: 0 12px 10px 12px;
      }

      #${HUD_ID} .mg-nw-line {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        white-space: nowrap;
      }

      #${HUD_ID} .mg-nw-label {
        opacity: 0.7;
        min-width: 96px;
      }

      #${HUD_ID} #mg-nw-current,
      #${HUD_ID} #mg-nw-next-weather,
      #${HUD_ID} #mg-nw-next-lunar,
      #${HUD_ID} #mg-nw-source,
      #${HUD_ID} #mg-nw-server-time {
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #${HUD_ID} .mg-nw-source-line {
        font-size: 11px;
        opacity: 0.72;
        margin-top: 2px;
      }

      #${HUD_ID}.hide-data-line #mg-nw-data-line {
        display: none;
      }

      #${HUD_ID}.hide-server-time-line #mg-nw-server-time-line {
        display: none;
      }

      #${HUD_ID} .mg-nw-settings-panel {
        display: none;
        margin-top: 9px;
        padding: 8px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.06);
      }

      #${HUD_ID}.settings-open .mg-nw-settings-panel {
        display: block;
      }

      #${HUD_ID} .mg-nw-settings-title {
        font-weight: 700;
        margin-bottom: 6px;
        font-size: 12px;
      }

      #${HUD_ID} .mg-nw-setting-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin: 6px 0;
      }

      #${HUD_ID} .mg-nw-setting-row span {
        opacity: 0.86;
      }

      #${HUD_ID} .mg-nw-offset-wrap {
        display: flex;
        align-items: center;
        gap: 5px;
      }

      #${HUD_ID} input[type="number"] {
        width: 76px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 7px;
        background: rgba(0, 0, 0, 0.28);
        color: #ffffff;
        padding: 3px 6px;
        font-size: 12px;
      }

      #${HUD_ID} input[type="checkbox"] {
        transform: scale(1.05);
      }

      #${HUD_ID} .mg-nw-setting-help {
        margin-top: 6px;
        font-size: 11px;
        opacity: 0.72;
      }

      #${HUD_ID} .mg-nw-setting-actions {
        display: flex;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }

      #${HUD_ID} .mg-nw-setting-actions button {
        border: 0;
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.16);
        color: #ffffff;
        padding: 4px 8px;
        font-size: 12px;
        cursor: pointer;
      }

      #${HUD_ID} .mg-nw-setting-actions button:hover {
        background: rgba(255, 255, 255, 0.26);
      }

      #${HUD_ID} .mg-nw-expanded-area {
        display: none;
        margin-top: 9px;
        padding-top: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.16);
      }

      #${HUD_ID}.expanded .mg-nw-expanded-area {
        display: block;
      }

      #${HUD_ID} .mg-nw-subtitle {
        font-weight: 700;
        font-size: 12px;
        opacity: 0.88;
        margin-top: 7px;
        margin-bottom: 5px;
      }

      #${HUD_ID} .mg-nw-lunar-title {
        color: #ffffff;
        margin-top: 10px;
      }

      #${HUD_ID} .mg-nw-upcoming-row {
        display: grid;
        grid-template-columns: 34px 92px 1fr auto;
        gap: 8px;
        align-items: center;
        padding: 2px 0;
        white-space: nowrap;
      }

      #${HUD_ID} .mg-nw-index {
        opacity: 0.70;
      }

      #${HUD_ID} .mg-nw-time {
        opacity: 0.78;
      }

      #${HUD_ID} .mg-nw-name {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #${HUD_ID} .mg-nw-in {
        opacity: 0.82;
        text-align: right;
        color: #ffffff;
        font-weight: 400;
      }

      #${HUD_ID} .mg-nw-empty {
        opacity: 0.72;
        padding: 2px 0;
      }

      #${HUD_ID} .mg-nw-rain {
        color: #7ec8ff;
        font-weight: 700;
      }

      #${HUD_ID} .mg-nw-snow {
        color: #ffffff;
        font-weight: 700;
      }

      #${HUD_ID} .mg-nw-thunderstorm {
        color: #fff0a8;
        font-weight: 700;
      }

      #${HUD_ID} .mg-nw-dawn {
        color: #d3b4ff;
        font-weight: 700;
      }

      #${HUD_ID} .mg-nw-amber {
        color: #ffbf5f;
        font-weight: 700;
      }

      #${HUD_ID}.dragging {
        opacity: 0.82;
      }
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(box);

    requestAnimationFrame(() => {
      reapplyCurrentHudPosition(box, false);
    });

    installDrag(box);
    installToggle(box);
    installSettingsControls(box);

    return box;
  }

  function installToggle(box) {
    const toggle = document.getElementById("mg-nw-toggle");

    if (!toggle) return;

    toggle.addEventListener("click", function (ev) {
      ev.stopPropagation();

      settings.expanded = !settings.expanded;
      box.classList.toggle("expanded", settings.expanded);
      toggle.textContent = settings.expanded ? "−" : "+";

      saveSettings();

      requestAnimationFrame(() => {
        reapplyCurrentHudPosition(box, false);
      });

      updateHud();
    });
  }

  function installSettingsControls(box) {
    const settingsToggle = document.getElementById("mg-nw-settings-toggle");
    const showDataInput = document.getElementById("mg-nw-show-data-line");
    const showServerTimeInput = document.getElementById("mg-nw-show-server-time-line");
    const savePositionInput = document.getElementById("mg-nw-save-position");
    const normalListCountInput = document.getElementById("mg-nw-normal-list-count");
    const lunarListCountInput = document.getElementById("mg-nw-lunar-list-count");
    const offsetInput = document.getElementById("mg-nw-time-offset-sec");
    const restoreDefaultsButton = document.getElementById("mg-nw-restore-defaults");
    const resetPositionButton = document.getElementById("mg-nw-reset-position");

    if (settingsToggle) {
      settingsToggle.addEventListener("click", function (ev) {
        ev.stopPropagation();

        settings.settingsOpen = !settings.settingsOpen;
        box.classList.toggle("settings-open", settings.settingsOpen);

        saveSettings();

        requestAnimationFrame(() => {
          reapplyCurrentHudPosition(box, false);
        });
      });
    }

    function syncInputsFromSettings() {
      if (showDataInput) showDataInput.checked = !!settings.showDataLine;
      if (showServerTimeInput) showServerTimeInput.checked = !!settings.showServerTimeLine;
      if (savePositionInput) savePositionInput.checked = !!settings.saveHudPosition;
      if (normalListCountInput) normalListCountInput.value = String(getNormalListCount());
      if (lunarListCountInput) lunarListCountInput.value = String(getLunarListCount());
      if (offsetInput) offsetInput.value = String(Number(settings.timeOffsetSec) || 0);
    }

    function applySettingsLive(options = {}) {
      const normalizeInputs = !!options.normalizeInputs;

      settings.showDataLine = !!showDataInput?.checked;
      settings.showServerTimeLine = !!showServerTimeInput?.checked;
      settings.saveHudPosition = !!savePositionInput?.checked;

      settings.normalListCount = clampSettingNumber(
        normalListCountInput?.value,
        MIN_LIST_COUNT,
        MAX_LIST_COUNT,
        DEFAULT_NORMAL_LIST_COUNT
      );

      settings.lunarListCount = clampSettingNumber(
        lunarListCountInput?.value,
        MIN_LIST_COUNT,
        MAX_LIST_COUNT,
        DEFAULT_LUNAR_LIST_COUNT
      );

      const parsedOffset = Number(offsetInput?.value ?? 0);
      settings.timeOffsetSec = Number.isFinite(parsedOffset) ? parsedOffset : 0;

      if (settings.saveHudPosition) {
        const rect = box.getBoundingClientRect();
        settings.left = Math.round(rect.left);
        settings.top = Math.round(rect.top);
      } else {
        settings.left = null;
        settings.top = null;
      }

      box.classList.toggle("hide-data-line", !settings.showDataLine);
      box.classList.toggle("hide-server-time-line", !settings.showServerTimeLine);
      box.classList.toggle("save-position", !!settings.saveHudPosition);

      if (normalizeInputs) {
        if (normalListCountInput) normalListCountInput.value = String(getNormalListCount());
        if (lunarListCountInput) lunarListCountInput.value = String(getLunarListCount());
        if (offsetInput) offsetInput.value = String(Number(settings.timeOffsetSec) || 0);
      }

      saveSettings();
      updateHud();

      requestAnimationFrame(() => {
        reapplyCurrentHudPosition(box, false);
      });
    }

    if (showDataInput) {
      showDataInput.addEventListener("change", function () {
        applySettingsLive();
      });
    }

    if (showServerTimeInput) {
      showServerTimeInput.addEventListener("change", function () {
        applySettingsLive();
      });
    }

    if (savePositionInput) {
      savePositionInput.addEventListener("change", function () {
        applySettingsLive();
      });
    }

    if (normalListCountInput) {
      normalListCountInput.addEventListener("input", function () {
        applySettingsLive();
      });

      normalListCountInput.addEventListener("change", function () {
        applySettingsLive({ normalizeInputs: true });
      });
    }

    if (lunarListCountInput) {
      lunarListCountInput.addEventListener("input", function () {
        applySettingsLive();
      });

      lunarListCountInput.addEventListener("change", function () {
        applySettingsLive({ normalizeInputs: true });
      });
    }

    if (offsetInput) {
      offsetInput.addEventListener("input", function () {
        applySettingsLive();
      });

      offsetInput.addEventListener("change", function () {
        applySettingsLive({ normalizeInputs: true });
      });
    }

    if (restoreDefaultsButton) {
      restoreDefaultsButton.addEventListener("click", function (ev) {
        ev.stopPropagation();

        settings.timeOffsetSec = 0;
        settings.normalListCount = DEFAULT_NORMAL_LIST_COUNT;
        settings.lunarListCount = DEFAULT_LUNAR_LIST_COUNT;

        syncInputsFromSettings();

        saveSettings();
        updateHud();

        requestAnimationFrame(() => {
          reapplyCurrentHudPosition(box, false);
        });
      });
    }

    if (resetPositionButton) {
      resetPositionButton.addEventListener("click", function (ev) {
        ev.stopPropagation();

        settings.left = null;
        settings.top = null;
        saveSettings();

        requestAnimationFrame(() => {
          reapplyCurrentHudPosition(box, false);
        });
      });
    }
  }

  function installDrag(box) {
    const handle = document.getElementById("mg-nw-drag-handle");

    if (!handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("mousedown", function (ev) {
      const target = ev.target;

      if (target && target.closest && target.closest("button,input,label")) {
        return;
      }

      dragging = true;

      const rect = box.getBoundingClientRect();

      startX = ev.clientX;
      startY = ev.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      box.classList.add("dragging");
      ev.preventDefault();
    });

    window.addEventListener("mousemove", function (ev) {
      if (!dragging) return;

      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      applySafeHudPosition(box, startLeft + dx, startTop + dy, false);
    });

    window.addEventListener("mouseup", function () {
      if (!dragging) return;

      dragging = false;
      box.classList.remove("dragging");

      const rect = box.getBoundingClientRect();
      applySafeHudPosition(box, rect.left, rect.top, true);
    });
  }

  function renderEventRows(events, emptyText) {
    if (!events || !events.length) {
      return `<div class="mg-nw-empty">${escapeHtml(emptyText)}</div>`;
    }

    return events
      .map((ev, index) => {
        const cls = weatherClass(ev.id);
        const timeText = formatDateTime(ev.startsAtMs);
        const remainText = formatRemaining(ev.startsAtMs - getEffectiveNowMs());

        return `
          <div class="mg-nw-upcoming-row">
            <span class="mg-nw-index">#${index + 1}</span>
            <span class="mg-nw-time">${escapeHtml(timeText)}</span>
            <span class="mg-nw-name ${cls}">${escapeHtml(ev.name)}</span>
            <span class="mg-nw-in">${escapeHtml(remainText)}</span>
          </div>
        `;
      })
      .join("");
  }

  function updateHud() {
    const box = document.getElementById(HUD_ID);

    if (box) {
      box.classList.toggle("save-position", !!settings.saveHudPosition);
      box.classList.toggle("hide-data-line", !settings.showDataLine);
      box.classList.toggle("hide-server-time-line", !settings.showServerTimeLine);
      box.classList.toggle("settings-open", !!settings.settingsOpen);
    }

    const currentEl = document.getElementById("mg-nw-current");
    const nextWeatherEl = document.getElementById("mg-nw-next-weather");
    const nextLunarEl = document.getElementById("mg-nw-next-lunar");
    const sourceEl = document.getElementById("mg-nw-source");
    const serverTimeEl = document.getElementById("mg-nw-server-time");
    const weatherListEl = document.getElementById("mg-nw-weather-list");
    const lunarListEl = document.getElementById("mg-nw-lunar-list");

    const normalEvents = getNextNormalList(getNormalListCount());
    const lunarEvents = getNextLunarList(getLunarListCount());

    const nextWeather = normalEvents[0] || null;
    const nextLunar = lunarEvents[0] || null;

    if (currentEl) {
      if (gameWeatherId === undefined) {
        currentEl.textContent = "읽는 중...";
        currentEl.className = "";
      } else if (gameWeatherId === null) {
        currentEl.textContent = QWS_NEXT_WEATHER_FORECAST.currentName(null);
        currentEl.className = "";
      } else {
        currentEl.textContent = QWS_NEXT_WEATHER_FORECAST.currentName(gameWeatherId);
        currentEl.className = weatherClass(gameWeatherId);
      }
    }

    /*
     * 다음 날씨:
     * 날씨 이름 부분만 색상 적용
     */
    if (nextWeatherEl) {
      if (nextWeather) {
        const cls = weatherClass(nextWeather.id);
        const name = escapeHtml(nextWeather.name);
        const remain = escapeHtml(formatRemaining(nextWeather.startsAtMs - getEffectiveNowMs()));

        nextWeatherEl.innerHTML = `<span class="${cls}">${name}</span> <span class="mg-nw-in">in ${remain}</span>`;
      } else {
        nextWeatherEl.textContent = "예보 없음";
      }

      nextWeatherEl.className = "";
    }

    /*
     * 다음 희귀 날씨:
     * 날씨 이름 부분만 색상 적용
     */
    if (nextLunarEl) {
      if (nextLunar) {
        const cls = weatherClass(nextLunar.id);
        const name = escapeHtml(nextLunar.name);
        const remain = escapeHtml(formatRemaining(nextLunar.startsAtMs - getEffectiveNowMs()));

        nextLunarEl.innerHTML = `<span class="${cls}">${name}</span> <span class="mg-nw-in">in ${remain}</span>`;
      } else {
        nextLunarEl.textContent = "희귀 날씨 예보 없음";
      }

      nextLunarEl.className = "";
    }

    if (sourceEl) {
      const offset = Number(settings.timeOffsetSec) || 0;
      sourceEl.textContent =
        `Current: ${gameWeatherSource} / Future: Arie's Mod 3.2.162 embedded / offset: ${offset}s`;
    }

    if (serverTimeEl) {
      const offset = Number(settings.timeOffsetSec) || 0;

      if (serverCurrentTimeMs) {
        serverTimeEl.textContent =
          `${formatDateTime(getCorrectedGameNowMs())} (${offset >= 0 ? "+" : ""}${offset}s)`;
      } else {
        serverTimeEl.textContent =
          `${formatDateTime(getEffectiveNowMs())} (${offset >= 0 ? "+" : ""}${offset}s)`;
      }
    }

    if (weatherListEl) {
      weatherListEl.innerHTML = renderEventRows(normalEvents, "예보 없음");
    }

    if (lunarListEl) {
      lunarListEl.innerHTML = renderEventRows(lunarEvents, "희귀 날씨 예보 없음");
    }
  }

  W.MGWeatherHUD = {
    resetPosition() {
      resetHudPosition();
      console.log("[MG Weather HUD] position reset.");
    },

    clearSavedData() {
      localStorage.removeItem(SETTINGS_KEY);
      console.log("[MG Weather HUD] saved data cleared. Reloading...");
      location.reload();
    },

    getSettings() {
      const copy = {
        expanded: !!settings.expanded,
        settingsOpen: !!settings.settingsOpen,
        saveHudPosition: !!settings.saveHudPosition,
        showDataLine: !!settings.showDataLine,
        showServerTimeLine: !!settings.showServerTimeLine,
        normalListCount: getNormalListCount(),
        lunarListCount: getLunarListCount(),
        timeOffsetSec: Number(settings.timeOffsetSec) || 0,
        left: settings.left,
        top: settings.top,
      };

      console.log("[MG Weather HUD] settings:", copy);
      return copy;
    },

    setSaveHudPosition(value) {
      settings.saveHudPosition = !!value;

      const box = document.getElementById(HUD_ID);

      if (settings.saveHudPosition && box) {
        const rect = box.getBoundingClientRect();
        settings.left = Math.round(rect.left);
        settings.top = Math.round(rect.top);
      } else {
        settings.left = null;
        settings.top = null;
      }

      saveSettings();
      updateHud();
      return this.getSettings();
    },

    setShowDataLine(value) {
      settings.showDataLine = !!value;
      saveSettings();
      updateHud();
      return this.getSettings();
    },

    setShowServerTimeLine(value) {
      settings.showServerTimeLine = !!value;
      saveSettings();
      updateHud();
      return this.getSettings();
    },

    setNormalListCount(value) {
      settings.normalListCount = clampSettingNumber(
        value,
        MIN_LIST_COUNT,
        MAX_LIST_COUNT,
        DEFAULT_NORMAL_LIST_COUNT
      );

      saveSettings();
      updateHud();
      return this.getSettings();
    },

    setLunarListCount(value) {
      settings.lunarListCount = clampSettingNumber(
        value,
        MIN_LIST_COUNT,
        MAX_LIST_COUNT,
        DEFAULT_LUNAR_LIST_COUNT
      );

      saveSettings();
      updateHud();
      return this.getSettings();
    },

    setTimeOffsetSec(value) {
      const n = Number(value);
      settings.timeOffsetSec = Number.isFinite(n) ? n : 0;
      saveSettings();
      updateHud();
      return this.getSettings();
    },

    restoreDefaults() {
      settings.timeOffsetSec = 0;
      settings.normalListCount = DEFAULT_NORMAL_LIST_COUNT;
      settings.lunarListCount = DEFAULT_LUNAR_LIST_COUNT;

      saveSettings();
      updateHud();

      return this.getSettings();
    },

    getState() {
      const normalEvents = getNextNormalList(getNormalListCount());
      const lunarEvents = getNextLunarList(getLunarListCount());
      const now = getEffectiveNowMs();

      const state = {
        engineSource: QWS_NEXT_WEATHER_FORECAST.__source,
        settings: this.getSettings(),
        effectiveNowMs: now,
        effectiveNowText: new Date(now).toString(),
        gameWeatherRaw,
        gameWeatherId,
        gameWeatherDisplay:
          gameWeatherId === undefined
            ? "reading"
            : QWS_NEXT_WEATHER_FORECAST.currentName(gameWeatherId),
        gameWeatherSource,
        gameWeatherUpdatedAtClient,
        serverCurrentTimeMs,
        serverCurrentTimeReceivedAtClient,
        gameNowMs: getGameNowMs(),
        correctedGameNowMs: getCorrectedGameNowMs(),
        correctedGameNowText: new Date(getCorrectedGameNowMs()).toString(),
        nextNormalList: normalEvents,
        nextLunarList: lunarEvents,
        firstAnyEvent: normalizeEvent(QWS_NEXT_WEATHER_FORECAST.nextEvent(now)),
        firstLunarEvent: normalizeEvent(QWS_NEXT_WEATHER_FORECAST.nextLunarEvent(now)),
      };

      console.log("[MG Weather HUD] state:", state);
      return state;
    },

    forceWeather(value) {
      updateGameWeather(value, "manual");
      updateHud();
    },

    resetWeather() {
      gameWeatherRaw = undefined;
      gameWeatherId = undefined;
      gameWeatherSource = "manual reset";
      gameWeatherUpdatedAtClient = 0;
      updateHud();
    },

    engine() {
      return QWS_NEXT_WEATHER_FORECAST;
    },

    debugNext() {
      const now = getEffectiveNowMs();
      const next = QWS_NEXT_WEATHER_FORECAST.nextEvent(now);
      const lunar = QWS_NEXT_WEATHER_FORECAST.nextLunarEvent(now);

      const result = {
        now,
        nowText: new Date(now).toString(),
        timeOffsetSec: Number(settings.timeOffsetSec) || 0,
        normalListCount: getNormalListCount(),
        lunarListCount: getLunarListCount(),
        next,
        nextDisplay: next
          ? `${QWS_NEXT_WEATHER_FORECAST.displayName(next.weatherId)} ${formatRemaining(next.startsAtMs - now)}`
          : null,
        lunar,
        lunarDisplay: lunar
          ? `${QWS_NEXT_WEATHER_FORECAST.displayName(lunar.weatherId)} ${formatRemaining(lunar.startsAtMs - now)}`
          : null,
      };

      console.log("[MG Weather HUD] debugNext:", result);
      return result;
    },
  };

  function bootHud() {
    cleanupHudDomOnly();

    if (!settings.saveHudPosition) {
      settings.left = null;
      settings.top = null;
      saveSettings();
    }

    createHud();
    updateHud();

    hudUpdateTimer = setInterval(updateHud, 1000);

    window.addEventListener("resize", function () {
      const box = document.getElementById(HUD_ID);
      if (!box) return;

      reapplyCurrentHudPosition(box, false);
    });

    console.log("[MG Weather HUD KR v1.0.1 - weather-name-only colors] loaded.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootHud, { once: true });
  } else {
    bootHud();
  }
})();