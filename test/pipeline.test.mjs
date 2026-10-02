// Asserts the pipeline's behaviour after the fixes by running the repo's real
// handlers through sim.mjs, including concurrent interleavings.
import * as sim from './sim.mjs';

const {
  state,
  as,
  handlers,
  ORIG,
  PROC,
  tagsOf,
  procObjects,
  getStatus,
  image,
  newUpload,
  presignRaw,
  s3Put,
} = sim;
const {
  processUpload,
  guardDutyScan,
  s3CreatedEvent,
  runPipe,
  deliverToWebp,
  invokeAsync,
  lifecycleRecord,
} = sim;

const results = [];
let current = '';
function check(label, actual, expected) {
  results.push({
    scenario: current,
    label,
    ok: JSON.stringify(actual) === JSON.stringify(expected),
    actual,
    expected,
  });
}
async function scenario(name, fn) {
  sim.reset();
  current = name;
  try {
    await fn();
  } catch (e) {
    results.push({
      scenario: name,
      label: 'threw',
      ok: false,
      actual: e.stack,
      expected: 'no exception',
    });
  }
}

// ---------------------------------------------------------------------------
await scenario('01 happy path, then lifecycle expiry', async () => {
  const p = await newUpload(await image(2000, 1200));
  const { piped, dlq } = await processUpload(p);
  const done = await getStatus(p.imageId);
  check('pipe forwarded one message', piped.length, 1);
  check('no DLQ', dlq.length, 0);
  check('status', done.status, 'WEBP_CREATED');
  check('webp size', `${done.webpWidth}x${done.webpHeight}`, '1280x768');
  check('variants', Object.keys(done.variants), ['original', 'webp']);
  check(
    'safe original content type from decoded format',
    done.safeOriginalContentType,
    'image/png',
  );
  check('uploadedAt recorded', Boolean(done.uploadedAt), true);
  const tags = tagsOf(p.key);
  check('original tag count <= 10', Object.keys(tags).length <= 10, true);
  check(
    'gate tags present',
    [tags['scan-result'], tags['variant-required']],
    ['CLEAN', 'TRUE'],
  );
  check(
    'retention tags written by post-scan',
    ['expires-at-epoch', 'retention-seconds', 'retention-days'].every(
      (k) => k in tags,
    ),
    true,
  );
  await as('lifecycle', () =>
    handlers.lifecycle({
      Records: [
        lifecycleRecord(ORIG, p.key),
        lifecycleRecord(PROC, done.safeOriginalKey),
        lifecycleRecord(PROC, done.webpKey),
      ],
    }),
  );
  const expired = await getStatus(p.imageId);
  check(
    'expired status',
    [expired.status, expired.retentionStatus],
    ['ARTIFACTS_EXPIRED', 'EXPIRED'],
  );
  check('no download URLs after expiry', Object.keys(expired.variants), []);
  await deliverToWebp(piped);
  check(
    'late WebP message does not overwrite expiry',
    (await getStatus(p.imageId)).status,
    'ARTIFACTS_EXPIRED',
  );
});

await scenario(
  '02 live-like overlap: slow upload-complete vs post-scan',
  async () => {
    const p = await newUpload(await image(800, 600));
    const ev = await guardDutyScan(p.key);
    state.latency = (caller, op) =>
      caller === 'upload-complete'
        ? ({ 'S3.HeadObject': 50, 'DDB.Update': 400 }[op] ?? 50)
        : caller === 'post-scan'
          ? ({ 'S3.HeadObject': 80 }[op] ?? 40)
          : 1;
    await Promise.all([
      as('upload-complete', () =>
        handlers.uploadComplete(s3CreatedEvent(p.key)),
      ),
      as('post-scan', () => handlers.postScan(ev)),
    ]);
    state.latency = () => 1;
    check(
      'upload-complete wrote no tags',
      state.calls.some(
        ([, c, op]) => c === 'upload-complete' && /Tagging/.test(op),
      ),
      false,
    );
    check('gate tags survived', tagsOf(p.key)['scan-result'], 'CLEAN');
    check(
      'status not rolled back by late upload-complete',
      (await getStatus(p.imageId)).status,
      'SCANNED',
    );
    await deliverToWebp(runPipe());
    check('final status', (await getStatus(p.imageId)).status, 'WEBP_CREATED');
  },
);

