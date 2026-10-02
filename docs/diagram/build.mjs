// Generates docs/architecture.png, the README overview diagram, in the style of
// AWS reference architectures. Run with `npm run diagram` after changing the
// flow. Icons come from the aws-icons package (official AWS Architecture Icons);
// the SVG is rendered to PNG in a headless browser (Edge on Windows, otherwise
// Playwright Chromium: `npx playwright install chromium`, or set PW_CHANNEL).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const ICONS = path.join(repo, 'node_modules', 'aws-icons', 'icons');
const OUTPUT = path.join(repo, 'docs', 'architecture.png');
const W = 1920;
const H = 1080;
const INK = '#232F3E';
const MUTED = '#545B64';
const FONT = "'Amazon Ember', 'Helvetica Neue', Arial, sans-serif";

const iconFiles = {
  lambda: 'architecture-service/AWSLambda.svg',
  s3: 'architecture-service/AmazonSimpleStorageService.svg',
  apigw: 'architecture-service/AmazonAPIGateway.svg',
  ddb: 'architecture-service/AmazonDynamoDB.svg',
  eb: 'architecture-service/AmazonEventBridge.svg',
  sqs: 'architecture-service/AmazonSimpleQueueService.svg',
  gd: 'architecture-service/AmazonGuardDuty.svg',
  pipes: 'resource/AmazonEventBridgePipes.svg',
  user: 'resource/User.svg',
  cloud: 'architecture-group/AWSCloudlogo.svg',
  region: 'architecture-group/Region.svg',
};
const dataUri = (key) =>
  `data:image/svg+xml;base64,${Buffer.from(readFileSync(path.join(ICONS, iconFiles[key]))).toString('base64')}`;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const parts = [];
const add = (s) => parts.push(s);

function text(
  x,
  y,
  lines,
  {
    size = 13,
    weight = 400,
    fill = INK,
    anchor = 'middle',
    lineHeight = 1.25,
  } = {},
) {
  const arr = Array.isArray(lines) ? lines : [lines];
  arr.forEach((line, i) =>
    add(
      `<text x="${x}" y="${y + i * size * lineHeight}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(line)}</text>`,
    ),
  );
}
// Service icon centered at (x, y) with its label underneath (or to the side).
function node(key, x, y, label, { size = 48, labelSide = 'below' } = {}) {
  add(
    `<image href="${dataUri(key)}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}"/>`,
  );
  const lines = Array.isArray(label) ? label : [label];
  if (labelSide === 'below') text(x, y + size / 2 + 16, lines);
  else if (labelSide === 'right')
    text(x + size / 2 + 8, y - (lines.length - 1) * 8 + 4, lines, {
      anchor: 'start',
    });
  else if (labelSide === 'left')
    text(x - size / 2 - 8, y - (lines.length - 1) * 8 + 4, lines, {
      anchor: 'end',
    });
  else if (labelSide === 'above')
    text(x, y - size / 2 - 10 - (lines.length - 1) * 16, lines);
  return { x, y, size };
}
function group(
  x,
  y,
  w,
  h,
  title,
  {
    icon,
    stroke = '#7D8998',
    dash = '6 4',
    titleColor = MUTED,
    width = 1.2,
    fill = 'none',
  } = {},
) {
  add(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`,
  );
  if (icon) {
    add(
      `<image href="${dataUri(icon)}" x="${x}" y="${y}" width="32" height="32"/>`,
    );
    text(x + 40, y + 21, title, {
      anchor: 'start',
      size: 14,
      weight: 600,
      fill: titleColor,
    });
  } else
    text(x + 10, y + 20, title, {
      anchor: 'start',
      size: 13,
      weight: 600,
      fill: titleColor,
    });
}
// Orthogonal connector through the given points.
function arrow(points, { dashed = false, color = INK } = {}) {
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  add(
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" ${dashed ? 'stroke-dasharray="6 4"' : ''} stroke-linejoin="round" marker-end="url(#${dashed ? 'headDashed' : 'head'})"/>`,
  );
}
function line(points, { dashed = false } = {}) {
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  add(
    `<path d="${d}" fill="none" stroke="${INK}" stroke-width="1.6" ${dashed ? 'stroke-dasharray="6 4"' : ''} stroke-linejoin="round"/>`,
  );
}
function badge(n, x, y) {
  add(`<circle cx="${x}" cy="${y}" r="12" fill="${INK}"/>`);
  text(x, y + 4.5, String(n), { size: 13, weight: 700, fill: '#FFFFFF' });
}

