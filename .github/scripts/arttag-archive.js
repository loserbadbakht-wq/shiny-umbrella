// Fetch Gelbooru posts by tag, download via the Worker proxy,
// compress with 7z, auto-split into 999000k volumes ONLY when the
// archive reaches that size (single .7z otherwise), stage for git push.
//
// Environment:
//   TAGS               - space/comma separated tags
//   RATING             - all | safe | questionable | explicit
//   USE_FILTER         - 'true' | 'false'
//   MAX_PAGES          - integer (100 posts per page)
//   COMPRESSION_PRESET - store | fast | normal | ultra
//   KEEP_RAW           - 'true' | 'false'
//   KEY                - Gelbooru API key (secret)
//   ID                 - Gelbooru user id (secret)
//   PROXY_URL          - Worker media proxy base URL
//   FILTER_LIST_URL    - JSON with BLOCKED_TAGS

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GELBOORU_API = 'https://gelbooru.com/index.php';

// Split threshold — archives below this stay as a single .7z file;
// archives at or above this are split into .7z.001, .7z.002, ...
// 7-Zip treats `k` as 1024 bytes, so 999000k ≈ 976 MiB.
const VOLUME_SIZE = '999000k';

const PROXY_URL        = process.env.PROXY_URL || '';
const FILTER_LIST_URL  = process.env.FILTER_LIST_URL || '';
const TAGS             = (process.env.TAGS || '').trim();
const RATING           = (process.env.RATING || 'all').trim().toLowerCase();
const USE_FILTER       = (process.env.USE_FILTER || 'false') === 'true';
const KEEP_RAW         = (process.env.KEEP_RAW || 'false') === 'true';
const MAX_PAGES        = clampInt(process.env.MAX_PAGES, 1, 50, 10);
const API_KEY          = process.env.KEY || '';
const USER_ID          = process.env.ID  || '';
const PRESET_NAME      = (process.env.COMPRESSION_PRESET || 'fast').trim().toLowerCase();

// 7z presets. Images barely compress — `fast` and `ultra` produce
// essentially the same size for media archives, but `ultra` is 30× slower.
const PRESETS = {
  store:  { mx: 0, ms: 'off', mfb: 32,  md: '16m'  },
  fast:   { mx: 1, ms: 'on',  mfb: 32,  md: '16m'  },
  normal: { mx: 5, ms: 'on',  mfb: 64,  md: '64m'  },
  ultra:  { mx: 9, ms: 'on',  mfb: 273, md: '256m' },
};

const PRESET = PRESETS[PRESET_NAME];
if (!PRESET) {
  console.error(`Unknown COMPRESSION_PRESET "${PRESET_NAME}". Use store|fast|normal|ultra.`);
  process.exit(1);
}

// Safety caps
const PAGE_SIZE       = 100;
const MAX_TOTAL_POSTS = 3000;

const RATING_MAP  = { safe: 's', questionable: 'q', explicit: 'e' };
const RATING_FULL = { safe: 'safe', questionable: 'questionable', explicit: 'explicit' };

// Throttle
const SLEEP_PAGE_FETCH = 1500;
const SLEEP_DOWNLOAD   = 800;
const SLEEP_ON_429     = 15000;