await scenario(
  '03 post-scan completes before upload-complete starts',
  async () => {
    const p = await newUpload(await image(800, 600));
    const ev = await guardDutyScan(p.key);
    await as('post-scan', () => handlers.postScan(ev));
    await as('upload-complete', () =>
      handlers.uploadComplete(s3CreatedEvent(p.key)),
    );
    const s = await getStatus(p.imageId);
    check('status stays SCANNED', s.status, 'SCANNED');
    check(
      'upload metadata still recorded',
      [s.uploadStatus, s.lifecycleStatus, s.retentionStatus],
      ['UPLOADED', 'AWAITING_LIFECYCLE_EXPIRATION', 'ACTIVE'],
    );
    await deliverToWebp(runPipe());
    check('final status', (await getStatus(p.imageId)).status, 'WEBP_CREATED');
  },
);

await scenario(
  '04 upload-complete retry/duplicate after WebP finished',
  async () => {
    const p = await newUpload(await image(800, 600));
    await processUpload(p);
    const before = await getStatus(p.imageId);
    await as('upload-complete', () =>
      handlers.uploadComplete(s3CreatedEvent(p.key)),
    );
    const after = await getStatus(p.imageId);
    check('status unchanged', after.status, 'WEBP_CREATED');
    check('uploadedAt unchanged', after.uploadedAt, before.uploadedAt);
  },
);

await scenario('05 corrupt bytes declared image/png', async () => {
  const p = await newUpload(Buffer.from('this is not an image'), 'image/png');
  const { dlq } = await processUpload(p);
  const s = await getStatus(p.imageId);
  check('no retries/DLQ for deterministic decode failure', dlq.length, 0);
  check('status', s.status, 'WEBP_FAILED');
  check(
    'reason recorded',
    /Cannot convert image/.test(s.variantFailureReason),
    true,
  );
  check('nothing written to processed bucket', procObjects(), []);
});

await scenario('06 SVG (script-capable) bytes declared image/png', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
  );
  const p = await newUpload(svg, 'image/png');
  await processUpload(p);
  const s = await getStatus(p.imageId);
  check('status', s.status, 'WEBP_FAILED');
  check(
    'reason',
    s.variantFailureReason,
    'Cannot convert image: Unsupported image format: svg',
  );
  check('nothing written to processed bucket', procObjects(), []);
});

await scenario('07 presign validation', async () => {
  check(
    'text/html rejected',
    (
      await presignRaw(
        JSON.stringify({ filename: 'a.html', contentType: 'text/html' }),
      )
    ).statusCode,
    400,
  );
  check(
    'image/svg+xml rejected',
    (
      await presignRaw(
        JSON.stringify({ filename: 'a.svg', contentType: 'image/svg+xml' }),
      )
    ).statusCode,
    400,
  );
  check(
    'image/heic rejected',
    (
      await presignRaw(
        JSON.stringify({ filename: 'a.heic', contentType: 'image/heic' }),
      )
    ).statusCode,
    400,
  );
  check('invalid JSON -> 400', (await presignRaw('not json')).statusCode, 400);
  check('JSON null -> 400', (await presignRaw('null')).statusCode, 400);
  check(
    'IMAGE/JPEG accepted (case-insensitive)',
    (
      await presignRaw(
        JSON.stringify({ filename: 'a.jpg', contentType: 'IMAGE/JPEG' }),
      )
    ).statusCode,
    200,
  );
});

