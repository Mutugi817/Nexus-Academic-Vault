'use strict';

const axios = require('axios');
const fflate = require('fflate');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const httpSrv = require('http');

// ============================================================
// NEXUS ACADEMIC VAULT DOWNLOADER
// Node.js + axios + fs + path + readline + http + fflate
// ============================================================

const API_BASE = 'https://repository.chuka.ac.ke/server/api';
const REPOSITORY_BASE = 'https://repository.chuka.ac.ke';

const CONFIG = {
  rootCommunity: {
    name: 'Examination Past Papers',
    uuid: 'ea404f68-df7a-4d01-9c96-e4912b94ba96',
    type: 'community',
  },

  outputDir: path.resolve(__dirname, 'downloads'),
  manifestFile: path.resolve(__dirname, 'download-manifest.json'),
  failedFile: path.resolve(__dirname, 'failed-downloads.json'),
  debugDir: path.resolve(__dirname, 'debug'),

  pageSize: 20,
  maxRetries: 4,
  requestTimeout: 30000,
  delayMin: 300,
  delayMax: 700,

  downloadConcurrency: 4,

  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/150.0.0.0 Safari/537.36',
};

const http = axios.create({
  baseURL: API_BASE,
  timeout: CONFIG.requestTimeout,
  headers: {
    'User-Agent': CONFIG.userAgent,
    Accept: 'application/json',
  },
  validateStatus: () => true,
});

let manifest = {};
let failures = [];

// GLOBAL CACHE FOR WEB GUI
const guiPaperCache = new Map();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ============================================================
// GENERAL HELPERS
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return (
    Math.floor(Math.random() * (CONFIG.delayMax - CONFIG.delayMin + 1)) +
    CONFIG.delayMin
  );
}

function ask(question) {
  return new Promise((resolve) =>
    rl.question(question, (answer) => resolve(answer.trim())),
  );
}

function clearScreen() {
  process.stdout.write('\x1Bc');
}

function line(char = '=', length = 60) {
  console.log(char.repeat(length));
}

function title(text) {
  console.log('');
  line();
  console.log(` ${text}`);
  line();
  console.log('');
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value))
    return value.map(normalizeText).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    if (value.value !== undefined) return normalizeText(value.value);
    if (value.text !== undefined) return normalizeText(value.text);
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function sanitizeWindowsName(value, fallback = 'Unknown') {
  let name = normalizeText(value) || fallback;
  name = name.replace(/[<>:"/\\|?*]/g, '_');
  name = name.replace(/[\x00-\x1F]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/[. ]+$/g, '');

  const reserved = new Set([
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  ]);

  if (reserved.has(name.split('.')[0].toUpperCase())) name = `_${name}`;
  return name.substring(0, 180).trim();
}

function absoluteUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `${REPOSITORY_BASE}${url}`;
  return `${API_BASE}/${url.replace(/^\/+/, '')}`;
}

function getHalLink(resource, relation) {
  const href = resource?._links?.[relation]?.href;
  if (Array.isArray(href)) return href[0] || null;
  return href || null;
}

function uuidFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(
    /\/(?:items|communities|collections|bundles|bitstreams)\/([0-9a-f-]{20,})/i,
  );
  return match ? match[1] : null;
}

function getUuid(resource) {
  return (
    resource?.uuid ||
    resource?.id ||
    uuidFromUrl(getHalLink(resource, 'self')) ||
    uuidFromUrl(resource?.self) ||
    uuidFromUrl(resource?.href) ||
    null
  );
}

async function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = await fs.promises.readFile(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

async function saveManifest() {
  await saveJson(CONFIG.manifestFile, manifest);
}
async function saveFailures() {
  await saveJson(CONFIG.failedFile, failures);
}

function isRetryable(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

// ============================================================
// HTTP CORE
// ============================================================

async function request(config, label = 'request', options = {}) {
  const allow404 = options.allow404 === true;
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      await sleep(randomDelay());
      const response = await http.request(config);
      if (response.status >= 200 && response.status < 300) return response;
      if (allow404 && response.status === 404) return response;
      const retry = isRetryable(response.status);

      if (!retry || attempt === CONFIG.maxRetries) {
        throw new Error(`${label}: HTTP ${response.status}`);
      }
      console.log(
        `[RETRY] ${label}: HTTP ${response.status}, attempt ${attempt}/${CONFIG.maxRetries}`,
      );
    } catch (error) {
      lastError = error;
      if (attempt === CONFIG.maxRetries) throw error;
      console.log(
        `[RETRY] ${label}: ${error.message}, attempt ${attempt}/${CONFIG.maxRetries}`,
      );
    }
    await sleep(1500 * attempt);
  }
  throw lastError || new Error(`${label} failed`);
}

// ============================================================
// DSPACE RESPONSE HELPERS
// ============================================================

function arraysFromEmbedded(data, names) {
  const out = [];
  function add(value) {
    if (Array.isArray(value)) for (const x of value) out.push(x);
  }
  const embedded = data?._embedded || {};
  for (const name of names) {
    add(embedded[name]);
    add(data?.[name]);
  }
  return out;
}

function pageInfo(data) {
  return (
    data?.page ||
    data?._embedded?.page ||
    data?._embedded?.searchResult?.page ||
    data?.pagination ||
    {}
  );
}

function extractDiscoveryItems(data) {
  const found = new Map();

  function looksLikeItem(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const self = getHalLink(obj, 'self');
    const uuid = getUuid(obj);
    if (!uuid) return false;
    if (self && /\/core\/items\//i.test(self)) return true;
    const metadata = obj.metadata;
    const title = metadata?.['dc.title'] || obj.title || obj.name;
    return (
      Boolean(title) &&
      (obj.type === 'item' ||
        obj.entityType === 'ITEM' ||
        obj._links?.bundles ||
        obj._links?.bitstreams)
    );
  }

  function visit(obj, depth = 0) {
    if (!obj || depth > 12) return;
    if (Array.isArray(obj)) {
      for (const child of obj) visit(child, depth + 1);
      return;
    }
    if (typeof obj !== 'object') return;
    if (looksLikeItem(obj)) found.set(getUuid(obj), obj);
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'page') continue;
      visit(value, depth + 1);
    }
  }

  visit(data);
  return Array.from(found.values());
}

// ============================================================
// COMMUNITY / COLLECTION NAVIGATION
// ============================================================

async function getCommunity(uuid) {
  const response = await request(
    { method: 'GET', url: `/core/communities/${uuid}` },
    `Community ${uuid}`,
  );
  return response.data;
}

async function getCollection(uuid) {
  const response = await request(
    { method: 'GET', url: `/core/collections/${uuid}` },
    `Collection ${uuid}`,
  );
  return response.data;
}

async function getRelatedCollectionLinks(community) {
  const href =
    getHalLink(community, 'collections') ||
    `/core/communities/${getUuid(community)}/collections`;
  const response = await request(
    { method: 'GET', url: absoluteUrl(href) },
    `Collections for ${getUuid(community)}`,
  );
  return extractResourceList(response.data, ['collections', 'entries']);
}

async function getSubcommunityLinks(community) {
  const href =
    getHalLink(community, 'subcommunities') ||
    `/core/communities/${getUuid(community)}/subcommunities`;
  const response = await request(
    { method: 'GET', url: absoluteUrl(href) },
    `Subcommunities for ${getUuid(community)}`,
  );
  return extractResourceList(response.data, [
    'subcommunities',
    'communities',
    'entries',
  ]);
}

