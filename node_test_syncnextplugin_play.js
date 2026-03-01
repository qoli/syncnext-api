#!/usr/bin/env node

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const vm = require("vm");

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!hit) return fallback;
  return hit.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function tsCompact() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    p2(d.getMonth() + 1) +
    p2(d.getDate()) +
    "-" +
    p2(d.getHours()) +
    p2(d.getMinutes()) +
    p2(d.getSeconds())
  );
}

function isoNow() {
  return new Date().toISOString();
}

function createLogger(logPath) {
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  return {
    log(msg) {
      const line = String(msg == null ? "" : msg);
      process.stdout.write(line + "\n");
      stream.write(line + "\n");
    },
    error(msg) {
      const line = String(msg == null ? "" : msg);
      process.stderr.write(line + "\n");
      stream.write(line + "\n");
    },
    close() {
      stream.end();
    },
  };
}

function createFetchImpl() {
  if (typeof fetch === "function") {
    return fetch.bind(globalThis);
  }

  try {
    const mod = require("node-fetch");
    return (mod.default || mod);
  } catch (_) {}

  try {
    const fallback = require(path.resolve(
      __dirname,
      "..",
      "SyncnextPlugin_official",
      "node_modules",
      "node-fetch"
    ));
    return fallback.default || fallback;
  } catch (_) {}

  throw new Error("fetch is unavailable. Use Node 18+ or install node-fetch.");
}

const fetchImpl = createFetchImpl();

async function fetchWithTimeout(url, options, timeoutMs) {
  const ms = toInt(timeoutMs, 20000);
  if (typeof AbortController === "function") {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      return await fetchImpl(url, Object.assign({}, options || {}, { signal: ac.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  return await Promise.race([
    fetchImpl(url, options || {}),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    }),
  ]);
}

function looksLikeURL(input) {
  return /^https?:\/\//i.test(String(input || ""));
}

function normalizeURL(url) {
  return String(url || "").trim();
}

function removeSyncnextPluginScheme(apiValue) {
  return String(apiValue || "").replace(/^syncnextplugin:\/\//i, "");
}

function extractPluginFolderByConfigURL(configURL) {
  const hit = String(configURL || "").match(/\/(plugin_[^\/?#]+)\/config\.json(?:[?#].*)?$/i);
  return hit && hit[1] ? hit[1] : "";
}

function headersToObject(headers) {
  const out = {};
  if (headers && typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      out[key] = value;
    });
  }

  const setCookies = extractSetCookies(headers);
  if (setCookies.length > 0) {
    out["set-cookie"] = setCookies;
    out["Set-Cookie"] = setCookies;
  }
  return out;
}

function extractSetCookies(headers) {
  if (!headers) return [];

  if (typeof headers.getSetCookie === "function") {
    const arr = headers.getSetCookie();
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  }

  if (typeof headers.raw === "function") {
    const raw = headers.raw();
    const arr = raw && raw["set-cookie"];
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  }

  if (typeof headers.get === "function") {
    const value = headers.get("set-cookie");
    if (value) return [value];
  }

  return [];
}

function safeJSONParse(input, fallback) {
  try {
    return JSON.parse(input);
  } catch (_) {
    return fallback;
  }
}

function containsSafeLineMarkers(text) {
  return /safeline|SafeLineChallenge|雷池|\/\.safeline\/|Protected By .*WAF|访问已被拦截|Access Forbidden/i.test(
    String(text || "")
  );
}

function extractHeaderValue(headers, key) {
  const lowerKey = String(key || "").toLowerCase();
  if (!headers || typeof headers !== "object") return "";
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === lowerKey) {
      return String(headers[k] || "");
    }
  }
  return "";
}

function isSafeLineChallenge(status, body, headers) {
  if (Number(status) === 468) return true;
  const text = String(body || "");
  const contentType = extractHeaderValue(headers, "content-type");
  if (/text\/html/i.test(contentType) && containsSafeLineMarkers(text)) return true;
  return containsSafeLineMarkers(text);
}

function compactHTTPEvents(events) {
  return (events || []).slice(-6).map((item) => ({
    method: item.method,
    url: item.url,
    status: item.status,
    safeLine: !!item.safeLine,
    error: item.error || "",
  }));
}

function explainFailure(errorText, httpEvents) {
  const text = String(errorText || "");
  const events = Array.isArray(httpEvents) ? httpEvents : [];
  const safeLineEvents = events.filter((item) => item && item.safeLine);
  if (safeLineEvents.length > 0) {
    return {
      reasonCode: "safeline_challenge_blocked",
      reasonText: "偵測到 SafeLine 挑戰頁，導致播放器頁未返回原始 HTML",
    };
  }

  if (/emptyView:/i.test(text)) {
    return {
      reasonCode: "plugin_empty_view",
      reasonText: "插件回傳 emptyView，未取得可播放地址",
    };
  }

  if (/callback timeout/i.test(text)) {
    return {
      reasonCode: "callback_timeout",
      reasonText: "等待插件回調超時，可能是站點回應慢或頁面結構改版",
    };
  }

  return {
    reasonCode: "unknown",
    reasonText: text || "unknown error",
  };
}

function parseArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload == null) return [];
  if (typeof payload === "string") {
    const text = payload.trim();
    if (!text) return [];
    const parsed = safeJSONParse(text, null);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
    return [];
  }
  if (typeof payload === "object") return [payload];
  return [];
}

