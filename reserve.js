/*
 * PEPS reservation sniper.
 *
 * Supports multiple sequential "jobs" in a single config — each job has its
 * own activity/date/targets, and the script walks through them one at a time.
 * Between jobs you log in to the relevant account in the Chrome window the
 * script opens, then press Enter to continue.
 *
 * Config formats:
 *
 * Multi-job (preferred when you have several bookings to make):
 *   {
 *     "fire_lead_ms": 50,
 *     "jobs": [
 *       {
 *         "name": "compte-a",
 *         "activity": "Volleyball",
 *         "date": "2026-05-18",
 *         "targets": [ { "plateau": "1305C", "start_time": "18:30", "terrain": "1" } ]
 *       },
 *       {
 *         "name": "compte-b",
 *         "activity": "Volleyball",
 *         "date": "2026-05-18",
 *         "targets": [ { "plateau": "1305C", "start_time": "19:30", "terrain": "1" } ]
 *       }
 *     ]
 *   }
 *
 * Single-job (legacy, still works):
 *   {
 *     "activity": "Volleyball",
 *     "date": "2026-05-18",
 *     "targets": [ ... ]
 *   }
 *
 * Setup (run once):
 *   npm install
 *
 * Run:
 *   node reserve.js                 # uses config.json
 *   node reserve.js other.json      # uses other.json
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.argv[2] || 'config.json';

function loadConfig() {
  const path = join(__dirname, CONFIG_PATH);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`Could not read ${CONFIG_PATH} at ${path}: ${e.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${e.message}`);
  }
  return normalizeAndValidate(cfg);
}

function normalizeAndValidate(cfg) {
  const errors = [];

  function isString(v) {
    return typeof v === 'string' && v.trim() !== '';
  }
  function checkPositiveNumber(obj, field) {
    if (obj[field] === undefined) return;
    const v = obj[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      errors.push(`"${field}" must be a positive number (got: ${JSON.stringify(v)})`);
    }
  }

  function validateJob(job, location) {
    if (typeof job !== 'object' || job === null) {
      errors.push(`${location}: must be an object`);
      return;
    }
    if (!isString(job.activity)) {
      errors.push(`${location}: "activity" must be a non-empty string`);
    }
    if (job.name !== undefined && !isString(job.name)) {
      errors.push(`${location}: "name" must be a non-empty string if present`);
    }
    if (job.date !== undefined) {
      if (!isString(job.date) || !/^\d{4}-\d{2}-\d{2}$/.test(job.date)) {
        errors.push(`${location}: "date" must be in YYYY-MM-DD format (got: ${JSON.stringify(job.date)})`);
      }
    }
    if (!Array.isArray(job.targets) || job.targets.length === 0) {
      errors.push(`${location}: "targets" must be a non-empty array`);
    } else {
      job.targets.forEach((t, i) => {
        const loc = `${location}.targets[${i}]`;
        if (typeof t !== 'object' || t === null) {
          errors.push(`${loc}: must be an object with plateau/start_time/terrain`);
          return;
        }
        if (!isString(t.plateau)) errors.push(`${loc}: "plateau" must be a non-empty string`);
        if (!isString(t.start_time)) errors.push(`${loc}: "start_time" must be a non-empty string`);
        if (!isString(t.terrain)) errors.push(`${loc}: "terrain" must be a non-empty string`);
        if (isString(t.start_time) && !/^\d{2}:\d{2}$/.test(t.start_time)) {
          errors.push(`${loc}: "start_time" must be HH:MM with leading zeros (got: ${JSON.stringify(t.start_time)})`);
        }
      });
    }
  }

  let jobs;
  if (Array.isArray(cfg.jobs)) {
    if (cfg.jobs.length === 0) {
      errors.push('"jobs" must be a non-empty array');
      jobs = [];
    } else {
      cfg.jobs.forEach((j, i) => validateJob(j, `jobs[${i}]`));
      jobs = cfg.jobs;
    }
  } else {
    validateJob(cfg, 'top-level');
    jobs = [cfg];
  }

  jobs.forEach((j, i) => {
    if (!isString(j.name)) j.name = `job-${i + 1}`;
  });

  checkPositiveNumber(cfg, 'fire_lead_ms');
  checkPositiveNumber(cfg, 'step1_retry_count');
  checkPositiveNumber(cfg, 'step1_retry_delay_ms');
  checkPositiveNumber(cfg, 'keepalive_interval_ms');

  if (errors.length > 0) {
    throw new Error(['config is invalid:', ...errors.map((e) => `  - ${e}`)].join('\n'));
  }

  return {
    fire_lead_ms: cfg.fire_lead_ms ?? 50,
    step1_retry_count: cfg.step1_retry_count ?? 4,
    step1_retry_delay_ms: cfg.step1_retry_delay_ms ?? 120,
    keepalive_interval_ms: cfg.keepalive_interval_ms ?? 4 * 60 * 1000,
    jobs,
  };
}

let CONFIG;
try {
  CONFIG = loadConfig();
} catch (e) {
  console.error('\n' + e.message + '\n');
  process.exit(1);
}

const BASE = 'https://secure.sas.ulaval.ca';
const FIRE_LEAD_MS = CONFIG.fire_lead_ms;
const STEP1_RETRY_COUNT = CONFIG.step1_retry_count;
const STEP1_RETRY_DELAY_MS = CONFIG.step1_retry_delay_ms;
const KEEPALIVE_INTERVAL_MS = CONFIG.keepalive_interval_ms;

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

let _rl = null;
function getReadline() {
  if (!_rl) {
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return _rl;
}
function closeReadline() {
  if (_rl) {
    _rl.close();
    _rl = null;
  }
}
function pressEnter(msg) {
  return new Promise((resolve) => {
    const rl = getReadline();
    process.stdout.write(msg);
    rl.once('line', () => resolve());
  });
}

let sleepInhibitor = null;
function preventSleep() {
  try {
    const child = spawn(
      'systemd-inhibit',
      [
        '--what=sleep:idle',
        '--who=peps-reservation',
        '--why=waiting for reservation booking',
        '--mode=block',
        'sleep',
        'infinity',
      ],
      { stdio: 'ignore' },
    );
    child.on('error', (e) => {
      console.log(`(Sleep inhibit unavailable: ${e.message}. Disable sleep manually in Settings if needed.)`);
    });
    child.on('spawn', () => {
      console.log('Sleep/suspend inhibited until the script exits.');
    });
    return child;
  } catch (e) {
    console.log(`(Could not start sleep inhibitor: ${e.message})`);
    return null;
  }
}

function releaseSleepInhibitor() {
  if (sleepInhibitor && !sleepInhibitor.killed) {
    try {
      sleepInhibitor.kill();
    } catch {
      /* ignore */
    }
  }
}