// ───────────────────────────────────────────── helpers
function clampInt(v, min, max, dflt) {
  const n = parseInt(String(v || ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function stripQuotes(s) {
  return String(s || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function normalizeApiRating(r) {
  const v = String(r || '').toLowerCase().trim();
  if (v === 's' || v === 'safe')         return 's';
  if (v === 'q' || v === 'questionable') return 'q';
  if (v === 'e' || v === 'explicit')     return 'e';
  if (v === 'g' || v === 'general')      return 's';
  if (v === 'sensitive')                 return 'sensitive';
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (arttag-archive)' },
  });
  if (res.status === 429 && attempt < 3) {
    console.warn(`429 on ${url} — backing off ${SLEEP_ON_429}ms`);
    await sleep(SLEEP_ON_429);
    return fetchJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function extFromUrl(u) {
  try {
    const p = new URL(u).pathname.split('.').pop() || '';
    if (/^[a-z0-9]{2,5}$/i.test(p)) return p.toLowerCase();
  } catch {}
  return null;
}

function extFromContentType(ct) {
  const c = (ct || '').toLowerCase();
  if (c.includes('jpeg')) return 'jpg';
  if (c.includes('png'))  return 'png';
  if (c.includes('gif'))  return 'gif';
  if (c.includes('webp')) return 'webp';
  if (c.includes('avif')) return 'avif';
  if (c.includes('mp4'))  return 'mp4';
  if (c.includes('webm')) return 'webm';
  if (c.includes('quicktime')) return 'mov';
  return 'bin';
}

function sanitizeSlug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'arttag';
}

// ───────────────────────────────────────────── main
async function main() {
  if (!TAGS && RATING === 'all') {
    throw new Error('At least one of `tags` or `rating` must be specified.');
  }
  if (!PROXY_URL) throw new Error('PROXY_URL env var is required.');

  console.log(`→ Compression preset: ${PRESET_NAME} (mx=${PRESET.mx}, ms=${PRESET.ms})`);
  console.log(`→ Auto-split threshold: ${VOLUME_SIZE} (smaller archives stay as single .7z)`);

  // 1. Filter list
  let blockedTags = [];
  if (USE_FILTER) {
    console.log(`→ Fetching filter list: ${FILTER_LIST_URL}`);
    try {
      const cfg = await fetchJson(FILTER_LIST_URL);
      blockedTags = Array.isArray(cfg.BLOCKED_TAGS) ? cfg.BLOCKED_TAGS : [];
      console.log(`  Loaded ${blockedTags.length} blocked tags.`);
    } catch (e) {
      console.warn(`  ⚠️ Filter list failed (${e.message}) — continuing unfiltered.`);
    }
  } else {
    console.log('→ Filter list disabled (use_filter=false).');
  }

  // 2. Build query
  const tagParts = [];
  if (TAGS) {
    tagParts.push(
      ...TAGS.split(/[,\s]+/)
        .map(stripQuotes)
        .filter(Boolean)
    );
  }
  if (RATING !== 'all') {
    if (!RATING_FULL[RATING]) {
      throw new Error(`Unknown rating "${RATING}". Use all|safe|questionable|explicit.`);
    }
    tagParts.push(`rating:${RATING_FULL[RATING]}`);
  }
  const baseQuery = tagParts.join(' ');
  const fullQuery = blockedTags.length
    ? `${baseQuery} ${blockedTags.map((t) => `-${stripQuotes(t)}`).join(' ')}`
    : baseQuery;

  console.log(`→ Query: ${fullQuery}`);

  // 3. Fetch posts
  const all = [];
  const seen = new Set();

  for (let pid = 0; pid < MAX_PAGES; pid++) {
    if (all.length >= MAX_TOTAL_POSTS) {
      console.log(`  hit MAX_TOTAL_POSTS (${MAX_TOTAL_POSTS}) — stopping pagination.`);
      break;
    }

    const params = new URLSearchParams({
      page: 'dapi', s: 'post', q: 'index', json: '1',
      limit: String(PAGE_SIZE), pid: String(pid), tags: fullQuery,
    });
    if (API_KEY) params.set('api_key', API_KEY);
    if (USER_ID) params.set('user_id', USER_ID);

    console.log(`→ Fetching page ${pid + 1}/${MAX_PAGES}...`);
    let data;
    try {
      data = await fetchJson(`${GELBOORU_API}?${params}`);
    } catch (e) {
      console.error(`  ✗ page ${pid + 1} failed: ${e.message}`);
      break;
    }

    const posts = data.post || [];
    console.log(`  Got ${posts.length} posts.`);
    if (!posts.length) break;

    for (const p of posts) {
      const id = parseInt(p.id, 10);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      all.push({ ...p, id });
    }

    if (posts.length < PAGE_SIZE) break;
    if (pid < MAX_PAGES - 1) await sleep(SLEEP_PAGE_FETCH);
  }

  console.log(`→ Total unique posts: ${all.length}`);

  // 4. Client-side filters
  let filtered = all;

  if (RATING !== 'all') {
    const code = RATING_MAP[RATING];

    const dist = {};
    for (const p of filtered) {
      const k = normalizeApiRating(p.rating) || '(empty)';
      dist[k] = (dist[k] || 0) + 1;
    }
    console.log(`  API rating distribution: ${JSON.stringify(dist)}`);

    filtered = filtered.filter((p) => normalizeApiRating(p.rating) === code);
    console.log(`  After rating=${RATING}: ${filtered.length}`);

    if (filtered.length === 0 && all.length > 0) {
      console.log('  DEBUG sample post:',
        JSON.stringify({ id: all[0].id, rating: all[0].rating }, null, 2));
    }
  }

  if (blockedTags.length) {
    const blocked = new Set(blockedTags.map((t) => stripQuotes(t)));
    filtered = filtered.filter((p) => {
      const t = (p.tags || '').split(/\s+/).filter(Boolean);
      return !t.some((x) => blocked.has(x));
    });
    console.log(`  After blocked-tag filter: ${filtered.length}`);
  }

  if (!filtered.length) {
    console.log('→ Nothing matches. Aborting.');
    return;
  }

  // 5. Output dirs
  fs.mkdirSync('archives', { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = sanitizeSlug(TAGS || 'rating_only');
  const ratingSuffix = RATING !== 'all' ? `_${RATING}` : '';
  const folderName = `${slug}${ratingSuffix}_${ts}`;
  const mediaDir = path.join('archives', folderName);
  fs.mkdirSync(mediaDir, { recursive: true });

  // 6. Download
  let downloaded = 0;
  let failed = 0;
  const failedIds = [];

  for (const post of filtered) {
    const candidates = [post.file_url, post.sample_url, post.preview_url]
      .filter((u) => typeof u === 'string' && u.length > 0);

    if (!candidates.length) {
      failed++;
      failedIds.push(post.id);
      continue;
    }

    let ok = false;
    for (const target of candidates) {
      try {
        const proxyUrl = `${PROXY_URL.replace(/\/+$/, '')}/${target}`;
        const res = await fetch(proxyUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (arttag-archive)' },
        });

        if (res.status === 429) {
          console.warn(`  ⏸ 429 on ${post.id} — waiting ${SLEEP_ON_429}ms`);
          await sleep(SLEEP_ON_429);
          continue;
        }
        if (!res.ok) {
          console.warn(`  ${post.id}: ${res.status}`);
          continue;
        }

        const ct = res.headers.get('content-type') || '';
        if (/text\/html|application\/xhtml/i.test(ct)) {
          console.warn(`  ${post.id}: upstream returned HTML — skipping`);
          continue;
        }

        const ext = extFromUrl(target) || extFromContentType(ct);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) continue;

        const base = String(post.id).padStart(10, '0');
        fs.writeFileSync(path.join(mediaDir, `${base}.${ext}`), buf);

        fs.writeFileSync(
          path.join(mediaDir, `${base}.json`),
          JSON.stringify({
            id: post.id,
            rating: post.rating,
            score: post.score,
            source: post.source,
            tags: post.tags,
            file_url: post.file_url,
            sample_url: post.sample_url,
            preview_url: post.preview_url,
            fetched_at: new Date().toISOString(),
            query: { tags: TAGS, rating: RATING, use_filter: USE_FILTER },
          }, null, 2)
        );

        downloaded++;
        console.log(`  ✓ ${post.id} (${(buf.length / 1024 / 1024).toFixed(2)} MB, ${ext})`);
        ok = true;
        break;
      } catch (e) {
        console.warn(`  ${post.id}: ${e.message}`);
      }
    }

    if (!ok) {
      failed++;
      failedIds.push(post.id);
      console.log(`  ✗ ${post.id} — all candidates failed`);
    }

    await sleep(SLEEP_DOWNLOAD);
  }

  console.log(`→ Downloaded: ${downloaded}   Failed: ${failed}`);

  if (!downloaded) {
    console.log('→ Nothing downloaded — aborting.');
    fs.rmSync(mediaDir, { recursive: true, force: true });
    return;
  }

  if (failedIds.length) {
    fs.writeFileSync(
      path.join(mediaDir, '_failed_ids.json'),
      JSON.stringify({ count: failedIds.length, ids: failedIds }, null, 2)
    );
  }

  // 7. Compress with auto-split at VOLUME_SIZE
  const archivePath = path.join('archives', `${folderName}.7z`);
  console.log(`→ Compressing (preset=${PRESET_NAME}, mx=${PRESET.mx}, ms=${PRESET.ms}, -v${VOLUME_SIZE})…`);

  const sevenZipArgs = [
    'a', '-t7z', '-m0=lzma2',
    `-mx=${PRESET.mx}`,
    `-ms=${PRESET.ms}`,
    `-mfb=${PRESET.mfb}`,
    `-md=${PRESET.md}`,
    '-mmt=on',
    '-y',
    `-v${VOLUME_SIZE}`,
    archivePath,
    mediaDir,
  ];

  execSync(`7z ${sevenZipArgs.map((a) => JSON.stringify(a)).join(' ')}`, {
    stdio: 'inherit',
    shell: '/bin/bash',
  });

  // Detect outputs. 7z with -v produces either one .7z.001 (if the
  // archive is smaller than VOLUME_SIZE) or multiple .7z.00N files.
  const archiveDir  = path.dirname(archivePath);
  const archiveBase = path.basename(archivePath);
  const entries     = fs.readdirSync(archiveDir);

  const volumes = entries
    .filter((e) => e.startsWith(archiveBase + '.'))
    .sort();

  let archiveFiles;
  if (volumes.length === 1 && volumes[0] === archiveBase + '.001') {
    // Single volume → rename to plain .7z so it's not treated as split.
    const singlePath = path.join(archiveDir, volumes[0]);
    fs.renameSync(singlePath, archivePath);
    archiveFiles = [archivePath];
    console.log(`→ Archive < ${VOLUME_SIZE}; saved as single .7z (no split).`);
  } else if (volumes.length > 1) {
    archiveFiles = volumes.map((e) => path.join(archiveDir, e));
    console.log(`→ Archive >= ${VOLUME_SIZE}; split into ${volumes.length} volumes.`);
  } else if (entries.includes(archiveBase)) {
    // Safety net (shouldn't happen since -v is always passed)
    archiveFiles = [archivePath];
    console.log('→ Archive saved as single .7z.');
  } else {
    throw new Error('Archive creation reported success but no output files found.');
  }

  // Size report
  let totalSize = 0;
  for (const f of archiveFiles) {
    const s = fs.statSync(f).size;
    totalSize += s;
    console.log(`  ${path.basename(f)}: ${(s / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log(`→ Archive total: ${(totalSize / 1024 / 1024).toFixed(2)} MB (${archiveFiles.length} file${archiveFiles.length > 1 ? 's' : ''})`);

  const sourceSize = fs.readdirSync(mediaDir)
    .reduce((n, f) => n + fs.statSync(path.join(mediaDir, f)).size, 0);
  const saved = sourceSize - totalSize;
  console.log(`→ Source: ${(sourceSize / 1024 / 1024).toFixed(2)} MB, saved ${(saved / 1024 / 1024).toFixed(2)} MB (${(saved / sourceSize * 100).toFixed(1)}%)`);

  // 8. Cleanup
  if (!KEEP_RAW) {
    fs.rmSync(mediaDir, { recursive: true, force: true });
    console.log('→ Raw folder removed.');
  } else {
    console.log('→ Raw folder kept (KEEP_RAW=true).');
  }

  console.log('✓ Done.');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
