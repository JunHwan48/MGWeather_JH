// ==UserScript==
// @name         JH_Weatherinfo
// @namespace    MGWeatherHUD
// @version      2.2
// @description  독립형 날씨 예보 HUD
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
    if (W.__MG_WEATHER_HUD_JH_RUNNING__) {
        return;
    }
    W.__MG_WEATHER_HUD_JH_RUNNING__ = true;
    const HUD_ID = "mg-weather-hud-jh";
    const STYLE_ID = `${HUD_ID}-style`;
    const SETTINGS_KEY = "mg_weather_hud_jh";
    const TEST_KEY = "mg_weather_hud_jh_forecast_test";
    const MARGIN = 14;
    const DEFAULT_NORMAL_COUNT = 5;
    const DEFAULT_LUNAR_COUNT = 3;
    const MIN_COUNT = 1;
    const MAX_COUNT = 20;
    const STALE_MS = 3 * 60 * 1000;
    const DEFAULT_OPACITY = 90;
    const FULL = 0;
    const SUMMARY = 1;
    const HEADER = 2;
    let gameWeatherId;
    let gameWeatherSource = "대기 중";
    let gameWeatherUpdatedAt = 0;
    let serverTimeMs = 0;
    let serverTimeReceivedAt = 0;
    let lastTestedWeather;
    function loadTestData() {
        try {
            const saved = JSON.parse(localStorage.getItem(TEST_KEY) || "{}");
            return {
                total: Math.max(0, Number(saved.total) || 0),
                matched: Math.max(0, Number(saved.matched) || 0),
                records: Array.isArray(saved.records) ? saved.records.slice(-100) : [],
            };
        }
        catch {
            return { total: 0, matched: 0, records: [] };
        }
    }
    const forecastTest = loadTestData();
    function saveTestData() {
        try {
            localStorage.setItem(TEST_KEY, JSON.stringify({
                total: forecastTest.total,
                matched: forecastTest.matched,
                records: forecastTest.records.slice(-100),
            }));
            return true;
        }
        catch {
            return false;
        }
    }
    const $ = (id) => document.getElementById(id);
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    function clampInt(value, min, max, fallback) {
        const number = Math.round(Number(value));
        return Number.isFinite(number)
            ? clamp(number, min, max)
            : fallback;
    }
    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
    function gameNow() {
        if (serverTimeMs && serverTimeReceivedAt) {
            return serverTimeMs + (Date.now() - serverTimeReceivedAt);
        }
        return Date.now();
    }
    function updateServerTime(value) {
        const ms = Number(value);
        if (!Number.isFinite(ms)) {
            return;
        }
        serverTimeMs = ms;
        serverTimeReceivedAt = Date.now();
    }
    function formatTime(ms) {
        const date = new Date(ms);
        return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
    function formatRemaining(ms) {
        if (!Number.isFinite(ms)) {
            return "--";
        }
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) {
            return (String(hours) +
                "h " +
                String(minutes).padStart(2, "0") +
                "m " +
                String(seconds).padStart(2, "0") +
                "s");
        }
        if (minutes > 0) {
            return (String(minutes) +
                "m " +
                String(seconds).padStart(2, "0") +
                "s");
        }
        return String(seconds) + "s";
    }
    function formatAge(ms) {
        if (!Number.isFinite(ms)) {
            return "수신 기록 없음";
        }
        const total = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return minutes
            ? `${minutes}분 ${seconds}초 전`
            : `${seconds}초 전`;
    }
    function dateKey(ms) {
        const date = new Date(ms);
        return [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, "0"),
            String(date.getDate()).padStart(2, "0"),
        ].join("-");
    }
    function formatDateDivider(ms, now = gameNow()) {
        const date = new Date(ms);
        const current = new Date(now);
        const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const currentDay = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
        const difference = Math.round((targetDay - currentDay) / 86400000);
        const dateText = `${date.getMonth() + 1}월 ${date.getDate()}일`;
        if (difference === 0) {
            return `오늘 · ${dateText}`;
        }
        if (difference === 1) {
            return `내일 · ${dateText}`;
        }
        const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
        return `${dateText} ${weekdays[date.getDay()]}요일`;
    }
    function normalizeCollapse(value) {
        const number = Number(value);
        return [FULL, SUMMARY, HEADER].includes(number)
            ? number
            : FULL;
    }
    function readSettingsText() {
        return localStorage.getItem(SETTINGS_KEY) || "{}";
    }
    function loadSettings() {
        const defaults = {
            collapseMode: FULL,
            settingsOpen: false,
            showDebug: false,
            summaryType: "classic",
            opacity: DEFAULT_OPACITY,
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
                showDebug: saved.showDebug !== undefined
                    ? !!saved.showDebug
                    : !!saved.showDataLine,
                summaryType: saved.summaryType === "allWeather"
                    ? "allWeather"
                    : "classic",
                opacity: clampInt(saved.opacity, 5, 100, DEFAULT_OPACITY),
                normalListCount: clampInt(saved.normalListCount, MIN_COUNT, MAX_COUNT, DEFAULT_NORMAL_COUNT),
                lunarListCount: clampInt(saved.lunarListCount, MIN_COUNT, MAX_COUNT, DEFAULT_LUNAR_COUNT),
                left: Number.isFinite(Number(saved.left))
                    ? Number(saved.left)
                    : null,
                top: Number.isFinite(Number(saved.top))
                    ? Number(saved.top)
                    : null,
            };
        }
        catch {
            return defaults;
        }
    }
    const settings = loadSettings();
    function saveSettings() {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            collapseMode: normalizeCollapse(settings.collapseMode),
            settingsOpen: !!settings.settingsOpen,
            showDebug: !!settings.showDebug,
            summaryType: settings.summaryType === "allWeather"
                ? "allWeather"
                : "classic",
            opacity: clampInt(settings.opacity, 5, 100, DEFAULT_OPACITY),
            normalListCount: clampInt(settings.normalListCount, MIN_COUNT, MAX_COUNT, DEFAULT_NORMAL_COUNT),
            lunarListCount: clampInt(settings.lunarListCount, MIN_COUNT, MAX_COUNT, DEFAULT_LUNAR_COUNT),
            left: Number.isFinite(Number(settings.left))
                ? Math.round(settings.left)
                : null,
            top: Number.isFinite(Number(settings.top))
                ? Math.round(settings.top)
                : null,
        }));
    }
    const FORECAST = (() => {
        const SLOT_MS = 5 * 60 * 1000;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const SLOTS_PER_DAY = 288;
        const NORMAL_LOOKAHEAD_DAYS = 2;
        const config = {
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
        const source = "MG Weather 내장 엔진";
        const cache = new Map();
        function mashFactory() {
            let number = 4022871197;
            return function mash(data) {
                data = String(data);
                for (let index = 0; index < data.length; index++) {
                    number += data.charCodeAt(index);
                    let value = 0.02519603282416938 * number;
                    number = value >>> 0;
                    value -= number;
                    value *= number;
                    number = value >>> 0;
                    value -= number;
                    number +=
                        (value * 4294967296) >>> 0;
                }
                return ((number >>> 0) *
                    2.3283064365386963e-10);
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
            if (s0 < 0) {
                s0 += 1;
            }
            s1 -= mash(seed);
            if (s1 < 0) {
                s1 += 1;
            }
            s2 -= mash(seed);
            if (s2 < 0) {
                s2 += 1;
            }
            return function random() {
                const value = 2091639 * s0 +
                    carry * 2.3283064365386963e-10;
                s0 = s1;
                s1 = s2;
                s2 = value - (carry = value | 0);
                return s2;
            };
        }
        function weightedPick(table, random) {
            const total = table.reduce((sum, row) => sum + Number(row.weight || 0), 0);
            if (!(total > 0)) {
                return table[0]?.weatherId || null;
            }
            let roll = random() * total;
            for (const row of table) {
                roll -= Number(row.weight || 0);
                if (roll <= 0) {
                    return row.weatherId;
                }
            }
            return (table[table.length - 1]?.weatherId ||
                null);
        }
        function startOfUtcDay(ms) {
            const date = new Date(ms);
            return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
        }
        function dayKey(ms) {
            return new Date(startOfUtcDay(ms))
                .toISOString()
                .slice(0, 10);
        }
        function slotIndex(ms) {
            return clamp(Math.floor((ms - startOfUtcDay(ms)) /
                SLOT_MS), 0, SLOTS_PER_DAY - 1);
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
                for (let index = 0; index < lunarDuration; index++) {
                    reserved.add(fixedSlot + index);
                }
            }
            const minSlots = Math.max(1, Math.floor(hydro.minFrequencyMinutes / 5));
            const maxSlots = Math.max(minSlots, Math.floor(hydro.maxFrequencyMinutes / 5));
            const hydroDuration = durationSlots(hydro);
            let slot = Math.floor(random() * minSlots);
            while (slot < SLOTS_PER_DAY) {
                const weatherId = weightedPick(hydro.dropTable, random);
                let canPlace = !!weatherId &&
                    slot + hydroDuration <=
                        SLOTS_PER_DAY;
                for (let index = 0; canPlace &&
                    index < hydroDuration; index++) {
                    if (reserved.has(slot + index)) {
                        canPlace = false;
                    }
                }
                if (canPlace) {
                    for (let index = 0; index < hydroDuration; index++) {
                        schedule[slot + index] =
                            weatherId;
                    }
                }
                slot += Math.max(1, minSlots +
                    Math.floor((maxSlots - minSlots) *
                        random()));
            }
            for (const fixedSlot of lunar.fixedTimeSlots) {
                const weatherId = weightedPick(lunar.dropTable, random);
                if (!weatherId) {
                    continue;
                }
                for (let index = 0; index < lunarDuration; index++) {
                    schedule[fixedSlot + index] =
                        weatherId;
                }
            }
            return schedule;
        }
        function scheduleForDay(key) {
            if (cache.has(key)) {
                return cache.get(key);
            }
            const schedule = buildSchedule(key);
            cache.set(key, schedule);
            while (cache.size > 6) {
                cache.delete(cache.keys().next().value);
            }
            return schedule;
        }
        function firstSlot(schedule, slot, weatherId) {
            while (slot > 0 &&
                schedule[slot - 1] === weatherId) {
                slot--;
            }
            return slot;
        }
        function lastSlot(schedule, slot, weatherId) {
            while (slot < SLOTS_PER_DAY - 1 &&
                schedule[slot + 1] === weatherId) {
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
                startsAtMs: dayStart +
                    start * SLOT_MS,
                endsAtMs: dayStart +
                    (end + 1) * SLOT_MS,
            };
        }
        function nextEvent(now) {
            const todayStart = startOfUtcDay(now);
            const todaySchedule = scheduleForDay(dayKey(now));
            const currentSlot = slotIndex(now);
            const currentWeather = todaySchedule[currentSlot] ||
                null;
            const firstSearchSlot = currentWeather
                ? lastSlot(todaySchedule, currentSlot, currentWeather) + 1
                : currentSlot + 1;
            for (let dayOffset = 0; dayOffset < NORMAL_LOOKAHEAD_DAYS; dayOffset++) {
                const dayStart = todayStart +
                    dayOffset * DAY_MS;
                const key = new Date(dayStart)
                    .toISOString()
                    .slice(0, 10);
                const schedule = scheduleForDay(key);
                const start = dayOffset === 0
                    ? firstSearchSlot
                    : 0;
                for (let slot = start; slot < SLOTS_PER_DAY; slot++) {
                    const weatherId = schedule[slot];
                    if (!weatherId) {
                        continue;
                    }
                    const end = lastSlot(schedule, slot, weatherId);
                    return {
                        weatherId,
                        startsAtMs: dayStart +
                            slot * SLOT_MS,
                        endsAtMs: dayStart +
                            (end + 1) * SLOT_MS,
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
                if (!event) {
                    break;
                }
                result.push(event);
                cursor = Math.max(event.startsAtMs, event.endsAtMs - 1);
            }
            return result;
        }
        function nextLunarEventList(now, count) {
            const result = [];
            const todayStart = startOfUtcDay(now);
            const slotsPerDay = Math.max(1, config.lunar.fixedTimeSlots.length);
            const lookaheadDays = Math.max(2, Math.ceil(count / slotsPerDay) + 1);
            const durationMs = durationSlots(config.lunar) *
                SLOT_MS;
            for (let dayOffset = 0; dayOffset < lookaheadDays &&
                result.length < count; dayOffset++) {
                const dayStart = todayStart +
                    dayOffset * DAY_MS;
                const key = new Date(dayStart)
                    .toISOString()
                    .slice(0, 10);
                const schedule = scheduleForDay(key);
                for (const slot of config.lunar.fixedTimeSlots) {
                    const startsAtMs = dayStart +
                        slot * SLOT_MS;
                    if (startsAtMs <= now) {
                        continue;
                    }
                    const weatherId = schedule[slot];
                    if (!weatherId) {
                        continue;
                    }
                    result.push({
                        weatherId,
                        startsAtMs,
                        endsAtMs: startsAtMs +
                            durationMs,
                    });
                    if (result.length >= count) {
                        break;
                    }
                }
            }
            return result;
        }
        function displayName(value) {
            const raw = String(value ?? "").trim();
            const key = raw
                .toLowerCase()
                .replace(/\s+/g, "");
            if (!key ||
                key === "sunny" ||
                key === "clearskies") {
                return "Clear Skies";
            }
            if (key === "frost" ||
                key === "snow") {
                return "Snow";
            }
            if (key === "ambermoon" ||
                key === "harvestmoon") {
                return "Amber Moon";
            }
            if (key === "rain") {
                return "Rain";
            }
            if (key === "thunderstorm" ||
                key === "thunder") {
                return "Thunderstorm";
            }
            if (key === "dawn") {
                return "Dawn";
            }
            return raw || "Clear Skies";
        }
        return {
            currentEvent,
            nextEventList,
            nextLunarEventList,
            displayName,
            getSource: () => source,
            getConfig: () => JSON.parse(JSON.stringify(config)),
        };
    })();
    function testWeatherName(weatherId) {
        return FORECAST.displayName(weatherId ?? null);
    }
    function recordForecastTest(actualWeatherId, source) {
        if (source !== "날씨 변경 패치") {
            return;
        }
        if (lastTestedWeather === actualWeatherId) {
            return;
        }
        lastTestedWeather = actualWeatherId;
        const now = gameNow();
        const predicted = FORECAST.currentEvent(now);
        const predictedWeatherId = predicted?.weatherId ?? null;
        const matched = predictedWeatherId === (actualWeatherId ?? null);
        const record = {
            observedAtMs: now,
            actualWeatherId: actualWeatherId ?? null,
            predictedWeatherId,
            predictedStartsAtMs: Number.isFinite(Number(predicted?.startsAtMs))
                ? predicted.startsAtMs
                : null,
            predictedEndsAtMs: Number.isFinite(Number(predicted?.endsAtMs))
                ? predicted.endsAtMs
                : null,
            matched,
        };
        forecastTest.total += 1;
        if (matched) {
            forecastTest.matched += 1;
        }
        forecastTest.records.push(record);
        if (forecastTest.records.length > 100) {
            forecastTest.records.shift();
        }
        saveTestData();
    }
    function resetForecastTest() {
        forecastTest.total = 0;
        forecastTest.matched = 0;
        forecastTest.records.length = 0;
        lastTestedWeather = undefined;
        saveTestData();
        updateHud();
        return getForecastTestStatus();
    }
    function getForecastTestStatus() {
        const total = forecastTest.total;
        const rate = total ? (forecastTest.matched / total) * 100 : null;
        return {
            total,
            matched: forecastTest.matched,
            mismatched: total - forecastTest.matched,
            matchRatePercent: rate,
            last: forecastTest.records.at(-1) || null,
            records: forecastTest.records.slice(),
            config: FORECAST.getConfig(),
        };
    }
    W.MGWeatherTest = {
        getStatus: getForecastTestStatus,
        reset: resetForecastTest,
        export: () => JSON.stringify(getForecastTestStatus(), null, 2),
    };
    function weatherStatus() {
        if (!gameWeatherUpdatedAt) {
            return {
                state: "WAITING",
                stale: false,
                ageMs: null,
            };
        }
        const ageMs = Math.max(0, Date.now() -
            gameWeatherUpdatedAt);
        const stale = ageMs >= STALE_MS;
        return {
            state: stale
                ? "STALE"
                : "LIVE",
            stale,
            ageMs,
        };
    }
    function currentRemainingMs() {
        if (gameWeatherId === undefined) {
            return null;
        }
        const now = gameNow();
        const current = FORECAST.currentEvent(now);
        if (!Number.isFinite(Number(current?.endsAtMs))) {
            return null;
        }
        if ((current.weatherId ?? null) !==
            (gameWeatherId ?? null)) {
            return null;
        }
        return Math.max(0, current.endsAtMs - now);
    }
    function normalizeGameWeather(value) {
        if (value == null ||
            value === "" ||
            value === false) {
            return null;
        }
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
                if (normalized !== undefined) {
                    return normalized;
                }
            }
            return undefined;
        }
        const text = String(value).trim();
        if (!text) {
            return null;
        }
        if (/^clear$/i.test(text) ||
            /^clear\s*skies$/i.test(text) ||
            /^sunny$/i.test(text) ||
            /맑은\s*하늘/.test(text)) {
            return null;
        }
        if (/^rain$/i.test(text) ||
            text === "비") {
            return "Rain";
        }
        if (/^frost$/i.test(text) ||
            /^snow$/i.test(text) ||
            text === "눈" ||
            text === "서리") {
            return "Frost";
        }
        if (/^thunder\s*storm$/i.test(text) ||
            /^thunderstorm$/i.test(text) ||
            text === "뇌우") {
            return "Thunderstorm";
        }
        if (/^dawn$/i.test(text) ||
            text === "던" ||
            text === "달" ||
            text === "새벽") {
            return "Dawn";
        }
        if (/^amber\s*moon$/i.test(text) ||
            /^ambermoon$/i.test(text) ||
            /^harvest\s*moon$/i.test(text) ||
            text === "엠버문") {
            return "AmberMoon";
        }
        if (/partialstate|partial state|thunderstruck|dawnlit|amberlit|ambershine|raindance|wet|chilled|frozen|gold|rainbow|seedfinder|snowdrop|granter|charged|bound/i.test(text)) {
            return undefined;
        }
        return undefined;
    }
    function updateGameWeather(raw, source) {
        const normalized = normalizeGameWeather(raw);
        if (normalized === undefined) {
            return;
        }
        gameWeatherId = normalized;
        gameWeatherSource =
            source || "게임 상태";
        gameWeatherUpdatedAt =
            Date.now();
        updateHud();
        try {
            recordForecastTest(normalized, source);
        }
        catch (error) {
            console.warn("[MG Weather 검증] 기록 실패", error);
        }
    }
    function processFullState(state, syncCurrentTime = true) {
        try {
            const data = state?.child?.data;
            if (!data) {
                return;
            }
            if (Object.prototype.hasOwnProperty.call(data, "weather")) {
                updateGameWeather(data.weather, "전체 상태");
            }
            if (syncCurrentTime &&
                Object.prototype.hasOwnProperty.call(data, "currentTime")) {
                updateServerTime(data.currentTime);
            }
        }
        catch { }
    }
    function processPayload(payload, allowFallbackTime = true) {
        if (!payload ||
            typeof payload !== "object") {
            return;
        }
        const publishedAtServerMs = Number(payload.publishedAtServerMs);
        const hasPublishedServerTime = Number.isFinite(publishedAtServerMs) &&
            publishedAtServerMs > 0;
        if (hasPublishedServerTime) {
            updateServerTime(publishedAtServerMs);
        }
        if (payload.fullState) {
            processFullState(payload.fullState, allowFallbackTime &&
                !hasPublishedServerTime);
        }
        if (payload.child?.data) {
            processFullState(payload, allowFallbackTime &&
                !hasPublishedServerTime);
        }
        const patchGroups = [
            payload.patches,
            payload.frame?.patches,
            payload.state?.patches,
            payload.data?.patches
        ];
        for (const patches of patchGroups) {
            if (!Array.isArray(patches)) {
                continue;
            }
            for (const patch of patches) {
                if (patch?.path ===
                    "/child/data/weather") {
                    updateGameWeather(patch.value, "날씨 변경 패치");
                }
                else if (allowFallbackTime &&
                    !hasPublishedServerTime &&
                    patch?.path ===
                        "/child/data/currentTime") {
                    updateServerTime(patch.value);
                }
            }
        }
        for (const nested of [
            payload.frame,
            payload.state
        ]) {
            if (nested &&
                nested !== payload &&
                typeof nested === "object") {
                processPayload(nested, false);
            }
        }
    }
    function parseMessage(text) {
        if (!text ||
            typeof text !== "string") {
            return;
        }
        const trimmed = text.trim();
        if (!trimmed) {
            return;
        }
        try {
            processPayload(JSON.parse(trimmed));
            return;
        }
        catch { }
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start < 0 ||
            end <= start) {
            return;
        }
        try {
            processPayload(JSON.parse(trimmed.slice(start, end + 1)));
        }
        catch { }
    }
    function handleSocketData(data) {
        try {
            if (typeof data === "string") {
                parseMessage(data);
            }
            else if (data instanceof ArrayBuffer) {
                parseMessage(new TextDecoder().decode(data));
            }
            else if (data instanceof Blob) {
                data
                    .text()
                    .then(parseMessage)
                    .catch(() => { });
            }
        }
        catch { }
    }
    function installWebSocketReader() {
        if (W.__MG_WEATHER_HUD_JH_WS_INSTALLED__) {
            return;
        }
        const NativeWebSocket = W.WebSocket;
        if (!NativeWebSocket) {
            return;
        }
        W.__MG_WEATHER_HUD_JH_WS_INSTALLED__ =
            true;
        function WrappedWebSocket(...args) {
            const socket = new NativeWebSocket(...args);
            try {
                socket.addEventListener("message", (event) => {
                    handleSocketData(event.data);
                });
            }
            catch { }
            return socket;
        }
        WrappedWebSocket.prototype =
            NativeWebSocket.prototype;
        for (const property of Object.getOwnPropertyNames(NativeWebSocket)) {
            try {
                if (!(property in
                    WrappedWebSocket)) {
                    Object.defineProperty(WrappedWebSocket, property, Object.getOwnPropertyDescriptor(NativeWebSocket, property));
                }
            }
            catch { }
        }
        W.WebSocket =
            WrappedWebSocket;
    }
    installWebSocketReader();
    function nextCollapseMode() {
        if (settings.collapseMode === FULL) {
            return HEADER;
        }
        if (settings.collapseMode === HEADER) {
            return SUMMARY;
        }
        return FULL;
    }
    function collapseIcon() {
        if (settings.collapseMode === FULL) {
            return "▤";
        }
        if (settings.collapseMode === HEADER) {
            return "▣";
        }
        return "▁";
    }
    function collapseTitle() {
        if (settings.collapseMode === FULL) {
            return "완전히 접기";
        }
        if (settings.collapseMode === HEADER) {
            return "요약 보기";
        }
        return "전체 펼치기";
    }
    function applyHudState(box) {
        if (!box) {
            return;
        }
        box.style.setProperty("--mg-nw-opacity", String(clampInt(settings.opacity, 5, 100, DEFAULT_OPACITY) / 100));
        box.classList.toggle("collapse-summary", settings.collapseMode === SUMMARY);
        box.classList.toggle("collapse-header", settings.collapseMode === HEADER);
        box.classList.toggle("settings-open", settings.settingsOpen);
        box.classList.toggle("hide-debug", !settings.showDebug);
        box.classList.toggle("summary-all-weather", settings.summaryType === "allWeather");
    }
    function safePosition(box, desiredLeft, desiredTop) {
        const width = box.offsetWidth || 340;
        const height = box.offsetHeight || 220;
        const maxLeft = Math.max(MARGIN, window.innerWidth -
            width -
            MARGIN);
        const maxTop = Math.max(MARGIN, window.innerHeight -
            height -
            MARGIN);
        return {
            left: clamp(Number.isFinite(desiredLeft)
                ? desiredLeft
                : maxLeft, MARGIN, maxLeft),
            top: clamp(Number.isFinite(desiredTop)
                ? desiredTop
                : MARGIN, MARGIN, maxTop),
        };
    }
    function applyPosition(box, left, top, save) {
        const position = safePosition(box, left, top);
        box.style.left =
            `${position.left}px`;
        box.style.top =
            `${position.top}px`;
        box.style.right = "auto";
        box.style.bottom = "auto";
        if (!save) {
            return;
        }
        settings.left =
            Math.round(position.left);
        settings.top =
            Math.round(position.top);
        saveSettings();
    }
    function reapplyPosition(box, save) {
        applyPosition(box, settings.left, settings.top, save);
    }
    function installDrag(box) {
        const handle = $("mg-nw-drag-handle");
        if (!handle) {
            return;
        }
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;
        function begin(event) {
            if (event.target?.closest?.("button,input,label")) {
                return;
            }
            const point = event.touches
                ? event.touches[0]
                : event;
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
            if (!dragging) {
                return;
            }
            const point = event.touches
                ? event.touches[0]
                : event;
            applyPosition(box, startLeft +
                point.clientX -
                startX, startTop +
                point.clientY -
                startY, false);
            event.preventDefault();
        }
        function end() {
            if (!dragging) {
                return;
            }
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
        if ($(STYLE_ID)) {
            return;
        }
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
#${HUD_ID}{position:fixed;z-index:2147483647;min-width:270px;max-width:410px;color:#f7fbff;background:rgba(12,16,24,var(--mg-nw-opacity,.9));border:1px solid rgba(255,255,255,.18);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.35;user-select:none;overflow:hidden;backdrop-filter:blur(8px)}
#${HUD_ID}.dragging{opacity:.92}

#${HUD_ID}.hide-debug #mg-nw-debug,#${HUD_ID}.collapse-header .mg-nw-body,#${HUD_ID}.collapse-summary .mg-nw-extra{display:none}
#${HUD_ID}.collapse-summary:not(.hide-debug) .mg-nw-extra,#${HUD_ID}.collapse-header:not(.hide-debug) .mg-nw-body,#${HUD_ID}.collapse-header:not(.hide-debug) .mg-nw-extra{display:block}
#${HUD_ID} .mg-nw-all-weather-summary{display:none}
#${HUD_ID}.summary-all-weather .mg-nw-classic-summary{display:none}
#${HUD_ID}.summary-all-weather .mg-nw-all-weather-summary{display:block}
#${HUD_ID}.collapse-summary:not(.hide-debug) .mg-nw-extra>:not(#mg-nw-debug):not(.mg-nw-settings-panel),#${HUD_ID}.collapse-header:not(.hide-debug) .mg-nw-body>.mg-nw-line,#${HUD_ID}.collapse-header:not(.hide-debug) .mg-nw-body>.mg-nw-all-weather-summary,#${HUD_ID}.collapse-header:not(.hide-debug) .mg-nw-extra>:not(#mg-nw-debug):not(.mg-nw-settings-panel){display:none}
#${HUD_ID}.settings-open .mg-nw-settings-panel,#${HUD_ID}.collapse-summary.settings-open .mg-nw-extra,#${HUD_ID}.collapse-header.settings-open .mg-nw-body,#${HUD_ID}.collapse-header.settings-open .mg-nw-extra{display:block}
#${HUD_ID}.collapse-summary.settings-open .mg-nw-extra>:not(.mg-nw-settings-panel):not(#mg-nw-debug),#${HUD_ID}.collapse-header.settings-open .mg-nw-body>.mg-nw-line,#${HUD_ID}.collapse-header.settings-open .mg-nw-body>.mg-nw-all-weather-summary,#${HUD_ID}.collapse-header.settings-open .mg-nw-extra>:not(.mg-nw-settings-panel):not(#mg-nw-debug){display:none}
#${HUD_ID} .mg-nw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;background:rgba(255,255,255,calc(.08 * var(--mg-nw-opacity,.9)));border-bottom:1px solid rgba(255,255,255,.13);cursor:move;touch-action:none}
#${HUD_ID} .mg-nw-title{display:flex;align-items:baseline;gap:5px;font-weight:750;letter-spacing:.2px}
#${HUD_ID} .mg-nw-version{color:rgba(230,240,255,.5);font-size:9px;font-weight:600;letter-spacing:0}
#${HUD_ID} .mg-nw-buttons{display:flex;gap:5px;align-items:center}
#${HUD_ID} button{appearance:none;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#f7fbff;border-radius:8px;padding:2px 7px;min-width:30px;height:26px;font-size:15px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
#${HUD_ID} button:hover{background:rgba(255,255,255,.16)}
#${HUD_ID} .mg-nw-body{padding:10px}
#${HUD_ID} .mg-nw-line{display:grid;grid-template-columns:79px 1fr;gap:3px;margin:5px 0;align-items:baseline}
#${HUD_ID} .mg-nw-label{color:rgba(230,240,255,.72)}
#${HUD_ID} .mg-nw-value{color:#fff;font-weight:650}
#${HUD_ID} .mg-nw-summary-value{display:grid;grid-template-columns:minmax(0,1fr) 68px;column-gap:4px;align-items:baseline;min-width:0}
#${HUD_ID} .mg-nw-summary-value>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${HUD_ID} .mg-nw-summary-time{justify-self:end;text-align:right;color:rgba(230,240,255,.75);font-weight:400;white-space:nowrap}
#${HUD_ID} .mg-nw-all-weather-summary{padding:2px 0}
#${HUD_ID} .mg-nw-all-weather-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;column-gap:6px;margin:3px 0;padding:5px 7px;border:1px solid transparent;border-radius:8px}
#${HUD_ID} .mg-nw-all-weather-rank{color:rgba(230,240,255,.46);font-size:10px;font-weight:800;text-align:center}
#${HUD_ID} .mg-nw-all-weather-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:750}
#${HUD_ID} .mg-nw-all-weather-time{color:rgba(230,240,255,.78);font-variant-numeric:tabular-nums;white-space:nowrap}
#${HUD_ID} .mg-nw-all-weather-row.is-nearest{background:rgba(158,203,255,.16);border-color:rgba(158,203,255,.48);box-shadow:0 0 0 1px rgba(158,203,255,.08) inset}
#${HUD_ID} .mg-nw-all-weather-row.is-second{background:rgba(255,255,255,.075);border-color:rgba(255,255,255,.22)}
#${HUD_ID} .mg-nw-all-weather-row.is-nearest .mg-nw-all-weather-rank{color:#bfe0ff}
#${HUD_ID} .mg-nw-all-weather-row.is-second .mg-nw-all-weather-rank{color:rgba(245,249,255,.78)}
#${HUD_ID} .mg-nw-section-title{margin:8px 0 3px;padding:3px 7px;border-radius:6px;background:rgba(255,255,255,calc(.055 * var(--mg-nw-opacity,.9)));color:rgba(235,243,255,.82);font-size:11px;font-weight:700;line-height:1.25;text-align:center}
#${HUD_ID} .mg-nw-date-divider{display:flex;align-items:center;gap:7px;margin:8px 0 3px;color:rgba(230,240,255,.72);font-size:11px;font-weight:700;white-space:nowrap}
#${HUD_ID} .mg-nw-date-divider::before,#${HUD_ID} .mg-nw-date-divider::after{content:"";height:1px;flex:1;background:rgba(255,255,255,.16)}
#${HUD_ID} .mg-nw-upcoming-row{display:grid;grid-template-columns:24px 52px 1fr auto;column-gap:3px;align-items:center;padding:2px 0;font-size:12px}
#${HUD_ID} .mg-nw-index{color:rgba(230,240,255,.55)}
#${HUD_ID} .mg-nw-time,#${HUD_ID} .mg-nw-in{color:rgba(230,240,255,.75);font-variant-numeric:tabular-nums}
#${HUD_ID} .mg-nw-name{color:#fff;font-weight:700}
#${HUD_ID} .mg-nw-rain{color:#7ec8ff;font-weight:700}
#${HUD_ID} .mg-nw-snow{color:#fff;font-weight:700}
#${HUD_ID} .mg-nw-thunderstorm{color:#fff0a8;font-weight:700}
#${HUD_ID} .mg-nw-dawn{color:#d3b4ff;font-weight:700}
#${HUD_ID} .mg-nw-amber{color:#ffbf5f;font-weight:700}
#${HUD_ID} .mg-nw-empty{color:rgba(230,240,255,.58);font-size:12px;padding:3px 0}
#${HUD_ID} .mg-nw-debug{margin-top:10px;padding:8px;border:1px solid rgba(255,255,255,.18);border-radius:9px;background:rgba(12,16,24,.96);font-size:12px}
#${HUD_ID} .mg-nw-debug-title{margin-bottom:6px;color:rgba(230,240,255,.78);font-weight:700}
#${HUD_ID} .mg-nw-debug-row{display:grid;grid-template-columns:82px 1fr;gap:8px;margin:3px 0}
#${HUD_ID} .mg-nw-debug-key{color:rgba(230,240,255,.58)}
#${HUD_ID} .mg-nw-debug-value{color:rgba(245,249,255,.9);word-break:break-word}
#${HUD_ID} .mg-nw-debug-live{color:#8ff0ad;font-weight:700}
#${HUD_ID} .mg-nw-debug-stale{color:#ffb36b;font-weight:700}
#${HUD_ID} .mg-nw-debug-waiting{color:#ffd86b;font-weight:700}
#${HUD_ID} .mg-nw-test-match{color:#8ff0ad;font-weight:700}
#${HUD_ID} .mg-nw-test-mismatch{color:#ff8d8d;font-weight:700}
#${HUD_ID} .mg-nw-settings-panel{display:none;margin-top:9px;padding:8px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(12,16,24,.96)}
#${HUD_ID}.collapse-header.settings-open .mg-nw-settings-panel{margin-top:0}
#${HUD_ID} .mg-nw-settings-title{margin-bottom:6px;font-size:12px;font-weight:700}
#${HUD_ID} .mg-nw-setting-row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:6px 0}
#${HUD_ID} input[type=checkbox]{transform:scale(1.05)}
#${HUD_ID} input[type=range]{width:118px;accent-color:#9ecbff}
#${HUD_ID} input[type=number]{width:76px;border:1px solid rgba(255,255,255,.22);border-radius:7px;background:rgba(0,0,0,.28);color:#fff;padding:3px 6px;font-size:12px}
#${HUD_ID} select{width:138px;border:1px solid rgba(255,255,255,.22);border-radius:7px;background:#171d28;color:#fff;padding:4px 6px;font-size:12px}
#${HUD_ID} .mg-nw-opacity-control{display:flex;align-items:center;gap:7px}
#${HUD_ID} .mg-nw-opacity-value{width:34px;text-align:right;color:rgba(245,249,255,.9);font-variant-numeric:tabular-nums;font-size:12px}
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
  <div class="mg-nw-title">MG Weather <span class="mg-nw-version">v.2.1 beta</span></div>
  <div class="mg-nw-buttons">
    <button id="mg-nw-settings-btn" type="button" title="설정" aria-label="설정">⚙</button>
    <button id="mg-nw-toggle-btn" type="button" title="${collapseTitle()}" aria-label="${collapseTitle()}">${collapseIcon()}</button>
  </div>
</div>

<div class="mg-nw-body">
  <div class="mg-nw-line mg-nw-classic-summary">
    <div class="mg-nw-label">현재</div>
    <div class="mg-nw-value mg-nw-summary-value" id="mg-nw-current">읽는 중...</div>
  </div>

  <div class="mg-nw-line mg-nw-classic-summary">
    <div class="mg-nw-label">다음</div>
    <div class="mg-nw-value mg-nw-summary-value" id="mg-nw-next-weather">계산 중...</div>
  </div>

  <div class="mg-nw-line mg-nw-classic-summary">
    <div class="mg-nw-label">다음 희귀</div>
    <div class="mg-nw-value mg-nw-summary-value" id="mg-nw-next-lunar">계산 중...</div>
  </div>

  <div class="mg-nw-all-weather-summary" id="mg-nw-all-weather-summary">
    <div class="mg-nw-empty">계산 중...</div>
  </div>

  <div class="mg-nw-extra">
    <div class="mg-nw-section-title">다음 날씨</div>
    <div id="mg-nw-weather-list"></div>

    <div class="mg-nw-section-title">다음 희귀 날씨</div>
    <div id="mg-nw-lunar-list"></div>

    <div class="mg-nw-settings-panel">
      <div class="mg-nw-settings-title">설정</div>

      <label class="mg-nw-setting-row">
        <span>요약보기 기준</span>
        <select id="mg-nw-summary-type">
          <option value="classic" ${settings.summaryType === "classic" ? "selected" : ""}>다음 날씨</option>
          <option value="allWeather" ${settings.summaryType === "allWeather" ? "selected" : ""}>전체 날씨</option>
        </select>
      </label>

      <label class="mg-nw-setting-row">
        <span>탭 투명도</span>
        <span class="mg-nw-opacity-control">
          <input id="mg-nw-opacity" type="range" min="5" max="100" step="1" value="${settings.opacity}">
          <span class="mg-nw-opacity-value" id="mg-nw-opacity-value">${settings.opacity}%</span>
        </span>
      </label>

      <label class="mg-nw-setting-row">
        <span>다음 날씨 개수</span>
        <input id="mg-nw-normal-count" type="number" min="${MIN_COUNT}" step="1" max="${MAX_COUNT}" value="${settings.normalListCount}">
      </label>

      <label class="mg-nw-setting-row">
        <span>다음 희귀 날씨 개수</span>
        <input id="mg-nw-lunar-count" type="number" min="${MIN_COUNT}" step="1" max="${MAX_COUNT}" value="${settings.lunarListCount}">
      </label>

      <label class="mg-nw-setting-row">
        <span>디버그 표시</span>
        <input id="mg-nw-show-debug" type="checkbox" ${settings.showDebug ? "checked" : ""}>
      </label>
    </div>

    <div class="mg-nw-debug" id="mg-nw-debug">
      <div class="mg-nw-debug-title">디버그</div>

      <div class="mg-nw-debug-row">
        <div class="mg-nw-debug-key">상태</div>
        <div class="mg-nw-debug-value" id="mg-nw-debug-status">-</div>
      </div>

      <div class="mg-nw-debug-row">
        <div class="mg-nw-debug-key">마지막 수신</div>
        <div class="mg-nw-debug-value" id="mg-nw-debug-age">-</div>
      </div>

      <div class="mg-nw-debug-row">
        <div class="mg-nw-debug-key">날씨 출처</div>
        <div class="mg-nw-debug-value" id="mg-nw-debug-current-source">-</div>
      </div>

      <div class="mg-nw-debug-row">
        <div class="mg-nw-debug-key">예보 출처</div>
        <div class="mg-nw-debug-value" id="mg-nw-debug-forecast-source">-</div>
      </div>

      <div class="mg-nw-debug-row">
        <div class="mg-nw-debug-key">시간 기준</div>
        <div class="mg-nw-debug-value" id="mg-nw-debug-time-source">-</div>
      </div>

      <div class="mg-nw-debug-row">
        <div class="mg-nw-debug-key">검증 표본</div>
        <div class="mg-nw-debug-value" id="mg-nw-debug-test-count">0</div>
      </div>

      <div class="mg-nw-debug-row">
        <div class="mg-nw-debug-key">일치율</div>
        <div class="mg-nw-debug-value" id="mg-nw-debug-test-rate">-</div>
      </div>

      <div class="mg-nw-debug-row">
        <div class="mg-nw-debug-key">마지막 검증</div>
        <div class="mg-nw-debug-value" id="mg-nw-debug-test-last">대기 중</div>
      </div>
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
        const opacityInput = $("mg-nw-opacity");
        const opacityValue = $("mg-nw-opacity-value");
        const normalInput = $("mg-nw-normal-count");
        const lunarInput = $("mg-nw-lunar-count");
        const summaryTypeInput = $("mg-nw-summary-type");
        toggle?.addEventListener("click", (event) => {
            event.stopPropagation();
            settings.collapseMode =
                nextCollapseMode();
            applyHudState(box);
            toggle.textContent =
                collapseIcon();
            toggle.title =
                collapseTitle();
            toggle.setAttribute("aria-label", collapseTitle());
            saveSettings();
            setTimeout(() => reapplyPosition(box, true), 0);
        });
        settingsButton?.addEventListener("click", (event) => {
            event.stopPropagation();
            settings.settingsOpen =
                !settings.settingsOpen;
            applyHudState(box);
            saveSettings();
            setTimeout(() => reapplyPosition(box, true), 0);
        });
        debugInput?.addEventListener("change", () => {
            settings.showDebug =
                debugInput.checked;
            saveSettings();
            updateHud();
        });
        summaryTypeInput?.addEventListener("change", () => {
            settings.summaryType =
                summaryTypeInput.value === "allWeather"
                    ? "allWeather"
                    : "classic";
            saveSettings();
            updateHud();
            setTimeout(() => reapplyPosition(box, true), 0);
        });
        opacityInput?.addEventListener("input", () => {
            settings.opacity =
                clampInt(opacityInput.value, 5, 100, DEFAULT_OPACITY);
            if (opacityValue) {
                opacityValue.textContent =
                    `${settings.opacity}%`;
            }
            applyHudState(box);
            saveSettings();
        });
        normalInput?.addEventListener("change", () => {
            settings.normalListCount =
                clampInt(normalInput.value, MIN_COUNT, MAX_COUNT, DEFAULT_NORMAL_COUNT);
            normalInput.value =
                settings.normalListCount;
            saveSettings();
            updateHud();
        });
        lunarInput?.addEventListener("change", () => {
            settings.lunarListCount =
                clampInt(lunarInput.value, MIN_COUNT, MAX_COUNT, DEFAULT_LUNAR_COUNT);
            lunarInput.value =
                settings.lunarListCount;
            saveSettings();
            updateHud();
        });
    }
    function weatherClass(id) {
        return id === "Rain"
            ? "mg-nw-rain"
            : id === "Frost" ||
                id === "Snow"
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
        return FORECAST
            .nextEventList(gameNow(), settings.normalListCount)
            .map(normalizeEvent)
            .filter(Boolean);
    }
    function getLunarEvents() {
        return FORECAST
            .nextLunarEventList(gameNow(), settings.lunarListCount)
            .map(normalizeEvent)
            .filter(Boolean);
    }
    const ALL_WEATHER_IDS = [
        "Rain",
        "Frost",
        "Thunderstorm",
        "Dawn",
        "AmberMoon",
    ];
    let allWeatherSummaryCache = {
        updatedAt: 0,
        events: [],
    };
    function getAllWeatherSummaryEvents() {
        const now = gameNow();
        if (allWeatherSummaryCache.events.length === ALL_WEATHER_IDS.length &&
            now - allWeatherSummaryCache.updatedAt < 30000 &&
            allWeatherSummaryCache.events.every((event) => !Number.isFinite(event.startsAtMs) || event.startsAtMs > now)) {
            return allWeatherSummaryCache.events;
        }
        const found = new Map();
        for (const event of FORECAST.nextEventList(now, 120)) {
            const id = event.weatherId === "Snow" ? "Frost" : event.weatherId;
            if (ALL_WEATHER_IDS.includes(id) && !found.has(id)) {
                found.set(id, normalizeEvent(event));
            }
            if (found.size >= ALL_WEATHER_IDS.length) {
                break;
            }
        }
        if (!found.has("Dawn") || !found.has("AmberMoon")) {
            for (const event of FORECAST.nextLunarEventList(now, 48)) {
                const id = event.weatherId;
                if (ALL_WEATHER_IDS.includes(id) && !found.has(id)) {
                    found.set(id, normalizeEvent(event));
                }
                if (found.has("Dawn") && found.has("AmberMoon")) {
                    break;
                }
            }
        }
        const events = ALL_WEATHER_IDS.map((id) => found.get(id) || {
            id,
            name: FORECAST.displayName(id),
            startsAtMs: Infinity,
            endsAtMs: Infinity,
        });
        allWeatherSummaryCache = {
            updatedAt: now,
            events,
        };
        return events;
    }
    function renderAllWeatherSummary(events, now) {
        const nearest = [...events]
            .filter((event) => Number.isFinite(event.startsAtMs))
            .sort((a, b) => a.startsAtMs - b.startsAtMs)
            .slice(0, 2);
        const nearestId = nearest[0]?.id;
        const secondId = nearest[1]?.id;
        return events
            .map((event) => {
            const rank = event.id === nearestId
                ? "1"
                : event.id === secondId
                    ? "2"
                    : "";
            const emphasis = event.id === nearestId
                ? " is-nearest"
                : event.id === secondId
                    ? " is-second"
                    : "";
            return `
          <div class="mg-nw-all-weather-row${emphasis}">
            <span class="mg-nw-all-weather-rank">${rank}</span>
            <span class="mg-nw-all-weather-name ${weatherClass(event.id)}">
              ${escapeHtml(event.name)}
            </span>
            <span class="mg-nw-all-weather-time">
              ${Number.isFinite(event.startsAtMs)
                ? formatRemaining(event.startsAtMs - now)
                : "--"}
            </span>
          </div>
        `;
        })
            .join("");
    }
    function renderRows(events, emptyText) {
        if (!events.length) {
            return `
        <div class="mg-nw-empty">
          ${escapeHtml(emptyText)}
        </div>
      `;
        }
        const now = gameNow();
        let previousDate = dateKey(events[0].startsAtMs);
        return events
            .map((event, index) => {
            const currentDate = dateKey(event.startsAtMs);
            const divider = index > 0 &&
                currentDate !== previousDate
                ? `
              <div class="mg-nw-date-divider">
                ${escapeHtml(formatDateDivider(event.startsAtMs, now))}
              </div>
            `
                : "";
            previousDate =
                currentDate;
            return `
          ${divider}

          <div class="mg-nw-upcoming-row">
            <span class="mg-nw-index">
              #${index + 1}
            </span>

            <span class="mg-nw-time">
              ${formatTime(event.startsAtMs)}
            </span>

            <span class="mg-nw-name ${weatherClass(event.id)}">
              ${escapeHtml(event.name)}
            </span>

            <span class="mg-nw-in">
              ${formatRemaining(event.startsAtMs -
                now)}
            </span>
          </div>
        `;
        })
            .join("");
    }
    function updateHud() {
        const box = $(HUD_ID);
        if (!box) {
            return;
        }
        applyHudState(box);
        const now = gameNow();
        const normalEvents = getNormalEvents();
        const lunarEvents = getLunarEvents();
        const allWeatherEvents = settings.summaryType === "allWeather"
            ? getAllWeatherSummaryEvents()
            : [];
        const nextWeather = normalEvents[0];
        const nextLunar = lunarEvents[0];
        const currentElement = $("mg-nw-current");
        if (currentElement) {
            if (gameWeatherId === undefined) {
                currentElement.textContent =
                    "읽는 중...";
            }
            else {
                const name = FORECAST.displayName(gameWeatherId);
                const remaining = currentRemainingMs();
                const remainingHtml = remaining === null
                    ? ""
                    : `
<span class="mg-nw-summary-time">
                ${formatRemaining(remaining)}
              </span>
            `;
                currentElement.innerHTML =
                    gameWeatherId === null
                        ? `
              <span>
                ${escapeHtml(name)}
              </span>
              ${remainingHtml}
            `
                        : `
              <span class="${weatherClass(gameWeatherId)}">
                ${escapeHtml(name)}
              </span>
              ${remainingHtml}
            `;
            }
        }
        const nextWeatherElement = $("mg-nw-next-weather");
        if (nextWeatherElement) {
            nextWeatherElement.innerHTML =
                nextWeather
                    ? `
            <span class="${weatherClass(nextWeather.id)}">
              ${escapeHtml(nextWeather.name)}
            </span>
<span class="mg-nw-summary-time">
              ${formatRemaining(nextWeather.startsAtMs -
                        now)}
            </span>
          `
                    : "예보 없음";
        }
        const allWeatherSummary = $("mg-nw-all-weather-summary");
        if (allWeatherSummary) {
            allWeatherSummary.innerHTML =
                renderAllWeatherSummary(allWeatherEvents, now);
        }
        const nextLunarElement = $("mg-nw-next-lunar");
        if (nextLunarElement) {
            nextLunarElement.innerHTML =
                nextLunar
                    ? `
            <span class="${weatherClass(nextLunar.id)}">
              ${escapeHtml(nextLunar.name)}
            </span>
<span class="mg-nw-summary-time">
              ${formatRemaining(nextLunar.startsAtMs -
                        now)}
            </span>
          `
                    : "희귀 날씨 예보 없음";
        }
        const weatherList = $("mg-nw-weather-list");
        const lunarList = $("mg-nw-lunar-list");
        if (weatherList) {
            weatherList.innerHTML =
                renderRows(normalEvents, "예보 없음");
        }
        if (lunarList) {
            lunarList.innerHTML =
                renderRows(lunarEvents, "희귀 날씨 예보 없음");
        }
        const status = weatherStatus();
        const statusElement = $("mg-nw-debug-status");
        if (statusElement) {
            statusElement.textContent =
                status.state;
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
        const timeSource = $("mg-nw-debug-time-source");
        if (ageElement) {
            ageElement.textContent =
                formatAge(status.ageMs);
        }
        if (currentSource) {
            currentSource.textContent =
                gameWeatherSource;
        }
        if (forecastSource) {
            forecastSource.textContent =
                FORECAST.getSource();
        }
        if (timeSource) {
            timeSource.textContent =
                serverTimeMs
                    ? "게임 서버"
                    : "기기 시간";
        }
        const testCount = $("mg-nw-debug-test-count");
        const testRate = $("mg-nw-debug-test-rate");
        const testLast = $("mg-nw-debug-test-last");
        const testStatus = getForecastTestStatus();
        if (testCount) {
            testCount.textContent = `${testStatus.matched}/${testStatus.total} 일치`;
        }
        if (testRate) {
            testRate.textContent = testStatus.total
                ? `${testStatus.matchRatePercent.toFixed(1)}%`
                : "표본 없음";
        }
        if (testLast) {
            const last = testStatus.last;
            if (!last) {
                testLast.textContent = "날씨 변경 대기 중";
                testLast.className = "mg-nw-debug-value mg-nw-debug-waiting";
            }
            else {
                testLast.textContent = last.matched
                    ? `${testWeatherName(last.actualWeatherId)} · 일치`
                    : `실제 ${testWeatherName(last.actualWeatherId)} / 예측 ${testWeatherName(last.predictedWeatherId)}`;
                testLast.className =
                    "mg-nw-debug-value " +
                        (last.matched ? "mg-nw-test-match" : "mg-nw-test-mismatch");
            }
        }
    }
    let hudTimer = 0;
    function scheduleHudTick() {
        clearTimeout(hudTimer);
        if (document.hidden) {
            return;
        }
        const remainder = ((gameNow() % 1000) + 1000) % 1000;
        hudTimer = setTimeout(() => {
            updateHud();
            scheduleHudTick();
        }, Math.max(50, 1010 - remainder));
    }
    function boot() {
        createHud();
        updateHud();
        scheduleHudTick();
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                clearTimeout(hudTimer);
            }
            else {
                updateHud();
                scheduleHudTick();
            }
        });
        window.addEventListener("resize", () => {
            const box = $(HUD_ID);
            if (box) {
                reapplyPosition(box, true);
            }
        });
    }
    if (document.readyState ===
        "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
    else {
        boot();
    }
})();
