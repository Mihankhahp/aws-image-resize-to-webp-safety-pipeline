// Drives test-ui/index.html in a headless browser against ui-server.mjs and
// saves screenshots to test/output/ui for review. Uses Edge on Windows,
// otherwise Playwright Chromium (`npx playwright install chromium`); set
// PW_CHANNEL to choose another installed browser.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startUiServer, uiConfig } from './ui-server.mjs';
import { sharp } from './sim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'output', 'ui');
mkdirSync(shots, { recursive: true });
const PORT = 5180;
const ENDPOINT = `http://localhost:${PORT}/v1/upload-url`;
const server = await startUiServer(PORT);
const channel =
  process.env.PW_CHANNEL ||
  (process.platform === 'win32' ? 'msedge' : undefined);
const browser = await chromium.launch({ channel, headless: true });

const results = [];
const check = (label, ok, detail = '') =>
  results.push({ label, ok: Boolean(ok), detail });

// A photo-like test image: smooth gradients plus a few shapes.
async function testPhoto(width, height) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.round(40 + 180 * (x / width));
      raw[i + 1] = Math.round(90 + 120 * (y / height));
      raw[i + 2] = Math.round(200 - 120 * (x / width) * (y / height));
    }
  const circle = Buffer.from(
    `<svg width="${width}" height="${height}"><circle cx="${width * 0.68}" cy="${height * 0.42}" r="${height * 0.22}" fill="#ffd166" fill-opacity="0.9"/><rect x="${width * 0.12}" y="${height * 0.55}" width="${width * 0.3}" height="${height * 0.28}" rx="40" fill="#073b4c" fill-opacity="0.75"/></svg>`,
  );
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .composite([{ input: circle }])
    .png()
    .toBuffer();
}
const photo = await testPhoto(2400, 1600);

async function newPage(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...options,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Outside the stack-hosted website there is no config.json; that 404 is expected.
  page.on(
    'console',
    (m) =>
      m.type() === 'error' &&
      !m.location().url.endsWith('/config.json') &&
      errors.push(m.text()),
  );
  return { context, page, errors };
}
async function upload(page, name, mimeType, buffer) {
  await page.setInputFiles('#fileInput', { name, mimeType, buffer });
  await page.click('#startButton');
}
const outcomeTitle = (page) => page.locator('#outcomeTitle');

