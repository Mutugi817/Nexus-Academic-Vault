'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ============================================================
// UNIVERSITY REPOSITORY CLI DOWNLOADER
// Node.js + axios + fs + path + readline (all built-in except axios)
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

  // Keep concurrency low. This is deliberately conservative.
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

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let shuttingDown = false;

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

function pause() {
  return ask('\nPress ENTER to continue...');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';

  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean).join(' ');
  }

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

  if (reserved.has(name.split('.')[0].toUpperCase())) {
    name = `_${name}`;
  }

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

async function debugResponse(name, details) {
  try {
    await fs.promises.mkdir(CONFIG.debugDir, { recursive: true });
    const safe = sanitizeWindowsName(name, 'debug').replace(/\.json$/i, '');
    await saveJson(
      path.join(CONFIG.debugDir, `${safe}-${Date.now()}.json`),
      details,
    );
  } catch {}
}

function isRetryable(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

// ============================================================
// HTTP
// ============================================================

async function request(config, label = 'request', options = {}) {
  const allow404 = options.allow404 === true;
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      await sleep(randomDelay());

      const response = await http.request(config);

      if (response.status >= 200 && response.status < 300) {
        return response;
      }

      if (allow404 && response.status === 404) {
        return response;
      }

      const retry = isRetryable(response.status);

      if (!retry || attempt === CONFIG.maxRetries) {
        await debugResponse('http-error', {
          label,
          attempt,
          status: response.status,
          statusText: response.statusText,
          url: response.config?.url,
          method: response.config?.method,
          response: response.data,
        });

        throw new Error(`${label}: HTTP ${response.status}`);
      }

      console.log(
        `[RETRY] ${label}: HTTP ${response.status}, ` +
          `attempt ${attempt}/${CONFIG.maxRetries}`,
      );
    } catch (error) {
      lastError = error;

      if (attempt === CONFIG.maxRetries) throw error;

      console.log(
        `[RETRY] ${label}: ${error.message}, ` +
          `attempt ${attempt}/${CONFIG.maxRetries}`,
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
    if (Array.isArray(value)) {
      for (const x of value) out.push(x);
    }
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

// Discovery is special on this DSpace installation.
// The actual item may be nested under:
// searchResult -> objects -> indexableObject
// or another HAL wrapper.
//
// Instead of assuming one exact shape, recursively inspect the
// response and accept only objects that look like DSpace items.
function extractDiscoveryItems(data) {
  const found = new Map();

  function looksLikeItem(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;

    const self = getHalLink(obj, 'self');
    const uuid = getUuid(obj);

    if (!uuid) return false;

    if (self && /\/core\/items\//i.test(self)) return true;

    // Indexable objects can sometimes omit the self relation
    // but contain item metadata.
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

    if (looksLikeItem(obj)) {
      found.set(getUuid(obj), obj);
    }

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

  // Generic fallback: inspect arrays for objects that have
  // a self link pointing to a known DSpace resource.
  const found = new Map();

  function visit(obj, depth = 0) {
    if (!obj || depth > 8) return;

    if (Array.isArray(obj)) {
      for (const x of obj) visit(x, depth + 1);
      return;
    }

    if (typeof obj !== 'object') return;

    const self = getHalLink(obj, 'self') || obj.self || '';
    const isResource = /\/core\/(communities|collections)\//i.test(self);

    if (isResource) {
      const uuid = getUuid(obj);
      if (uuid) found.set(uuid, obj);
    }

    for (const value of Object.values(obj)) {
      visit(value, depth + 1);
    }
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

function resourceCount(resource) {
  const values = [
    resource?.numberOfItems,
    resource?.items,
    resource?.metadata?.['dc.numberOfItems'],
    resource?.count,
  ];

  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

// ============================================================
// DISCOVERY
// ============================================================

async function discoverCollection(uuid, query = '') {
  const items = new Map();

  let page = 0;
  let totalPages = null;
  let totalElements = null;

  while (totalPages === null || page < totalPages) {
    console.log(
      `Requesting page ${page + 1}` +
        (totalPages !== null ? ` of ${totalPages}` : '') +
        '...',
    );

    const response = await request(
      {
        method: 'GET',
        url: '/discover/search/objects',
        params: {
          query,
          scope: uuid,
          page,
          size: CONFIG.pageSize,
        },
      },
      `Discovery page ${page + 1}`,
    );

    const data = response.data;
    const info = pageInfo(data);

    if (info.totalPages !== undefined) {
      totalPages = Number(info.totalPages);
    }

    if (info.totalElements !== undefined) {
      totalElements = Number(info.totalElements);
    }

    const discovered = extractDiscoveryItems(data);

    console.log(`Items found in response: ${discovered.length}`);

    if (totalElements !== null) {
      console.log(`Repository reports: ${totalElements} total`);
    }

    if (discovered.length === 0) {
      await debugResponse(`discovery-page-${page + 1}`, {
        page,
        query,
        scope: uuid,
        pageInfo: info,
        topLevelKeys: Object.keys(data || {}),
        response: data,
      });
    }

    for (const item of discovered) {
      const itemUuid = getUuid(item);
      if (itemUuid) items.set(itemUuid, item);
    }

    page++;

    if (totalPages === null) {
      // If DSpace omitted pagination metadata, stop when a page
      // returns no actual item objects.
      if (discovered.length === 0) break;
      totalPages = page;
    }
  }

  return {
    items: Array.from(items.values()),
    totalElements,
  };
}

// ============================================================
// ITEM -> BUNDLES -> ORIGINAL -> BITSTREAMS
// ============================================================

async function getItemBundles(item) {
  const itemUuid = getUuid(item);
  let href = getHalLink(item, 'bundles');

  if (!href) href = `/core/items/${itemUuid}/bundles`;

  const response = await request(
    { method: 'GET', url: absoluteUrl(href) },
    `Bundles for item ${itemUuid}`,
  );

  return extractResourceList(response.data, ['bundles', 'entries']);
}

async function getBundleBitstreams(bundle) {
  const bundleUuid = getUuid(bundle);
  let href = getHalLink(bundle, 'bitstreams');

  if (!href) href = `/core/bundles/${bundleUuid}/bitstreams`;

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

function bitstreamName(bitstream) {
  return normalizeText(
    bitstream.name || bitstream.filename || bitstream.originalName,
  );
}

function bitstreamMime(bitstream) {
  return normalizeText(
    bitstream.format?.mimetype || bitstream.mimetype || bitstream.mimeType,
  ).toLowerCase();
}

function isPdf(bitstream) {
  return (
    bitstreamMime(bitstream).includes('pdf') ||
    bitstreamName(bitstream).toLowerCase().endsWith('.pdf')
  );
}

// ============================================================
// METADATA
// ============================================================

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

    if (obj[key] !== undefined) {
      const values = Array.isArray(obj[key]) ? obj[key] : [obj[key]];
      for (const x of values) {
        const normalized = normalizeText(x?.value ?? x?.text ?? x);
        if (normalized) result.push(normalized);
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

function repositoryTitle(item) {
  return allTitleText(item)[0] || 'Untitled Paper';
}

function extractCourseCode(item) {
  const text = allTitleText(item).join(' ');

  const match = text.match(/\b([A-Z]{2,8})\s*[-_]?\s*(\d{3,6})\b/i);

  if (!match) return '';

  return `${match[1].toUpperCase()} ${match[2]}`;
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
  const fields = ['dc.date.issued', 'dc.date.created', 'dc.date'];

  for (const field of fields) {
    for (const value of metadataValues(item, field)) {
      const match = value.match(/\b(19|20)\d{2}\b/);
      if (match) return match[0];
    }
  }

  const title = repositoryTitle(item);
  const match = title.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : 'Unknown Year';
}

function extractExamType(item) {
  const text = allTitleText(item).join(' ').toLowerCase();

  if (
    text.includes('resit') ||
    text.includes('supplementary') ||
    text.includes('special') ||
    text.includes('retake')
  ) {
    return 'Resit-Special Exam';
  }

  return 'Main Exam';
}

function extractYearLevel(item) {
  const code = extractCourseCode(item);

  if (!code) return 'Unknown';

  const match = code.match(/\s(\d+)/);
  if (!match) return 'Unknown';

  const digits = match[1];

  // Chuka course codes commonly encode level in the first digit
  // after the prefix, but this is intentionally marked as an
  // inference rather than a guaranteed repository field.
  if (digits.length >= 3) {
    const first = Number(digits[0]);

    if (first >= 1 && first <= 4) {
      return `Year ${first}`;
    }
  }

  return 'Unknown';
}

function paperInfo(item) {
  return {
    uuid: getUuid(item),
    title: repositoryTitle(item),
    courseCode: extractCourseCode(item),
    courseTitle: extractCourseTitle(item),
    year: extractYear(item),
    yearLevel: extractYearLevel(item),
    examType: extractExamType(item),
    item,
  };
}

// ============================================================
// FILTERING / SEARCH
// ============================================================

function matchesFilter(paper, filter) {
  const code = paper.courseCode.toLowerCase();
  const title = paper.title.toLowerCase();
  const courseTitle = paper.courseTitle.toLowerCase();
  const year = paper.year.toLowerCase();
  const yearLevel = paper.yearLevel.toLowerCase();
  const exam = paper.examType.toLowerCase();

  if (filter.text) {
    const q = filter.text.toLowerCase();
    const combined = `${code} ${title} ${courseTitle} ${year} ${exam}`;
    if (!combined.includes(q)) return false;
  }

  if (filter.courseCode) {
    if (!code.includes(filter.courseCode.toLowerCase())) return false;
  }

  if (filter.courseName) {
    if (!courseTitle.includes(filter.courseName.toLowerCase())) return false;
  }

  if (filter.year) {
    if (year !== filter.year.toLowerCase()) return false;
  }

  if (filter.yearLevel && filter.yearLevel !== 'all') {
    if (yearLevel !== filter.yearLevel.toLowerCase()) return false;
  }

  if (filter.examType && filter.examType !== 'all') {
    if (exam !== filter.examType.toLowerCase()) return false;
  }

  return true;
}

function filterPapers(papers, filter) {
  return papers.filter((paper) => matchesFilter(paper, filter));
}

function printPaperList(papers, selected = new Set(), max = 50) {
  const visible = papers.slice(0, max);

  for (let i = 0; i < visible.length; i++) {
    const paper = visible[i];
    const mark = selected.has(i) ? 'X' : ' ';

    console.log(
      `[${mark}] ${String(i + 1).padStart(3)}. ` +
        `${paper.courseCode || 'NO CODE'} - ${paper.courseTitle}`,
    );

    console.log(`      ${paper.year} | ${paper.examType} | ${paper.yearLevel}`);
  }

  if (papers.length > max) {
    console.log(`\n... ${papers.length - max} more results not shown.`);
  }
}

// ============================================================
// PDF VALIDATION / DOWNLOAD
// ============================================================

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

  if (!fs.existsSync(candidate)) return candidate;
  if (await validPdf(candidate)) return candidate;

  const parsed = path.parse(name);

  for (let n = 2; ; n++) {
    candidate = path.join(directory, `${parsed.name} [${n}]${parsed.ext}`);

    if (!fs.existsSync(candidate)) return candidate;
    if (await validPdf(candidate)) return candidate;
  }
}

async function downloadBitstream(bitstream, destination) {
  const uuid = getUuid(bitstream);
  let href = getHalLink(bitstream, 'content');

  if (!href) href = `/core/bitstreams/${uuid}/content`;

  href = absoluteUrl(href);

  const temp = `${destination}.part`;

  try {
    await fs.promises.unlink(temp);
  } catch {}

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      await sleep(randomDelay());

      const response = await http.get(href, {
        responseType: 'stream',
        headers: {
          'User-Agent': CONFIG.userAgent,
          Accept: 'application/pdf,*/*',
        },
        validateStatus: () => true,
      });

      if (response.status < 200 || response.status >= 300) {
        if (!isRetryable(response.status) || attempt === CONFIG.maxRetries) {
          await debugResponse('download-error', {
            uuid,
            href,
            attempt,
            status: response.status,
            response: response.data,
          });

          throw new Error(`PDF content HTTP ${response.status}`);
        }

        await sleep(1500 * attempt);
        continue;
      }

      await fs.promises.mkdir(path.dirname(destination), { recursive: true });

      const writer = fs.createWriteStream(temp);

      await new Promise((resolve, reject) => {
        response.data.pipe(writer);
        response.data.on('error', reject);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      if (!(await validPdf(temp))) {
        try {
          await fs.promises.unlink(temp);
        } catch {}
        throw new Error('Downloaded content is not a valid PDF');
      }

      await fs.promises.rename(temp, destination);

      const stat = await fs.promises.stat(destination);

      return stat.size;
    } catch (error) {
      try {
        await fs.promises.unlink(temp);
      } catch {}

      if (attempt === CONFIG.maxRetries) throw error;

      console.log(`[RETRY] ${error.message} (${attempt}/${CONFIG.maxRetries})`);

      await sleep(1500 * attempt);
    }
  }

  throw new Error('Download failed');
}

// ============================================================
// PAPER DOWNLOAD
// ============================================================

async function downloadPaper(paper, collectionPath, itemIndex, total) {
  console.log('');
  console.log(`------------------------------------------------------------`);
  console.log(`[${itemIndex}/${total}] ${paper.title}`);
  console.log(`Course: ${paper.courseCode || 'Unknown'}`);
  console.log(`Year: ${paper.year}`);
  console.log(`Exam: ${paper.examType}`);

  try {
    const bundles = await getItemBundles(paper.item);
    const original = findOriginalBundle(bundles);

    if (!original) {
      console.log('[NO ORIGINAL BUNDLE]');
      failures.push({
        uuid: paper.uuid,
        title: paper.title,
        reason: 'ORIGINAL bundle not found',
        timestamp: new Date().toISOString(),
      });
      await saveFailures();
      return { downloaded: 0, skipped: 0, failed: 1 };
    }

    const bitstreams = await getBundleBitstreams(original);
    const pdfs = bitstreams.filter(isPdf);

    if (!pdfs.length) {
      console.log('[NO PDF]');
      failures.push({
        uuid: paper.uuid,
        title: paper.title,
        reason: 'No PDF bitstream found',
        timestamp: new Date().toISOString(),
      });
      await saveFailures();
      return { downloaded: 0, skipped: 0, failed: 1 };
    }

    const folder = path.join(
      collectionPath,
      sanitizeWindowsName(paper.courseCode || 'Unknown Course'),
      sanitizeWindowsName(paper.year || 'Unknown Year'),
      sanitizeWindowsName(paper.examType || 'Main Exam'),
    );

    await fs.promises.mkdir(folder, { recursive: true });

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < pdfs.length; i++) {
      const bitstream = pdfs[i];
      const bitstreamUuid = getUuid(bitstream);

      const base =
        pdfs.length === 1
          ? `${paper.courseCode || 'Past Paper'} - ${paper.courseTitle || paper.title}.pdf`
          : `${paper.courseCode || 'Past Paper'} - ${paper.courseTitle || paper.title} [${i + 1}].pdf`;

      const destination = await uniquePdfPath(folder, base);
      const relative = path.relative(__dirname, destination);
      const key = `${paper.uuid}:${bitstreamUuid}`;

      const previous = manifest[key];

      if (previous?.status === 'downloaded') {
        const previousPath = path.resolve(__dirname, previous.filename);

        if (await validPdf(previousPath)) {
          console.log(`[SKIP] ${path.basename(previousPath)}`);
          skipped++;
          continue;
        }
      }

      if (await validPdf(destination)) {
        console.log(`[SKIP] ${path.basename(destination)}`);

        manifest[key] = {
          uuid: paper.uuid,
          bitstreamUuid,
          title: paper.title,
          courseCode: paper.courseCode,
          courseTitle: paper.courseTitle,
          year: paper.year,
          yearLevel: paper.yearLevel,
          examType: paper.examType,
          filename: relative,
          status: 'downloaded',
          downloadedAt: new Date().toISOString(),
        };

        await saveManifest();
        skipped++;
        continue;
      }

      console.log(`[DOWNLOAD] ${path.basename(destination)}`);

      try {
        const size = await downloadBitstream(bitstream, destination);

        console.log(`[OK] ${formatBytes(size)}`);

        manifest[key] = {
          uuid: paper.uuid,
          bitstreamUuid,
          title: paper.title,
          courseCode: paper.courseCode,
          courseTitle: paper.courseTitle,
          year: paper.year,
          yearLevel: paper.yearLevel,
          examType: paper.examType,
          filename: relative,
          status: 'downloaded',
          downloadedAt: new Date().toISOString(),
        };

        await saveManifest();
        downloaded++;
      } catch (error) {
        console.log(`[FAILED] ${error.message}`);

        manifest[key] = {
          uuid: paper.uuid,
          bitstreamUuid,
          title: paper.title,
          courseCode: paper.courseCode,
          courseTitle: paper.courseTitle,
          year: paper.year,
          yearLevel: paper.yearLevel,
          examType: paper.examType,
          status: 'failed',
          error: error.message,
          failedAt: new Date().toISOString(),
        };

        await saveManifest();

        failures.push({
          uuid: paper.uuid,
          bitstreamUuid,
          title: paper.title,
          filename: relative,
          reason: error.message,
          timestamp: new Date().toISOString(),
        });

        await saveFailures();
        failed++;
      }
    }

    return { downloaded, skipped, failed };
  } catch (error) {
    console.log(`[FAILED ITEM] ${error.message}`);

    failures.push({
      uuid: paper.uuid,
      title: paper.title,
      reason: error.message,
      timestamp: new Date().toISOString(),
    });

    await saveFailures();

    return { downloaded: 0, skipped: 0, failed: 1 };
  }
}

async function downloadPapers(papers, collection) {
  if (!papers.length) {
    console.log('Nothing selected.');
    return;
  }

  const collectionName = resourceName(collection, 'Collection');

  const collectionPath = path.join(
    CONFIG.outputDir,
    sanitizeWindowsName(collectionName, 'Collection'),
  );

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  // Low concurrency worker pool.
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= papers.length) return;

      const result = await downloadPaper(
        papers[index],
        collectionPath,
        index + 1,
        papers.length,
      );

      downloaded += result.downloaded;
      skipped += result.skipped;
      failed += result.failed;
    }
  }

  const workers = [];
  const count = Math.min(CONFIG.downloadConcurrency, papers.length);

  for (let i = 0; i < count; i++) workers.push(worker());

  await Promise.all(workers);

  console.log('');
  line();
  console.log('DOWNLOAD SUMMARY');
  line();
  console.log(`Selected papers: ${papers.length}`);
  console.log(`PDFs downloaded: ${downloaded}`);
  console.log(`Already existed: ${skipped}`);
  console.log(`Failed: ${failed}`);
}

// ============================================================
// COLLECTION SESSION
// ============================================================

async function loadCollectionPapers(collection) {
  clearScreen();

  const name = resourceName(collection, 'Collection');
  const uuid = getUuid(collection);

  title(name);

  console.log(`UUID: ${uuid}`);
  console.log('');
  console.log('Loading collection papers...');
  console.log('This may take a while for large collections.');
  console.log('');

  const result = await discoverCollection(uuid);

  const papers = result.items.map(paperInfo);

  console.log('');
  console.log(`Loaded ${papers.length} unique papers.`);

  if (result.totalElements !== null) {
    console.log(`Repository reported ${result.totalElements} total results.`);
  }

  return papers;
}

async function filterMenu(papers) {
  while (true) {
    clearScreen();
    title('FILTER PAPERS');

    console.log(`Available papers: ${papers.length}`);
    console.log('');
    console.log('1. Unit / Course Code');
    console.log('2. Course Name');
    console.log('3. Year');
    console.log('4. Year Level');
    console.log('5. Exam Type');
    console.log('6. Text Search');
    console.log('7. Multiple Filters');
    console.log('8. Show All');
    console.log('B. Back');

    const choice = (await ask('\nSelect: ')).toLowerCase();

    if (choice === 'b') return null;

    if (choice === '8') return papers;

    if (choice === '1') {
      const value = await ask('Enter unit/course code: ');
      return filterPapers(papers, { courseCode: value });
    }

    if (choice === '2') {
      const value = await ask('Enter course name text: ');
      return filterPapers(papers, { courseName: value });
    }

    if (choice === '3') {
      const value = await ask('Enter year, e.g. 2024: ');
      return filterPapers(papers, { year: value });
    }

    if (choice === '4') {
      const value = await ask('Enter year level (1-4): ');
      return filterPapers(papers, { yearLevel: `Year ${value}` });
    }

    if (choice === '5') {
      console.log('\n1. Main Exam');
      console.log('2. Resit-Special Exam');
      const type = await ask('Select: ');

      return filterPapers(papers, {
        examType: type === '2' ? 'Resit-Special Exam' : 'Main Exam',
      });
    }

    if (choice === '6') {
      const value = await ask('Search title/course/year: ');
      return filterPapers(papers, { text: value });
    }

    if (choice === '7') {
      const courseCode = await ask('Course code (ENTER to skip): ');
      const courseName = await ask('Course name (ENTER to skip): ');
      const year = await ask('Year (ENTER to skip): ');
      const level = await ask('Year level 1-4 (ENTER to skip): ');

      return filterPapers(papers, {
        courseCode: courseCode || undefined,
        courseName: courseName || undefined,
        year: year || undefined,
        yearLevel: level ? `Year ${level}` : undefined,
      });
    }
  }
}

async function selectionMenu(papers, collection) {
  let current = papers;
  const selected = new Set();

  while (true) {
    clearScreen();
    title('PAPER SELECTION');

    console.log(`Results: ${current.length}`);
    console.log('');

    if (!current.length) {
      console.log('No papers match the current filter.');
      await pause();
      return;
    }

    printPaperList(current, selected);

    console.log('');
    console.log('Commands:');
    console.log('A = select all');
    console.log('N = select none');
    console.log('F = filter');
    console.log('S = search within results');
    console.log('D = download selected');
    console.log('B = back');

    const input = (await ask('\nCommand: ')).toLowerCase();

    if (input === 'b') return;

    if (input === 'a') {
      selected.clear();
      for (let i = 0; i < current.length; i++) selected.add(i);
      continue;
    }

    if (input === 'n') {
      selected.clear();
      continue;
    }

    if (input === 'f') {
      const filtered = await filterMenu(papers);
      if (filtered !== null) {
        current = filtered;
        selected.clear();
      }
      continue;
    }

    if (input === 's') {
      const q = await ask('Search: ');
      current = filterPapers(current, { text: q });
      selected.clear();
      continue;
    }

    if (input === 'd') {
      const chosen = Array.from(selected)
        .map((index) => current[index])
        .filter(Boolean);

      if (!chosen.length) {
        console.log('No papers selected.');
        await pause();
        continue;
      }

      clearScreen();
      console.log(`Downloading ${chosen.length} selected papers...`);
      await downloadPapers(chosen, collection);
      await pause();
      continue;
    }

    // Numeric selection:
    // "1,3,5" or "2-8"
    const tokens = input
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    for (const token of tokens) {
      if (/^\d+$/.test(token)) {
        const n = Number(token) - 1;
        if (n >= 0 && n < current.length) {
          if (selected.has(n)) selected.delete(n);
          else selected.add(n);
        }
      } else if (/^\d+\-\d+$/.test(token)) {
        const [a, b] = token.split('-').map(Number);
        const start = Math.min(a, b) - 1;
        const end = Math.max(a, b) - 1;

        for (let i = start; i <= end; i++) {
          if (i >= 0 && i < current.length) selected.add(i);
        }
      }
    }
  }
}

// ============================================================
// COMMUNITY BROWSER
// ============================================================

async function browseCommunity(community) {
  while (true) {
    clearScreen();

    const name = resourceName(community, 'Community');
    const uuid = getUuid(community);

    title(name);

    console.log(`UUID: ${uuid}`);
    console.log('');
    console.log('Loading communities and collections...');

    let subcommunities = [];
    let collections = [];

    try {
      subcommunities = await getSubcommunityLinks(community);
    } catch (error) {
      console.log(`[WARNING] Could not load subcommunities: ${error.message}`);
    }

    try {
      collections = await getRelatedCollectionLinks(community);
    } catch (error) {
      console.log(`[WARNING] Could not load collections: ${error.message}`);
    }

    clearScreen();
    title(name);

    let number = 1;
    const choices = [];

    if (subcommunities.length) {
      console.log('COMMUNITIES');
      console.log('');

      for (const child of subcommunities) {
        const childName = resourceName(child);
        const count = resourceCount(child);

        console.log(
          `${number}. ${childName}` + (count !== null ? ` (${count})` : ''),
        );

        choices.push({
          type: 'community',
          resource: child,
        });

        number++;
      }

      console.log('');
    }

    if (collections.length) {
      console.log('COLLECTIONS');
      console.log('');

      for (const collection of collections) {
        const collectionName = resourceName(collection);
        const count = resourceCount(collection);

        console.log(
          `${number}. ${collectionName}` +
            (count !== null ? ` (${count})` : ''),
        );

        choices.push({
          type: 'collection',
          resource: collection,
        });

        number++;
      }

      console.log('');
    }

    console.log('U. Enter UUID manually');
    console.log('B. Back');
    console.log('Q. Quit');

    const choice = (await ask('\nSelect: ')).toLowerCase();

    if (choice === 'q') return 'quit';
    if (choice === 'b') return 'back';

    if (choice === 'u') {
      const uuidInput = await ask('Enter community or collection UUID: ');

      if (!/^[0-9a-f-]{20,}$/i.test(uuidInput)) {
        console.log('That does not look like a UUID.');
        await pause();
        continue;
      }

      await browseUuid(uuidInput);
      continue;
    }

    const index = Number(choice) - 1;

    if (!Number.isInteger(index) || !choices[index]) {
      console.log('Invalid selection.');
      await pause();
      continue;
    }

    const selected = choices[index];

    if (selected.type === 'community') {
      const result = await browseCommunity(selected.resource);
      if (result === 'quit') return 'quit';
    } else {
      const result = await collectionMenu(selected.resource);
      if (result === 'quit') return 'quit';
    }
  }
}

// ============================================================
// COLLECTION MENU
// ============================================================

async function collectionMenu(collection) {
  while (true) {
    clearScreen();

    const name = resourceName(collection, 'Collection');
    const uuid = getUuid(collection);

    title(name);

    console.log(`UUID: ${uuid}`);
    console.log('');
    console.log('1. Browse / download papers');
    console.log('2. Download all papers');
    console.log('3. Filter papers');
    console.log('4. Search papers');
    console.log('B. Back');
    console.log('Q. Quit');

    const choice = (await ask('\nSelect: ')).toLowerCase();

    if (choice === 'b') return 'back';
    if (choice === 'q') return 'quit';

    if (choice === '1') {
      try {
        const papers = await loadCollectionPapers(collection);
        await pause();
        await selectionMenu(papers, collection);
      } catch (error) {
        console.log(`[ERROR] ${error.message}`);
        await pause();
      }
    }

    if (choice === '2') {
      try {
        const papers = await loadCollectionPapers(collection);

        if (!papers.length) {
          console.log('No papers discovered.');
          await pause();
          continue;
        }

        console.log('');
        console.log(`About to download ${papers.length} papers.`);
        const confirm = (await ask('Continue? (y/n): ')).toLowerCase();

        if (confirm === 'y') {
          await downloadPapers(papers, collection);
        }

        await pause();
      } catch (error) {
        console.log(`[ERROR] ${error.message}`);
        await pause();
      }
    }

    if (choice === '3') {
      try {
        const papers = await loadCollectionPapers(collection);
        const filtered = await filterMenu(papers);

        if (filtered !== null) {
          await selectionMenu(filtered, collection);
        }
      } catch (error) {
        console.log(`[ERROR] ${error.message}`);
        await pause();
      }
    }

    if (choice === '4') {
      try {
        const papers = await loadCollectionPapers(collection);
        const query = await ask('Search title/course/year: ');
        const results = filterPapers(papers, { text: query });

        console.log('');
        console.log(`Found ${results.length} matching papers.`);

        if (results.length) {
          await selectionMenu(results, collection);
        } else {
          await pause();
        }
      } catch (error) {
        console.log(`[ERROR] ${error.message}`);
        await pause();
      }
    }
  }
}

// ============================================================
// UUID BROWSER
// ============================================================

async function browseUuid(uuid) {
  clearScreen();
  title('LOOKING UP UUID');

  console.log(`UUID: ${uuid}`);
  console.log('');

  try {
    // Try collection first because collection lookup is known
    // to work on this repository.
    try {
      const collection = await getCollection(uuid);
      console.log(`Detected: Collection`);
      console.log(`Name: ${resourceName(collection)}`);
      console.log('');
      await pause();
      await collectionMenu(collection);
      return;
    } catch {}

    const community = await getCommunity(uuid);

    console.log(`Detected: Community`);
    console.log(`Name: ${resourceName(community)}`);
    console.log('');
    await pause();

    await browseCommunity(community);
  } catch (error) {
    console.log(`[ERROR] UUID could not be resolved: ${error.message}`);
    await pause();
  }
}

// ============================================================
// RESUME / MANIFEST
// ============================================================

async function resumeMenu() {
  clearScreen();
  title('RESUME PREVIOUS DOWNLOAD');

  const records = Object.values(manifest);

  if (!records.length) {
    console.log('No download records exist yet.');
    await pause();
    return;
  }

  const failed = records.filter((r) => r.status === 'failed');
  const downloaded = records.filter((r) => r.status === 'downloaded');

  console.log(`Manifest records: ${records.length}`);
  console.log(`Downloaded: ${downloaded.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log('');
  console.log('The downloader automatically resumes when you select');
  console.log('the same collection and choose the same papers again.');
  console.log('');
  console.log('Failed report:');
  console.log(CONFIG.failedFile);

  await pause();
}

// ============================================================
// MAIN MENU
// ============================================================

async function mainMenu() {
  while (true) {
    clearScreen();

    title('CHUKA UNIVERSITY REPOSITORY DOWNLOADER');

    console.log('Repository:');
    console.log(REPOSITORY_BASE);
    console.log('');
    console.log('1. Browse Examination Past Papers');
    console.log('2. Enter Community / Collection UUID');
    console.log('3. Resume / View Download Status');
    console.log('4. Exit');

    const choice = await ask('\nSelect: ');

    if (choice === '1') {
      const result = await browseCommunity(CONFIG.rootCommunity);
      if (result === 'quit') return;
    }

    if (choice === '2') {
      const uuid = await ask('\nEnter UUID: ');

      if (!/^[0-9a-f-]{20,}$/i.test(uuid)) {
        console.log('Invalid UUID format.');
        await pause();
        continue;
      }

      await browseUuid(uuid);
    }

    if (choice === '3') {
      await resumeMenu();
    }

    if (choice === '4' || choice.toLowerCase() === 'q') {
      return;
    }
  }
}

// ============================================================
// SHUTDOWN
// ============================================================

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[${signal}] Saving progress...`);

  try {
    await saveManifest();
    await saveFailures();
  } catch {}

  rl.close();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('CTRL+C'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ============================================================
// START
// ============================================================

async function main() {
  await fs.promises.mkdir(CONFIG.outputDir, { recursive: true });
  await fs.promises.mkdir(CONFIG.debugDir, { recursive: true });

  manifest = await loadJson(CONFIG.manifestFile, {});
  failures = await loadJson(CONFIG.failedFile, []);

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    manifest = {};
  }

  if (!Array.isArray(failures)) failures = [];

  clearScreen();

  console.log('');
  line();
  console.log(' CHUKA UNIVERSITY REPOSITORY DOWNLOADER');
  line();
  console.log('');
  console.log('Starting...');
  console.log('');

  try {
    await mainMenu();
  } catch (error) {
    console.error('');
    console.error(`[FATAL] ${error.stack || error.message}`);

    await debugResponse('fatal', {
      error: error.stack || error.message,
    });
  } finally {
    await saveManifest();
    await saveFailures();
    rl.close();
  }
}

main();