function extractResourceList(data, names) {
  const direct = arraysFromEmbedded(data, names);
  if (direct.length) return direct;
  const found = new Map();

  function visit(obj, depth = 0) {
    if (!obj || depth > 8) return;
    if (Array.isArray(obj)) {
      for (const x of obj) visit(x, depth + 1);
      return;
    }
    if (typeof obj !== 'object') return;
    const self = getHalLink(obj, 'self') || obj.self || '';
    if (/\/core\/(communities|collections)\//i.test(self)) {
      const uuid = getUuid(obj);
      if (uuid) found.set(uuid, obj);
    }
    for (const value of Object.values(obj)) visit(value, depth + 1);
  }

  visit(data);
  return Array.from(found.values());
}

function resourceName(resource, fallback = 'Unnamed') {
  return normalizeText(
    resource?.name ||
      resource?.metadata?.['dc.title']?.[0]?.value ||
      resource?.metadata?.['dc.title']?.[0]?.text ||
      resource?.title ||
      fallback,
  );
}

// ============================================================
// DISCOVERY (LOAD SINGLE PAGE AT A TIME)
// ============================================================

async function discoverCollection(uuid, query = '', page = 0) {
  const items = new Map();
  let totalPages = 1;
  let totalElements = 0;

  console.log(`Requesting page ${page + 1}...`);
  const response = await request(
    {
      method: 'GET',
      url: '/discover/search/objects',
      params: { query, scope: uuid, page, size: CONFIG.pageSize },
    },
    `Discovery page ${page + 1}`,
  );

  const data = response.data;
  const info = pageInfo(data);

  if (info.totalPages !== undefined) totalPages = Number(info.totalPages);
  if (info.totalElements !== undefined)
    totalElements = Number(info.totalElements);

  const discovered = extractDiscoveryItems(data);
  for (const item of discovered) {
    const itemUuid = getUuid(item);
    if (itemUuid) items.set(itemUuid, item);
  }

  return {
    items: Array.from(items.values()),
    page: Number(page),
    totalPages: totalPages || 1,
    totalElements: totalElements || items.size,
  };
}

// ============================================================
// ITEM METADATA & PDF VALIDATION
// ============================================================

async function getItemBundles(item) {
  const itemUuid = getUuid(item);
  let href = getHalLink(item, 'bundles') || `/core/items/${itemUuid}/bundles`;
  const response = await request(
    { method: 'GET', url: absoluteUrl(href) },
    `Bundles for item ${itemUuid}`,
  );
  return extractResourceList(response.data, ['bundles', 'entries']);
}

async function getBundleBitstreams(bundle) {
  const bundleUuid = getUuid(bundle);
  let href =
    getHalLink(bundle, 'bitstreams') ||
    `/core/bundles/${bundleUuid}/bitstreams`;
  const response = await request(
    { method: 'GET', url: absoluteUrl(href) },
    `Bitstreams for bundle ${bundleUuid}`,
  );
  return extractResourceList(response.data, ['bitstreams', 'entries']);
}

function findOriginalBundle(bundles) {
  return bundles.find(
    (b) => normalizeText(b.name || b.bundleName).toUpperCase() === 'ORIGINAL',
  );
}

function isPdf(bitstream) {
  const mime = normalizeText(
    bitstream.format?.mimetype || bitstream.mimetype || bitstream.mimeType,
  ).toLowerCase();
  const name = normalizeText(
    bitstream.name || bitstream.filename || bitstream.originalName,
  ).toLowerCase();
  return mime.includes('pdf') || name.endsWith('.pdf');
}

function metadataValues(item, key) {
  const result = [];
  function addFromObject(obj) {
    if (!obj || typeof obj !== 'object') return;
    const metadata = obj.metadata;
    if (metadata && !Array.isArray(metadata) && typeof metadata === 'object') {
      const value = metadata[key];
      if (value !== undefined) {
        const values = Array.isArray(value) ? value : [value];
        for (const x of values) {
          const normalized = normalizeText(x?.value ?? x?.text ?? x);
          if (normalized) result.push(normalized);
        }
      }
    }
    if (Array.isArray(metadata)) {
      for (const field of metadata) {
        if (field?.key === key || field?.metadata_field === key) {
          const normalized = normalizeText(field.value ?? field.text ?? field);
          if (normalized) result.push(normalized);
        }
      }
    }
  }
  addFromObject(item);
  return [...new Set(result)];
}

function allTitleText(item) {
  return [
    ...metadataValues(item, 'dc.title'),
    ...metadataValues(item, 'dc.title.alternative'),
    ...metadataValues(item, 'title'),
    ...metadataValues(item, 'name'),
  ].filter(Boolean);
}

function extractCourseCode(item) {
  const match = allTitleText(item)
    .join(' ')
    .match(/\b([A-Z]{2,8})\s*[-_]?\s*(\d{3,6})\b/i);
  return match ? `${match[1].toUpperCase()} ${match[2]}` : '';
}

function extractCourseTitle(item) {
  const code = extractCourseCode(item);
  const titles = allTitleText(item);
  for (const original of titles) {
    let title = original;
    if (code) {
      const escaped = code
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/, '\\s*');
      title = title.replace(new RegExp(`\\b${escaped}\\b`, 'i'), '');
    }
    title = title.replace(/^\s*[:\-–—|]+\s*/, '').trim();
    if (title)
      return sanitizeWindowsName(title.toUpperCase(), 'Unknown Course');
  }
  return 'Unknown Course';
}

function extractYear(item) {
  for (const field of ['dc.date.issued', 'dc.date.created', 'dc.date']) {
    for (const value of metadataValues(item, field)) {
      const match = value.match(/\b(19|20)\d{2}\b/);
      if (match) return match[0];
    }
  }
  return 'Unknown Year';
}

function extractExamType(item) {
  const text = allTitleText(item).join(' ').toLowerCase();
  if (
    text.includes('resit') ||
    text.includes('supplementary') ||
    text.includes('special')
  )
    return 'Resit-Special Exam';
  return 'Main Exam';
}

// ADDED: Logic to extract streams/semesters/modes of study
function extractStream(item) {
  const text = allTitleText(item).join(' ').toUpperCase();
  // Look for common patterns like Y1S1, Year 1 Sem 2, Sem 1, School Based, Regular, Part Time
  const match = text.match(
    /\b(Y\d\s*S\d|YEAR\s*\d\s*SEME[A-Z]*\s*\d|SEM\s*\d|SCHOOL\s*BASED|REGULAR|PART\s*TIME)\b/i,
  );
  return match ? match[0].toUpperCase().replace(/\s+/g, ' ') : '';
}

function paperInfo(item) {
  return {
    uuid: getUuid(item),
    title: allTitleText(item)[0] || 'Untitled Paper',
    courseCode: extractCourseCode(item),
    courseTitle: extractCourseTitle(item),
    year: extractYear(item),
    examType: extractExamType(item),
    stream: extractStream(item), // Now extracting streams
    item,
  };
}