// --- Desktop, light ---------------------------------------------------------
{
  const { context, page, errors } = await newPage({ colorScheme: 'light' });
  await page.goto(`http://localhost:${PORT}/`);
  check(
    'connect card shown on first visit',
    await page.isVisible('#connectCard'),
  );
  check(
    'start disabled before connecting',
    await page.isDisabled('#startButton'),
  );
  await page.screenshot({ path: path.join(shots, '01-connect.png') });

  await page.fill('#endpoint', 'not a url');
  await page.click('#connectForm button[type=submit]');
  check('invalid endpoint rejected', await page.isVisible('#endpointError'));
  await page.fill('#endpoint', `http://localhost:${PORT}/v1/`);
  await page.click('#connectForm button[type=submit]');
  check(
    'API base URL normalized to /upload-url',
    (await page.inputValue('#endpoint')) === ENDPOINT,
  );
  check(
    'connection chip shows host',
    (await page.textContent('#connectionLabel')).includes(`localhost:${PORT}`),
  );
  check(
    'connect card hidden after saving',
    !(await page.isVisible('#connectCard')),
  );

  await page.setInputFiles('#fileInput', {
    name: 'IMG_0042.HEIC',
    mimeType: 'image/heic',
    buffer: Buffer.from('x'),
  });
  check(
    'HEIC rejected with a specific message',
    /HEIC/.test(await page.textContent('#fileError')),
  );
  check('start still disabled', await page.isDisabled('#startButton'));
  await page.screenshot({ path: path.join(shots, '02-heic.png') });

  await page.setInputFiles('#fileInput', {
    name: 'sunset-photo.png',
    mimeType: 'image/png',
    buffer: photo,
  });
  await page.waitForFunction(() =>
    document.getElementById('fileFacts').textContent.includes('px'),
  );
  check(
    'file summary shows dimensions',
    (await page.textContent('#fileFacts')).includes('2400 × 1600 px'),
  );
  check('start enabled', await page.isEnabled('#startButton'));
  await page.screenshot({ path: path.join(shots, '03-selected.png') });

  await page.click('#startButton');
  await page.waitForSelector('[data-step="scan"][data-state="active"]');
  check(
    'picker steps aside while processing',
    !(await page.isVisible('#uploadCard')),
  );
  check(
    'upload bar hidden once uploaded',
    !(await page.isVisible('[data-step="upload"] .progress')),
  );
  check(
    'leave button says Start over after upload',
    (await page.textContent('#startOverRunning')) === 'Start over',
  );
  await page.screenshot({ path: path.join(shots, '04-scanning.png') });
  await page.waitForSelector('[data-step="convert"][data-state="active"]', {
    timeout: 15000,
  });
  await page.screenshot({ path: path.join(shots, '05-converting.png') });
  await outcomeTitle(page)
    .filter({ hasText: 'Your WebP is ready' })
    .waitFor({ timeout: 20000 });
  await page.waitForFunction(
    () => document.getElementById('webpPreview').naturalWidth > 0,
  );
  check(
    'all four steps done',
    (await page.$$('[data-state="done"]')).length === 4,
  );
  check(
    'WebP preview is 1280 px wide',
    (await page.evaluate(
      () => document.getElementById('webpPreview').naturalWidth,
    )) === 1280,
  );
  check(
    'download keeps a .webp file name',
    (await page.getAttribute('#downloadWebp', 'download')) ===
      'sunset-photo.webp',
  );
  check(
    'download link is a blob',
    (await page.getAttribute('#downloadWebp', 'href')).startsWith('blob:'),
  );
  check(
    'savings reported',
    /smaller/.test(await page.textContent('#outcomeBody')),
  );
  const fits = await page.evaluate(() =>
    [...document.querySelectorAll('.preview img, .preview canvas')].every(
      (el) => {
        const a = el.getBoundingClientRect();
        const b = el.parentElement.getBoundingClientRect();
        return (
          a.top >= b.top &&
          a.bottom <= b.bottom + 0.5 &&
          a.left >= b.left &&
          a.right <= b.right + 0.5
        );
      },
    ),
  );
  check('previews stay inside their frames', fits);
  await page.screenshot({
    path: path.join(shots, '06-success.png'),
    fullPage: true,
  });

  await page.click('#detailsCard summary');
  check(
    'image id shown in details',
    (await page.textContent('#imageIdValue')).length === 36,
  );
  await page.screenshot({
    path: path.join(shots, '07-details.png'),
    fullPage: true,
  });

  await page.click('#startOver');
  check('start over returns to the picker', await page.isVisible('#dropzone'));
  check(
    'results hidden after start over',
    !(await page.isVisible('#resultsCard')),
  );

  await upload(
    page,
    'malware-sample.png',
    'image/png',
    await testPhoto(400, 300),
  );
  await outcomeTitle(page)
    .filter({ hasText: 'malware detected' })
    .waitFor({ timeout: 20000 });
  check(
    'blocked: scan step failed',
    await page.isVisible('[data-step="scan"][data-state="failed"]'),
  );
  check(
    'blocked: threat named',
    /EICAR/.test(await page.textContent('#outcomeBody')),
  );
  check(
    'blocked: no download offered',
    !(await page.isVisible('#downloadWebp')),
  );
  await page.screenshot({
    path: path.join(shots, '08-blocked.png'),
    fullPage: true,
  });

  await page.click('#startOver');
  await page.setInputFiles('#fileInput', {
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from('definitely not a png'),
  });
  await page.waitForSelector('#thumbFallback:not([hidden])');
  check(
    'unpreviewable file shows a format badge instead of a broken image',
    (await page.textContent('#thumbFallback')) === 'PNG',
  );
  await page.click('#startButton');
  await outcomeTitle(page)
    .filter({ hasText: 'couldn’t be converted' })
    .waitFor({ timeout: 20000 });
  check(
    'failed: convert step failed',
    await page.isVisible('[data-step="convert"][data-state="failed"]'),
  );
  await page.screenshot({
    path: path.join(shots, '09-failed.png'),
    fullPage: true,
  });

  // A network failure during the S3 upload offers a retry with the same file.
  await page.click('#startOver');
  await page.route('**/__put**', (route) => route.abort('connectionreset'));
  await upload(page, 'retry-me.png', 'image/png', await testPhoto(400, 300));
  await outcomeTitle(page)
    .filter({ hasText: 'Upload failed' })
    .waitFor({ timeout: 10000 });
  check('upload failure offers Try again', await page.isVisible('#tryAgain'));
  await page.screenshot({
    path: path.join(shots, '10-upload-failed.png'),
    fullPage: true,
  });
  await page.unroute('**/__put**');
  await page.click('#tryAgain');
  await outcomeTitle(page)
    .filter({ hasText: 'Your WebP is ready' })
    .waitFor({ timeout: 20000 });
  check('Try again succeeds with the same file', true);

  // The aborted PUT above is the injected failure, not a page error.
  const unexpected = errors.filter((e) => !e.includes('ERR_CONNECTION_RESET'));
  check(
    'no console errors (desktop)',
    unexpected.length === 0,
    unexpected.join(' | '),
  );
  await context.close();
}