await scenario('08 presigned URL contract (real SDK)', async () => {
  const { body } = await presignRaw(
    JSON.stringify({ filename: 'photo.png', contentType: 'image/png' }),
  );
  const q = Object.fromEntries(new URL(body.uploadUrl).searchParams);
  check(
    'signed headers',
    q['X-Amz-SignedHeaders'],
    'content-type;host;if-none-match',
  );
  check(
    'no checksum of the empty presign body',
    [q['x-amz-checksum-crc32'], q['x-amz-sdk-checksum-algorithm']],
    [undefined, undefined],
  );
  check(
    'image id metadata signed into the query',
    q['x-amz-meta-imageid'],
    body.imageId,
  );
  check('required headers returned to the client', body.requiredHeaders, {
    'Content-Type': 'image/png',
    'If-None-Match': '*',
  });
});

await scenario('09 each upload URL creates the object once', async () => {
  const { body } = await presignRaw(
    JSON.stringify({ filename: 'photo.png', contentType: 'image/png' }),
  );
  const png = await image(64, 64);
  const ok = body.requiredHeaders;
  check(
    'PUT with a different Content-Type is rejected',
    s3Put(body.uploadUrl, { ...ok, 'Content-Type': 'text/html' }, png).status,
    403,
  );
  check(
    'PUT without If-None-Match is rejected',
    s3Put(body.uploadUrl, { 'Content-Type': 'image/png' }, png).status,
    403,
  );
  check(
    'PUT with the required headers succeeds',
    s3Put(body.uploadUrl, ok, png).status,
    200,
  );
  const stored = state.s3.get(`${ORIG}/${body.key}`).body;
  check(
    'second PUT with the same URL is refused',
    s3Put(body.uploadUrl, ok, Buffer.from('replacement')),
    { status: 412, code: 'PreconditionFailed' },
  );
  check(
    'stored object unchanged',
    state.s3.get(`${ORIG}/${body.key}`).body.equals(stored),
    true,
  );
});

await scenario(
  '10 defense in depth: unsupported type already in uploads/',
  async () => {
    const { body: p } = await presignRaw(
      JSON.stringify({ filename: 'x.png', contentType: 'image/png' }),
    );
    // Not reachable through the URL any more; simulates an object written another way.
    state.s3.set(`${ORIG}/${p.key}`, {
      body: Buffer.from('<script>alert(1)</script>'),
      contentType: 'text/html',
      metadata: {},
      tags: [],
    });
    const { piped } = await processUpload(p);
    const s = await getStatus(p.imageId);
    check('not forwarded to WebP', piped.length, 0);
    check(
      'terminal status + reason',
      [s.status, s.variantSkipReason],
      ['NO_VARIANT_REQUIRED', 'UNSUPPORTED_CONTENT_TYPE'],
    );
  },
);

process.env.RESIZE_THRESHOLD_BYTES = String(10 * 1024 * 1024);
const postScanWithThreshold = await sim.load('post-scan', '?threshold');
process.env.RESIZE_THRESHOLD_BYTES = '0';
await scenario(
  '11 resizeThresholdBytes=10MB with a small clean image',
  async () => {
    const p = await newUpload(await image(800, 600));
    const { piped } = await processUpload(p, {
      postScanHandler: postScanWithThreshold,
    });
    const s = await getStatus(p.imageId);
    check('not forwarded', piped.length, 0);
    check(
      'terminal status + reason',
      [s.status, s.variantSkipReason],
      ['NO_VARIANT_REQUIRED', 'BELOW_SIZE_THRESHOLD'],
    );
    await as('lifecycle', () =>
      handlers.lifecycle({ Records: [lifecycleRecord(ORIG, p.key)] }),
    );
    check('expires as EXPIRED', (await getStatus(p.imageId)).status, 'EXPIRED');
  },
);