process.on('exit', releaseSleepInhibitor);
process.on('SIGINT', () => {
  releaseSleepInhibitor();
  process.exit(130);
});
process.on('SIGTERM', () => {
  releaseSleepInhibitor();
  process.exit(143);
});

function cookiesToHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function targetLabel(t) {
  return `${t.plateau} ${t.start_time} terrain ${t.terrain}`;
}

function pageUrl(activity) {
  return `${BASE}/rtpeps/Reservation/Disponibilites?selectedActivite=${encodeURIComponent(activity)}`;
}

function defaultHeaders(cookieHeader, extra = {}) {
  return {
    Cookie: cookieHeader,
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8',
    ...extra,
  };
}

function parseTargetRow(html, target, fetchedAt) {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    const cellMatches = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
    if (cellMatches.length < 6) continue;
    const cells = cellMatches.map((m) => m[1]);
    const plateau = stripTags(cells[0]);
    const start = stripTags(cells[1]);
    const terrain = stripTags(cells[3]);
    if (plateau !== target.plateau) continue;
    if (start !== target.start_time) continue;
    if (terrain !== target.terrain) continue;
    const availability = cells[5];

    const hrefMatch = availability.match(/href="([^"]*\/Reservation\/Reserver\/(\d+))[^"]*"/);
    if (!hrefMatch) {
      return { error: 'no_reserve_link', cellText: stripTags(availability) };
    }
    const reserveHref = decodeEntities(hrefMatch[1]);
    const slotId = hrefMatch[2];

    const countdownMatch = availability.match(/data-countdown="(\d+)"/);
    const dataCountdownMs = countdownMatch ? parseInt(countdownMatch[1], 10) : null;

    const hasHideWrapper = /class="linkReserverHide"[^>]*style="display:\s*none/.test(availability);
    const isOpenNow = dataCountdownMs === null || !hasHideWrapper;

    const openAtMs = isOpenNow ? fetchedAt : fetchedAt + dataCountdownMs;

    return {
      slotId,
      reserveHref,
      dataCountdownMs,
      isOpenNow,
      openAtMs,
      cellText: stripTags(availability),
    };
  }
  return null;
}

function lavalDateParam(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-');
  return `${m}/${d}/${y} 00:00:00`;
}