// --- Stack-hosted: config.json connects the page ------------------------------
{
  uiConfig.endpoint = ENDPOINT;
  const { context, page, errors } = await newPage({ colorScheme: 'light' });
  await page.goto(`http://localhost:${PORT}/`);
  check(
    'config.json connects without the form',
    !(await page.isVisible('#connectCard')),
  );
  check(
    'config.json endpoint used',
    (await page.inputValue('#endpoint')) === ENDPOINT,
  );
  await page.setInputFiles('#fileInput', {
    name: 'hosted.png',
    mimeType: 'image/png',
    buffer: await testPhoto(400, 300),
  });
  await page.click('#startButton');
  await outcomeTitle(page)
    .filter({ hasText: 'Your WebP is ready' })
    .waitFor({ timeout: 20000 });
  await page.click('#detailsCard summary');
  // A real click grants clipboard access; headless browsers need it granted.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#copyId');
  await page.waitForFunction(
    () => document.getElementById('copyId').textContent !== 'Copy',
  );
  const copyLabel = await page.textContent('#copyId');
  check('copy button reports success', copyLabel === 'Copied', copyLabel);
  check('no console errors (hosted)', errors.length === 0, errors.join(' | '));
  uiConfig.endpoint = null;
  await context.close();
}

// --- Remembered endpoint, mobile, dark ---------------------------------------
{
  const { context, page, errors } = await newPage({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(
    `http://localhost:${PORT}/?endpoint=${encodeURIComponent(ENDPOINT)}`,
  );
  check(
    '?endpoint= connects without the form',
    !(await page.isVisible('#connectCard')),
  );
  await page.screenshot({
    path: path.join(shots, '11-mobile-start.png'),
    fullPage: true,
  });
  await upload(page, 'harbour.png', 'image/png', photo);
  await outcomeTitle(page)
    .filter({ hasText: 'Your WebP is ready' })
    .waitFor({ timeout: 20000 });
  await page.waitForFunction(
    () => document.getElementById('webpPreview').naturalWidth > 0,
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(
    'no horizontal scroll on mobile',
    overflow <= 0,
    `overflow ${overflow}px`,
  );
  await page.screenshot({
    path: path.join(shots, '12-mobile-success.png'),
    fullPage: true,
  });

  await page.reload();
  check(
    'endpoint remembered after reload',
    (await page.textContent('#connectionLabel')).includes(`localhost:${PORT}`),
  );
  check('no console errors (mobile)', errors.length === 0, errors.join(' | '));
  await context.close();
}

await browser.close();
server.close();
for (const r of results)
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok || !r.detail ? '' : `  (${r.detail})`}`,
  );
console.log(
  `\n${results.filter((r) => r.ok).length}/${results.length} UI checks passed; screenshots in ${shots}`,
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
