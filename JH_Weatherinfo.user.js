// ==UserScript==
// @name         JH_Weatherinfo
// @namespace    MGWeatherHUD
// @version      1.1.1
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
// @connect      github.com
// @updateURL    https://raw.githubusercontent.com/JunHwan48/MGWeather_JH/main/JH_Weatherinfo.user.js
// @downloadURL  https://raw.githubusercontent.com/JunHwan48/MGWeather_JH/main/JH_Weatherinfo.user.js
// ==/UserScript==

(function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  const HUD_ID = "mg-weather-hud-jh";
  const STYLE_ID = "mg-weather-hud-jh-style";
  const SETTINGS_KEY = "mg_weather_hud_jh_v125";

  const DEFAULT_MARGIN = 14;
  const DEFAULT_NORMAL_LIST_COUNT = 5;
  const DEFAULT_LUNAR_LIST_COUNT = 3;
  const MIN_LIST_COUNT = 1;
  const MAX_LIST_COUNT = 20;
  const DEFAULT_TIME_OFFSET_SEC = 0;

  const COLLAPSE_FULL = 0;
  const COLLAPSE_SUMMARY = 1;
  const COLLAPSE_HEADER = 2;

  let gameWeatherRaw = undefined;
  let gameWeatherId = undefined;
  let gameWeatherSource = "waiting";
  let gameWeatherUpdatedAtClient = 0;

  let serverCurrentTimeMs = 0;
  let serverCurrentTimeReceivedAtClient = 0;
  let hudUpdateTimer = null;

  const settings = loadSettings();

  function normalizeCollapseMode(value) {
    const n = Number(value);
    if (n === COLLAPSE_FULL || n === COLLAPSE_SUMMARY || n === COLLAPSE_HEADER) return n;
    return COLLAPSE_FULL;
  }

  function collapseButtonIcon() {
    if (settings.collapseMode === COLLAPSE_FULL) return "▤";
    if (settings.collapseMode === COLLAPSE_SUMMARY) return "▁";
    return "▣";
  }

  function collapseButtonTitle() {
    if (settings.collapseMode === COLLAPSE_FULL) return "요약 보기";
    if (settings.collapseMode === COLLAPSE_SUMMARY) return "완전히 접기";
    return "전체 펼치기";
  }

  function applySettingsOnlyClass(box) {
    if (!box) return;
    box.classList.toggle(
      "settings-only",
      settings.collapseMode === COLLAPSE_HEADER && settings.settingsOpen
    );
  }

  function applyCollapseClass(box) {
    if (!box) return;

    box.classList.toggle("collapse-summary", settings.collapseMode === COLLAPSE_SUMMARY);
    box.classList.toggle("collapse-header", settings.collapseMode === COLLAPSE_HEADER);

    applySettingsOnlyClass(box);
  }

  const QWS_NEXT_WEATHER_FORECAST = (() => {
    const SLOT_MS = 5 * 60 * 1000;
    const SLOTS_PER_DAY = 288;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const LOOKAHEAD_DAYS = 2;

    const DEFAULT_FORECAST_CONFIG = {
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

    const FORECAST_SOURCE_URLS = [
      "https://raw.githubusercontent.com/Ariedam64/MG-AriesMod/refs/heads/main/dist/quinoa-ws.min.user.js",
      "https://raw.githubusercontent.com/Ariedam64/MG-AriesMod/main/dist/quinoa-ws.min.user.js",
      "https://github.com/Ariedam64/MG-AriesMod/raw/refs/heads/main/dist/quinoa-ws.min.user.js",
    ];

    let forecastConfig = cloneConfig(DEFAULT_FORECAST_CONFIG);
    let forecastConfigSource = "embedded fallback";
    let forecastConfigLoadedAt = 0;
    let forecastConfigError = "";
    let forecastConfigSignature = stableStringify(forecastConfig);

    const cache = new Map();

    function cloneConfig(cfg) {
      return JSON.parse(JSON.stringify(cfg));
    }

    function stableStringify(value) {
      if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

      if (value && typeof value === "object") {
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
          .join(",")}}`;
      }

      return JSON.stringify(value);
    }

    function toFiniteNumber(value, fallback) {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }

    function normalizeDropTable(table, fallback) {
      const rows = Array.isArray(table) ? table : [];
      const out = [];

      for (const row of rows) {
        if (!row || typeof row !== "object") continue;

        const weatherId = String(row.weatherId ?? "").trim();
        const weight = toFiniteNumber(row.weight, NaN);

        if (!weatherId || !Number.isFinite(weight)) continue;

        out.push({
          weatherId,
          weight: Math.max(0, weight),
        });
      }

      return out.length ? out : cloneConfig(fallback);
    }

    function normalizeForecastConfig(candidate) {
      const src = candidate && typeof candidate === "object" ? candidate : {};
      const hydro = src.hydro && typeof src.hydro === "object" ? src.hydro : {};
      const lunar = src.lunar && typeof src.lunar === "object" ? src.lunar : {};

      const normalized = {
        hydro: {
          durationMinutes: Math.max(
            5,
            toFiniteNumber(hydro.durationMinutes, DEFAULT_FORECAST_CONFIG.hydro.durationMinutes)
          ),
          minFrequencyMinutes: Math.max(
            5,
            toFiniteNumber(hydro.minFrequencyMinutes, DEFAULT_FORECAST_CONFIG.hydro.minFrequencyMinutes)
          ),
          maxFrequencyMinutes: Math.max(
            5,
            toFiniteNumber(hydro.maxFrequencyMinutes, DEFAULT_FORECAST_CONFIG.hydro.maxFrequencyMinutes)
          ),
          dropTable: normalizeDropTable(hydro.dropTable, DEFAULT_FORECAST_CONFIG.hydro.dropTable),
        },
        lunar: {
          durationMinutes: Math.max(
            5,
            toFiniteNumber(lunar.durationMinutes, DEFAULT_FORECAST_CONFIG.lunar.durationMinutes)
          ),
          fixedTimeSlots: Array.isArray(lunar.fixedTimeSlots)
            ? lunar.fixedTimeSlots
                .map((v) => Math.round(Number(v)))
                .filter((v) => Number.isFinite(v) && v >= 0 && v < SLOTS_PER_DAY)
            : cloneConfig(DEFAULT_FORECAST_CONFIG.lunar.fixedTimeSlots),
          dropTable: normalizeDropTable(lunar.dropTable, DEFAULT_FORECAST_CONFIG.lunar.dropTable),
        },
      };

      if (normalized.hydro.maxFrequencyMinutes < normalized.hydro.minFrequencyMinutes) {
        normalized.hydro.maxFrequencyMinutes = normalized.hydro.minFrequencyMinutes;
      }

      if (!normalized.lunar.fixedTimeSlots.length) {
        normalized.lunar.fixedTimeSlots = cloneConfig(DEFAULT_FORECAST_CONFIG.lunar.fixedTimeSlots);
      }

      return normalized;
    }

    function applyForecastConfig(candidate, source) {
      const normalized = normalizeForecastConfig(candidate);
      const signature = stableStringify(normalized);

      forecastConfigSource = source || forecastConfigSource;
      forecastConfigLoadedAt = Date.now();
      forecastConfigError = "";

      if (signature === forecastConfigSignature) return false;

      forecastConfig = normalized;
      forecastConfigSignature = signature;
      cache.clear();

      return true;
    }

    function gmText(url) {
      return new Promise((resolve, reject) => {
        const gm =
          typeof GM_xmlhttpRequest === "function"
            ? GM_xmlhttpRequest
            : typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function"
              ? GM.xmlHttpRequest
              : null;

        if (!gm) {
          fetch(url, { cache: "no-store" })
            .then((res) => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.text();
            })
            .then(resolve)
            .catch(reject);
          return;
        }

        gm({
          method: "GET",
          url,
          timeout: 8000,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) {
              resolve(String(res.responseText || ""));
            } else {
              reject(new Error(`HTTP ${res.status}`));
            }
          },
          onerror: () => reject(new Error("network error")),
          ontimeout: () => reject(new Error("timeout")),
        });
      });
    }

    function extractBalancedObjectLiteral(source, constName) {
      const marker = new RegExp(`\\b(?:const|let|var)\\s+${constName}\\s*=\\s*\\{`, "m");
      const match = marker.exec(source);
      if (!match) return null;

      const start = source.indexOf("{", match.index);
      let depth = 0;
      let quote = "";
      let escaped = false;

      for (let i = start; i < source.length; i++) {
        const ch = source[i];

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

        if (ch === "}") {
          depth--;
          if (depth === 0) return source.slice(start, i + 1);
        }
      }

      return null;
    }

    function parseNumberProperty(objectText, name) {
      const re = new RegExp(`\\b${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, "m");
      const match = re.exec(objectText);
      return match ? Number(match[1]) : undefined;
    }

    function parseNumberArrayProperty(objectText, name) {
      const re = new RegExp(`\\b${name}\\s*:\\s*\\[([^\\]]*)\\]`, "m");
      const match = re.exec(objectText);
      if (!match) return undefined;

      return match[1]
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isFinite(n));
    }

    function parseDropTable(objectText) {
      const re =
        /weatherId\s*:\s*["']([^"']+)["']\s*,\s*weight\s*:\s*(-?\d+(?:\.\d+)?)/g;

      const out = [];
      let match;

      while ((match = re.exec(objectText))) {
        out.push({
          weatherId: match[1],
          weight: Number(match[2]),
        });
      }

      return out.length ? out : undefined;
    }

    function parseForecastConfigFromSource(sourceText) {
      const hydroText = extractBalancedObjectLiteral(sourceText, "HYDRO");
      const lunarText = extractBalancedObjectLiteral(sourceText, "LUNAR");

      if (!hydroText && !lunarText) throw new Error("HYDRO/LUNAR block not found");

      const candidate = {
        hydro: {},
        lunar: {},
      };

      if (hydroText) {
        candidate.hydro.durationMinutes = parseNumberProperty(hydroText, "durationMinutes");
        candidate.hydro.minFrequencyMinutes = parseNumberProperty(hydroText, "minFrequencyMinutes");
        candidate.hydro.maxFrequencyMinutes = parseNumberProperty(hydroText, "maxFrequencyMinutes");
        candidate.hydro.dropTable = parseDropTable(hydroText);
      }

      if (lunarText) {
        candidate.lunar.durationMinutes = parseNumberProperty(lunarText, "durationMinutes");
        candidate.lunar.fixedTimeSlots = parseNumberArrayProperty(lunarText, "fixedTimeSlots");
        candidate.lunar.dropTable = parseDropTable(lunarText);
      }

      return normalizeForecastConfig(candidate);
    }

    async function refreshForecastConfigFromAriesMod() {
      let lastError = "";

      for (const url of FORECAST_SOURCE_URLS) {
        try {
          const text = await gmText(url);
          const parsed = parseForecastConfigFromSource(text);
          const changed = applyForecastConfig(parsed, `Arie's Mod source: ${url}`);

          console.log("[MG Weather HUD] forecast config loaded.", {
            changed,
            state: getConfigState(),
          });

          return true;
        } catch (err) {
          lastError = `${url}: ${err && err.message ? err.message : String(err)}`;
        }
      }

      forecastConfigError = lastError || "unknown error";
      forecastConfigLoadedAt = Date.now();

      console.warn(
        "[MG Weather HUD] forecast config external load failed. fallback config used.",
        forecastConfigError
      );

      return false;
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

      if (!(total > 0)) return dropTable.length ? dropTable[0].weatherId : null;

      let roll = rng() * total;

      for (const row of dropTable) {
        roll -= Number(row.weight || 0);
        if (roll <= 0) return row.weatherId;
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
      return Math.max(0, Math.min(SLOTS_PER_DAY - 1, Math.floor((ms - dayStart) / SLOT_MS)));
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
      const HYDRO = forecastConfig.hydro;
      const LUNAR = forecastConfig.lunar;

      const result = Object.create(null);
      const rng = alea(dayKey);

      const reserved = new Set();
      const lunarDuration = durationSlots(LUNAR);

      for (const fixedSlot of LUNAR.fixedTimeSlots) {
        for (let i = 0; i < lunarDuration; i++) {
          reserved.add(fixedSlot + i);
        }
      }

      const minSlots = Math.max(1, Math.floor(HYDRO.minFrequencyMinutes / 5));
      const maxSlots = Math.max(minSlots, Math.floor(HYDRO.maxFrequencyMinutes / 5));
      const hydroDuration = durationSlots(HYDRO);

      let slot = Math.floor(rng() * minSlots);

      while (slot < SLOTS_PER_DAY) {
        const weatherId = pickWeighted(HYDRO.dropTable, rng);

        let canPlace = !!weatherId && slot + hydroDuration <= SLOTS_PER_DAY;

        for (let i = 0; canPlace && i < hydroDuration; i++) {
          if (reserved.has(slot + i)) canPlace = false;
        }

        if (canPlace) {
          for (let i = 0; i < hydroDuration; i++) {
            result[slot + i] = weatherId;
          }
        }

        slot += Math.max(1, minSlots + Math.floor((maxSlots - minSlots) * rng()));
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

    function findNextList(nowMs, predicate, count) {
      const result = [];
      let cursor = nowMs;

      for (let i = 0; i < count; i++) {
        const ev = findNext(cursor, predicate);
        if (!ev) break;

        result.push(ev);
        cursor = ev.endsAtMs + 1;
      }

      return result;
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

      if (h > 0) return `${h}h ${m}m ${sec}s`;
      if (m > 0) return `${m}m ${sec}s`;
      return `${sec}s`;
    }

    function getConfigState() {
      return {
        source: forecastConfigSource,
        loadedAt: forecastConfigLoadedAt,
        loadedAtText: forecastConfigLoadedAt ? new Date(forecastConfigLoadedAt).toString() : "",
        error: forecastConfigError,
        config: cloneConfig(forecastConfig),
      };
    }

    setTimeout(() => {
      refreshForecastConfigFromAriesMod().then(() => {
        try {
          updateHud();
        } catch {}
      });
    }, 1200);

    setInterval(() => {
      refreshForecastConfigFromAriesMod().then(() => {
        try {
          updateHud();
        } catch {}
      });
    }, 30 * 60 * 1000);

    return {
      nextEvent(nowMs = Date.now()) {
        return findNext(nowMs, () => true);
      },

      nextLunarEvent(nowMs = Date.now()) {
        return findNext(nowMs, isLunar);
      },

      nextEventList(nowMs = Date.now(), count = 5) {
        return findNextList(nowMs, () => true, count);
      },

      nextLunarEventList(nowMs = Date.now(), count = 3) {
        return findNextList(nowMs, isLunar, count);
      },

      displayName,
      currentName: displayName,
      formatRemaining,
      refreshConfig: refreshForecastConfigFromAriesMod,
      getConfigState,
      __source: "embedded Arie's Mod forecast engine with dynamic HYDRO/LUNAR weights",
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

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function clampSettingNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.round(n), min), max);
  }

  function loadSettings() {
    const defaults = {
      collapseMode: COLLAPSE_FULL,
      settingsOpen: false,
      showDataLine: false,
      showServerTimeLine: false,
      normalListCount: DEFAULT_NORMAL_LIST_COUNT,
      lunarListCount: DEFAULT_LUNAR_LIST_COUNT,
      timeOffsetSec: DEFAULT_TIME_OFFSET_SEC,
      left: null,
      top: null,
    };

    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      const merged = Object.assign({}, defaults, saved);

      merged.collapseMode =
        saved.collapseMode !== undefined
          ? normalizeCollapseMode(saved.collapseMode)
          : saved.expanded === false
            ? COLLAPSE_HEADER
            : defaults.collapseMode;

      merged.settingsOpen =
        saved.settingsOpen !== undefined ? !!saved.settingsOpen : defaults.settingsOpen;

      merged.showDataLine =
        saved.showDataLine !== undefined ? !!saved.showDataLine : defaults.showDataLine;

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

      merged.left = Number.isFinite(Number(saved.left)) ? Number(saved.left) : null;
      merged.top = Number.isFinite(Number(saved.top)) ? Number(saved.top) : null;

      return merged;
    } catch {
      return defaults;
    }
  }

  function saveSettings() {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        collapseMode: normalizeCollapseMode(settings.collapseMode),
        settingsOpen: !!settings.settingsOpen,
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
        left: Number.isFinite(Number(settings.left)) ? Math.round(settings.left) : null,
        top: Number.isFinite(Number(settings.top)) ? Math.round(settings.top) : null,
      })
    );
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

    if (/^dawn$/i.test(s) || s === "던" || s === "달" || s === "새벽") return "Dawn";

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
    } catch {}
  }

  function processPatch(patch) {
    if (!patch || typeof patch.path !== "string") return;

    if (patch.path === "/child/data/weather") {
      updateGameWeather(patch.value, "Game State patch weather");
      return;
    }

    if (patch.path === "/child/data/currentTime") {
      setServerCurrentTime(Number(patch.value));
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
    if (W.__MG_WEATHER_HUD_JH_WS_INSTALLED__) return;

    const NativeWebSocket = W.WebSocket;

    if (!NativeWebSocket) {
      console.warn("[MG Weather HUD] Native WebSocket not found.");
      return;
    }

    W.__MG_WEATHER_HUD_JH_WS_INSTALLED__ = true;

    function WrappedWebSocket(...args) {
      const ws = new NativeWebSocket(...args);

      try {
        ws.addEventListener("message", function (ev) {
          handleWsMessage(ev.data);
        });
      } catch {}

      return ws;
    }

    WrappedWebSocket.prototype = NativeWebSocket.prototype;

    for (const key of Object.getOwnPropertyNames(NativeWebSocket)) {
      try {
        if (!(key in WrappedWebSocket)) {
          Object.defineProperty(
            WrappedWebSocket,
            key,
            Object.getOwnPropertyDescriptor(NativeWebSocket, key)
          );
        }
      } catch {}
    }

    W.WebSocket = WrappedWebSocket;

    console.log("[MG Weather HUD] WebSocket reader installed.");
  }

  function handleWsMessage(data) {
    try {
      if (typeof data === "string") {
        parseStringMessage(data);
        return;
      }

      if (data instanceof ArrayBuffer) {
        parseStringMessage(new TextDecoder().decode(data));
        return;
      }

      if (data instanceof Blob) {
        data.text().then(parseStringMessage).catch(() => {});
      }
    } catch {}
  }

  function parseStringMessage(text) {
    if (!text || typeof text !== "string") return;

    const trimmed = text.trim();
    if (!trimmed) return;

    try {
      processPayload(JSON.parse(trimmed));
      return;
    } catch {}

    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");

    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        processPayload(JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)));
      } catch {}
    }
  }

  installWebSocketReader();

  function formatClock(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");

    return `${hh}:${mm}:${ss}`;
  }

  function formatListTime(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");

    return `${hh}:${mm}`;
  }

  function formatRemaining(ms) {
    return QWS_NEXT_WEATHER_FORECAST.formatRemaining(ms);
  }

  function weatherClass(id) {
    if (id === "Rain") return "mg-nw-rain";
    if (id === "Frost" || id === "Snow") return "mg-nw-snow";
    if (id === "Thunderstorm") return "mg-nw-thunderstorm";
    if (id === "Dawn") return "mg-nw-dawn";
    if (id === "AmberMoon") return "mg-nw-amber";
    return "";
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

  function normalizeEvent(ev) {
    if (!ev) return null;

    return {
      id: ev.weatherId,
      name: QWS_NEXT_WEATHER_FORECAST.displayName(ev.weatherId),
      startsAtMs: ev.startsAtMs,
      endsAtMs: ev.endsAtMs,
      startsAtText: formatListTime(ev.startsAtMs),
      endsAtText: formatListTime(ev.endsAtMs),
      remainingText: formatRemaining(ev.startsAtMs - getEffectiveNowMs()),
      isLunar: isLunarId(ev.weatherId),
    };
  }

  function getNextNormalList(count) {
    return QWS_NEXT_WEATHER_FORECAST.nextEventList(getEffectiveNowMs(), count)
      .map(normalizeEvent)
      .filter(Boolean);
  }

  function getNextLunarList(count) {
    return QWS_NEXT_WEATHER_FORECAST.nextLunarEventList(getEffectiveNowMs(), count)
      .map(normalizeEvent)
      .filter(Boolean);
  }

  function getSafeHudPosition(box, desiredLeft, desiredTop) {
    const width = box.offsetWidth || 340;
    const height = box.offsetHeight || 220;

    const maxLeft = Math.max(DEFAULT_MARGIN, window.innerWidth - width - DEFAULT_MARGIN);
    const maxTop = Math.max(DEFAULT_MARGIN, window.innerHeight - height - DEFAULT_MARGIN);

    const defaultLeft = maxLeft;
    const defaultTop = DEFAULT_MARGIN;

    const left = clamp(
      Number.isFinite(desiredLeft) ? desiredLeft : defaultLeft,
      DEFAULT_MARGIN,
      maxLeft
    );

    const top = clamp(
      Number.isFinite(desiredTop) ? desiredTop : defaultTop,
      DEFAULT_MARGIN,
      maxTop
    );

    return { left, top };
  }

  function applySafeHudPosition(box, desiredLeft, desiredTop, shouldSave) {
    const pos = getSafeHudPosition(box, desiredLeft, desiredTop);

    box.style.left = `${pos.left}px`;
    box.style.top = `${pos.top}px`;
    box.style.right = "auto";
    box.style.bottom = "auto";

    if (shouldSave) {
      settings.left = Math.round(pos.left);
      settings.top = Math.round(pos.top);
      saveSettings();
    }

    return pos;
  }

  function reapplyCurrentHudPosition(box, shouldSave) {
    return applySafeHudPosition(box, settings.left, settings.top, shouldSave);
  }

  function resetHudPosition() {
    const box = document.getElementById(HUD_ID);

    settings.left = null;
    settings.top = null;
    saveSettings();

    if (box) reapplyCurrentHudPosition(box, true);
  }

  function createStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;

    style.textContent = `
      #${HUD_ID} {
        position: fixed;
        z-index: 2147483647;
        min-width: 292px;
        max-width: 430px;
        color: #f7fbff;
        background: rgba(12, 16, 24, 0.90);
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        line-height: 1.35;
        user-select: none;
        overflow: hidden;
        backdrop-filter: blur(8px);
      }

      #${HUD_ID}.dragging {
        opacity: 0.92;
      }

      #${HUD_ID}.hide-data-line #mg-nw-data-line {
        display: none;
      }

      #${HUD_ID}.hide-server-time-line #mg-nw-server-time-line {
        display: none;
      }

      #${HUD_ID}.collapse-header .mg-nw-body {
        display: none;
      }

      #${HUD_ID}.collapse-summary .mg-nw-extra {
        display: none;
      }

      #${HUD_ID}.settings-open .mg-nw-settings-panel {
        display: block;
      }

      #${HUD_ID}.collapse-header.settings-only .mg-nw-body {
        display: block;
      }

      #${HUD_ID}.settings-only .mg-nw-body > .mg-nw-line {
        display: none;
      }

      #${HUD_ID}.settings-only .mg-nw-extra > :not(.mg-nw-settings-panel) {
        display: none;
      }

      #${HUD_ID}.settings-only .mg-nw-settings-panel {
        display: block;
      }

      #${HUD_ID} .mg-nw-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 9px 10px;
        background: rgba(255, 255, 255, 0.08);
        border-bottom: 1px solid rgba(255, 255, 255, 0.13);
        cursor: move;
        touch-action: none;
      }

      #${HUD_ID} .mg-nw-title {
        font-weight: 750;
        letter-spacing: 0.2px;
      }

      #${HUD_ID} .mg-nw-buttons {
        display: flex;
        gap: 5px;
        align-items: center;
      }

      #${HUD_ID} button {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.08);
        color: #f7fbff;
        border-radius: 8px;
        padding: 2px 7px;
        min-width: 30px;
        height: 26px;
        font-size: 15px;
        line-height: 1;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      #${HUD_ID} button:hover {
        background: rgba(255, 255, 255, 0.16);
      }

      #${HUD_ID} .mg-nw-body {
        padding: 10px;
      }

      #${HUD_ID} .mg-nw-line {
        display: grid;
        grid-template-columns: 104px 1fr;
        gap: 8px;
        margin: 5px 0;
        align-items: baseline;
      }

      #${HUD_ID} .mg-nw-label {
        color: rgba(230, 240, 255, 0.72);
      }

      #${HUD_ID} .mg-nw-value {
        font-weight: 650;
        color: #ffffff;
      }

      #${HUD_ID} .mg-nw-muted {
        color: rgba(230, 240, 255, 0.66);
        font-size: 12px;
        word-break: break-all;
      }

      #${HUD_ID} .mg-nw-section-title {
        margin-top: 10px;
        padding-top: 9px;
        border-top: 1px solid rgba(255, 255, 255, 0.13);
        color: rgba(230, 240, 255, 0.74);
        font-size: 12px;
        font-weight: 700;
      }

      #${HUD_ID} .mg-nw-upcoming-row {
        display: grid;
        grid-template-columns: 34px 52px 1fr auto;
        gap: 7px;
        align-items: center;
        padding: 2px 0;
        font-size: 12px;
      }

      #${HUD_ID} .mg-nw-index {
        color: rgba(230, 240, 255, 0.55);
      }

      #${HUD_ID} .mg-nw-time {
        color: rgba(230, 240, 255, 0.78);
        font-variant-numeric: tabular-nums;
      }

      #${HUD_ID} .mg-nw-name {
        font-weight: 700;
      }

      #${HUD_ID} .mg-nw-in {
        color: rgba(230, 240, 255, 0.72);
        font-variant-numeric: tabular-nums;
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

      #${HUD_ID} .mg-nw-empty {
        color: rgba(230, 240, 255, 0.58);
        font-size: 12px;
        padding: 3px 0;
      }

      #${HUD_ID} .mg-nw-settings-panel {
        display: none;
        margin-top: 0;
        padding: 8px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.06);
      }

      #${HUD_ID}.settings-open:not(.settings-only) .mg-nw-settings-panel {
        margin-top: 9px;
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
    `;

    document.documentElement.appendChild(style);
  }

  function cleanupHudDomOnly() {
    const old = document.getElementById(HUD_ID);
    if (old) old.remove();
  }

  function createHud() {
    createStyle();

    const box = document.createElement("div");
    box.id = HUD_ID;

    applyCollapseClass(box);

    if (settings.settingsOpen) box.classList.add("settings-open");
    if (!settings.showDataLine) box.classList.add("hide-data-line");
    if (!settings.showServerTimeLine) box.classList.add("hide-server-time-line");

    box.innerHTML = `
      <div class="mg-nw-head" id="mg-nw-drag-handle" title="드래그해서 HUD 위치 이동">
        <div class="mg-nw-title">MG Weather HUD</div>
        <div class="mg-nw-buttons">
          <button id="mg-nw-settings-btn" type="button" title="설정" aria-label="설정">⚙</button>
          <button id="mg-nw-toggle-btn" type="button" title="${collapseButtonTitle()}" aria-label="${collapseButtonTitle()}">${collapseButtonIcon()}</button>
        </div>
      </div>

      <div class="mg-nw-body">
        <div class="mg-nw-line">
          <div class="mg-nw-label">현재 날씨</div>
          <div class="mg-nw-value" id="mg-nw-current">읽는 중...</div>
        </div>

        <div class="mg-nw-line">
          <div class="mg-nw-label">다음 날씨</div>
          <div class="mg-nw-value" id="mg-nw-next-weather">계산 중...</div>
        </div>

        <div class="mg-nw-line">
          <div class="mg-nw-label">다음 희귀 날씨</div>
          <div class="mg-nw-value" id="mg-nw-next-lunar">계산 중...</div>
        </div>

        <div class="mg-nw-extra">
          <div class="mg-nw-line" id="mg-nw-server-time-line">
            <div class="mg-nw-label">서버 시간</div>
            <div class="mg-nw-value" id="mg-nw-server-time">-</div>
          </div>

          <div class="mg-nw-line" id="mg-nw-data-line">
            <div class="mg-nw-label">데이터</div>
            <div class="mg-nw-muted" id="mg-nw-source">-</div>
          </div>

          <div class="mg-nw-section-title">다음 날씨</div>
          <div id="mg-nw-weather-list"></div>

          <div class="mg-nw-section-title">다음 희귀 날씨</div>
          <div id="mg-nw-lunar-list"></div>

          <div class="mg-nw-settings-panel" id="mg-nw-settings-panel">
            <div class="mg-nw-settings-title">설정</div>

            <label class="mg-nw-setting-row">
              <span>데이터 항목 표시</span>
              <input id="mg-nw-show-data" type="checkbox" ${settings.showDataLine ? "checked" : ""}>
            </label>

            <label class="mg-nw-setting-row">
              <span>서버 시간 표시</span>
              <input id="mg-nw-show-server" type="checkbox" ${settings.showServerTimeLine ? "checked" : ""}>
            </label>

            <label class="mg-nw-setting-row">
              <span>시간 보정</span>
              <span class="mg-nw-offset-wrap">
                <input id="mg-nw-time-offset" type="number" step="1" value="${Number(settings.timeOffsetSec) || 0}">초
              </span>
            </label>

            <label class="mg-nw-setting-row">
              <span>다음 날씨 개수</span>
              <input id="mg-nw-normal-count" type="number" min="${MIN_LIST_COUNT}" max="${MAX_LIST_COUNT}" step="1" value="${getNormalListCount()}">
            </label>

            <label class="mg-nw-setting-row">
              <span>다음 희귀 날씨 개수</span>
              <input id="mg-nw-lunar-count" type="number" min="${MIN_LIST_COUNT}" max="${MAX_LIST_COUNT}" step="1" value="${getLunarListCount()}">
            </label>
          </div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(box);
    reapplyCurrentHudPosition(box, false);
    wireHudEvents(box);
    applySettingsOnlyClass(box);
  }

  function wireHudEvents(box) {
    const toggleBtn = document.getElementById("mg-nw-toggle-btn");
    const settingsBtn = document.getElementById("mg-nw-settings-btn");
    const showDataInput = document.getElementById("mg-nw-show-data");
    const showServerInput = document.getElementById("mg-nw-show-server");
    const offsetInput = document.getElementById("mg-nw-time-offset");
    const normalCountInput = document.getElementById("mg-nw-normal-count");
    const lunarCountInput = document.getElementById("mg-nw-lunar-count");

    if (toggleBtn) {
      toggleBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();

        settings.collapseMode = normalizeCollapseMode(settings.collapseMode + 1);
        settings.settingsOpen = false;

        box.classList.remove("settings-open", "settings-only");

        applyCollapseClass(box);

        toggleBtn.textContent = collapseButtonIcon();
        toggleBtn.title = collapseButtonTitle();
        toggleBtn.setAttribute("aria-label", collapseButtonTitle());

        saveSettings();
        setTimeout(() => reapplyCurrentHudPosition(box, true), 0);
      });
    }

    if (settingsBtn) {
      settingsBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();

        settings.settingsOpen = !settings.settingsOpen;

        box.classList.toggle("settings-open", !!settings.settingsOpen);
        applyCollapseClass(box);
        applySettingsOnlyClass(box);

        saveSettings();
        setTimeout(() => reapplyCurrentHudPosition(box, true), 0);
      });
    }

    if (showDataInput) {
      showDataInput.addEventListener("change", () => {
        settings.showDataLine = !!showDataInput.checked;
        saveSettings();
        updateHud();
      });
    }

    if (showServerInput) {
      showServerInput.addEventListener("change", () => {
        settings.showServerTimeLine = !!showServerInput.checked;
        saveSettings();
        updateHud();
      });
    }

    if (offsetInput) {
      offsetInput.addEventListener("change", () => {
        const n = Number(offsetInput.value);

        settings.timeOffsetSec = Number.isFinite(n) ? n : 0;
        offsetInput.value = String(settings.timeOffsetSec);

        saveSettings();
        updateHud();
      });
    }

    if (normalCountInput) {
      normalCountInput.addEventListener("change", () => {
        settings.normalListCount = clampSettingNumber(
          normalCountInput.value,
          MIN_LIST_COUNT,
          MAX_LIST_COUNT,
          DEFAULT_NORMAL_LIST_COUNT
        );

        normalCountInput.value = String(settings.normalListCount);

        saveSettings();
        updateHud();
      });
    }

    if (lunarCountInput) {
      lunarCountInput.addEventListener("change", () => {
        settings.lunarListCount = clampSettingNumber(
          lunarCountInput.value,
          MIN_LIST_COUNT,
          MAX_LIST_COUNT,
          DEFAULT_LUNAR_LIST_COUNT
        );

        lunarCountInput.value = String(settings.lunarListCount);

        saveSettings();
        updateHud();
      });
    }

    installDrag(box);
  }

  function installDrag(box) {
    const handle = document.getElementById("mg-nw-drag-handle");
    if (!handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    function begin(ev) {
      const target = ev.target;

      if (target && target.closest && target.closest("button,input,label")) return;

      dragging = true;

      const point = ev.touches ? ev.touches[0] : ev;
      const rect = box.getBoundingClientRect();

      startX = point.clientX;
      startY = point.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      box.classList.add("dragging");
      ev.preventDefault();
    }

    function move(ev) {
      if (!dragging) return;

      const point = ev.touches ? ev.touches[0] : ev;

      const dx = point.clientX - startX;
      const dy = point.clientY - startY;

      applySafeHudPosition(box, startLeft + dx, startTop + dy, false);
      ev.preventDefault();
    }

    function end() {
      if (!dragging) return;

      dragging = false;
      box.classList.remove("dragging");

      const rect = box.getBoundingClientRect();
      applySafeHudPosition(box, rect.left, rect.top, true);
    }

    handle.addEventListener("mousedown", begin);
    window.addEventListener("mousemove", move, { passive: false });
    window.addEventListener("mouseup", end);

    handle.addEventListener("touchstart", begin, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
  }

  function renderEventRows(events, emptyText) {
    if (!events || !events.length) {
      return `<div class="mg-nw-empty">${escapeHtml(emptyText)}</div>`;
    }

    return events
      .map((ev, index) => {
        const cls = weatherClass(ev.id);
        const timeText = formatListTime(ev.startsAtMs);
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
    if (!box) return;

    box.classList.toggle("hide-data-line", !settings.showDataLine);
    box.classList.toggle("hide-server-time-line", !settings.showServerTimeLine);
    box.classList.toggle("settings-open", !!settings.settingsOpen);

    applyCollapseClass(box);
    applySettingsOnlyClass(box);

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
        currentEl.className = "mg-nw-value";
      } else if (gameWeatherId === null) {
        currentEl.textContent = QWS_NEXT_WEATHER_FORECAST.currentName(null);
        currentEl.className = "mg-nw-value";
      } else {
        currentEl.textContent = QWS_NEXT_WEATHER_FORECAST.currentName(gameWeatherId);
        currentEl.className = `mg-nw-value ${weatherClass(gameWeatherId)}`;
      }
    }

    if (nextWeatherEl) {
      if (nextWeather) {
        nextWeatherEl.innerHTML =
          `<span class="${weatherClass(nextWeather.id)}">` +
          `${escapeHtml(nextWeather.name)}</span> ` +
          `<span class="mg-nw-in">in ${escapeHtml(
            formatRemaining(nextWeather.startsAtMs - getEffectiveNowMs())
          )}</span>`;
      } else {
        nextWeatherEl.textContent = "예보 없음";
      }
    }

    if (nextLunarEl) {
      if (nextLunar) {
        nextLunarEl.innerHTML =
          `<span class="${weatherClass(nextLunar.id)}">` +
          `${escapeHtml(nextLunar.name)}</span> ` +
          `<span class="mg-nw-in">in ${escapeHtml(
            formatRemaining(nextLunar.startsAtMs - getEffectiveNowMs())
          )}</span>`;
      } else {
        nextLunarEl.textContent = "희귀 날씨 예보 없음";
      }
    }

    if (sourceEl) {
      const cfg = QWS_NEXT_WEATHER_FORECAST.getConfigState();
      const offset = Number(settings.timeOffsetSec) || 0;

      sourceEl.textContent =
        `Current: ${gameWeatherSource} / Future: ${cfg.source} / ` +
        `offset: ${offset >= 0 ? "+" : ""}${offset}s`;
    }

    if (serverTimeEl) {
      const offset = Number(settings.timeOffsetSec) || 0;
      const basis = serverCurrentTimeMs ? "server" : "local";

      serverTimeEl.textContent =
        `${formatClock(getCorrectedGameNowMs())} ` +
        `(${basis}, ${offset >= 0 ? "+" : ""}${offset}s)`;
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
        collapseMode: normalizeCollapseMode(settings.collapseMode),
        settingsOpen: !!settings.settingsOpen,
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

    setCollapseMode(value) {
      settings.collapseMode = normalizeCollapseMode(value);
      saveSettings();
      updateHud();
      return this.getSettings();
    },

    restoreDefaults() {
      settings.collapseMode = COLLAPSE_FULL;
      settings.settingsOpen = false;
      settings.showDataLine = false;
      settings.showServerTimeLine = false;
      settings.normalListCount = DEFAULT_NORMAL_LIST_COUNT;
      settings.lunarListCount = DEFAULT_LUNAR_LIST_COUNT;
      settings.timeOffsetSec = DEFAULT_TIME_OFFSET_SEC;

      saveSettings();
      updateHud();

      return this.getSettings();
    },

    getState() {
      const now = getEffectiveNowMs();

      const state = {
        engineSource: QWS_NEXT_WEATHER_FORECAST.__source,
        forecastConfig: QWS_NEXT_WEATHER_FORECAST.getConfigState(),
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

        nextNormalList: getNextNormalList(getNormalListCount()),
        nextLunarList: getNextLunarList(getLunarListCount()),

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

    refreshConfig() {
      return QWS_NEXT_WEATHER_FORECAST.refreshConfig().then((ok) => {
        updateHud();

        return {
          ok,
          config: QWS_NEXT_WEATHER_FORECAST.getConfigState(),
        };
      });
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
          ? `${QWS_NEXT_WEATHER_FORECAST.displayName(next.weatherId)} ${formatRemaining(
              next.startsAtMs - now
            )}`
          : null,
        lunar,
        lunarDisplay: lunar
          ? `${QWS_NEXT_WEATHER_FORECAST.displayName(lunar.weatherId)} ${formatRemaining(
              lunar.startsAtMs - now
            )}`
          : null,
        forecastConfig: QWS_NEXT_WEATHER_FORECAST.getConfigState(),
      };

      console.log("[MG Weather HUD] debugNext:", result);
      return result;
    },
  };

  function bootHud() {
    cleanupHudDomOnly();

    createHud();
    updateHud();

    if (hudUpdateTimer) clearInterval(hudUpdateTimer);
    hudUpdateTimer = setInterval(updateHud, 1000);

    window.addEventListener("resize", function () {
      const box = document.getElementById(HUD_ID);
      if (!box) return;

      reapplyCurrentHudPosition(box, true);
    });

    console.log("[MG Weather HUD KR v1.1.1] loaded.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootHud, { once: true });
  } else {
    bootHud();
  }
})();