async function validPdf(file) {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size < 5) return false;
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(5);
      await handle.read(buffer, 0, 5, 0);
      return buffer.toString('ascii') === '%PDF-';
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function uniquePdfPath(directory, baseName) {
  let name = sanitizeWindowsName(baseName, 'past-paper');
  if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
  let candidate = path.join(directory, name);
  if (!fs.existsSync(candidate) || (await validPdf(candidate)))
    return candidate;

  const parsed = path.parse(name);
  for (let n = 2; ; n++) {
    candidate = path.join(directory, `${parsed.name} [${n}]${parsed.ext}`);
    if (!fs.existsSync(candidate) || (await validPdf(candidate)))
      return candidate;
  }
}

async function downloadBitstream(bitstream, destination) {
  const uuid = getUuid(bitstream);
  const href = absoluteUrl(
    getHalLink(bitstream, 'content') || `/core/bitstreams/${uuid}/content`,
  );
  const temp = `${destination}.part`;

  try {
    await fs.promises.unlink(temp);
  } catch {}

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      await sleep(randomDelay());
      const response = await http.get(href, {
        responseType: 'stream',
        validateStatus: () => true,
      });
      if (response.status < 200 || response.status >= 300)
        throw new Error(`HTTP ${response.status}`);

      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      const writer = fs.createWriteStream(temp);

      await new Promise((resolve, reject) => {
        response.data.pipe(writer);
        response.data.on('error', reject);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      if (!(await validPdf(temp))) throw new Error('Not a valid PDF');
      await fs.promises.rename(temp, destination);
      return;
    } catch (error) {
      try {
        await fs.promises.unlink(temp);
      } catch {}
      if (attempt === CONFIG.maxRetries) throw error;
      await sleep(1500 * attempt);
    }
  }
}

// ============================================================
// LOCAL DISK SAVING & PERSISTENCE
// ============================================================

async function downloadPaper(paper, collectionPath) {
  try {
    const bundles = await getItemBundles(paper.item);
    const original = findOriginalBundle(bundles);
    if (!original) return;

    const bitstreams = await getBundleBitstreams(original);
    const pdfs = bitstreams.filter(isPdf);
    if (!pdfs.length) return;

    const unitTitle = paper.courseCode
      ? `${paper.courseCode} - ${paper.courseTitle}`
      : paper.courseTitle || 'Unknown Unit';
    const folder = path.join(collectionPath, sanitizeWindowsName(unitTitle));
    await fs.promises.mkdir(folder, { recursive: true });

    // FORMATTING THE FILE NAME DYNAMICALLY WITH STREAMS
    const streamStr = paper.stream ? ` - ${paper.stream}` : '';
    const courseLabel = paper.courseCode
      ? `${paper.courseCode} - ${paper.courseTitle}`
      : paper.courseTitle;
    const cleanBaseName = `${courseLabel}${streamStr} - ${paper.year} - ${paper.examType}`;

    for (let i = 0; i < pdfs.length; i++) {
      const bitstream = pdfs[i];
      const bitstreamUuid = getUuid(bitstream);

      const base =
        pdfs.length === 1
          ? `${cleanBaseName}.pdf`
          : `${cleanBaseName} [${i + 1}].pdf`;

      const destination = await uniquePdfPath(folder, base);
      const relative = path.relative(__dirname, destination);
      const key = `${paper.uuid}:${bitstreamUuid}`;
      const previous = manifest[key];

      if (
        previous?.status === 'downloaded' &&
        (await validPdf(path.resolve(__dirname, previous.filename)))
      ) {
        continue;
      }

      if (await validPdf(destination)) {
        manifest[key] = {
          uuid: paper.uuid,
          filename: relative,
          status: 'downloaded',
        };
        await saveManifest();
        continue;
      }

      try {
        await downloadBitstream(bitstream, destination);
        manifest[key] = {
          uuid: paper.uuid,
          filename: relative,
          status: 'downloaded',
        };
        await saveManifest();
      } catch (error) {
        failures.push({ uuid: paper.uuid, reason: error.message });
        await saveFailures();
      }
    }
  } catch (error) {
    failures.push({ uuid: paper.uuid, reason: error.message });
    await saveFailures();
  }
}

async function ensurePapersDownloaded(papers, collectionName) {
  const collectionPath = path.join(
    CONFIG.outputDir,
    sanitizeWindowsName(collectionName, 'Collection'),
  );
  const workers = [];
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= papers.length) return;
      await downloadPaper(papers[index], collectionPath);
    }
  }

  const count = Math.min(CONFIG.downloadConcurrency, papers.length);
  for (let i = 0; i < count; i++) workers.push(worker());
  await Promise.all(workers);
}

// ============================================================
// PRODUCTION NATIVE WEB GUI SERVER
// ============================================================

