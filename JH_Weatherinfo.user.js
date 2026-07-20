// ==UserScript==
// @name         JH_Weatherinfo
// @namespace    MGWeatherHUD
// @version      1.2.0
// @description  Arie's Mod 기반 날씨 예보 HUD
// @author       JunHwan, ChatGPT
// @match        https://magicgarden.gg/r/*
// @match        https://magiccircle.gg/r/*
// @match        https://starweaver.org/r/*
// @match        https://1227719606223765687.discordsays.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/JunHwan48/MGWeather_JH/main/JH_Weatherinfo.user.js
// @downloadURL  https://raw.githubusercontent.com/JunHwan48/MGWeather_JH/main/JH_Weatherinfo.user.js
// ==/UserScript==

(function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const HUD_ID = "mg-weather-hud-jh";
  const STYLE_ID = `${HUD_ID}-style`;
  const SETTINGS_KEY = "mg_weather_hud_jh";
  const LEGACY_KEYS = ["mg_weather_hud_jh_v125"];

  const MARGIN = 14;
  const DEFAULT_NORMAL_COUNT = 5;
  const DEFAULT_LUNAR_COUNT = 3;
  const MIN_COUNT = 1;
  const MAX_COUNT = 20;
  const STALE_MS = 3 * 60 * 1000;

  const FULL = 0;
  const SUMMARY = 1;
  const HEADER = 2;

  let gameWeatherId;
  let gameWeatherSource = "대기 중";
  let gameWeatherUpdatedAt = 0;
  let updateTimer = null;

  const $ = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatTime(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes()
    ).padStart(2, "0")}`;
  }

  function formatRemaining(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    if (h) return `${h}h ${m}m ${s}s`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatAge(ms) {
    if (!Number.isFinite(ms)) return "수신 기록 없음";

    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;

    return m ? `${m}분 ${s}초 전` : `${s}초 전`;
  }

  function dateKey(ms) {
    const d = new Date(ms);

    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function formatDateDivider(ms, now = Date.now()) {
    const d = new Date(ms);
    const today = new Date(now);

    const targetDay = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate()
    ).getTime();

    const todayStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    ).getTime();

    const diff = Math.round((targetDay - todayStart) / 86400000);
    const dateText = `${d.getMonth() + 1}월 ${d.getDate()}일`;

    if (diff === 0) return `오늘 · ${dateText}`;
    if (diff === 1) return `내일 · ${dateText}`;

    return `${dateText} ${["일", "월", "화", "수", "목", "금", "토"][d.getDay()]}요일`;
  }

  function normalizeCollapse(value) {
    const n = Number(value);
    return [FULL, SUMMARY, HEADER].includes(n) ? n : FULL;
  }

  function readSettingsText() {
    const current = localStorage.getItem(SETTINGS_KEY);
    if (current) return current;

    for (const key of LEGACY_KEYS) {
      const old = localStorage.getItem(key);
      if (!old) continue;

      localStorage.setItem(SETTINGS_KEY, old);
      localStorage.removeItem(key);
      return old;
    }

    return "{}";
  }

  function loadSettings() {
    const defaults = {
      collapseMode: FULL,
      settingsOpen: false,
      showDebug: false,
      normalListCount: DEFAULT_NORMAL_COUNT,
      lunarListCount: DEFAULT_LUNAR_COUNT,
      left: null,
      top: null,
    };

    try {
      const saved = JSON.parse(readSettingsText());

      return {
        collapseMode: normalizeCollapse(saved.collapseMode),
        settingsOpen: !!saved.settingsOpen,
        showDebug:
          saved.showDebug !== undefined
            ? !!saved.showDebug
            : !!saved.showDataLine,
        normalListCount: clampInt(
          saved.normalListCount,
          MIN_COUNT,
          MAX_COUNT,
          DEFAULT_NORMAL_COUNT
        ),
        lunarListCount: clampInt(
          saved.lunarListCount,
          MIN_COUNT,
          MAX_COUNT,
          DEFAULT_LUNAR_COUNT
        ),
        left: Number.isFinite(Number(saved.left)) ? Number(saved.left) : null,
        top: Number.isFinite(Number(saved.top)) ? Number(saved.top) : null,
      };
    } catch {
      return defaults;
    }
  }

  const settings = loadSettings();

  function saveSettings() {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        collapseMode: normalizeCollapse(settings.collapseMode),
        settingsOpen: !!settings.settingsOpen,
        showDebug: !!settings.showDebug,
        normalListCount: clampInt(
          settings.normalListCount,
          MIN_COUNT,
          MAX_COUNT,
          DEFAULT_NORMAL_COUNT
        ),
        lunarListCount: clampInt(
          settings.lunarListCount,
          MIN_COUNT,
          MAX_COUNT,
          DEFAULT_LUNAR_COUNT
        ),
        left: Number.isFinite(Number(settings.left))
          ? Math.round(settings.left)
          : null,
        top: Number.isFinite(Number(settings.top))
          ? Math.round(settings.top)
          : null,
      })
    );
  }

  const FORECAST = (() => {
    const SLOT_MS = 5 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const SLOTS_PER_DAY = 288;
    const NORMAL_LOOKAHEAD_DAYS = 2;

    const ARIES_URL =
      "https://raw.githubusercontent.com/Ariedam64/MG-AriesMod/main/dist/quinoa-ws.min.user.js";

    const DEFAULT_CONFIG = {
      hydro: {
        durationMinutes: 10,
        minFrequencyMinutes: 40,
        maxFrequencyMinutes: 60,
        dropTable: [
          { weatherId: "Rain", weight: 50 },
          { weatherId: "Frost", weight: 30 },
          { weatherId: "Thunderstorm", weight: 20 },
        ],
      },
      lunar: {
        durationMinutes: 10,
        fixedTimeSlots: [0, 48, 96, 144, 192, 240],
        dropTable: [
          { weatherId: "Dawn", weight: 67 },
          { weatherId: "AmberMoon", weight: 33 },
        ],
      },
    };

    let config = clone(DEFAULT_CONFIG);
    let source = "내장 기본값";
    const cache = new Map();

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function finite(value, fallback) {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }

    function normalizeDropTable(table, fallback) {
      const result = [];

      for (const row of Array.isArray(table) ? table : []) {
        const weatherId = String(row?.weatherId ?? "").trim();
        const weight = Number(row?.weight);

        if (!weatherId || !Number.isFinite(weight)) continue;
        result.push({ weatherId, weight: Math.max(0, weight) });
      }

      return result.length ? result : clone(fallback);
    }

    function normalizeConfig(candidate) {
      const h = candidate?.hydro || {};
      const l = candidate?.lunar || {};

      const result = {
        hydro: {
          durationMinutes: Math.max(
            5,
            finite(h.durationMinutes, DEFAULT_CONFIG.hydro.durationMinutes)
          ),
          minFrequencyMinutes: Math.max(
            5,
            finite(
              h.minFrequencyMinutes,
              DEFAULT_CONFIG.hydro.minFrequencyMinutes
            )
          ),
          maxFrequencyMinutes: Math.max(
            5,
            finite(
              h.maxFrequencyMinutes,
              DEFAULT_CONFIG.hydro.maxFrequencyMinutes
            )
          ),
          dropTable: normalizeDropTable(
            h.dropTable,
            DEFAULT_CONFIG.hydro.dropTable
          ),
        },
        lunar: {
          durationMinutes: Math.max(
            5,
            finite(l.durationMinutes, DEFAULT_CONFIG.lunar.durationMinutes)
          ),
          fixedTimeSlots: Array.isArray(l.fixedTimeSlots)
            ? l.fixedTimeSlots
                .map((v) => Math.round(Number(v)))
                .filter(
                  (v) =>
                    Number.isFinite(v) && v >= 0 && v < SLOTS_PER_DAY
                )
            : clone(DEFAULT_CONFIG.lunar.fixedTimeSlots),
          dropTable: normalizeDropTable(
            l.dropTable,
            DEFAULT_CONFIG.lunar.dropTable
          ),
        },
      };

      if (
        result.hydro.maxFrequencyMinutes <
        result.hydro.minFrequencyMinutes
      ) {
        result.hydro.maxFrequencyMinutes =
          result.hydro.minFrequencyMinutes;
      }

      if (!result.lunar.fixedTimeSlots.length) {
        result.lunar.fixedTimeSlots = clone(
          DEFAULT_CONFIG.lunar.fixedTimeSlots
        );
      }

      result.lunar.fixedTimeSlots.sort((a, b) => a - b);
      return result;
    }

    function requestText(url) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === "function") {
          GM_xmlhttpRequest({
            method: "GET",
            url,
            timeout: 8000,
            onload: (res) =>
              res.status >= 200 && res.status < 300
                ? resolve(String(res.responseText || ""))
                : reject(new Error(`HTTP ${res.status}`)),
            onerror: () => reject(new Error("network error")),
            ontimeout: () => reject(new Error("timeout")),
          });
          return;
        }

        fetch(url, { cache: "no-store" })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
          })
          .then(resolve)
          .catch(reject);
      });
    }

    function extractObject(text, name) {
      const match =
        new RegExp(
          `\\b(?:const|let|var)\\s+${name}\\s*=\\s*\\{`,
          "m"
        ).exec(text) ||
        new RegExp(`\\b${name}\\s*=\\s*\\{`, "m").exec(text);

      if (!match) return null;

      const start = text.indexOf("{", match.index);
      let depth = 0;
      let quote = "";
      let escaped = false;

      for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (quote) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === quote) quote = "";
          continue;
        }

        if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
          continue;
        }

        if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) {
          return text.slice(start, i + 1);
        }
      }

      return null;
    }

    function readNumber(text, name) {
      const match = new RegExp(
        `\\b${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`,
        "m"
      ).exec(text);

      return match ? Number(match[1]) : undefined;
    }

    function readNumberArray(text, name) {
      const match = new RegExp(
        `\\b${name}\\s*:\\s*\\[([^\\]]*)\\]`,
        "m"
      ).exec(text);

      if (!match) return undefined;

      const values = match[1]
        .split(",")
        .map((v) => Number(v.trim()))
        .filter(Number.isFinite);

      return values.length ? values : undefined;
    }

    function readDropTable(text) {
      const result = [];
      const objects = /\{([^{}]+)\}/g;
      let match;

      while ((match = objects.exec(text))) {
        const row = match[1];
        const weather =
          /\bweatherId\s*:\s*["']([^"']+)["']/.exec(row);
        const weight =
          /\bweight\s*:\s*(-?\d+(?:\.\d+)?)/.exec(row);

        if (!weather || !weight) continue;

        result.push({
          weatherId: weather[1],
          weight: Number(weight[1]),
        });
      }

      return result.length ? result : undefined;
    }

    function parseConfig(text) {
      const hydro = extractObject(text, "HYDRO");
      const lunar = extractObject(text, "LUNAR");

      if (!hydro && !lunar) {
        throw new Error("forecast config not found");
      }

      return normalizeConfig({
        hydro: hydro
          ? {
              durationMinutes: readNumber(hydro, "durationMinutes"),
              minFrequencyMinutes: readNumber(
                hydro,
                "minFrequencyMinutes"
              ),
              maxFrequencyMinutes: readNumber(
                hydro,
                "maxFrequencyMinutes"
              ),
              dropTable: readDropTable(hydro),
            }
          : {},
        lunar: lunar
          ? {
              durationMinutes: readNumber(lunar, "durationMinutes"),
              fixedTimeSlots: readNumberArray(
                lunar,
                "fixedTimeSlots"
              ),
              dropTable: readDropTable(lunar),
            }
          : {},
      });
    }

    async function loadAriesConfig() {
      try {
        config = parseConfig(await requestText(ARIES_URL));
        source = "Arie's Mod";
        cache.clear();
        updateHud();
      } catch {
        source = "내장 기본값";
      }
    }

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

    function createRandom(seed) {
      const mash = mashFactory();
      let s0 = mash(" ");
      let s1 = mash(" ");
      let s2 = mash(" ");
      let carry = 1;

      seed = String(seed);

      s0 -= mash(seed);
      if (s0 < 0) s0++;

      s1 -= mash(seed);
      if (s1 < 0) s1++;

      s2 -= mash(seed);
      if (s2 < 0) s2++;

      return function random() {
        const value =
          2091639 * s0 + carry * 2.3283064365386963e-10;

        s0 = s1;
        s1 = s2;
        s2 = value - (carry = value | 0);

        return s2;
      };
    }

    function weightedPick(table, random) {
      const total = table.reduce(
        (sum, row) => sum + Number(row.weight || 0),
        0
      );

      if (!(total > 0)) return table[0]?.weatherId || null;

      let roll = random() * total;

      for (const row of table) {
        roll -= Number(row.weight || 0);
        if (roll <= 0) return row.weatherId;
      }

      return table[table.length - 1]?.weatherId || null;
    }

    function startOfUtcDay(ms) {
      const d = new Date(ms);

      return Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate()
      );
    }

    function dayKey(ms) {
      return new Date(startOfUtcDay(ms)).toISOString().slice(0, 10);
    }

    function slotIndex(ms) {
      return clamp(
        Math.floor((ms - startOfUtcDay(ms)) / SLOT_MS),
        0,
        SLOTS_PER_DAY - 1
      );
    }

    function durationSlots(group) {
      return Math.max(1, Math.round(group.durationMinutes / 5));
    }

    function buildSchedule(key) {
      const hydro = config.hydro;
      const lunar = config.lunar;
      const schedule = Object.create(null);
      const random = createRandom(key);
      const reserved = new Set();

      const lunarDuration = durationSlots(lunar);

      for (const fixedSlot of lunar.fixedTimeSlots) {
        for (let i = 0; i < lunarDuration; i++) {
          reserved.add(fixedSlot + i);
        }
      }

      const minSlots = Math.max(
        1,
        Math.floor(hydro.minFrequencyMinutes / 5)
      );

      const maxSlots = Math.max(
        minSlots,
        Math.floor(hydro.maxFrequencyMinutes / 5)
      );

      const hydroDuration = durationSlots(hydro);
      let slot = Math.floor(random() * minSlots);

      while (slot < SLOTS_PER_DAY) {
        const weatherId = weightedPick(hydro.dropTable, random);
        let canPlace =
          !!weatherId && slot + hydroDuration <= SLOTS_PER_DAY;

        for (let i = 0; canPlace && i < hydroDuration; i++) {
          if (reserved.has(slot + i)) canPlace = false;
        }

        if (canPlace) {
          for (let i = 0; i < hydroDuration; i++) {
            schedule[slot + i] = weatherId;
          }
        }

        slot += Math.max(
          1,
          minSlots + Math.floor((maxSlots - minSlots) * random())
        );
      }

      for (const fixedSlot of lunar.fixedTimeSlots) {
        const weatherId = weightedPick(lunar.dropTable, random);
        if (!weatherId) continue;

        for (let i = 0; i < lunarDuration; i++) {
          schedule[fixedSlot + i] = weatherId;
        }
      }

      return schedule;
    }

    function scheduleForDay(key) {
      if (cache.has(key)) return cache.get(key);

      const schedule = buildSchedule(key);
      cache.set(key, schedule);

      while (cache.size > 6) {
        cache.delete(cache.keys().next().value);
      }

      return schedule;
    }

    function firstSlot(schedule, slot, weatherId) {
      while (slot > 0 && schedule[slot - 1] === weatherId) slot--;
      return slot;
    }

    function lastSlot(schedule, slot, weatherId) {
      while (
        slot < SLOTS_PER_DAY - 1 &&
        schedule[slot + 1] === weatherId
      ) {
        slot++;
      }

      return slot;
    }

    function currentEvent(now) {
      const dayStart = startOfUtcDay(now);
      const schedule = scheduleForDay(dayKey(now));
      const slot = slotIndex(now);
      const weatherId = schedule[slot] || null;

      if (!weatherId) {
        const next = nextEvent(now);

        return {
          weatherId: null,
          startsAtMs: null,
          endsAtMs: next?.startsAtMs ?? null,
        };
      }

      const start = firstSlot(schedule, slot, weatherId);
      const end = lastSlot(schedule, slot, weatherId);

      return {
        weatherId,
        startsAtMs: dayStart + start * SLOT_MS,
        endsAtMs: dayStart + (end + 1) * SLOT_MS,
      };
    }

    function nextEvent(now) {
      const todayStart = startOfUtcDay(now);
      const todaySchedule = scheduleForDay(dayKey(now));
      const currentSlot = slotIndex(now);
      const currentWeather = todaySchedule[currentSlot] || null;

      const firstSearchSlot = currentWeather
        ? lastSlot(todaySchedule, currentSlot, currentWeather) + 1
        : currentSlot + 1;

      for (
        let dayOffset = 0;
        dayOffset < NORMAL_LOOKAHEAD_DAYS;
        dayOffset++
      ) {
        const dayStart = todayStart + dayOffset * DAY_MS;
        const key = new Date(dayStart).toISOString().slice(0, 10);
        const schedule = scheduleForDay(key);
        const start = dayOffset === 0 ? firstSearchSlot : 0;

        for (let slot = start; slot < SLOTS_PER_DAY; slot++) {
          const weatherId = schedule[slot];
          if (!weatherId) continue;

          const end = lastSlot(schedule, slot, weatherId);

          return {
            weatherId,
            startsAtMs: dayStart + slot * SLOT_MS,
            endsAtMs: dayStart + (end + 1) * SLOT_MS,
          };
        }
      }

      return null;
    }

    function nextEventList(now, count) {
      const result = [];
      let cursor = now;

      while (result.length < count) {
        const event = nextEvent(cursor);
        if (!event) break;

        result.push(event);
        cursor = event.endsAtMs + 1;
      }

      return result;
    }

    function nextLunarEventList(now, count) {
      const result = [];
      const todayStart = startOfUtcDay(now);
      const slotsPerDay = Math.max(
        1,
        config.lunar.fixedTimeSlots.length
      );

      const lookaheadDays = Math.max(
        2,
        Math.ceil(count / slotsPerDay) + 1
      );

      const durationMs = durationSlots(config.lunar) * SLOT_MS;

      for (
        let dayOffset = 0;
        dayOffset < lookaheadDays && result.length < count;
        dayOffset++
      ) {
        const dayStart = todayStart + dayOffset * DAY_MS;
        const key = new Date(dayStart).toISOString().slice(0, 10);
        const schedule = scheduleForDay(key);

        for (const slot of config.lunar.fixedTimeSlots) {
          const startsAtMs = dayStart + slot * SLOT_MS;

          if (startsAtMs <= now) continue;

          const weatherId = schedule[slot];
          if (!weatherId) continue;

          result.push({
            weatherId,
            startsAtMs,
            endsAtMs: startsAtMs + durationMs,
          });

          if (result.length >= count) break;
        }
      }

      return result;
    }

    function displayName(value) {
      const raw = String(value ?? "").trim();
      const key = raw.toLowerCase().replace(/\s+/g, "");

      if (!key || key === "sunny" || key === "clearskies") {
        return "Clear Skies";
      }

      if (key === "frost" || key === "snow") return "Snow";
      if (key === "ambermoon" || key === "harvestmoon") {
        return "Amber Moon";
      }

      if (key === "rain") return "Rain";
      if (key === "thunderstorm" || key === "thunder") {
        return "Thunderstorm";
      }

      if (key === "dawn") return "Dawn";
      return raw || "Clear Skies";
    }

    setTimeout(loadAriesConfig, 1200);

    return {
      currentEvent,
      nextEventList,
      nextLunarEventList,
      displayName,
      getSource: () => source,
    };
  })();

  function weatherStatus() {
    if (!gameWeatherUpdatedAt) {
      return { state: "WAITING", stale: false, ageMs: null };
    }

    const ageMs = Math.max(0, Date.now() - gameWeatherUpdatedAt);
    const stale = ageMs >= STALE_MS;

    return {
      state: stale ? "STALE" : "LIVE",
      stale,
      ageMs,
    };
  }

  function currentRemainingMs() {
    if (gameWeatherId === undefined || weatherStatus().stale) {
      return null;
    }

    const now = Date.now();
    const current = FORECAST.currentEvent(now);

    if (!Number.isFinite(Number(current?.endsAtMs))) return null;

    if ((current.weatherId ?? null) !== (gameWeatherId ?? null)) {
      return null;
    }

    return Math.max(0, current.endsAtMs - now);
  }

  function normalizeGameWeather(value) {
    if (value == null || value === "" || value === false) return null;

    if (typeof value === "object") {
      for (const candidate of [
        value.weatherId,
        value.id,
        value.weather,
        value.name,
        value.type,
        value.value,
      ]) {
        const normalized = normalizeGameWeather(candidate);
        if (normalized !== undefined) return normalized;
      }

      return undefined;
    }

    const text = String(value).trim();
    if (!text) return null;

    if (
      /^clear$/i.test(text) ||
      /^clear\s*skies$/i.test(text) ||
      /^sunny$/i.test(text) ||
      /맑은\s*하늘/.test(text)
    ) {
      return null;
    }

    if (/^rain$/i.test(text) || text === "비") return "Rain";

    if (
      /^frost$/i.test(text) ||
      /^snow$/i.test(text) ||
      text === "눈" ||
      text === "서리"
    ) {
      return "Frost";
    }

    if (
      /^thunder\s*storm$/i.test(text) ||
      /^thunderstorm$/i.test(text) ||
      text === "뇌우"
    ) {
      return "Thunderstorm";
    }

    if (
      /^dawn$/i.test(text) ||
      text === "던" ||
      text === "달" ||
      text === "새벽"
    ) {
      return "Dawn";
    }

    if (
      /^amber\s*moon$/i.test(text) ||
      /^ambermoon$/i.test(text) ||
      /^harvest\s*moon$/i.test(text) ||
      text === "엠버문"
    ) {
      return "AmberMoon";
    }

    if (
      /partialstate|partial state|thunderstruck|dawnlit|amberlit|ambershine|raindance|wet|chilled|frozen|gold|rainbow|seedfinder|snowdrop|granter|charged|bound/i.test(
        text
      )
    ) {
      return undefined;
    }

    return undefined;
  }

  function updateGameWeather(raw, source) {
    const normalized = normalizeGameWeather(raw);
    if (normalized === undefined) return;

    gameWeatherId = normalized;
    gameWeatherSource = source || "게임 상태";
    gameWeatherUpdatedAt = Date.now();

    updateHud();
  }

  function processFullState(state) {
    try {
      const data = state?.child?.data;

      if (
        data &&
        Object.prototype.hasOwnProperty.call(data, "weather")
      ) {
        updateGameWeather(data.weather, "전체 상태");
      }
    } catch {}
  }

  function processPayload(payload) {
    if (!payload || typeof payload !== "object") return;

    if (payload.fullState) processFullState(payload.fullState);
    if (payload.child?.data) processFullState(payload);

    if (Array.isArray(payload.patches)) {
      for (const patch of payload.patches) {
        if (patch?.path === "/child/data/weather") {
          updateGameWeather(patch.value, "날씨 변경 패치");
        }
      }
    }
  }

  function parseMessage(text) {
    if (!text || typeof text !== "string") return;

    const trimmed = text.trim();
    if (!trimmed) return;

    try {
      processPayload(JSON.parse(trimmed));
      return;
    } catch {}

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start < 0 || end <= start) return;

    try {
      processPayload(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {}
  }

  function handleSocketData(data) {
    try {
      if (typeof data === "string") {
        parseMessage(data);
      } else if (data instanceof ArrayBuffer) {
        parseMessage(new TextDecoder().decode(data));
      } else if (data instanceof Blob) {
        data.text().then(parseMessage).catch(() => {});
      }
    } catch {}
  }

  function installWebSocketReader() {
    if (W.__MG_WEATHER_HUD_JH_WS_INSTALLED__) return;

    const NativeWebSocket = W.WebSocket;
    if (!NativeWebSocket) return;

    W.__MG_WEATHER_HUD_JH_WS_INSTALLED__ = true;

    function WrappedWebSocket(...args) {
      const socket = new NativeWebSocket(...args);

      try {
        socket.addEventListener("message", (event) =>
          handleSocketData(event.data)
        );
      } catch {}

      return socket;
    }

    WrappedWebSocket.prototype = NativeWebSocket.prototype;

    for (const property of Object.getOwnPropertyNames(NativeWebSocket)) {
      try {
        if (!(property in WrappedWebSocket)) {
          Object.defineProperty(
            WrappedWebSocket,
            property,
            Object.getOwnPropertyDescriptor(
              NativeWebSocket,
              property
            )
          );
        }
      } catch {}
    }

    W.WebSocket = WrappedWebSocket;
  }

  installWebSocketReader();

  function nextCollapseMode() {
    if (settings.collapseMode === FULL) return HEADER;
    if (settings.collapseMode === HEADER) return SUMMARY;
    return FULL;
  }

  function collapseIcon() {
    if (settings.collapseMode === FULL) return "▤";
    if (settings.collapseMode === HEADER) return "▣";
    return "▁";
  }

  function collapseTitle() {
    if (settings.collapseMode === FULL) return "완전히 접기";
    if (settings.collapseMode === HEADER) return "요약 보기";
    return "전체 펼치기";
  }

  function applyHudState(box) {
    if (!box) return;

    box.classList.toggle(
      "collapse-summary",
      settings.collapseMode === SUMMARY
    );

    box.classList.toggle(
      "collapse-header",
      settings.collapseMode === HEADER
    );

    box.classList.toggle("settings-open", settings.settingsOpen);
    box.classList.toggle("hide-debug", !settings.showDebug);
  }

  function safePosition(box, desiredLeft, desiredTop) {
    const width = box.offsetWidth || 340;
    const height = box.offsetHeight || 220;

    const maxLeft = Math.max(
      MARGIN,
      window.innerWidth - width - MARGIN
    );

    const maxTop = Math.max(
      MARGIN,
      window.innerHeight - height - MARGIN
    );

    return {
      left: clamp(
        Number.isFinite(desiredLeft) ? desiredLeft : maxLeft,
        MARGIN,
        maxLeft
      ),
      top: clamp(
        Number.isFinite(desiredTop) ? desiredTop : MARGIN,
        MARGIN,
        maxTop
      ),
    };
  }

  function applyPosition(box, left, top, save) {
    const position = safePosition(box, left, top);

    box.style.left = `${position.left}px`;
    box.style.top = `${position.top}px`;
    box.style.right = "auto";
    box.style.bottom = "auto";

    if (!save) return;

    settings.left = Math.round(position.left);
    settings.top = Math.round(position.top);
    saveSettings();
  }

  function reapplyPosition(box, save) {
    applyPosition(box, settings.left, settings.top, save);
  }

  function installDrag(box) {
    const handle = $("mg-nw-drag-handle");
    if (!handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    function begin(event) {
      if (event.target?.closest?.("button,input,label")) return;

      const point = event.touches ? event.touches[0] : event;
      const rect = box.getBoundingClientRect();

      dragging = true;
      startX = point.clientX;
      startY = point.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      box.classList.add("dragging");
      event.preventDefault();
    }

    function move(event) {
      if (!dragging) return;

      const point = event.touches ? event.touches[0] : event;

      applyPosition(
        box,
        startLeft + point.clientX - startX,
        startTop + point.clientY - startY,
        false
      );

      event.preventDefault();
    }

    function end() {
      if (!dragging) return;

      dragging = false;
      box.classList.remove("dragging");

      const rect = box.getBoundingClientRect();
      applyPosition(box, rect.left, rect.top, true);
    }

    handle.addEventListener("mousedown", begin);
    handle.addEventListener("touchstart", begin, { passive: false });

    window.addEventListener("mousemove", move, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });

    window.addEventListener("mouseup", end);
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
  }

  function createStyle() {
    if ($(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;

    style.textContent = `
#${HUD_ID}{position:fixed;z-index:2147483647;min-width:292px;max-width:430px;color:#f7fbff;background:rgba(12,16,24,.9);border:1px solid rgba(255,255,255,.18);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.35;user-select:none;overflow:hidden;backdrop-filter:blur(8px)}
#${HUD_ID}.dragging{opacity:.92}
#${HUD_ID}.hide-debug #mg-nw-debug,#${HUD_ID}.collapse-header .mg-nw-body,#${HUD_ID}.collapse-summary .mg-nw-extra{display:none}
#${HUD_ID}.settings-open .mg-nw-settings-panel,#${HUD_ID}.collapse-summary.settings-open .mg-nw-extra,#${HUD_ID}.collapse-header.settings-open .mg-nw-body,#${HUD_ID}.collapse-header.settings-open .mg-nw-extra{display:block}
#${HUD_ID}.collapse-summary.settings-open .mg-nw-extra>:not(.mg-nw-settings-panel),#${HUD_ID}.collapse-header.settings-open .mg-nw-body>.mg-nw-line,#${HUD_ID}.collapse-header.settings-open .mg-nw-extra>:not(.mg-nw-settings-panel){display:none}
#${HUD_ID} .mg-nw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;background:rgba(255,255,255,.08);border-bottom:1px solid rgba(255,255,255,.13);cursor:move;touch-action:none}
#${HUD_ID} .mg-nw-title{font-weight:750;letter-spacing:.2px}
#${HUD_ID} .mg-nw-buttons{display:flex;gap:5px;align-items:center}
#${HUD_ID} button{appearance:none;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#f7fbff;border-radius:8px;padding:2px 7px;min-width:30px;height:26px;font-size:15px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
#${HUD_ID} button:hover{background:rgba(255,255,255,.16)}
#${HUD_ID} .mg-nw-body{padding:10px}
#${HUD_ID} .mg-nw-line{display:grid;grid-template-columns:104px 1fr;gap:8px;margin:5px 0;align-items:baseline}
#${HUD_ID} .mg-nw-label{color:rgba(230,240,255,.72)}
#${HUD_ID} .mg-nw-value{color:#fff;font-weight:650}
#${HUD_ID} .mg-nw-section-title{margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.13);color:rgba(230,240,255,.74);font-size:12px;font-weight:700}
#${HUD_ID} .mg-nw-date-divider{margin:7px 0 3px;padding:3px 6px;border-radius:6px;background:rgba(255,255,255,.07);color:rgba(235,243,255,.82);font-size:11px;font-weight:700}
#${HUD_ID} .mg-nw-upcoming-row{display:grid;grid-template-columns:34px 52px 1fr auto;gap:7px;align-items:center;padding:2px 0;font-size:12px}
#${HUD_ID} .mg-nw-index{color:rgba(230,240,255,.55)}
#${HUD_ID} .mg-nw-time,#${HUD_ID} .mg-nw-in{color:rgba(230,240,255,.75);font-variant-numeric:tabular-nums}
#${HUD_ID} .mg-nw-name{color:#fff;font-weight:700}
#${HUD_ID} .mg-nw-rain{color:#7ec8ff;font-weight:700}
#${HUD_ID} .mg-nw-snow{color:#fff;font-weight:700}
#${HUD_ID} .mg-nw-thunderstorm{color:#fff0a8;font-weight:700}
#${HUD_ID} .mg-nw-dawn{color:#d3b4ff;font-weight:700}
#${HUD_ID} .mg-nw-amber{color:#ffbf5f;font-weight:700}
#${HUD_ID} .mg-nw-empty{color:rgba(230,240,255,.58);font-size:12px;padding:3px 0}
#${HUD_ID} .mg-nw-debug{margin-top:10px;padding:8px;border:1px solid rgba(255,255,255,.12);border-radius:9px;background:rgba(0,0,0,.18);font-size:12px}
#${HUD_ID} .mg-nw-debug-title{margin-bottom:6px;color:rgba(230,240,255,.78);font-weight:700}
#${HUD_ID} .mg-nw-debug-row{display:grid;grid-template-columns:82px 1fr;gap:8px;margin:3px 0}
#${HUD_ID} .mg-nw-debug-key{color:rgba(230,240,255,.58)}
#${HUD_ID} .mg-nw-debug-value{color:rgba(245,249,255,.9);word-break:break-word}
#${HUD_ID} .mg-nw-debug-live{color:#8ff0ad;font-weight:700}
#${HUD_ID} .mg-nw-debug-stale{color:#ffb36b;font-weight:700}
#${HUD_ID} .mg-nw-debug-waiting{color:#ffd86b;font-weight:700}
#${HUD_ID} .mg-nw-settings-panel{display:none;margin-top:9px;padding:8px;border:1px solid rgba(255,255,255,.14);border-radius:10px;background:rgba(255,255,255,.06)}
#${HUD_ID}.collapse-header.settings-open .mg-nw-settings-panel{margin-top:0}
#${HUD_ID} .mg-nw-settings-title{margin-bottom:6px;font-size:12px;font-weight:700}
#${HUD_ID} .mg-nw-setting-row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:6px 0}
#${HUD_ID} input[type=number]{width:76px;border:1px solid rgba(255,255,255,.22);border-radius:7px;background:rgba(0,0,0,.28);color:#fff;padding:3px 6px;font-size:12px}
#${HUD_ID} input[type=checkbox]{transform:scale(1.05)}
`;

    document.documentElement.appendChild(style);
  }

  function createHud() {
    createStyle();
    $(HUD_ID)?.remove();

    const box = document.createElement("div");
    box.id = HUD_ID;

    box.innerHTML = `
<div class="mg-nw-head" id="mg-nw-drag-handle" title="드래그해서 HUD 위치 이동">
  <div class="mg-nw-title">MG Weather</div>
  <div class="mg-nw-buttons">
    <button id="mg-nw-settings-btn" type="button" title="설정" aria-label="설정">⚙</button>
    <button id="mg-nw-toggle-btn" type="button" title="${collapseTitle()}" aria-label="${collapseTitle()}">${collapseIcon()}</button>
  </div>
</div>
<div class="mg-nw-body">
  <div class="mg-nw-line"><div class="mg-nw-label">현재 날씨</div><div class="mg-nw-value" id="mg-nw-current">읽는 중...</div></div>
  <div class="mg-nw-line"><div class="mg-nw-label">다음 날씨</div><div class="mg-nw-value" id="mg-nw-next-weather">계산 중...</div></div>
  <div class="mg-nw-line"><div class="mg-nw-label">다음 희귀 날씨</div><div class="mg-nw-value" id="mg-nw-next-lunar">계산 중...</div></div>

  <div class="mg-nw-extra">
    <div class="mg-nw-section-title">다음 날씨</div>
    <div id="mg-nw-weather-list"></div>

    <div class="mg-nw-section-title">다음 희귀 날씨</div>
    <div id="mg-nw-lunar-list"></div>

    <div class="mg-nw-debug" id="mg-nw-debug">
      <div class="mg-nw-debug-title">디버그</div>
      <div class="mg-nw-debug-row"><div class="mg-nw-debug-key">상태</div><div class="mg-nw-debug-value" id="mg-nw-debug-status">-</div></div>
      <div class="mg-nw-debug-row"><div class="mg-nw-debug-key">마지막 수신</div><div class="mg-nw-debug-value" id="mg-nw-debug-age">-</div></div>
      <div class="mg-nw-debug-row"><div class="mg-nw-debug-key">날씨 출처</div><div class="mg-nw-debug-value" id="mg-nw-debug-current-source">-</div></div>
      <div class="mg-nw-debug-row"><div class="mg-nw-debug-key">예보 출처</div><div class="mg-nw-debug-value" id="mg-nw-debug-forecast-source">-</div></div>
    </div>

    <div class="mg-nw-settings-panel">
      <div class="mg-nw-settings-title">설정</div>
      <label class="mg-nw-setting-row"><span>디버그 표시</span><input id="mg-nw-show-debug" type="checkbox" ${settings.showDebug ? "checked" : ""}></label>
      <label class="mg-nw-setting-row"><span>다음 날씨 개수</span><input id="mg-nw-normal-count" type="number" min="${MIN_COUNT}" max="${MAX_COUNT}" value="${settings.normalListCount}"></label>
      <label class="mg-nw-setting-row"><span>다음 희귀 날씨 개수</span><input id="mg-nw-lunar-count" type="number" min="${MIN_COUNT}" max="${MAX_COUNT}" value="${settings.lunarListCount}"></label>
    </div>
  </div>
</div>`;

    document.documentElement.appendChild(box);

    applyHudState(box);
    reapplyPosition(box, false);
    wireHudEvents(box);
    installDrag(box);
  }

  function wireHudEvents(box) {
    const toggle = $("mg-nw-toggle-btn");
    const settingsButton = $("mg-nw-settings-btn");
    const debugInput = $("mg-nw-show-debug");
    const normalInput = $("mg-nw-normal-count");
    const lunarInput = $("mg-nw-lunar-count");

    toggle?.addEventListener("click", (event) => {
      event.stopPropagation();

      settings.collapseMode = nextCollapseMode();
      settings.settingsOpen = false;

      applyHudState(box);

      toggle.textContent = collapseIcon();
      toggle.title = collapseTitle();
      toggle.setAttribute("aria-label", collapseTitle());

      saveSettings();
      setTimeout(() => reapplyPosition(box, true), 0);
    });

    settingsButton?.addEventListener("click", (event) => {
      event.stopPropagation();

      settings.settingsOpen = !settings.settingsOpen;
      applyHudState(box);
      saveSettings();

      setTimeout(() => reapplyPosition(box, true), 0);
    });

    debugInput?.addEventListener("change", () => {
      settings.showDebug = debugInput.checked;
      saveSettings();
      updateHud();
    });

    normalInput?.addEventListener("change", () => {
      settings.normalListCount = clampInt(
        normalInput.value,
        MIN_COUNT,
        MAX_COUNT,
        DEFAULT_NORMAL_COUNT
      );

      normalInput.value = settings.normalListCount;
      saveSettings();
      updateHud();
    });

    lunarInput?.addEventListener("change", () => {
      settings.lunarListCount = clampInt(
        lunarInput.value,
        MIN_COUNT,
        MAX_COUNT,
        DEFAULT_LUNAR_COUNT
      );

      lunarInput.value = settings.lunarListCount;
      saveSettings();
      updateHud();
    });
  }

  function weatherClass(id) {
    return id === "Rain"
      ? "mg-nw-rain"
      : id === "Frost" || id === "Snow"
        ? "mg-nw-snow"
        : id === "Thunderstorm"
          ? "mg-nw-thunderstorm"
          : id === "Dawn"
            ? "mg-nw-dawn"
            : id === "AmberMoon"
              ? "mg-nw-amber"
              : "";
  }

  function normalizeEvent(event) {
    return event
      ? {
          id: event.weatherId,
          name: FORECAST.displayName(event.weatherId),
          startsAtMs: event.startsAtMs,
          endsAtMs: event.endsAtMs,
        }
      : null;
  }

  function getNormalEvents() {
    return FORECAST.nextEventList(
      Date.now(),
      settings.normalListCount
    )
      .map(normalizeEvent)
      .filter(Boolean);
  }

  function getLunarEvents() {
    return FORECAST.nextLunarEventList(
      Date.now(),
      settings.lunarListCount
    )
      .map(normalizeEvent)
      .filter(Boolean);
  }

  function renderRows(events, emptyText) {
    if (!events.length) {
      return `<div class="mg-nw-empty">${escapeHtml(emptyText)}</div>`;
    }

    const now = Date.now();
    let previousDate = dateKey(events[0].startsAtMs);

    return events
      .map((event, index) => {
        const currentDate = dateKey(event.startsAtMs);

        const divider =
          index > 0 && currentDate !== previousDate
            ? `<div class="mg-nw-date-divider">${escapeHtml(
                formatDateDivider(event.startsAtMs, now)
              )}</div>`
            : "";

        previousDate = currentDate;

        return `${divider}<div class="mg-nw-upcoming-row">
<span class="mg-nw-index">#${index + 1}</span>
<span class="mg-nw-time">${formatTime(event.startsAtMs)}</span>
<span class="mg-nw-name ${weatherClass(event.id)}">${escapeHtml(event.name)}</span>
<span class="mg-nw-in">${formatRemaining(event.startsAtMs - now)}</span>
</div>`;
      })
      .join("");
  }

  function updateHud() {
    const box = $(HUD_ID);
    if (!box) return;

    applyHudState(box);

    const normalEvents = getNormalEvents();
    const lunarEvents = getLunarEvents();

    const nextWeather = normalEvents[0];
    const nextLunar = lunarEvents[0];

    const current = $("mg-nw-current");

    if (current) {
      if (gameWeatherId === undefined) {
        current.textContent = "읽는 중...";
      } else {
        const name = FORECAST.displayName(gameWeatherId);
        const remaining = currentRemainingMs();

        const remainingHtml =
          remaining === null
            ? ""
            : ` <span class="mg-nw-in">in ${formatRemaining(
                remaining
              )}</span>`;

        current.innerHTML =
          gameWeatherId === null
            ? `<span>${escapeHtml(name)}</span>${remainingHtml}`
            : `<span class="${weatherClass(gameWeatherId)}">${escapeHtml(
                name
              )}</span>${remainingHtml}`;
      }
    }

    const nextWeatherElement = $("mg-nw-next-weather");

    if (nextWeatherElement) {
      nextWeatherElement.innerHTML = nextWeather
        ? `<span class="${weatherClass(nextWeather.id)}">${escapeHtml(
            nextWeather.name
          )}</span> <span class="mg-nw-in">in ${formatRemaining(
            nextWeather.startsAtMs - Date.now()
          )}</span>`
        : "예보 없음";
    }

    const nextLunarElement = $("mg-nw-next-lunar");

    if (nextLunarElement) {
      nextLunarElement.innerHTML = nextLunar
        ? `<span class="${weatherClass(nextLunar.id)}">${escapeHtml(
            nextLunar.name
          )}</span> <span class="mg-nw-in">in ${formatRemaining(
            nextLunar.startsAtMs - Date.now()
          )}</span>`
        : "희귀 날씨 예보 없음";
    }

    const weatherList = $("mg-nw-weather-list");
    const lunarList = $("mg-nw-lunar-list");

    if (weatherList) {
      weatherList.innerHTML = renderRows(normalEvents, "예보 없음");
    }

    if (lunarList) {
      lunarList.innerHTML = renderRows(
        lunarEvents,
        "희귀 날씨 예보 없음"
      );
    }

    const status = weatherStatus();
    const statusElement = $("mg-nw-debug-status");

    if (statusElement) {
      statusElement.textContent = status.state;
      statusElement.className =
        "mg-nw-debug-value " +
        (status.state === "LIVE"
          ? "mg-nw-debug-live"
          : status.state === "STALE"
            ? "mg-nw-debug-stale"
            : "mg-nw-debug-waiting");
    }

    const ageElement = $("mg-nw-debug-age");
    const currentSource = $("mg-nw-debug-current-source");
    const forecastSource = $("mg-nw-debug-forecast-source");

    if (ageElement) ageElement.textContent = formatAge(status.ageMs);
    if (currentSource) currentSource.textContent = gameWeatherSource;
    if (forecastSource) forecastSource.textContent = FORECAST.getSource();
  }

  function boot() {
    createHud();
    updateHud();

    if (updateTimer) clearInterval(updateTimer);
    updateTimer = setInterval(updateHud, 1000);

    window.addEventListener("resize", () => {
      const box = $(HUD_ID);
      if (box) reapplyPosition(box, true);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();