function pickMediaDetailURL(media) {
  if (!media || typeof media !== "object") return "";
  const candidates = [
    media.detailURLString,
    media.detailURL,
    media.episodeDetailURL,
    media.href,
    media.url,
    media.id,
  ];

  for (const value of candidates) {
    const text = String(value || "").trim();
    if (looksLikeURL(text)) return text;
  }

  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) return text;
  }

  return "";
}

function pickEpisodeURL(episode) {
  if (!episode || typeof episode !== "object") return "";
  const candidates = [
    episode.episodeDetailURL,
    episode.detailURLString,
    episode.playURL,
    episode.url,
    episode.id,
  ];
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (looksLikeURL(text)) return text;
  }
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function normalizePageURL(urlTemplate) {
  return String(urlTemplate || "")
    .replace(/\$\{pageNumber\}/g, "1")
    .replace(/\$\{keyword\}/g, "test");
}

function pickIndexPage(config) {
  const pages = Array.isArray(config && config.pages) ? config.pages : [];
  if (pages.length === 0) return null;

  let page = pages.find((item) => String(item && item.key || "").toLowerCase() === "index");
  if (!page) {
    page = pages.find((item) => /最近|更新|首頁|首页/i.test(String(item && item.title || "")));
  }
  if (!page) page = pages[0];
  return page;
}

function toAbsoluteFilePathIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) return path.resolve(filePath);
  } catch (_) {}
  return "";
}

async function readLocalText(filePath) {
  return await fsp.readFile(filePath, "utf8");
}