await scenario(
  '12 duplicate GuardDuty result after WebP finished',
  async () => {
    const p = await newUpload(await image(800, 600));
    const { ev } = await processUpload(p);
    await as('post-scan', () => handlers.postScan(ev));
    check(
      'status stays WEBP_CREATED',
      (await getStatus(p.imageId)).status,
      'WEBP_CREATED',
    );
    check('not re-queued', runPipe().length, 0);
    check(
      'WebP tags not overwritten',
      tagsOf(p.key)['processed-status'],
      'WEBP_CREATED',
    );
  },
);

await scenario(
  '13 duplicate GuardDuty result while waiting for WebP',
  async () => {
    const p = await newUpload(await image(800, 600));
    await as('upload-complete', () =>
      handlers.uploadComplete(s3CreatedEvent(p.key)),
    );
    const ev = await guardDutyScan(p.key);
    await as('post-scan', () => handlers.postScan(ev));
    await as('post-scan', () => handlers.postScan(ev));
    const piped = runPipe();
    check('both candidates forwarded (idempotent re-apply)', piped.length, 2);
    check('no DLQ', (await deliverToWebp(piped)).length, 0);
    check('final status', (await getStatus(p.imageId)).status, 'WEBP_CREATED');
  },
);

await scenario(
  '14 post-scan SQS send fails once; Lambda async retry recovers',
  async () => {
    const p = await newUpload(await image(800, 600));
    let failures = 0;
    state.fail = (caller, op) =>
      caller === 'post-scan' && op === 'SQS.SendMessage' && failures++ === 0
        ? new Error('ServiceUnavailable')
        : null;
    await processUpload(p);
    check('final status', (await getStatus(p.imageId)).status, 'WEBP_CREATED');
  },
);

await scenario('15 post-scan fails every attempt -> async DLQ', async () => {
  const p = await newUpload(await image(800, 600));
  await as('upload-complete', () =>
    handlers.uploadComplete(s3CreatedEvent(p.key)),
  );
  const ev = await guardDutyScan(p.key);
  state.fail = (caller, op) =>
    caller === 'post-scan' && op === 'S3.HeadObject'
      ? new Error('AccessDenied')
      : null;
  check(
    'event would land in AsyncEventDlq',
    await invokeAsync('post-scan', handlers.postScan, ev),
    { asyncDlq: 'AccessDenied' },
  );
});

await scenario(
  '16 WebP S3 write fails on every attempt -> DLQ + WEBP_FAILED',
  async () => {
    const p = await newUpload(await image(800, 600));
    state.fail = (caller, op) =>
      caller === 'webp' && op === 'S3.PutObject' ? new Error('SlowDown') : null;
    const { dlq } = await processUpload(p);
    const s = await getStatus(p.imageId);
    check('message in DLQ', dlq.length, 1);
    check(
      'status + reason',
      [s.status, s.variantFailureReason],
      ['WEBP_FAILED', 'Retries exhausted: SlowDown'],
    );
  },
);

await scenario('17 WebP transient failure once, then success', async () => {
  const p = await newUpload(await image(800, 600));
  let failures = 0;
  state.fail = (caller, op) =>
    caller === 'webp' && op === 'S3.PutObject' && failures++ === 0
      ? new Error('SlowDown')
      : null;
  const { dlq } = await processUpload(p);
  check('no DLQ', dlq.length, 0);
  check('final status', (await getStatus(p.imageId)).status, 'WEBP_CREATED');
});

await scenario('18 object tags missing at conversion', async () => {
  const p = await newUpload(await image(800, 600));
  await as('upload-complete', () =>
    handlers.uploadComplete(s3CreatedEvent(p.key)),
  );
  const ev = await guardDutyScan(p.key);
  await as('post-scan', () => handlers.postScan(ev));
  state.s3.get(`${ORIG}/${p.key}`).tags = [];
  await deliverToWebp(runPipe());
  check('status', (await getStatus(p.imageId)).status, 'WEBP_SKIPPED');
  check('nothing written to processed bucket', procObjects(), []);
});

