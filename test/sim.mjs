// Shared simulation: the repo's real Lambda handlers wired to in-memory AWS
// fakes. The presign Lambda runs on the real S3 SDK (offline, fake credentials)
// so upload URLs are exactly what AWS would receive, and s3Put() verifies them
// with SigV4 and applies If-None-Match the way S3 does.
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, '..');
// Point LAMBDA_ROOT at an older checkout to confirm the checks catch its bugs.
const lambdaRoot = process.env.LAMBDA_ROOT || repo;
const templatePath = path.join(
  repo,
  'cdk.out',
  'ImagePipelineStack.template.json',
);
if (!existsSync(templatePath)) {
  console.error(
    'Run `npx cdk synth` first: the tests read Lambda settings and the Pipe filter from the synthesized template.',
  );
  process.exit(1);
}
const fakeModules = {
  '@aws-sdk/client-s3': 'client-s3.mjs',
  '@aws-sdk/s3-request-presigner': 's3-request-presigner.mjs',
  '@aws-sdk/client-dynamodb': 'client-dynamodb.mjs',
  '@aws-sdk/lib-dynamodb': 'lib-dynamodb.mjs',
  '@aws-sdk/client-sqs': 'client-sqs.mjs',
};
const REAL_FOR_PRESIGN = new Set([
  '@aws-sdk/client-s3',
  '@aws-sdk/s3-request-presigner',
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || '';
    if (parent.includes('/lambda/presign/') && REAL_FOR_PRESIGN.has(specifier))
      return nextResolve(specifier, {
        ...context,
        parentURL: pathToFileURL(`${repo}/package.json`).href,
      });
    if (fakeModules[specifier] && !parent.includes('/node_modules/'))
      return {
        url: pathToFileURL(path.join(here, 'fakes', fakeModules[specifier]))
          .href,
        shortCircuit: true,
      };
    if (specifier === 'sharp')
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    return nextResolve(specifier, context);
  },
});