// ---------------------------------------------------------------- layout --
add(`<rect width="${W}" height="${H}" fill="#FFFFFF"/>`);
add(`<defs>
  <marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${INK}"/></marker>
  <marker id="headDashed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${INK}"/></marker>
</defs>`);

text(40, 50, 'AWS Image Resize to WebP Safety Pipeline', {
  anchor: 'start',
  size: 26,
  weight: 700,
});
text(
  40,
  78,
  'Malware-scanned image uploads, WebP conversion, and automatic expiration on AWS serverless services',
  { anchor: 'start', size: 15, fill: MUTED },
);

// User outside the cloud
node('user', 70, 545, ['Client /', 'browser'], { size: 56 });

group(130, 100, 1235, 950, 'AWS Cloud', {
  icon: 'cloud',
  stroke: INK,
  dash: '',
  titleColor: INK,
  width: 1.4,
});
group(150, 145, 1195, 890, 'AWS Region', {
  icon: 'region',
  stroke: '#00A4A6',
  dash: '',
  titleColor: '#00A4A6',
  width: 1.4,
});

// Band 1: test UI, request API, status store
group(170, 195, 165, 230, 'Test UI (optional)');
node('s3', 252, 300, ['Static website', 'bucket']);
group(355, 195, 350, 230, 'Request API');
node('apigw', 430, 310, ['Amazon API', 'Gateway']);
node('lambda', 615, 250, ['Presign', 'function']);
node('lambda', 615, 365, ['Status', 'function']);
node('ddb', 800, 310, ['Images table', '(status store)'], {
  size: 56,
  labelSide: 'right',
});

// Band 2: upload + scan, WebP conversion
group(170, 455, 655, 345, 'Upload and malware scan');
node('s3', 262, 545, ['Uploads bucket'], { labelSide: 'above' });
node('eb', 465, 545, ['Object Created rule'], { labelSide: 'above' });
node('lambda', 630, 545, ['Upload-complete', 'function']);
node('sqs', 465, 628, ['Dead-letter queue'], { size: 36, labelSide: 'right' });
node('gd', 262, 710, ['GuardDuty Malware', 'Protection for S3']);
node('eb', 465, 710, ['Scan result', 'rule']);
node('lambda', 630, 710, ['Post-scan', 'function']);

group(845, 455, 470, 345, 'WebP conversion');
node('sqs', 900, 710, ['Candidate', 'queue']);
node('pipes', 1020, 710, ['EventBridge', 'Pipes']);
node('sqs', 1140, 710, ['Variant', 'queue']);
node('lambda', 1260, 710, ['WebP', 'function']);
node('s3', 1260, 545, ['Processed', 'bucket'], { labelSide: 'left' });

// Band 3: lifecycle expiration
group(170, 830, 1145, 185, 'Lifecycle expiration (after objectRetentionDays)');
node('s3', 300, 925, ['S3 Lifecycle', '(both buckets)']);
node('eb', 560, 925, ['Lifecycle Expiration', 'rules']);
node('sqs', 800, 925, ['Lifecycle', 'queue']);
node('lambda', 1040, 925, ['Lifecycle', 'function']);

// ------------------------------------------------------------- connectors --
// 1. optional test UI
arrow(
  [
    [60, 517],
    [60, 300],
    [226, 300],
  ],
  { dashed: true },
);
badge(1, 60, 400);
// 2 + 9. API calls
arrow([
  [82, 517],
  [82, 440],
  [345, 440],
  [345, 310],
  [404, 310],
]);
badge(2, 345, 400);
badge(9, 345, 368);
arrow([
  [456, 300],
  [535, 300],
  [535, 250],
  [589, 250],
]);
arrow([
  [456, 320],
  [535, 320],
  [535, 365],
  [589, 365],
]);
// Request API -> status store
arrow([
  [641, 250],
  [725, 250],
  [725, 310],
  [770, 310],
]);
line([
  [641, 365],
  [725, 365],
  [725, 310],
]);
// 3. upload
arrow([
  [98, 545],
  [236, 545],
]);
badge(3, 190, 525);
// 4. Object Created -> rule -> upload-complete
arrow([
  [288, 545],
  [439, 545],
]);
badge(4, 365, 525);
arrow([
  [491, 545],
  [604, 545],
]);
// 5. scan
arrow([
  [262, 571],
  [262, 684],
]);
badge(5, 240, 628);
arrow([
  [288, 710],
  [439, 710],
]);
arrow([
  [491, 710],
  [604, 710],
]);
// failed events -> dead-letter queue
arrow(
  [
    [465, 571],
    [465, 608],
  ],
  { dashed: true },
);
arrow(
  [
    [465, 684],
    [465, 648],
  ],
  { dashed: true },
);
// upload + scan functions -> status store
line([
  [656, 545],
  [700, 545],
]);
line([
  [656, 700],
  [700, 700],
]);
arrow([
  [700, 700],
  [700, 478],
  [800, 478],
  [800, 340],
]);
// 6. post-scan -> candidate queue
arrow([
  [656, 722],
  [874, 722],
]);
badge(6, 765, 742);
// 7. pipe
arrow([
  [926, 710],
  [994, 710],
]);
arrow([
  [1046, 710],
  [1114, 710],
]);
badge(7, 1080, 688);
// 8. WebP function
arrow([
  [1166, 710],
  [1234, 710],
]);
arrow([
  [1260, 684],
  [1260, 571],
]);
badge(8, 1285, 628);
arrow([
  [1286, 700],
  [1332, 700],
  [1332, 238],
  [800, 238],
  [800, 280],
]);
// 10. lifecycle
arrow([
  [326, 925],
  [534, 925],
]);
badge(10, 430, 905);
arrow([
  [586, 925],
  [774, 925],
]);
arrow([
  [826, 925],
  [1014, 925],
]);
line([
  [1066, 925],
  [1332, 925],
  [1332, 700],
]);