await scenario(
  '19 malicious upload, then duplicate lifecycle events',
  async () => {
    const p = await newUpload(await image(64, 64));
    const { piped } = await processUpload(p, { scanResult: 'THREATS_FOUND' });
    check('not forwarded', piped.length, 0);
    check('status', (await getStatus(p.imageId)).status, 'BLOCKED');
    await as('lifecycle', () =>
      handlers.lifecycle({ Records: [lifecycleRecord(ORIG, p.key)] }),
    );
    check('expired', (await getStatus(p.imageId)).status, 'BLOCKED_EXPIRED');
    await as('lifecycle', () =>
      handlers.lifecycle({ Records: [lifecycleRecord(ORIG, p.key)] }),
    );
    check(
      'duplicate event keeps BLOCKED_EXPIRED',
      (await getStatus(p.imageId)).status,
      'BLOCKED_EXPIRED',
    );
  },
);

async function convertedUpload() {
  const p = await newUpload(await image(800, 600));
  await processUpload(p);
  return { p, s: await getStatus(p.imageId) };
}
await scenario(
  '20 concurrent lifecycle events (both read before either writes)',
  async () => {
    const { p, s } = await convertedUpload();
    await as('lifecycle', () =>
      handlers.lifecycle({ Records: [lifecycleRecord(ORIG, p.key)] }),
    );
    state.latency = (caller, op) =>
      caller.startsWith('lifecycle') && op === 'DDB.Update' ? 50 : 1;
    await Promise.all([
      as('lifecycle-A', () =>
        handlers.lifecycle({
          Records: [lifecycleRecord(PROC, s.safeOriginalKey)],
        }),
      ),
      as('lifecycle-B', () =>
        handlers.lifecycle({ Records: [lifecycleRecord(PROC, s.webpKey)] }),
      ),
    ]);
    const e = await getStatus(p.imageId);
    check(
      'final status',
      [e.status, e.retentionStatus],
      ['ARTIFACTS_EXPIRED', 'EXPIRED'],
    );
  },
);

await scenario(
  '21 lifecycle: partial update lands after the terminal one',
  async () => {
    const { p, s } = await convertedUpload();
    await as('lifecycle', () =>
      handlers.lifecycle({ Records: [lifecycleRecord(ORIG, p.key)] }),
    );
    const calls = {};
    state.latency = (caller, op) => {
      if (op !== 'DDB.Update') return 1;
      calls[caller] = (calls[caller] || 0) + 1;
      if (caller === 'lifecycle-A') return calls[caller] === 1 ? 10 : 200;
      if (caller === 'lifecycle-B') return calls[caller] === 1 ? 50 : 10;
      return 1;
    };
    await Promise.all([
      as('lifecycle-A', () =>
        handlers.lifecycle({
          Records: [lifecycleRecord(PROC, s.safeOriginalKey)],
        }),
      ),
      as('lifecycle-B', () =>
        handlers.lifecycle({ Records: [lifecycleRecord(PROC, s.webpKey)] }),
      ),
    ]);
    const e = await getStatus(p.imageId);
    check(
      'retention not downgraded',
      [e.status, e.retentionStatus],
      ['ARTIFACTS_EXPIRED', 'EXPIRED'],
    );
  },
);

await scenario('22 lifecycle event for an unknown image', async () => {
  const res = await as('lifecycle', () =>
    handlers.lifecycle({
      Records: [lifecycleRecord(ORIG, 'uploads/does-not-exist/x.png')],
    }),
  );
  check('no failure', res.batchItemFailures, []);
  check('no record created', state.ddb.has('does-not-exist'), false);
});

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
let last = '';
for (const r of results) {
  if (r.scenario !== last) console.log(`\n${(last = r.scenario)}`);
  console.log(
    `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok ? '' : `\n        expected ${JSON.stringify(r.expected)}\n        actual   ${typeof r.actual === 'string' ? r.actual : JSON.stringify(r.actual)}`}`,
  );
}
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
process.exitCode = failed.length ? 1 : 0;