// Environment mirrors the synthesized template; credentials are AWS's
// documentation examples and the SDK is kept away from real config files.
export const ORIG = 'orig-bucket';
export const PROC = 'proc-bucket';
export const CANDIDATE = 'candidate-queue';
export const FAKE_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
export const tpl = JSON.parse(readFileSync(templatePath, 'utf8'));
const fnEnv = (prefix) =>
  Object.entries(tpl.Resources).find(
    ([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith(prefix),
  )[1].Properties.Environment.Variables;
for (const prefix of [
  'PresignUrlFunction',
  'PostScanTaggerFunction',
  'CreateWebpVariantsFunction',
  'LifecycleExpirationStatusFunction',
])
  for (const [k, v] of Object.entries(fnEnv(prefix)))
    if (typeof v === 'string') process.env[k] = v;
Object.assign(process.env, {
  ORIGINAL_BUCKET_NAME: ORIG,
  PROCESSED_BUCKET_NAME: PROC,
  TABLE_NAME: 'images',
  VARIANT_CANDIDATE_QUEUE_URL: CANDIDATE,
  AWS_REGION: 'us-east-2',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: FAKE_SECRET,
  AWS_CONFIG_FILE: path.join(here, 'no-aws-config'),
  AWS_SHARED_CREDENTIALS_FILE: path.join(here, 'no-aws-credentials'),
  AWS_EC2_METADATA_DISABLED: 'true',
});
export const MAX_RECEIVE = Number(process.env.MAX_RECEIVE_COUNT || 3);

export const { state, als, reset } = await import('./fakes/state.mjs');
const { S3Client, GetObjectTaggingCommand } =
  await import('./fakes/client-s3.mjs');
export const sharp = (await import('sharp')).default;
export const load = (name, tag = '') =>
  import(
    pathToFileURL(`${lambdaRoot}/lambda/${name}/index.js`).href + tag
  ).then((m) => m.handler);
export const handlers = {
  presign: await load('presign'),
  uploadComplete: await load('upload-complete'),
  postScan: await load('post-scan'),
  createWebp: await load('create-webp-variants'),
  status: await load('status'),
  lifecycle: await load('lifecycle-expiration-status'),
};

const pipeProps = Object.values(tpl.Resources).find(
  (r) => r.Type === 'AWS::Pipes::Pipe',
).Properties;
const pipeFilter = JSON.parse(
  pipeProps.SourceParameters.FilterCriteria.Filters[0].Pattern,
);
const inputTemplate = pipeProps.TargetParameters.InputTemplate;

export const as = (caller, fn) => als.run({ caller }, fn);
export const tagsOf = (key) =>
  Object.fromEntries(
    state.s3.get(`${ORIG}/${key}`).tags.map((t) => [t.Key, t.Value]),
  );
export const procObjects = () =>
  [...state.s3.keys()].filter((k) => k.startsWith(PROC));

// --- S3 presigned PUT, verified like S3 does --------------------------------
const rfc3986 = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export function verifySigV4({
  method,
  url,
  headers,
  secret = FAKE_SECRET,
  now = Date.now(),
}) {
  const u = new URL(url);
  const pairs = [...u.searchParams.entries()];
  const q = Object.fromEntries(pairs);
  const signedHeaders = (q['X-Amz-SignedHeaders'] || '').split(';');
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k.toLowerCase(),
      String(v).trim(),
    ]),
  );
  lower.host = u.host;
  const missing = signedHeaders.filter((h) => !(h in lower));
  const canonicalQuery = pairs
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [
    method,
    u.pathname,
    canonicalQuery,
    signedHeaders.map((h) => `${h}:${lower[h] ?? ''}\n`).join(''),
    signedHeaders.join(';'),
    q['X-Amz-Content-Sha256'] || 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const [, date, region, service] = q['X-Amz-Credential'].split('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    q['X-Amz-Date'],
    `${date}/${region}/${service}/aws4_request`,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  let key = createHmac('sha256', `AWS4${secret}`).update(date).digest();
  for (const part of [region, service, 'aws4_request'])
    key = createHmac('sha256', key).update(part).digest();
  const signatureOk =
    createHmac('sha256', key).update(stringToSign).digest('hex') ===
    q['X-Amz-Signature'];
  const d = q['X-Amz-Date'];
  const signedAt = Date.UTC(
    +d.slice(0, 4),
    +d.slice(4, 6) - 1,
    +d.slice(6, 8),
    +d.slice(9, 11),
    +d.slice(11, 13),
    +d.slice(13, 15),
  );
  const expired = now > signedAt + Number(q['X-Amz-Expires']) * 1000;
  return {
    ok: signatureOk && !missing.length && !expired,
    signatureOk,
    missing,
    expired,
    signedHeaders,
    query: q,
  };
}

// Applies a client PUT to a presigned URL: 403 for a bad signature, 412 when
// If-None-Match: * meets an existing key, 400 for a checksum S3 would reject.
export function s3Put(uploadUrl, headers, body) {
  const v = verifySigV4({ method: 'PUT', url: uploadUrl, headers });
  if (!v.ok)
    return {
      status: 403,
      code: v.expired ? 'AccessDenied (expired)' : 'SignatureDoesNotMatch',
      missing: v.missing,
    };
  const u = new URL(uploadUrl);
  const bucket = u.hostname.split('.s3.')[0];
  const key = decodeURIComponent(u.pathname.slice(1));
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, value]) => [k.toLowerCase(), value]),
  );
  const conditional = lower['if-none-match'] ?? v.query['if-none-match'];
  if (conditional === '*' && state.s3.has(`${bucket}/${key}`))
    return { status: 412, code: 'PreconditionFailed' };
  const crc = v.query['x-amz-checksum-crc32'];
  if (crc && crc !== crc32Base64(body))
    return { status: 400, code: 'BadDigest' };
  const metadata = Object.fromEntries(
    Object.entries(v.query)
      .filter(([k]) => k.startsWith('x-amz-meta-'))
      .map(([k, value]) => [k.slice(11), value]),
  );
  state.s3.set(`${bucket}/${key}`, {
    body: Buffer.from(body),
    contentType: lower['content-type'],
    metadata,
    tags: [],
  });
  return { status: 200 };
}
function crc32Base64(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE(~c >>> 0);
  return out.toString('base64');
}