function startWebGUI() {
  const PORT = 4000;

  const server = httpSrv.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ============================================================
    // FRONTEND
    // ============================================================
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      res.end(`
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <title>Nexus Academic Vault</title>

  <script src="https://cdn.tailwindcss.com"></script>

  <script>
    tailwind.config = {
      darkMode: 'class',

      theme: {
        extend: {
          colors: {
            nexus: {
              50: '#eef7ff',
              100: '#d9edff',
              200: '#bce0ff',
              300: '#8dccff',
              400: '#58b4ff',
              500: '#2997ff',
              600: '#1678db',
              700: '#1260b0',
              800: '#144f8f',
              900: '#153f70'
            }
          },

          boxShadow: {
            glow: '0 0 35px rgba(59,130,246,.12)',
            card: '0 10px 40px rgba(0,0,0,.20)'
          },

          animation: {
            'fade-in': 'fadeIn .35s ease-out',
            'slide-up': 'slideUp .35s ease-out',
            'pulse-soft': 'pulseSoft 2s infinite'
          },

          keyframes: {
            fadeIn: {
              '0%': { opacity: '0' },
              '100%': { opacity: '1' }
            },

            slideUp: {
              '0%': { opacity: '0', transform: 'translateY(10px)' },
              '100%': { opacity: '1', transform: 'translateY(0)' }
            },

            pulseSoft: {
              '0%,100%': { opacity: '.7' },
              '50%': { opacity: '1' }
            }
          }
        }
      }
    };
  </script>

  <style>
    * {
      scrollbar-width: thin;
      scrollbar-color: #334155 #0f172a;
    }

    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: #0f172a;
    }

    ::-webkit-scrollbar-thumb {
      background: #334155;
      border-radius: 999px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: #475569;
    }

    body {
      background:
        radial-gradient(
          circle at 15% 10%,
          rgba(37, 99, 235, .08),
          transparent 28%
        ),
        radial-gradient(
          circle at 85% 30%,
          rgba(16, 185, 129, .06),
          transparent 25%
        ),
        #020617;
    }

    .glass {
      background: rgba(15, 23, 42, .68);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
    }

    .grid-pattern {
      background-image:
        linear-gradient(rgba(148,163,184,.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(148,163,184,.035) 1px, transparent 1px);
      background-size: 32px 32px;
    }

    .line-clamp-2 {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .line-clamp-3 {
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* CUSTOM STYLED CHECKBOXES */
    .custom-checkbox {
      appearance: none;
      -webkit-appearance: none;
      width: 1.25rem;
      height: 1.25rem;
      border-radius: 0.375rem;
      border: 1.5px solid #475569;
      background-color: #020617;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s ease;
      position: relative;
    }

    .custom-checkbox:hover {
      border-color: #3b82f6;
      box-shadow: 0 0 10px rgba(59, 130, 246, 0.3);
    }

    .custom-checkbox:checked {
      background-color: #2563eb;
      border-color: #3b82f6;
    }

    .custom-checkbox:checked::after {
      content: '';
      width: 0.35rem;
      height: 0.65rem;
      border: solid white;
      border-width: 0 2px 2px 0;
      transform: rotate(45deg) translate(-1px, -1px);
    }
  </style>
</head>

<body class="min-h-screen text-slate-200 font-sans">

  <!-- ==========================================================
       TOP NAVIGATION
       ========================================================== -->

  <header class="sticky top-0 z-50 border-b border-slate-800/80 glass">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="h-20 flex items-center justify-between gap-4">

        <!-- BRAND -->
        <div class="flex items-center gap-3 min-w-0">

          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h1 class="text-lg sm:text-xl font-extrabold tracking-tight truncate">
                Nexus Academic Vault
              </h1>
              <span class="hidden sm:inline-flex px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold uppercase tracking-wider">
                Chuka
              </span>
            </div>
            <div id="breadcrumb" class="text-xs text-slate-500 truncate mt-0.5">
              Connecting to repository...
            </div>
          </div>
        </div>

        <!-- ACTIONS -->
        <div class="flex items-center gap-2">
          <button onclick="loadTree('${CONFIG.rootCommunity.uuid}')" class="hidden sm:flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-sm font-medium transition">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10"/>
            </svg>
            Root
          </button>
          <button onclick="loadTree('${CONFIG.rootCommunity.uuid}')" class="sm:hidden w-10 h-10 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10"/>
            </svg>
          </button>
        </div>

      </div>
    </div>
  </header>


  <!-- ==========================================================
       MAIN (Added pb-32 for mobile bottom padding fix)
       ========================================================== -->

  <main class="relative grid-pattern min-h-[calc(100vh-80px)]">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 pb-32 sm:pb-8">

      <!-- HERO -->
      <section id="hero" class="mb-7 rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900 to-blue-950/30 p-5 sm:p-7 shadow-card overflow-hidden relative">
        <div class="absolute -right-20 -top-20 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl"></div>
        <div class="relative">
          <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
            <div class="max-w-2xl">
              
              <h2 class="text-2xl sm:text-3xl lg:text-4xl font-black tracking-tight text-white">
                Your academic repository
              </h2>
              <p class="mt-3 text-sm sm:text-base text-slate-400 leading-relaxed max-w-xl">
                Browse communities, explore course collections, find past examination papers and export exactly the documents you need.
              </p>
            </div>

            <!-- STAT CARDS -->
            <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-3 lg:min-w-[300px]">
              <div class="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
                <div class="text-xs text-slate-500 mb-1">Communities</div>
                <div id="stat-communities" class="text-2xl font-black text-white">—</div>
              </div>
              <div class="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
                <div class="text-xs text-slate-500 mb-1">Collections</div>
                <div id="stat-collections" class="text-2xl font-black text-white">—</div>
              </div>
              <div class="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
                <div class="text-xs text-slate-500 mb-1">Page Documents</div>
                <div id="stat-documents" class="text-2xl font-black text-white">—</div>
              </div>
              <div class="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
                <div class="text-xs text-slate-500 mb-1">Selected</div>
                <div id="stat-selected" class="text-2xl font-black text-blue-400">0</div>
              </div>
            </div>
          </div>
        </div>
      </section>


      <!-- LOADER -->
      <div id="loader" class="hidden py-20 flex flex-col items-center justify-center">
        <div class="relative">
          <div class="w-14 h-14 rounded-full border-4 border-slate-800 border-t-blue-500 animate-spin"></div>
          <div class="absolute inset-0 flex items-center justify-center">
            <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6l4 2"/>
            </svg>
          </div>
        </div>
        <div class="mt-5 text-sm font-semibold text-slate-300">Synchronizing repository</div>
        <div id="loader-status-text" class="text-xs text-slate-500 mt-1">Please wait while the vault is being updated...</div>
      </div>


      <!-- ======================================================
           TREE VIEW
           ====================================================== -->

      <section id="tree-section">
        <div id="tree-toolbar" class="hidden mb-5 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div>
            <h3 class="text-lg font-bold text-white">Repository Directory</h3>
            <p class="text-sm text-slate-500 mt-1">Select a community or collection to continue.</p>
          </div>
          <div class="relative w-full sm:w-72">
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35m2.35-5.65a7 7 0 11-14 0 7 7 0 0114 0z"/>
            </svg>
            <input id="tree-search" oninput="filterTree()" placeholder="Search directories..." class="w-full bg-slate-900/80 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white outline-none focus:border-blue-500 transition"/>
          </div>
        </div>

        <div id="view-tree" class="hidden grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5"></div>
      </section>


      <!-- ======================================================
           PAPERS VIEW
           ====================================================== -->

      <section id="view-papers" class="hidden animate-fade-in">

        <!-- HEADER -->
        <div class="flex flex-col gap-5 mb-6">
          <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <div>
              <div class="inline-flex items-center gap-2 text-xs text-emerald-400 font-bold uppercase tracking-wider mb-2">
                
                Collection
              </div>
              <h2 id="collection-title" class="text-2xl sm:text-3xl font-black text-white break-words">Documents</h2>
              <p id="collection-subtitle" class="text-sm text-slate-500 mt-1">Browse available examination documents.</p>
            </div>

            <!-- ACTION CONTROLS & FORMAT SELECTOR -->
            <div class="flex items-center gap-2 flex-wrap">
              <div class="flex items-center bg-slate-900/90 border border-slate-700/80 rounded-xl p-1 text-xs">
                <label class="cursor-pointer px-3 py-1.5 rounded-lg flex items-center gap-1.5 font-semibold text-slate-300 has-[:checked]:bg-blue-600 has-[:checked]:text-white transition">
                  <input type="radio" name="downloadFormat" value="zip" checked class="hidden">
                  <span>ZIP Archive</span>
                </label>
                <label class="cursor-pointer px-3 py-1.5 rounded-lg flex items-center gap-1.5 font-semibold text-slate-300 has-[:checked]:bg-blue-600 has-[:checked]:text-white transition">
                  <input type="radio" name="downloadFormat" value="files" class="hidden">
                  <span>Actual PDF Files</span>
                </label>
              </div>

              <button onclick="toggleSelectAll()" class="px-3.5 py-2 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs sm:text-sm font-semibold transition">
                Select All
              </button>

              <button onclick="clearSelection()" class="px-3.5 py-2 rounded-xl border border-slate-700 bg-transparent hover:bg-slate-800 text-xs sm:text-sm font-semibold text-slate-400 hover:text-white transition">
                Clear
              </button>

              <button id="downloadBtn" onclick="triggerDownload()" disabled class="flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs sm:text-sm font-bold shadow-lg shadow-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                </svg>
                <span id="downloadBtnText">Export</span>
              </button>
            </div>
          </div>

          <!-- PAPER TOOLBAR -->
          <div class="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
            <div class="relative flex-1">
              <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35m2.35-5.65a7 7 0 11-14 0 7 7 0 0114 0z"/>
              </svg>
              <input id="paper-search" oninput="filterPapers()" placeholder="Search course code, course name, year or exam type..." class="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white outline-none focus:border-blue-500"/>
            </div>
            <div id="selection-summary" class="shrink-0 text-xs text-slate-400 px-2">
              0 selected
            </div>
          </div>
        </div>

        <!-- DESKTOP TABLE VIEW (hidden on mobile) -->
        <div class="hidden sm:block rounded-2xl border border-slate-800 bg-slate-900/70 shadow-card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-left">
              <thead>
                <tr class="bg-slate-950/80 border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                  <th class="p-4 w-12 text-center">
                    <input id="master-checkbox" type="checkbox" onchange="masterCheckboxChanged()" class="custom-checkbox">
                  </th>
                  <th class="p-4 font-bold">Course</th>
                  <th class="p-4 font-bold">Year</th>
                  <th class="p-4 font-bold">Examination</th>
                  <th class="p-4 font-bold text-right">Actions</th>
                </tr>
              </thead>
              <tbody id="papers-tbody" class="divide-y divide-slate-800/70"></tbody>
            </table>
          </div>
        </div>

        <!-- MOBILE RESPONSIVE CARDS VIEW (visible on mobile) -->
        <div id="papers-mobile-cards" class="sm:hidden flex flex-col gap-3"></div>

        <!-- PAGINATION CONTROLS -->
        <div id="pagination-bar" class="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
          <div class="text-xs sm:text-sm text-slate-400 text-center sm:text-left">
            Showing Page <span id="current-page-num" class="font-bold text-white">1</span> of <span id="total-pages-num" class="font-bold text-white">1</span>
            <span class="text-slate-500 text-xs"> (<span id="total-elements-num">0</span> items total)</span>
          </div>

          <div class="flex items-center gap-2">
            <button id="prevPageBtn" onclick="changePage(-1)" disabled class="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
              </svg>
              Previous
            </button>

            <button id="nextPageBtn" onclick="changePage(1)" disabled class="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed transition">
              Next
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- MOBILE SELECTION BAR -->
        <div id="mobile-selection-bar" class="hidden fixed bottom-4 left-4 right-4 z-40 rounded-2xl border border-slate-700 bg-slate-900/95 backdrop-blur-xl shadow-2xl p-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-xs text-slate-500">Documents selected</div>
              <div id="mobile-selected-count" class="font-bold text-white">0</div>
            </div>
            <button onclick="triggerDownload()" class="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 font-bold text-sm text-white">
              Export
            </button>
          </div>
        </div>

      </section>

    </div>
  </main>


  <!-- ==========================================================
       TOASTS
       ========================================================== -->

  <div id="toast-container" class="fixed bottom-5 right-5 z-[100] flex flex-col gap-3 pointer-events-none w-[calc(100%-2rem)] max-w-sm"></div>


  <!-- ==========================================================
       JAVASCRIPT
       ========================================================== -->

  <script>
    let currentCollectionUuid = null;
    let currentCollection = null;
    let currentPapers = [];
    let activeController = null;
    let navigationHistory = [];

    let currentPage = 0;
    let totalPages = 1;
    let totalElements = 0;

    let repositoryStats = {
      communities: 0,
      collections: 0,
      documents: 0
    };


    // ==========================================================
    // TOAST
    // ==========================================================

    function showToast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      const isError = type === 'error';

      const icon = isError
        ? \`<svg class="w-5 h-5 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>\`
        : \`<svg class="w-5 h-5 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M12 21a9 9 0 110-18 9 9 0 010 18z"/></svg>\`;

      toast.className = \`
        pointer-events-auto flex items-start gap-3 p-4 rounded-2xl border shadow-2xl backdrop-blur-xl animate-slide-up
        \${isError ? 'bg-red-950/90 border-red-800/70' : 'bg-slate-900/95 border-slate-700'}
      \`;

      toast.innerHTML = \`
        \${icon}
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold text-white">\${isError ? 'Operation failed' : 'Nexus Vault'}</div>
          <div class="text-xs text-slate-400 mt-1 leading-relaxed">\${message}</div>
        </div>
        <button onclick="this.parentElement.remove()" class="text-slate-500 hover:text-white">×</button>
      \`;

      container.appendChild(toast);
      setTimeout(() => { if (toast.parentElement) toast.remove(); }, 5000);
    }


    // ==========================================================
    // LOADING
    // ==========================================================

    function showLoader(message = 'Please wait while the vault is being updated...') {
      const statusText = document.getElementById('loader-status-text');
      if (statusText) statusText.innerText = message;

      document.getElementById('loader').classList.remove('hidden');
      document.getElementById('view-tree').classList.add('hidden');
      document.getElementById('tree-toolbar').classList.add('hidden');
      document.getElementById('view-papers').classList.add('hidden');
    }

    function hideLoader() {
      document.getElementById('loader').classList.add('hidden');
    }


    // ==========================================================
    // LOAD TREE
    // ==========================================================

    async function loadTree(uuid, pushHistory = true) {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      const { signal } = activeController;

      if (pushHistory && (navigationHistory.length === 0 || navigationHistory[navigationHistory.length - 1] !== uuid)) {
        navigationHistory.push(uuid);
      }

      showLoader('Synchronizing repository & streaming directory items...');

      try {
        const response = await fetch('/api/browse?uuid=' + encodeURIComponent(uuid), { signal });
        if (!response.ok) throw new Error('Unable to retrieve repository directory.');

        const data = await response.json();
        if (signal.aborted) return;

        document.getElementById('breadcrumb').innerText = 'Directory / ' + data.name;

        repositoryStats.communities = data.subcommunities.length;
        repositoryStats.collections = data.collections.length;
        updateStats();

        const container = document.getElementById('view-tree');
        container.innerHTML = '';

        const allItems = [
          ...data.subcommunities.map(c => ({ type: 'community', data: c })),
          ...data.collections.map(c => ({ type: 'collection', data: c }))
        ];

        if (allItems.length === 0) {
          container.innerHTML = \`
            <div class="col-span-full rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-12 text-center">
              <div class="w-14 h-14 rounded-2xl bg-slate-800 mx-auto flex items-center justify-center text-slate-500">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0l-8 5-8-5m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5"/></svg>
              </div>
              <h3 class="mt-4 font-bold text-white">Empty directory</h3>
              <p class="mt-1 text-sm text-slate-500">There are no communities or collections here.</p>
            </div>
          \`;
        }

        for (let i = 0; i < allItems.length; i++) {
          if (signal.aborted) return;
          const item = allItems[i];

          if (item.type === 'community') {
            const community = item.data;
            const card = document.createElement('div');
            card.dataset.search = community.name.toLowerCase();
            card.className = 'tree-card group rounded-2xl border border-slate-800 bg-slate-900/70 hover:bg-slate-800/90 hover:border-blue-500/40 hover:-translate-y-1 transition-all duration-200 cursor-pointer overflow-hidden animate-slide-up';
            card.onclick = () => loadTree(community.uuid);
            card.innerHTML = \`
              <div class="h-1 bg-gradient-to-r from-blue-500 to-indigo-500 opacity-60 group-hover:opacity-100 transition"></div>
              <div class="p-5">
                <div class="flex items-start justify-between gap-4">
                  <div class="w-11 h-11 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 group-hover:scale-105 transition">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>
                  </div>
                  <div class="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-slate-500 group-hover:text-blue-400 transition">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                  </div>
                </div>
                <div class="mt-5">
                  <div class="text-[10px] font-bold uppercase tracking-[.16em] text-blue-400/70 mb-2">Community</div>
                  <div class="text-base font-bold text-white line-clamp-3">\${escapeHtml(community.name)}</div>
                </div>
              </div>
            \`;
            container.appendChild(card);
          } else {
            const collection = item.data;
            const card = document.createElement('div');
            card.dataset.search = collection.name.toLowerCase();
            card.className = 'tree-card group rounded-2xl border border-slate-800 bg-slate-900/70 hover:bg-slate-800/90 hover:border-emerald-500/40 hover:-translate-y-1 transition-all duration-200 cursor-pointer overflow-hidden animate-slide-up';
            card.onclick = () => loadPapers(collection.uuid, collection.name, 0);
            card.innerHTML = \`
              <div class="h-1 bg-gradient-to-r from-emerald-500 to-cyan-500 opacity-60 group-hover:opacity-100 transition"></div>
              <div class="p-5">
                <div class="flex items-start justify-between gap-4">
                  <div class="w-11 h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 group-hover:scale-105 transition">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 7a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 5v14"/></svg>
                  </div>
                  <div class="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-slate-500 group-hover:text-emerald-400 transition">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                  </div>
                </div>
                <div class="mt-5">
                  <div class="text-[10px] font-bold uppercase tracking-[.16em] text-emerald-400/70 mb-2">Collection</div>
                  <div class="text-base font-bold text-white line-clamp-3">\${escapeHtml(collection.name)}</div>
                </div>
              </div>
            \`;
            container.appendChild(card);
          }

          if (i % 4 === 0) {
            hideLoader();
            document.getElementById('tree-toolbar').classList.remove('hidden');
            container.classList.remove('hidden');
          }
        }

        hideLoader();
        document.getElementById('tree-toolbar').classList.remove('hidden');
        container.classList.remove('hidden');

      } catch (error) {
        if (error.name === 'AbortError') return;
        hideLoader();
        showToast(error.message, 'error');
      }
    }


    // ==========================================================
    // LOAD PAPERS (PAGINATED - LOAD ONE PAGE AT A TIME)
    // ==========================================================

    async function loadPapers(uuid, name, page = 0) {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      const { signal } = activeController;

      currentCollectionUuid = uuid;
      currentCollection = name;
      currentPage = page;

      showLoader(\`Fetching page \${page + 1} of examination documents...\`);

      document.getElementById('breadcrumb').innerText = 'Collection / ' + name;

      try {
        const response = await fetch(
          '/api/papers?uuid=' + encodeURIComponent(uuid) + '&page=' + page,
          { signal }
        );

        if (!response.ok) throw new Error('Unable to retrieve examination documents.');

        const data = await response.json();
        if (signal.aborted) return;

        currentPapers = data.papers || [];
        totalPages = data.totalPages || 1;
        totalElements = data.totalElements || currentPapers.length;

        document.getElementById('collection-title').innerText = name;
        document.getElementById('collection-subtitle').innerText =
          \`Page \${currentPage + 1} of \${totalPages} (\${totalElements} total document\${totalElements === 1 ? '' : 's'}) available.\`;

        repositoryStats.documents = currentPapers.length;
        updateStats();

        renderPapers(currentPapers);
        updatePaginationUI();

        hideLoader();
        document.getElementById('view-papers').classList.remove('hidden');

      } catch (error) {
        if (error.name === 'AbortError') return;
        hideLoader();
        showToast(error.message, 'error');
      }
    }


    function changePage(delta) {
      const newPage = currentPage + delta;
      if (newPage >= 0 && newPage < totalPages && currentCollectionUuid) {
        loadPapers(currentCollectionUuid, currentCollection, newPage);
      }
    }


    function updatePaginationUI() {
      document.getElementById('current-page-num').innerText = currentPage + 1;
      document.getElementById('total-pages-num').innerText = totalPages;
      document.getElementById('total-elements-num').innerText = totalElements;

      const prevBtn = document.getElementById('prevPageBtn');
      const nextBtn = document.getElementById('nextPageBtn');

      prevBtn.disabled = currentPage <= 0;
      nextBtn.disabled = currentPage >= totalPages - 1;
    }


    // ==========================================================
    // RENDER PAPERS (TABLE & MOBILE CARDS)
    // ==========================================================

    function renderPapers(papers) {
      const tbody = document.getElementById('papers-tbody');
      const cardsContainer = document.getElementById('papers-mobile-cards');

      tbody.innerHTML = '';
      cardsContainer.innerHTML = '';

      if (!papers.length) {
        const emptyHtml = \`
          <div class="p-10 text-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/40">
            <div class="w-12 h-12 rounded-2xl bg-slate-800 mx-auto flex items-center justify-center text-slate-500">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            </div>
            <div class="mt-3 font-bold text-white">No documents found</div>
            <div class="mt-1 text-xs text-slate-500">Try another collection or search page.</div>
          </div>
        \`;
        tbody.innerHTML = \`<tr><td colspan="5">\${emptyHtml}</td></tr>\`;
        cardsContainer.innerHTML = emptyHtml;
        updateSelectionUI();
        return;
      }

      papers.forEach((paper) => {
        const safeCode = escapeHtml(paper.courseCode || 'UNKNOWN');
        const safeTitle = escapeHtml(paper.courseTitle || 'Untitled Course');
        const safeYear = escapeHtml(paper.year || '—');
        const safeExam = escapeHtml(paper.examType || 'Examination');
        const safeStream = paper.stream ? escapeHtml(paper.stream) : '';
        const paperUuid = escapeHtml(paper.uuid);

        const searchData = [paper.courseCode, paper.courseTitle, paper.year, paper.examType, paper.stream]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        // 1. DESKTOP TABLE ROW
        const row = document.createElement('tr');
        row.dataset.search = searchData;
        row.className = 'paper-row group hover:bg-slate-800/50 transition cursor-pointer';

        row.onclick = (event) => {
          if (event.target.tagName === 'INPUT' || event.target.closest('button')) return;
          const checkbox = row.querySelector('.paper-chk');
          if (checkbox) {
            checkbox.checked = !checkbox.checked;
            syncMobileCheckbox(paper.uuid, checkbox.checked);
            updateSelectionUI();
          }
        };

        row.innerHTML = \`
          <td class="p-4 text-center">
            <input type="checkbox" value="\${paperUuid}" data-uuid="\${paperUuid}" class="paper-chk custom-checkbox" onchange="syncMobileCheckbox('\${paperUuid}', this.checked); updateSelectionUI();">
          </td>
          <td class="p-4 min-w-[280px]">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M7 3h7l5 5v13H7a2 2 0 01-2-2V5a2 2 0 01-2-2z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M14 3v6h5"/></svg>
              </div>
              <div class="min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <div class="inline-flex px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[10px] font-black tracking-wider">\${safeCode}</div>
                  \${safeStream ? \`<div class="inline-flex px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold tracking-wider">\${safeStream}</div>\` : ''}
                </div>
                <div class="text-sm font-semibold text-slate-200 line-clamp-2">\${safeTitle}</div>
              </div>
            </div>
          </td>
          <td class="p-4 text-sm text-slate-400 font-medium">\${safeYear}</td>
          <td class="p-4">
            <span class="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs font-medium text-slate-300">
              <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
              \${safeExam}
            </span>
          </td>
          <td class="p-4 text-right">
            <button onclick="downloadSingleFile('\${paperUuid}')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-blue-600 border border-slate-700 hover:border-blue-500 text-xs font-semibold text-slate-200 hover:text-white transition">
              Download PDF
            </button>
          </td>
        \`;
        tbody.appendChild(row);

        // 2. MOBILE CARD VIEW
        const card = document.createElement('div');
        card.dataset.search = searchData;
        card.className = 'paper-card-mobile p-4 rounded-2xl border border-slate-800 bg-slate-900/80 flex flex-col gap-3 relative';

        card.innerHTML = \`
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-2.5 min-w-0">
              <input type="checkbox" value="\${paperUuid}" data-uuid="\${paperUuid}" class="paper-chk-mobile custom-checkbox shrink-0" onchange="syncDesktopCheckbox('\${paperUuid}', this.checked); updateSelectionUI();">
              <span class="inline-flex px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[10px] font-black tracking-wider">\${safeCode}</span>
              \${safeStream ? \`<span class="inline-flex px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold tracking-wider">\${safeStream}</span>\` : ''}
            </div>
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-slate-800 border border-slate-700 text-[11px] font-medium text-slate-300">
              \${safeYear}
            </span>
          </div>

          <div class="text-sm font-bold text-white leading-snug">\${safeTitle}</div>

          <div class="flex items-center justify-between gap-2 mt-1 pt-2 border-t border-slate-800/80">
            <span class="text-xs text-amber-400 font-medium">\${safeExam}</span>
            <button onclick="downloadSingleFile('\${paperUuid}')" class="px-3 py-1.5 rounded-xl bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white border border-blue-500/30 text-xs font-bold transition">
              Get PDF
            </button>
          </div>
        \`;
        cardsContainer.appendChild(card);
      });

      document.getElementById('master-checkbox').checked = false;
      updateSelectionUI();
    }


    function syncMobileCheckbox(uuid, checked) {
      const mob = document.querySelector(\`.paper-chk-mobile[data-uuid="\${uuid}"]\`);
      if (mob) mob.checked = checked;
    }

    function syncDesktopCheckbox(uuid, checked) {
      const desk = document.querySelector(\`.paper-chk[data-uuid="\${uuid}"]\`);
      if (desk) desk.checked = checked;
    }


    // ==========================================================
    // SEARCH PAPERS
    // ==========================================================

    function filterPapers() {
      const query = document.getElementById('paper-search').value.trim().toLowerCase();

      document.querySelectorAll('.paper-row, .paper-card-mobile').forEach(el => {
        const matches = !query || el.dataset.search.includes(query);
        el.style.display = matches ? '' : 'none';
      });
    }


    // ==========================================================
    // SEARCH TREE
    // ==========================================================

    function filterTree() {
      const query = document.getElementById('tree-search').value.trim().toLowerCase();

      document.querySelectorAll('.tree-card').forEach(card => {
        const matches = !query || card.dataset.search.includes(query);
        card.style.display = matches ? '' : 'none';
      });
    }


    // ==========================================================
    // SELECTION
    // ==========================================================

    function getSelected() {
      const selected = new Set();
      document.querySelectorAll('.paper-chk:checked, .paper-chk-mobile:checked').forEach(chk => {
        selected.add(chk.value);
      });
      return Array.from(selected);
    }


    function updateSelectionUI() {
      const selected = getSelected();
      const count = selected.length;

      document.getElementById('stat-selected').innerText = count;
      document.getElementById('selection-summary').innerText = count + ' document' + (count === 1 ? '' : 's') + ' selected';
      document.getElementById('mobile-selected-count').innerText = count + ' document' + (count === 1 ? '' : 's');

      const button = document.getElementById('downloadBtn');
      button.disabled = count === 0;

      document.getElementById('mobile-selection-bar').classList.toggle('hidden', count === 0);

      const all = document.querySelectorAll('.paper-chk');
      const master = document.getElementById('master-checkbox');
      master.checked = all.length > 0 && selected.length === all.length;
      master.indeterminate = selected.length > 0 && selected.length < all.length;
    }


    function toggleSelectAll() {
      const checkboxes = document.querySelectorAll('.paper-chk, .paper-chk-mobile');
      const allSelected = Array.from(checkboxes).every(cb => cb.checked);

      checkboxes.forEach(cb => cb.checked = !allSelected);
      updateSelectionUI();
    }


    function clearSelection() {
      document.querySelectorAll('.paper-chk, .paper-chk-mobile').forEach(cb => cb.checked = false);
      updateSelectionUI();
    }


    function masterCheckboxChanged() {
      const master = document.getElementById('master-checkbox');
      document.querySelectorAll('.paper-chk, .paper-chk-mobile').forEach(cb => cb.checked = master.checked);
      updateSelectionUI();
    }


    // ==========================================================
    // SINGLE FILE DOWNLOAD
    // ==========================================================

    async function downloadSingleFile(uuid) {
      showToast('Preparing PDF file download...');
      try {
        const link = document.createElement('a');
        link.href = '/api/download-file?uuid=' + encodeURIComponent(uuid) + '&collectionName=' + encodeURIComponent(currentCollection || 'Export');
        link.setAttribute('download', '');
        document.body.appendChild(link);
        link.click();
        link.remove();
        showToast('File download started.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }


    // ==========================================================
    // BULK DOWNLOAD (ZIP OR ACTUAL FILES CHOICE)
    // ==========================================================

    async function triggerDownload() {
      const selected = getSelected();
      if (!selected.length) {
        showToast('Select at least one document before exporting.', 'error');
        return;
      }

      const formatOption = document.querySelector('input[name="downloadFormat"]:checked')?.value || 'zip';

      // IF USER CHOSE ACTUAL PDF FILES
      if (formatOption === 'files') {
        showToast('Downloading ' + selected.length + ' individual PDF file(s)...');
        for (const uuid of selected) {
          await downloadSingleFile(uuid);
          await new Promise(r => setTimeout(r, 600));
        }
        return;
      }

      // IF USER CHOSE ZIP
      const button = document.getElementById('downloadBtn');
      const buttonText = document.getElementById('downloadBtnText');

      button.disabled = true;
      buttonText.innerText = 'Compiling...';
      button.classList.add('animate-pulse');

      showToast('Preparing ' + selected.length + ' document' + (selected.length === 1 ? '' : 's') + ' for ZIP archive.');

      try {
        const response = await fetch('/api/download-zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uuids: selected,
            collectionName: currentCollection
          })
        });

        if (!response.ok) {
          let message = 'The server could not create the archive.';
          try {
            const text = await response.text();
            if (text) message = text;
          } catch (_) {}
          throw new Error(message);
        }

        buttonText.innerText = 'Downloading...';
        const blob = await response.blob();
        const objectUrl = window.URL.createObjectURL(blob);

        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = sanitizeFilename(currentCollection || 'Nexus_Vault_Export') + '_Archive.zip';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
        showToast('Archive successfully generated and downloaded.');

      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        buttonText.innerText = 'Export';
        button.disabled = getSelected().length === 0;
        button.classList.remove('animate-pulse');
      }
    }


    // ==========================================================
    // STATISTICS & HELPERS
    // ==========================================================

    function updateStats() {
      document.getElementById('stat-communities').innerText = repositoryStats.communities;
      document.getElementById('stat-collections').innerText = repositoryStats.collections;
      document.getElementById('stat-documents').innerText = repositoryStats.documents;
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function sanitizeFilename(value) {
      return String(value || 'Export')
        .replace(/[<>:"/\\\\|?*]/g, '_')
        .replace(/\\s+/g, '_')
        .substring(0, 100);
    }

    // BROWSER HISTORY
    window.addEventListener('popstate', () => {
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
      hideLoader();
      if (navigationHistory.length > 1) {
        navigationHistory.pop();
        const previousUuid = navigationHistory[navigationHistory.length - 1];
        if (previousUuid) loadTree(previousUuid, false);
      } else {
        loadTree('${CONFIG.rootCommunity.uuid}', false);
      }
    });

    // INIT
    loadTree('${CONFIG.rootCommunity.uuid}');
  </script>

</body>
</html>
      `);

      return;
    }

    // ============================================================
    // BROWSE TREE API
    // ============================================================

    if (url.pathname === '/api/browse' && req.method === 'GET') {
      const uuid = url.searchParams.get('uuid');

      try {
        const comm = await getCommunity(uuid);
        const subcommunities = await getSubcommunityLinks(comm).catch(() => []);
        const collections = await getRelatedCollectionLinks(comm).catch(
          () => [],
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            name: resourceName(comm),
            subcommunities: subcommunities.map((c) => ({
              uuid: getUuid(c),
              name: resourceName(c),
            })),
            collections: collections.map((c) => ({
              uuid: getUuid(c),
              name: resourceName(c),
            })),
          }),
        );
      } catch (err) {
        console.error('[Browse API Error]', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }

      return;
    }

    // ============================================================
    // PAPERS API (PAGINATED - SINGLE PAGE AT A TIME)
    // ============================================================

    if (url.pathname === '/api/papers' && req.method === 'GET') {
      const uuid = url.searchParams.get('uuid');
      const page = parseInt(url.searchParams.get('page') || '0', 10);

      try {
        const result = await discoverCollection(uuid, '', page);
        const papers = result.items.map(paperInfo);

        papers.forEach((paper) => guiPaperCache.set(paper.uuid, paper));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            papers: papers.map((p) => ({
              uuid: p.uuid,
              courseCode: p.courseCode,
              courseTitle: p.courseTitle,
              year: p.year,
              examType: p.examType,
              stream: p.stream, // Pass stream to frontend
            })),
            page: result.page,
            totalPages: result.totalPages,
            totalElements: result.totalElements,
          }),
        );
      } catch (err) {
        console.error('[Papers API Error]', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }

      return;
    }

    // ============================================================
    // SINGLE FILE DOWNLOAD API (PERSISTED ON SERVER)
    // ============================================================

    if (url.pathname === '/api/download-file' && req.method === 'GET') {
      const uuid = url.searchParams.get('uuid');
      const collectionName = url.searchParams.get('collectionName') || 'Export';

      try {
        const paper = guiPaperCache.get(uuid);
        if (!paper) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({ error: 'Document not found in cache.' }),
          );
        }

        await ensurePapersDownloaded([paper], collectionName);

        let localFilePath = null;
        for (const key of Object.keys(manifest)) {
          const entry = manifest[key];
          if (entry.uuid === uuid && entry.status === 'downloaded') {
            const candidate = path.resolve(__dirname, entry.filename);
            if (fs.existsSync(candidate)) {
              localFilePath = candidate;
              break;
            }
          }
        }

        if (!localFilePath) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({ error: 'File could not be found on server.' }),
          );
        }

        const stat = await fs.promises.stat(localFilePath);
        const filename = path.basename(localFilePath);

        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });

        const readStream = fs.createReadStream(localFilePath);
        readStream.pipe(res);
      } catch (err) {
        console.error('[Single File Download Error]', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }

      return;
    }

    // ============================================================
    // ZIP DOWNLOAD API (SWAPPED WITH HIGH-PERFORMANCE fflate)
    // ============================================================

    if (url.pathname === '/api/download-zip' && req.method === 'POST') {
      let body = '';

      req.on('data', (chunk) => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        try {
          const { uuids, collectionName } = JSON.parse(body);

          if (!Array.isArray(uuids) || uuids.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(
              JSON.stringify({ error: 'No document UUIDs were provided.' }),
            );
          }

          const targetPapers = uuids
            .map((id) => guiPaperCache.get(id))
            .filter(Boolean);

          if (!targetPapers.length) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(
              JSON.stringify({
                error:
                  'None of the selected documents could be found in the cache.',
              }),
            );
          }

          console.log(
            `[Download] Preparing ${targetPapers.length} documents...`,
          );

          await ensurePapersDownloaded(
            targetPapers,
            collectionName || 'Export',
          );

          const zipFiles = {};
          let filesAdded = 0;

          for (const targetUuid of uuids) {
            for (const key of Object.keys(manifest)) {
              const entry = manifest[key];

              if (entry.uuid === targetUuid && entry.status === 'downloaded') {
                const localFilePath = path.resolve(__dirname, entry.filename);

                if (!fs.existsSync(localFilePath)) {
                  console.warn(`[Download] Missing file ${localFilePath}`);
                  continue;
                }

                const zipInternalPath = path.relative(
                  CONFIG.outputDir,
                  localFilePath,
                );

                try {
                  const fileBuffer = await fs.promises.readFile(localFilePath);
                  zipFiles[zipInternalPath] = new Uint8Array(fileBuffer);
                  filesAdded++;
                } catch (readErr) {
                  console.warn(
                    `[Download] Unable to read file ${localFilePath}: ${readErr.message}`,
                  );
                }
              }
            }
          }

          console.log(
            `[Download] Added ${filesAdded} files to high-performance fflate ZIP`,
          );

          if (filesAdded === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(
              JSON.stringify({
                error:
                  'Unable to load file or complete process. No files found on disk.',
              }),
            );
          }

          fflate.zip(zipFiles, { level: 6 }, (err, zippedData) => {
            if (err) {
              console.error(
                '[Download API Error] fflate compression failed:',
                err,
              );
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'Unable to load file or complete process',
                  }),
                );
              }
              return;
            }

            res.writeHead(200, {
              'Content-Type': 'application/zip',
              'Content-Disposition':
                'attachment; filename="Nexus_Vault_Export.zip"',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Content-Length': zippedData.length,
            });

            res.end(Buffer.from(zippedData));
            console.log('[Download] High-performance ZIP sent successfully.');
          });
        } catch (err) {
          console.error('[Download API Error]', err);

          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Unable to load file or complete process',
                details: err.message,
              }),
            );
          } else if (!res.destroyed) {
            res.destroy(err);
          }
        }
      });

      return;
    }

    // ============================================================
    // 404
    // ============================================================

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(PORT, () => {
    clearScreen();
    title('NEXUS ACADEMIC VAULT (PRODUCTION GUI)');
    console.log(`\nLocal server is running! Native Interface Active.\n`);
    console.log(`   http://localhost:${PORT}\n`);
    console.log(
      'Access from any machine on your network utilizing your local IP address.',
    );
  });
}

// ============================================================
// BOOTSTRAP
// ============================================================

async function main() {
  await fs.promises.mkdir(CONFIG.outputDir, { recursive: true });
  await fs.promises.mkdir(CONFIG.debugDir, { recursive: true });

  manifest = await loadJson(CONFIG.manifestFile, {});
  failures = await loadJson(CONFIG.failedFile, []);

  startWebGUI();
}

main();