async function readRemoteText(url, timeoutMs) {
  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: "*/*",
      },
      redirect: "follow",
    },
    timeoutMs
  );

  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status}`);
  }
  return await res.text();
}

async function resolvePluginSource(subscription, options) {
  const apiURL = normalizeURL(removeSyncnextPluginScheme(subscription.api));
  if (!looksLikeURL(apiURL)) {
    throw new Error(`invalid syncnextPlugin URL: ${subscription.api}`);
  }

  const pluginFolder = extractPluginFolderByConfigURL(apiURL);
  const pluginRoot = options.pluginRoot;
  let mode = "remote";
  let localDir = "";

  if (pluginFolder && pluginRoot) {
    const candidateDir = path.join(pluginRoot, pluginFolder);
    const localConfig = path.join(candidateDir, "config.json");
    if (toAbsoluteFilePathIfExists(localConfig)) {
      mode = "local";
      localDir = candidateDir;
    }
  }

  let configText = "";
  if (mode === "local") {
    configText = await readLocalText(path.join(localDir, "config.json"));
  } else {
    configText = await readRemoteText(apiURL, options.requestTimeoutMs);
  }

  const config = safeJSONParse(configText, null);
  if (!config || typeof config !== "object") {
    throw new Error("config.json parse failed");
  }

  const files = Array.isArray(config.files) ? config.files.slice() : [];
  if (files.length === 0) {
    throw new Error("config.files is empty");
  }

  const baseRemoteURL = apiURL.replace(/\/config\.json(?:[?#].*)?$/i, "");
  const loadedFiles = [];

  for (const fileName of files) {
    const name = String(fileName || "").trim();
    if (!name) continue;

    let content = "";
    if (mode === "local") {
      const abs = path.join(localDir, name);
      content = await readLocalText(abs);
      loadedFiles.push({ name, source: abs, content });
      continue;
    }

    const fileURL = looksLikeURL(name) ? name : `${baseRemoteURL}/${name}`;
    content = await readRemoteText(fileURL, options.requestTimeoutMs);
    loadedFiles.push({ name, source: fileURL, content });
  }

  return {
    subscription,
    apiURL,
    pluginFolder,
    mode,
    config,
    files: loadedFiles,
  };
}

function buildPlayerResult(callbackType, payload) {
  if (callbackType === "toPlayer") {
    return {
      url: String(payload == null ? "" : payload).trim(),
      headers: {},
      raw: payload,
    };
  }

  if (callbackType === "toPlayerByJSON") {
    const parsed =
      typeof payload === "string"
        ? safeJSONParse(payload, {})
        : (payload && typeof payload === "object" ? payload : {});

    return {
      url: String(parsed.url || "").trim(),
      headers: parsed.headers && typeof parsed.headers === "object" ? parsed.headers : {},
      raw: payload,
    };
  }

  if (callbackType === "toPlayerCandidates") {
    const parsed =
      typeof payload === "string"
        ? safeJSONParse(payload, {})
        : (payload && typeof payload === "object" ? payload : {});
    const list = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const first = list[0] || {};
    const url = typeof first === "string" ? first : String(first.url || "");
    const headers =
      first && typeof first === "object" && first.headers && typeof first.headers === "object"
        ? first.headers
        : {};
    return {
      url: url.trim(),
      headers,
      raw: payload,
    };
  }

  return { url: "", headers: {}, raw: payload };
}

function buildInvocationAdapter(options) {
  const state = {
    pending: null,
    emptyViews: [],
  };

  function reset() {
    state.pending = null;
    state.emptyViews = [];
  }

  function setPending(expected, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending = null;
        const hint =
          state.emptyViews.length > 0
            ? `; emptyView=${state.emptyViews[state.emptyViews.length - 1]}`
            : "";
        reject(new Error(`callback timeout (${expected})${hint}`));
      }, timeoutMs);

      state.pending = {
        expected,
        resolve,
        reject,
        timer,
      };
    });
  }

  function clearPending() {
    if (!state.pending) return;
    clearTimeout(state.pending.timer);
    state.pending = null;
  }

  function isAccepted(expected, callbackType) {
    if (expected === "medias") {
      return callbackType === "toMedias" || callbackType === "toSearchMedias";
    }
    if (expected === "episodes") {
      return callbackType === "toEpisodes" || callbackType === "toEpisodesCandidates";
    }
    if (expected === "player") {
      return (
        callbackType === "toPlayer" ||
        callbackType === "toPlayerByJSON" ||
        callbackType === "toPlayerCandidates"
      );
    }
    return false;
  }

  function onCallback(callbackType, payload, key) {
    if (!state.pending) return;
    if (!isAccepted(state.pending.expected, callbackType)) return;

    const pending = state.pending;
    clearPending();
    pending.resolve({
      callbackType,
      payload,
      key,
      emptyViews: state.emptyViews.slice(),
    });
  }

  function onEmptyView(message) {
    const text = String(message == null ? "" : message);
    state.emptyViews.push(text);

    if (
      options.failOnEmptyView &&
      state.pending &&
      (state.pending.expected === "player" || state.pending.expected === "episodes")
    ) {
      const pending = state.pending;
      clearPending();
      pending.reject(new Error(`emptyView: ${text || "unknown"}`));
    }
  }

  async function invoke(context, fnName, args, expected, timeoutMs) {
    reset();
    const fn = context[fnName];
    if (typeof fn !== "function") {
      throw new Error(`function not found: ${fnName}`);
    }

    const waitCallback = setPending(expected, timeoutMs);

    try {
      const ret = fn.apply(context, args || []);
      if (ret && typeof ret.then === "function") {
        ret.catch((error) => {
          if (state.pending) {
            const pending = state.pending;
            clearPending();
            pending.reject(error);
          }
        });
      }
    } catch (error) {
      clearPending();
      throw error;
    }

    return await waitCallback;
  }

  return {
    onCallback,
    onEmptyView,
    invoke,
  };
}

function createPluginRuntime(pluginSource, options, logger) {
  const adapter = buildInvocationAdapter(options);
  const httpEvents = [];

  function pushHTTPEvent(event) {
    httpEvents.push(event);
    if (httpEvents.length > 500) {
      httpEvents.shift();
    }
  }

  async function doHTTP(req, methodOverride) {
    const request = req && typeof req === "object" ? req : {};
    const url = String(request.url || "").trim();
    if (!url) {
      throw new Error("$http.fetch missing req.url");
    }

    const method = String(methodOverride || request.method || "GET").toUpperCase();
    const headers = Object.assign({}, request.headers || {});
    if (!headers["User-Agent"] && !headers["user-agent"]) {
      headers["User-Agent"] = DEFAULT_UA;
    }

    const fetchOptions = {
      method,
      headers,
      redirect: "follow",
    };

    if (method !== "HEAD" && request.body != null && method !== "GET") {
      fetchOptions.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    }

    const event = {
      at: isoNow(),
      method,
      url,
      status: 0,
      safeLine: false,
      error: "",
    };

    try {
      const response = await fetchWithTimeout(url, fetchOptions, options.requestTimeoutMs);
      const responseHeaders = headersToObject(response.headers);
      let body = method === "HEAD" ? "" : await response.text();
      let status = response.status;
      let finalURL = response.url;

      event.status = status;
      event.safeLine = method === "GET" && isSafeLineChallenge(status, body, responseHeaders);

      pushHTTPEvent(event);

      return {
        status,
        statusCode: status,
        headers: responseHeaders,
        body,
        url: finalURL,
      };
    } catch (error) {
      event.error = error.message || String(error);
      if (options.verboseConsole) {
        logger.error(`[http-error] ${method} ${url} -> ${error.message || error}`);
      }
      pushHTTPEvent(event);
      return {
        status: 0,
        statusCode: 0,
        headers: {},
        body: "",
        url,
        error: error.message || String(error),
      };
    }
  }

  const context = {
    console: {
      log: (...args) => {
        if (!options.verboseConsole) return;
        logger.log(
          `[plugin-log] ${args
            .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
            .join(" ")}`
        );
      },
      error: (...args) => {
        logger.error(
          `[plugin-error] ${args
            .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
            .join(" ")}`
        );
      },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Buffer,
    URL,
    URLSearchParams,
    atob: (input) => Buffer.from(String(input || ""), "base64").toString("binary"),
    btoa: (input) => Buffer.from(String(input || ""), "binary").toString("base64"),
    $http: {
      fetch: (req) => doHTTP(req, null),
      head: (req) => doHTTP(req, "HEAD"),
    },
    $next: {
      toMedias: (json, key) => adapter.onCallback("toMedias", json, key),
      toSearchMedias: (json, key) => adapter.onCallback("toSearchMedias", json, key),
      toEpisodes: (json, key) => adapter.onCallback("toEpisodes", json, key),
      toEpisodesCandidates: (json, key) => adapter.onCallback("toEpisodesCandidates", json, key),
      toPlayer: (value, key) => adapter.onCallback("toPlayer", value, key),
      toPlayerByJSON: (json, key) => adapter.onCallback("toPlayerByJSON", json, key),
      toPlayerCandidates: (json, key) => adapter.onCallback("toPlayerCandidates", json, key),
      emptyView: (msg) => adapter.onEmptyView(msg),
      aliLink: () => {},
      aliPlay: () => {},
    },
  };

  context.window = context;
  context.global = context;
  context.self = context;

  vm.createContext(context);

  for (const file of pluginSource.files) {
    vm.runInContext(file.content, context, {
      filename: file.name,
      timeout: options.vmLoadTimeoutMs,
    });
  }

  return {
    context,
    invoke: (fnName, args, expected, timeoutMs) =>
      adapter.invoke(context, fnName, args, expected, timeoutMs),
    getHTTPEvents: () => httpEvents.slice(),
    getHTTPEventsSince: (index) => httpEvents.slice(index || 0),
  };
}

function stageTimeoutMs(stageConfig, fallbackMs) {
  const sec = Number(stageConfig && stageConfig.timeout);
  if (Number.isFinite(sec) && sec > 0) {
    return Math.max(fallbackMs, Math.floor(sec * 1000) + 5000);
  }
  return fallbackMs;
}

async function probePlayableURL(url, headers, options) {
  const result = {
    ok: false,
    method: "HEAD",
    status: 0,
    contentType: "",
    error: "",
  };

  const target = String(url || "").trim();
  if (!looksLikeURL(target)) {
    result.error = "non-http url";
    return result;
  }

  const reqHeaders = Object.assign({}, headers || {});
  if (!reqHeaders["User-Agent"] && !reqHeaders["user-agent"]) {
    reqHeaders["User-Agent"] = DEFAULT_UA;
  }

  try {
    const headRes = await fetchWithTimeout(
      target,
      {
        method: "HEAD",
        headers: reqHeaders,
        redirect: "follow",
      },
      options.probeTimeoutMs
    );
    result.status = headRes.status;
    result.contentType = headRes.headers.get("content-type") || "";

    if (headRes.status >= 200 && headRes.status < 400) {
      result.ok = true;
      return result;
    }
  } catch (error) {
    result.error = error.message || String(error);
  }

  result.method = "GET";
  const getHeaders = Object.assign({}, reqHeaders, { Range: "bytes=0-1023" });

  try {
    const getRes = await fetchWithTimeout(
      target,
      {
        method: "GET",
        headers: getHeaders,
        redirect: "follow",
      },
      options.probeTimeoutMs
    );

    const body = await getRes.text();
    const contentType = getRes.headers.get("content-type") || "";

    result.status = getRes.status;
    result.contentType = contentType;

    const looksLikeMediaType =
      /mpegurl|video|octet-stream|application\/vnd\.apple\.mpegurl|audio/i.test(contentType);
    const looksLikeM3U8 = /^#EXTM3U/i.test(String(body || "").trim());
    const looksLikeMediaURL = /\.(m3u8|mp4|m4v|mov|flv|ts)(\?|$)/i.test(target);

    if (getRes.status >= 200 && getRes.status < 400 && (looksLikeMediaType || looksLikeM3U8 || looksLikeMediaURL)) {
      result.ok = true;
      return result;
    }

    if (!result.error) {
      result.error = `status ${getRes.status}`;
    }
  } catch (error) {
    result.error = error.message || String(error);
  }

  return result;
}

function buildSubscriptionLabel(entry, index) {
  const name = String(entry.name || entry.title || "").trim();
  if (name) return name;
  return `plugin-${index + 1}`;
}

async function runSinglePlugin(subscription, index, options, logger) {
  const startedAt = isoNow();
  const pluginReport = {
    index: index + 1,
    subscriptionName: buildSubscriptionLabel(subscription, index),
    api: subscription.api,
    startedAt,
    endedAt: "",
    mode: "",
    pluginName: "",
    pluginFolder: "",
    indexPage: null,
    summary: {
      casesTotal: 0,
      ok: 0,
      fail: 0,
    },
    cases: [],
    errors: [],
  };

  try {
    const source = await resolvePluginSource(subscription, options);
    pluginReport.mode = source.mode;
    pluginReport.pluginFolder = source.pluginFolder;
    pluginReport.pluginName = String(source.config.name || pluginReport.subscriptionName);
    const runtime = createPluginRuntime(source, options, logger);

    function buildFailureMeta(errorText, stageEvents) {
      const explained = explainFailure(errorText, stageEvents);
      return {
        reasonCode: explained.reasonCode,
        reasonText: explained.reasonText,
        httpDiagnostics: compactHTTPEvents(stageEvents),
      };
    }

    const indexPage = pickIndexPage(source.config);
    if (!indexPage || !indexPage.javascript || !indexPage.url) {
      throw new Error("index page config missing");
    }

    const indexURL = normalizePageURL(indexPage.url);
    const indexTimeout = stageTimeoutMs(indexPage, options.invokeTimeoutMs);
    const episodesTimeout = stageTimeoutMs(source.config.episodes, options.invokeTimeoutMs);
    const playerTimeout = stageTimeoutMs(source.config.player, options.invokeTimeoutMs);
    pluginReport.indexPage = {
      key: indexPage.key || "",
      title: indexPage.title || "",
      url: indexURL,
      javascript: indexPage.javascript,
    };

    logger.log(
      `[plugin ${index + 1}] ${pluginReport.pluginName} | mode=${source.mode} | index=${indexURL}`
    );

    const mediasResult = await runtime.invoke(
      indexPage.javascript,
      [indexURL, source.apiURL],
      "medias",
      indexTimeout
    );
    const medias = parseArrayPayload(mediasResult.payload);
    const selectedMedias =
      options.limitMedias > 0 ? medias.slice(0, options.limitMedias) : medias.slice();

    logger.log(
      `[plugin ${index + 1}] medias total=${medias.length}, testing=${selectedMedias.length}`
    );

    if (selectedMedias.length === 0) {
      const mediaFailure = explainFailure("no medias returned", runtime.getHTTPEvents());
      throw new Error(`no medias returned; ${mediaFailure.reasonText}`);
    }

    for (let mediaIndex = 0; mediaIndex < selectedMedias.length; mediaIndex++) {
      const media = selectedMedias[mediaIndex];
      const mediaTitle = String(media && media.title || `media-${mediaIndex + 1}`);
      const detailURL = pickMediaDetailURL(media);

      if (!detailURL) {
        const failureMeta = buildFailureMeta("detailURL missing", []);
        pluginReport.cases.push({
          ok: false,
          stage: "episodes",
          mediaTitle,
          episodeTitle: "",
          detailURL: "",
          episodeURL: "",
          playURL: "",
          probe: null,
          error: "detailURL missing",
          reasonCode: failureMeta.reasonCode,
          reasonText: failureMeta.reasonText,
          httpDiagnostics: failureMeta.httpDiagnostics,
        });
        logger.log(`[FAIL] ${pluginReport.pluginName} | ${mediaTitle} | detailURL missing`);
        continue;
      }

      let episodesResult;
      const episodesHTTPIndex = runtime.getHTTPEvents().length;
      try {
        episodesResult = await runtime.invoke(
          source.config.episodes && source.config.episodes.javascript,
          [detailURL],
          "episodes",
          episodesTimeout
        );
      } catch (error) {
        const stageEvents = runtime.getHTTPEventsSince(episodesHTTPIndex);
        const failureMeta = buildFailureMeta(error.message || String(error), stageEvents);
        pluginReport.cases.push({
          ok: false,
          stage: "episodes",
          mediaTitle,
          episodeTitle: "",
          detailURL,
          episodeURL: "",
          playURL: "",
          probe: null,
          error: error.message || String(error),
          reasonCode: failureMeta.reasonCode,
          reasonText: failureMeta.reasonText,
          httpDiagnostics: failureMeta.httpDiagnostics,
        });
        logger.log(
          `[FAIL] ${pluginReport.pluginName} | ${mediaTitle} | episodes -> ${error.message || error} | reason=${failureMeta.reasonCode}`
        );
        continue;
      }

      let episodes = [];
      if (episodesResult.callbackType === "toEpisodesCandidates") {
        const parsed =
          typeof episodesResult.payload === "string"
            ? safeJSONParse(episodesResult.payload, {})
            : (episodesResult.payload && typeof episodesResult.payload === "object"
                ? episodesResult.payload
                : {});
        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        const firstCandidate = candidates[0] || {};
        episodes = parseArrayPayload(firstCandidate.list || firstCandidate.episodes || []);
      } else {
        episodes = parseArrayPayload(episodesResult.payload);
      }

      const targetEpisodes = options.allEpisodes ? episodes : episodes.slice(0, 1);
      if (targetEpisodes.length === 0) {
        const failureMeta = buildFailureMeta("no episodes", runtime.getHTTPEventsSince(episodesHTTPIndex));
        pluginReport.cases.push({
          ok: false,
          stage: "episodes",
          mediaTitle,
          episodeTitle: "",
          detailURL,
          episodeURL: "",
          playURL: "",
          probe: null,
          error: "no episodes",
          reasonCode: failureMeta.reasonCode,
          reasonText: failureMeta.reasonText,
          httpDiagnostics: failureMeta.httpDiagnostics,
        });
        logger.log(
          `[FAIL] ${pluginReport.pluginName} | ${mediaTitle} | no episodes | reason=${failureMeta.reasonCode}`
        );
        continue;
      }

      for (let epIndex = 0; epIndex < targetEpisodes.length; epIndex++) {
        const episode = targetEpisodes[epIndex];
        const episodeTitle = String(episode && episode.title || `episode-${epIndex + 1}`);
        const episodeURL = pickEpisodeURL(episode);

        if (!episodeURL) {
          const failureMeta = buildFailureMeta("episodeURL missing", []);
          pluginReport.cases.push({
            ok: false,
            stage: "player",
            mediaTitle,
            episodeTitle,
            detailURL,
            episodeURL: "",
            playURL: "",
            probe: null,
            error: "episodeURL missing",
            reasonCode: failureMeta.reasonCode,
            reasonText: failureMeta.reasonText,
            httpDiagnostics: failureMeta.httpDiagnostics,
          });
          logger.log(
            `[FAIL] ${pluginReport.pluginName} | ${mediaTitle} | ${episodeTitle} | episodeURL missing | reason=${failureMeta.reasonCode}`
          );
          continue;
        }

        const playerHTTPIndex = runtime.getHTTPEvents().length;
        try {
          const playerCallback = await runtime.invoke(
            source.config.player && source.config.player.javascript,
            [episodeURL],
            "player",
            playerTimeout
          );

          const player = buildPlayerResult(playerCallback.callbackType, playerCallback.payload);
          const playURL = String(player.url || "").trim();
          if (!playURL) {
            const failureMeta = buildFailureMeta("empty play url", runtime.getHTTPEventsSince(playerHTTPIndex));
            pluginReport.cases.push({
              ok: false,
              stage: "player",
              mediaTitle,
              episodeTitle,
              detailURL,
              episodeURL,
              playURL: "",
              probe: null,
              error: "empty play url",
              reasonCode: failureMeta.reasonCode,
              reasonText: failureMeta.reasonText,
              httpDiagnostics: failureMeta.httpDiagnostics,
            });
            logger.log(
              `[FAIL] ${pluginReport.pluginName} | ${mediaTitle} | ${episodeTitle} -> empty play url | reason=${failureMeta.reasonCode}`
            );
            continue;
          }

          let probe = null;
          if (options.enableProbe) {
            probe = await probePlayableURL(playURL, player.headers, options);
          }

          const ok = options.strictProbe ? !!(probe && probe.ok) : true;
          pluginReport.cases.push({
            ok,
            stage: "player",
            mediaTitle,
            episodeTitle,
            detailURL,
            episodeURL,
            playURL,
            probe,
            error: ok ? "" : (probe && probe.error ? probe.error : "probe failed"),
            reasonCode: ok ? "" : "probe_failed",
            reasonText: ok ? "" : "播放鏈可取得，但 probe 檢測未通過",
            httpDiagnostics: ok ? [] : compactHTTPEvents(runtime.getHTTPEventsSince(playerHTTPIndex)),
          });

          logger.log(
            `[${ok ? "OK" : "FAIL"}] ${pluginReport.pluginName} | ${mediaTitle} | ${episodeTitle} -> ${playURL}`
          );
        } catch (error) {
          const stageEvents = runtime.getHTTPEventsSince(playerHTTPIndex);
          const failureMeta = buildFailureMeta(error.message || String(error), stageEvents);
          pluginReport.cases.push({
            ok: false,
            stage: "player",
            mediaTitle,
            episodeTitle,
            detailURL,
            episodeURL,
            playURL: "",
            probe: null,
            error: error.message || String(error),
            reasonCode: failureMeta.reasonCode,
            reasonText: failureMeta.reasonText,
            httpDiagnostics: failureMeta.httpDiagnostics,
          });
          logger.log(
            `[FAIL] ${pluginReport.pluginName} | ${mediaTitle} | ${episodeTitle} -> ${error.message || error} | reason=${failureMeta.reasonCode}`
          );
        }
      }
    }
  } catch (error) {
    pluginReport.errors.push(error.message || String(error));
  }

  pluginReport.summary.casesTotal = pluginReport.cases.length;
  pluginReport.summary.ok = pluginReport.cases.filter((item) => item.ok).length;
  pluginReport.summary.fail = pluginReport.cases.filter((item) => !item.ok).length;
  pluginReport.endedAt = isoNow();

  return pluginReport;
}

async function main() {
  const timestamp = tsCompact();
  const sourcesPath = path.resolve(getArg("sources", path.join(__dirname, "sourcesv3.json")));
  const outputDir = path.resolve(getArg("output-dir", __dirname));
  const outputFolderName = getArg("output-folder", "syncnextPlugin_play_test_runs");
  const managedOutputRoot = path.join(outputDir, outputFolderName);
  const runOutputDir = path.join(managedOutputRoot, timestamp);
  const pluginRoot = path.resolve(
    getArg("plugin-root", path.resolve(__dirname, "..", "SyncnextPlugin_official"))
  );
  const limitMedias = toInt(getArg("limit-medias", "3"), 3);
  const invokeTimeoutMs = toInt(getArg("invoke-timeout-ms", "45000"), 45000);
  const requestTimeoutMs = toInt(getArg("request-timeout-ms", "25000"), 25000);
  const probeTimeoutMs = toInt(getArg("probe-timeout-ms", "15000"), 15000);
  const vmLoadTimeoutMs = toInt(getArg("vm-load-timeout-ms", "8000"), 8000);
  const maxPlugins = toInt(getArg("max-plugins", "0"), 0);
  const onlyFilter = String(getArg("only", "") || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const options = {
    pluginRoot,
    limitMedias,
    allEpisodes: hasFlag("all-episodes"),
    strictProbe: hasFlag("strict-probe"),
    enableProbe: !hasFlag("no-probe"),
    failOnEmptyView: !hasFlag("allow-emptyview"),
    invokeTimeoutMs,
    requestTimeoutMs,
    probeTimeoutMs,
    vmLoadTimeoutMs,
    verboseConsole: hasFlag("verbose-console"),
  };

  await fsp.mkdir(runOutputDir, { recursive: true });

  const logPath = path.join(runOutputDir, "run.log");
  const reportPath = path.join(runOutputDir, "report.json");
  const latestPath = path.join(managedOutputRoot, "latest.json");
  const latestLogPath = path.join(managedOutputRoot, "latest.log");

  const logger = createLogger(logPath);
  logger.log(`[log] ${logPath}`);
  logger.log(`[sources] ${sourcesPath}`);
  logger.log(`[output] ${reportPath}`);

  try {
    const raw = await readLocalText(sourcesPath);
    const list = safeJSONParse(raw, null);
    if (!Array.isArray(list)) {
      throw new Error("sources file is not an array");
    }

    const syncnextPluginList = list.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        /^syncnextplugin:\/\//i.test(String(item.api || ""))
    );

    let filtered = syncnextPluginList.slice();
    if (onlyFilter.length > 0) {
      filtered = filtered.filter((entry) => {
        const label = buildSubscriptionLabel(entry, 0).toLowerCase();
        const folder = extractPluginFolderByConfigURL(removeSyncnextPluginScheme(entry.api)).toLowerCase();
        return onlyFilter.includes(label) || onlyFilter.includes(folder);
      });
    }
    if (maxPlugins > 0) {
      filtered = filtered.slice(0, maxPlugins);
    }

    logger.log(
      `[subscriptions] total=${list.length}, syncnextPlugin=${syncnextPluginList.length}, testing=${filtered.length}`
    );

    const pluginReports = [];
    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const report = await runSinglePlugin(entry, i, options, logger);
      pluginReports.push(report);
    }

    const allCases = pluginReports.flatMap((item) => item.cases);
    const report = {
      generatedAt: isoNow(),
      sourcesPath,
      outputDir: runOutputDir,
      options: {
        limitMedias: options.limitMedias,
        allEpisodes: options.allEpisodes,
        strictProbe: options.strictProbe,
        enableProbe: options.enableProbe,
        invokeTimeoutMs: options.invokeTimeoutMs,
        requestTimeoutMs: options.requestTimeoutMs,
        probeTimeoutMs: options.probeTimeoutMs,
        pluginRoot: options.pluginRoot,
      },
      summary: {
        pluginsTotal: pluginReports.length,
        pluginsWithFatalErrors: pluginReports.filter((item) => item.errors.length > 0).length,
        casesTotal: allCases.length,
        ok: allCases.filter((item) => item.ok).length,
        fail: allCases.filter((item) => !item.ok).length,
      },
      plugins: pluginReports,
    };

    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    await fsp.writeFile(latestPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    await fsp.copyFile(logPath, latestLogPath);

    logger.log(
      `[summary] plugins=${report.summary.pluginsTotal}, fatal=${report.summary.pluginsWithFatalErrors}, cases=${report.summary.casesTotal}, ok=${report.summary.ok}, fail=${report.summary.fail}`
    );
    logger.log(`[report] ${reportPath}`);
    logger.log(`[latest] ${latestPath}`);
    logger.log(`[latest-log] ${latestLogPath}`);

    if (report.summary.fail > 0 || report.summary.pluginsWithFatalErrors > 0) {
      process.exitCode = 1;
    }
  } finally {
    logger.close();
  }
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${error.message || error}\n`);
  process.exit(1);
});