async function selectDateOnServer(cookieHeader, yyyymmdd) {
  const param = lavalDateParam(yyyymmdd);
  const url = `${BASE}/rtpeps/Reservation/Sport?selectedDate=${encodeURIComponent(param)}`;
  return fetch(url, {
    headers: defaultHeaders(cookieHeader),
    redirect: 'follow',
  });
}

async function fetchPage(cookieHeader, job) {
  const fetchedAt = Date.now();
  if (job.date) {
    await selectDateOnServer(cookieHeader, job.date);
  }
  const resp = await fetch(pageUrl(job.activity), {
    headers: defaultHeaders(cookieHeader),
    redirect: 'follow',
  });
  const html = await resp.text();
  return { resp, html, fetchedAt };
}

async function fireStep1(cookieHeader, slotId, job) {
  const url = `${BASE}/rtpeps/Reservation/Reserver/${slotId}`;
  const resp = await fetch(url, {
    headers: defaultHeaders(cookieHeader, { Referer: pageUrl(job.activity) }),
    redirect: 'follow',
  });
  const body = await resp.text();
  const isConfirmation =
    /Confirmer la r[ée]servation/i.test(body) || /\/Reservation\/Confirmation/i.test(resp.url);
  return { resp, body, isConfirmation };
}

async function fireStep2(cookieHeader, confirmationHtml) {
  const tokenMatch = confirmationHtml.match(
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/,
  );
  if (!tokenMatch) {
    return { ok: false, reason: 'csrf_token_not_found' };
  }
  const token = tokenMatch[1];
  const url = `${BASE}/rtpeps/Reservation/Reserver?hasConfirmation=True`;
  const body = `__RequestVerificationToken=${encodeURIComponent(token)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: defaultHeaders(cookieHeader, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${BASE}/rtpeps/Reservation/Confirmation?bypassPartenaires=True`,
    }),
    body,
    redirect: 'follow',
  });
  const respBody = await resp.text();
  return { ok: true, resp, body: respBody };
}

const SUCCESS_PHRASES = [
  'consulter vos réservations',
  "n'oubliez pas de confirmer votre réservation sur place",
  'retour aux réservations',
];