// --- Pipeline helpers --------------------------------------------------------
export async function presignRaw(body) {
  const res = await as('presign', () => handlers.presign({ body }));
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}
export async function newUpload(
  bytes,
  contentType = 'image/png',
  filename = 'photo.png',
) {
  const res = await presignRaw(JSON.stringify({ filename, contentType }));
  if (res.statusCode !== 200)
    throw new Error(`presign failed: ${JSON.stringify(res.body)}`);
  const put = s3Put(
    res.body.uploadUrl,
    res.body.requiredHeaders || { 'Content-Type': contentType },
    bytes,
  );
  if (put.status !== 200)
    throw new Error(`upload failed: ${JSON.stringify(put)}`);
  return res.body;
}
export const s3CreatedEvent = (key) => ({
  source: 'aws.s3',
  'detail-type': 'Object Created',
  detail: {
    bucket: { name: ORIG },
    object: { key, size: 1, etag: 'e', sequencer: '01' },
    reason: 'PutObject',
  },
});
export async function guardDutyScan(key, result = 'NO_THREATS_FOUND') {
  return as('guardduty', async () => {
    const { TagSet } = await new S3Client().send(
      new GetObjectTaggingCommand({ Bucket: ORIG, Key: key }),
    );
    TagSet.push({ Key: 'GuardDutyMalwareScanStatus', Value: result });
    state.s3.get(`${ORIG}/${key}`).tags = TagSet;
    return {
      source: 'aws.guardduty',
      'detail-type': 'GuardDuty Malware Protection Object Scan Result',
      detail: {
        schemaVersion: '1.0',
        scanStatus: 'COMPLETED',
        resourceType: 'S3_OBJECT',
        s3ObjectDetails: {
          bucketName: ORIG,
          objectKey: key,
          eTag: 'e',
          s3Throttled: false,
        },
        scanResultDetails: {
          scanResultStatus: result,
          threats:
            result === 'THREATS_FOUND'
              ? [{ name: 'EICAR-Test-File (not a virus)' }]
              : null,
        },
      },
    };
  });
}
export function runPipe() {
  const msgs = state.sqs.get(CANDIDATE) || [];
  state.sqs.set(CANDIDATE, []);
  const out = [];
  for (const raw of msgs) {
    const body = JSON.parse(raw);
    if (
      !Object.entries(pipeFilter.body).every(([k, allowed]) =>
        allowed.includes(body[k]),
      )
    )
      continue;
    out.push(
      JSON.parse(
        inputTemplate.replace(/<\$\.body\.(\w+)>/g, (_, k) =>
          body[k] === undefined ? '""' : JSON.stringify(body[k]),
        ),
      ),
    );
  }
  return out;
}
let msgId = 0;
// Delivers each message like an SQS event source: failed records are retried up
// to maxReceiveCount, after which the message would move to the DLQ.
export async function deliverToWebp(messages) {
  const dlq = [];
  for (const m of messages) {
    const messageId = `m${++msgId}`;
    for (let n = 1; n <= MAX_RECEIVE; n++) {
      const res = await as('webp', () =>
        handlers.createWebp({
          Records: [
            {
              messageId,
              body: JSON.stringify(m),
              attributes: { ApproximateReceiveCount: String(n) },
            },
          ],
        }),
      );
      if (!res.batchItemFailures.length) break;
      if (n === MAX_RECEIVE) dlq.push(m);
    }
  }
  return dlq;
}
// EventBridge -> Lambda async invocation: a failed invocation is retried twice.
export async function invokeAsync(caller, handler, event) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await as(caller, () => handler(event));
    } catch (error) {
      if (attempt === 3) return { asyncDlq: error.message };
    }
  }
}
export const lifecycleRecord = (bucket, key) => ({
  messageId: `l${++msgId}`,
  body: JSON.stringify({
    'detail-type': 'Object Deleted',
    source: 'aws.s3',
    detail: {
      bucket: { name: bucket },
      object: { key },
      reason: 'Lifecycle Expiration',
      'deletion-type': 'Permanently Deleted',
    },
  }),
});
export const getStatus = async (imageId) =>
  JSON.parse(
    (await as('status', () => handlers.status({ pathParameters: { imageId } })))
      .body,
  );
export const image = (w, h) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 30, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();
export async function processUpload(
  p,
  { scanResult = 'NO_THREATS_FOUND', postScanHandler = handlers.postScan } = {},
) {
  await invokeAsync(
    'upload-complete',
    handlers.uploadComplete,
    s3CreatedEvent(p.key),
  );
  const ev = await guardDutyScan(p.key, scanResult);
  await invokeAsync('post-scan', postScanHandler, ev);
  const piped = runPipe();
  const dlq = await deliverToWebp(piped);
  return { ev, piped, dlq };
}