// -------------------------------------------------------------- side panel --
const px = 1385;
add(
  `<rect x="${px}" y="100" width="505" height="950" fill="#F2F3F3" stroke="none"/>`,
);
text(px + 24, 140, 'How it works', { anchor: 'start', size: 18, weight: 700 });
const steps = [
  ['Optionally, the client loads the test UI from an', 'S3 static website.'],
  [
    'The client requests an upload URL. The presign function',
    'checks the file type, records the image in DynamoDB,',
    'and returns a single-use presigned URL.',
  ],
  [
    'The client uploads directly to the uploads bucket. The URL',
    'signs Content-Type and If-None-Match: *, so it can create',
    'the object only once.',
  ],
  [
    'EventBridge routes the Object Created event to the',
    'upload-complete function, which records the upload.',
  ],
  [
    'GuardDuty Malware Protection for S3 scans the new object',
    'and publishes the verdict to EventBridge.',
  ],
  [
    'The post-scan function records the verdict, tags the object,',
    'and queues every outcome. Events that keep failing go',
    'to a dead-letter queue.',
  ],
  ['EventBridge Pipes forwards only clean images to the', 'variant queue.'],
  [
    'The WebP function re-checks the tags, decodes the image,',
    'and writes a safe original and a resized WebP copy.',
  ],
  [
    'The client polls the status API, which returns the status',
    'and short-lived download URLs.',
  ],
  [
    'After the retention period, S3 Lifecycle deletes the objects.',
    'The lifecycle function marks the image expired.',
  ],
];
let sy = 182;
steps.forEach((lines, i) => {
  badge(i + 1, px + 36, sy - 4);
  text(px + 60, sy, lines, { anchor: 'start', size: 13.5, lineHeight: 1.3 });
  sy += lines.length * 17.5 + 22;
});
sy += 4;
add(
  `<line x1="${px + 24}" y1="${sy}" x2="${px + 481}" y2="${sy}" stroke="#D5DBDB"/>`,
);
sy += 26;
text(
  px + 24,
  sy,
  [
    'Every function records its step in DynamoDB with',
    'conditional writes, so statuses only move forward.',
  ],
  { anchor: 'start', size: 13.5, lineHeight: 1.3 },
);
sy += 52;
line([
  [px + 24, sy - 4],
  [px + 64, sy - 4],
]);
text(px + 74, sy, 'Request or event flow', { anchor: 'start', size: 13 });
line(
  [
    [px + 250, sy - 4],
    [px + 290, sy - 4],
  ],
  { dashed: true },
);
text(px + 300, sy, 'Optional or failure path', { anchor: 'start', size: 13 });

text(px + 24, 1030, 'Icons: AWS Architecture Icons', {
  anchor: 'start',
  size: 11.5,
  fill: MUTED,
});

// ------------------------------------------------------------------ output --
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('\n')}</svg>`;
const channel =
  process.env.PW_CHANNEL ||
  (process.platform === 'win32' ? 'msedge' : undefined);
const browser = await chromium.launch({ channel, headless: true });
// Rendered at 2x so the image stays sharp when readers zoom in.
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
});
await page.setContent(
  `<!doctype html><html><body style="margin:0">${svg}</body></html>`,
);
await page.screenshot({
  path: OUTPUT,
  clip: { x: 0, y: 0, width: W, height: H },
});
await browser.close();
console.log('wrote', path.relative(repo, OUTPUT));