const FAILURE_PHRASES = [
  'déjà réservé',
  "n'est plus disponible",
  'plus disponible',
  'maximum de réservations',
  'limite de réservations',
  'vous ne pouvez pas',
  'une erreur est survenue',
];

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#233;/g, 'é')
    .replace(/&#232;/g, 'è')
    .replace(/&#234;/g, 'ê')
    .replace(/&#224;/g, 'à')
    .replace(/&#244;/g, 'ô')
    .replace(/&#231;/g, 'ç')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function classifyStep2(finalUrl, body) {
  const text = visibleText(body);
  if (/confirmer la r[ée]servation\s*!/.test(text)) return 'failed_still_on_confirm';
  if (SUCCESS_PHRASES.some((p) => text.includes(p))) return 'success';
  if (FAILURE_PHRASES.some((p) => text.includes(p))) return 'failed';
  return 'unknown';
}

const FRENCH_MONTHS = {
  '01': 'janvier', '02': 'février', '03': 'mars', '04': 'avril',
  '05': 'mai', '06': 'juin', '07': 'juillet', '08': 'août',
  '09': 'septembre', '10': 'octobre', '11': 'novembre', '12': 'décembre',
};

function expectedDateHeadingFragment(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-');
  return `${parseInt(d, 10)} ${FRENCH_MONTHS[m]} ${y}`;
}

function saveResponse(job, target, label, body) {
  const safeTime = target.start_time.replace(':', '');
  const fname = `booked_${job.name}_${Date.now()}_${target.plateau}_${safeTime}_${target.terrain}_${label}.html`;
  writeFileSync(join(__dirname, fname), body);
  return fname;
}

async function waitUntil(targetTs, label) {
  while (true) {
    const remaining = targetTs - Date.now();
    if (remaining <= 0) return;
    const chunk = Math.min(remaining, 30_000);
    process.stdout.write(
      `\r[${nowStamp()}] ${label} | ${(remaining / 1000).toFixed(1)}s until fire   `,
    );
    await sleep(chunk);
  }
}

async function attemptTarget(cookieHeader, job, target, info) {
  const label = `${job.name} ${targetLabel(target)}`;
  await waitUntil(info.openAtMs + FIRE_LEAD_MS, label);
  console.log(`\n[${nowStamp()}] Firing step 1 for ${label} (slot ${info.slotId})`);

  let step1;
  for (let attempt = 1; attempt <= STEP1_RETRY_COUNT; attempt++) {
    const t0 = Date.now();
    try {
      step1 = await fireStep1(cookieHeader, info.slotId, job);
    } catch (e) {
      console.log(`  step1 attempt ${attempt} threw: ${e.message}`);
      await sleep(STEP1_RETRY_DELAY_MS);
      continue;
    }
    const dt = Date.now() - t0;
    console.log(
      `  step1 attempt ${attempt}: HTTP ${step1.resp.status} | ${dt}ms | confirmation=${step1.isConfirmation}`,
    );
    if (step1.isConfirmation) break;
    if (attempt < STEP1_RETRY_COUNT) await sleep(STEP1_RETRY_DELAY_MS);
  }

  if (!step1 || !step1.isConfirmation) {
    const fname = step1
      ? saveResponse(job, target, 'step1_fail', step1.body)
      : null;
    return { outcome: 'failed', stage: 'step1', savedTo: fname };
  }

  console.log(`[${nowStamp()}] Step 1 OK. Firing step 2 (confirm POST)...`);
  const step2 = await fireStep2(cookieHeader, step1.body);
  if (!step2.ok) {
    const fname = saveResponse(job, target, 'step2_no_csrf', step1.body);
    return { outcome: 'unknown', stage: 'step2_setup', reason: step2.reason, savedTo: fname };
  }
  const cls = classifyStep2(step2.resp.url, step2.body);
  const fname = saveResponse(job, target, `step2_${cls}`, step2.body);
  console.log(
    `  step2: HTTP ${step2.resp.status} | final URL: ${step2.resp.url} | classified=${cls} | saved to ${fname}`,
  );
  if (cls === 'success') {
    return { outcome: 'success', savedTo: fname, classification: cls };
  }
  if (cls === 'unknown') {
    return { outcome: 'unknown', stage: 'step2', savedTo: fname };
  }
  return { outcome: 'failed', stage: 'step2', savedTo: fname };
}

async function loginForJob(job, jobIndex, totalJobs) {
  console.log(`\n\n############## Login ${jobIndex + 1}/${totalJobs}: ${job.name} ##############`);
  console.log(`Activity: ${job.activity}`);
  if (job.date) console.log(`Date:     ${job.date}`);
  console.log('Target priority list:');
  job.targets.forEach((t, i) => console.log(`  ${i + 1}. ${targetLabel(t)}`));

  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  await page.goto(pageUrl(job.activity));

  console.log(`\n>>> [${job.name}] Log in via Laval CAS in the browser window.`);
  console.log('>>> Once you see the reservations page,');
  await pressEnter(`>>> press Enter here to continue [${job.name}]: `);

  await page.goto(pageUrl(job.activity));
  await page.waitForLoadState('networkidle').catch(() => {});

  const cookies = await ctx.cookies();
  const cookieHeader = cookiesToHeader(cookies);
  console.log(`Captured ${cookies.length} cookies for ${job.name}.`);
  await browser.close();
  return cookieHeader;
}

async function bookForJob(job, cookieHeader, jobIndex, totalJobs) {
  console.log(`\n\n############## Booking ${jobIndex + 1}/${totalJobs}: ${job.name} ##############`);

  const { resp: probeResp, html: probeHtml, fetchedAt } = await fetchPage(cookieHeader, job);
  const lastResponseFile = `last_response_${job.name}.html`;
  writeFileSync(join(__dirname, lastResponseFile), probeHtml);
  if (probeResp.status !== 200) {
    console.log(`Probe failed: HTTP ${probeResp.status}. Saved page to ${lastResponseFile}`);
    return { outcome: 'failed_probe' };
  }

  const dateHeading = probeHtml.match(/Disponibilit[ée]s pour la journ[ée]e du\s*([^<]+)</i);
  const headingText = dateHeading ? stripTags(decodeEntities(dateHeading[1])) : null;
  if (headingText) {
    console.log(`Page is showing slots for: ${headingText}`);
  }
  if (job.date) {
    const expected = expectedDateHeadingFragment(job.date);
    if (!headingText || !headingText.toLowerCase().includes(expected.toLowerCase())) {
      console.log(`Date mismatch: requested ${job.date} (${expected}) but page shows ${headingText ?? 'unknown'}.`);
      console.log('Skipping this job.');
      return { outcome: 'failed_date_mismatch' };
    }
  }

  const infos = [];
  let foundCount = 0;
  for (const target of job.targets) {
    const info = parseTargetRow(probeHtml, target, fetchedAt);
    if (!info || info.error) {
      console.log(`  - ${targetLabel(target)}: NOT FOUND (will skip)`);
      infos.push(null);
    } else {
      const when = info.isOpenNow
        ? 'OPEN NOW'
        : `opens in ${(info.dataCountdownMs / 1000).toFixed(1)}s`;
      console.log(`  - ${targetLabel(target)}: slotId=${info.slotId} ${when}`);
      infos.push(info);
      foundCount++;
    }
  }
  if (foundCount === 0) {
    console.log(`\nNo target was found for ${job.name}. Skipping.`);
    return { outcome: 'failed_no_targets' };
  }

  for (let i = 0; i < job.targets.length; i++) {
    const target = job.targets[i];
    const info = infos[i];
    if (info === null) continue;
    console.log(`\n--- Trying target ${i + 1}/${job.targets.length}: ${targetLabel(target)} ---`);
    const result = await attemptTarget(cookieHeader, job, target, info);

    if (result.outcome === 'success') {
      console.log(`\n*** SUCCESS [${job.name}]: booked ${targetLabel(target)} ***`);
      console.log(`Response saved to ${result.savedTo}`);
      return { outcome: 'success', booked: target, savedTo: result.savedTo };
    }
    if (result.outcome === 'unknown') {
      console.log(
        `\n!!! UNCERTAIN outcome for ${targetLabel(target)} at stage ${result.stage}.\n` +
          `    Open ${result.savedTo} to verify whether the booking went through.`,
      );
      return { outcome: 'unknown', savedTo: result.savedTo };
    }
    console.log(`Target ${targetLabel(target)} failed at stage ${result.stage}. Moving to next.`);
  }

  console.log(`\nAll targets for ${job.name} failed.`);
  return { outcome: 'failed_all_targets' };
}

async function keepAliveAll(jobs, cookieHeaders) {
  for (let i = 0; i < jobs.length; i++) {
    const ch = cookieHeaders[i];
    if (!ch) continue;
    try {
      await fetchPage(ch, jobs[i]);
    } catch (e) {
      console.log(`\n[${nowStamp()}] keep-alive fetch failed for ${jobs[i].name}: ${e.message}`);
    }
  }
}

async function main() {
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Jobs to run: ${CONFIG.jobs.length}`);
  CONFIG.jobs.forEach((j, i) => {
    console.log(`  ${i + 1}. ${j.name} — ${j.activity}${j.date ? ` on ${j.date}` : ''}`);
  });
  console.log(`Fire lead: ${FIRE_LEAD_MS}ms | Step1 retries: ${STEP1_RETRY_COUNT} (${STEP1_RETRY_DELAY_MS}ms between) | Keep-alive: ${(KEEPALIVE_INTERVAL_MS / 1000).toFixed(0)}s`);

  sleepInhibitor = preventSleep();

  // Phase 1: collect logins for ALL jobs upfront.
  const cookieHeaders = [];
  for (let i = 0; i < CONFIG.jobs.length; i++) {
    const ch = await loginForJob(CONFIG.jobs[i], i, CONFIG.jobs.length);
    cookieHeaders.push(ch);
  }

  console.log('\n\n############## All logins captured. You can now leave the computer. ##############');
  console.log('The script will book each slot at its open moment.');
  console.log(`All sessions are kept alive in the background every ${(KEEPALIVE_INTERVAL_MS / 1000).toFixed(0)}s.\n`);

  // Phase 2: keep all sessions alive while we wait for each booking.
  const keepAliveTimer = setInterval(
    () => keepAliveAll(CONFIG.jobs, cookieHeaders),
    KEEPALIVE_INTERVAL_MS,
  );

  const results = [];
  for (let i = 0; i < CONFIG.jobs.length; i++) {
    const job = CONFIG.jobs[i];
    let res;
    try {
      res = await bookForJob(job, cookieHeaders[i], i, CONFIG.jobs.length);
    } catch (e) {
      console.error(`\nJob ${job.name} threw: ${e.message}`);
      res = { outcome: 'error', error: e.message };
    }
    results.push({ job: job.name, ...res });
  }

  clearInterval(keepAliveTimer);

  console.log('\n\n############## All jobs complete ##############');
  results.forEach((r) => {
    const status = r.outcome === 'success' ? 'OK   ' : 'FAIL ';
    console.log(`  [${status}] ${r.job}: ${r.outcome}${r.booked ? ` — ${targetLabel(r.booked)}` : ''}`);
  });
  await pressEnter('\nPress Enter to exit: ');
  closeReadline();
  releaseSleepInhibitor();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
