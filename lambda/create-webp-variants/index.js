import path from 'node:path';
import sharp from 'sharp';
import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const {
  ORIGINAL_BUCKET_NAME,
  PROCESSED_BUCKET_NAME,
  TABLE_NAME,
  WEB_MAX_WIDTH = '1280',
  WEBP_QUALITY = '72',
  MAX_RECEIVE_COUNT = '3',
  PROCESSED_PREFIX = 'processed/',
  OBJECT_RETENTION_DAYS = '1',
  OBJECT_RETENTION_SECONDS = '86400',
} = process.env;

// Decoded formats accepted as a safe original, mapped to the Content-Type it is
// stored and served with. The uploader's claimed Content-Type is never trusted.
const SAFE_SOURCE_CONTENT_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  tiff: 'image/tiff',
};

async function streamToBuffer(stream) {
  if (stream.transformToByteArray)
    return Buffer.from(await stream.transformToByteArray());
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
function imageIdFromKey(key) {
  const parts = key.split('/');
  return parts[0] === 'uploads' && parts[1] ? parts[1] : key;
}
function filenameFromKey(key) {
  return path.basename(key) || 'image';
}
function outputKeys(inputKey, imageId) {
  const filename = filenameFromKey(inputKey);
  const parsed = path.parse(filename);
  return {
    safeOriginalKey: `${PROCESSED_PREFIX}${imageId}/original/${filename}`,
    webpKey: `${PROCESSED_PREFIX}${imageId}/web/${parsed.name || 'image'}-web-${WEB_MAX_WIDTH}.webp`,
  };
}
function tagsToObject(tagSet = []) {
  return Object.fromEntries(tagSet.map((tag) => [tag.Key, tag.Value]));
}
function expectedLifecycleExpiry(now = new Date()) {
  const retentionSeconds = Number(OBJECT_RETENTION_SECONDS);
  const expiresAt = new Date(now.getTime() + retentionSeconds * 1000);
  return {
    retentionSeconds,
    expiresAtIso: expiresAt.toISOString(),
    expiresAtEpoch: Math.floor(expiresAt.getTime() / 1000),
  };
}
function s3TaggingHeader(tags) {
  return new URLSearchParams(
    Object.entries(tags).map(([key, value]) => [
      key,
      String(value).slice(0, 256),
    ]),
  ).toString();
}
function mergeTags(existingTagSet, nextTags) {
  const map = new Map(
    (existingTagSet || []).map((tag) => [tag.Key, tag.Value]),
  );
  for (const [key, value] of Object.entries(nextTags))
    map.set(key, String(value).slice(0, 256));
  const preferred = [
    'GuardDutyMalwareScanStatus',
    'scan-result',
    'variant-required',
    'size-category',
    'processed-status',
    'webp-status',
    'expires-at-epoch',
    'retention-seconds',
    'retention-days',
  ];
  const result = [];
  for (const key of preferred)
    if (map.has(key) && result.length < 10)
      result.push({ Key: key, Value: map.get(key) });
  for (const [key, value] of map.entries())
    if (!preferred.includes(key) && result.length < 10)
      result.push({ Key: key, Value: value });
  return result;
}
function sourceContentType(metadata) {
  // The prebuilt sharp binaries decode HEIF only when it is AV1 (AVIF).
  if (metadata.format === 'heif')
    return metadata.compression === 'av1' ? 'image/avif' : undefined;
  return SAFE_SOURCE_CONTENT_TYPES[metadata.format];
}

// Only an image still waiting for conversion can fail or be skipped; a late or
// duplicate message must not overwrite a status that already moved on.
async function recordVariantOutcome(imageId, status, reason) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { imageId },
        UpdateExpression:
          'SET #status = :status, variantStatus = :status, variantFailureReason = :reason, updatedAt = :updatedAt',
        ConditionExpression: '#status = :scanned',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': status,
          ':reason': String(reason).slice(0, 1000),
          ':scanned': 'SCANNED',
          ':updatedAt': new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
  }
}

async function convertToWebp(originalBuffer) {
  const image = sharp(originalBuffer, { failOn: 'none' }).rotate();
  const metadata = await image.metadata();
  const contentType = sourceContentType(metadata);
  if (!contentType)
    throw new Error(`Unsupported image format: ${metadata.format}`);
  const webpBuffer = await image
    .resize({ width: Number(WEB_MAX_WIDTH), withoutEnlargement: true })
    .webp({ quality: Number(WEBP_QUALITY), effort: 4 })
    .toBuffer();
  const webpMetadata = await sharp(webpBuffer).metadata();
  return { metadata, contentType, webpBuffer, webpMetadata };
}

async function processRecord(record) {
  const message = JSON.parse(record.body || '{}');
  const bucket = message.bucket || ORIGINAL_BUCKET_NAME;
  const key = message.key;
  const versionId = message.versionId || undefined;
  if (!key) throw new Error('Variant message missing key.');
  const imageId = message.imageId || imageIdFromKey(key);
  const versionArgs = versionId ? { VersionId: versionId } : {};

  const tagResult = await s3.send(
    new GetObjectTaggingCommand({ Bucket: bucket, Key: key, ...versionArgs }),
  );
  const tagValues = tagsToObject(tagResult.TagSet);
  if (
    tagValues['scan-result'] !== 'CLEAN' ||
    tagValues['variant-required'] !== 'TRUE'
  ) {
    console.warn(
      'Skipping variant creation because tags do not allow processing:',
      { bucket, key, imageId, tags: tagValues },
    );
    await recordVariantOutcome(
      imageId,
      'WEBP_SKIPPED',
      'Object tags do not mark the upload as clean and variant-required.',
    );
    return;
  }

  const object = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, ...versionArgs }),
  );
  const originalBuffer = await streamToBuffer(object.Body);

  // Decode before writing anything, so an undecodable upload is never stored
  // as a "safe original". Decoding is deterministic, so retrying cannot help.
  let converted;
  try {
    converted = await convertToWebp(originalBuffer);
  } catch (error) {
    console.warn('Cannot convert upload to WebP:', {
      bucket,
      key,
      imageId,
      error: error.message,
    });
    await recordVariantOutcome(
      imageId,
      'WEBP_FAILED',
      `Cannot convert image: ${error.message}`,
    );
    return;
  }
  const { metadata, contentType, webpBuffer, webpMetadata } = converted;

  const { safeOriginalKey, webpKey } = outputKeys(key, imageId);
  const now = new Date();
  const nowIso = now.toISOString();
  const { retentionSeconds, expiresAtIso, expiresAtEpoch } =
    expectedLifecycleExpiry(now);
  const commonOutputTags = {
    'image-id': imageId,
    'expires-at-epoch': String(expiresAtEpoch),
    'retention-seconds': String(retentionSeconds),
    'retention-days': String(OBJECT_RETENTION_DAYS),
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: PROCESSED_BUCKET_NAME,
      Key: safeOriginalKey,
      Body: originalBuffer,
      ContentType: contentType,
      Metadata: {
        imageid: imageId,
        originalbucket: bucket,
        originalkey: key,
        variant: 'safe-original',
      },
      Tagging: s3TaggingHeader({
        ...commonOutputTags,
        variant: 'safe-original',
      }),
    }),
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: PROCESSED_BUCKET_NAME,
      Key: webpKey,
      Body: webpBuffer,
      ContentType: 'image/webp',
      Metadata: {
        imageid: imageId,
        originalbucket: bucket,
        originalkey: key,
        variant: 'webp',
        width: String(webpMetadata.width || ''),
        height: String(webpMetadata.height || ''),
      },
      Tagging: s3TaggingHeader({ ...commonOutputTags, variant: 'webp' }),
    }),
  );

  await s3.send(
    new PutObjectTaggingCommand({
      Bucket: bucket,
      Key: key,
      ...versionArgs,
      Tagging: {
        TagSet: mergeTags(tagResult.TagSet, {
          'processed-status': 'WEBP_CREATED',
          'webp-status': 'CREATED',
        }),
      },
    }),
  );

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { imageId },
        UpdateExpression:
          'SET #status = :status, variantStatus = :variantStatus, safeOriginalBucket = :processedBucket, safeOriginalKey = :safeOriginalKey, safeOriginalSizeBytes = :safeOriginalSizeBytes, safeOriginalContentType = :safeOriginalContentType, webpBucket = :processedBucket, webpKey = :webpKey, webpSizeBytes = :webpSizeBytes, webpWidth = :webpWidth, webpHeight = :webpHeight, webpQuality = :webpQuality, sourceWidth = :sourceWidth, sourceHeight = :sourceHeight, processedAt = :processedAt, updatedAt = :updatedAt, processedLifecycleExpiresAfter = :processedExpiresAt, processedLifecycleExpiresAfterEpoch = :processedExpiresAtEpoch, objectRetentionDays = :retentionDays, objectRetentionSeconds = :retentionSeconds, lifecycleStatus = :lifecycleStatus, retentionStatus = :retentionStatus REMOVE safeOriginalDeletedAt, webpDeletedAt, safeOriginalLifecycleExpiredAt, webpLifecycleExpiredAt, expiredAt',
        // Re-processing a duplicate message is fine; overwriting a status that
        // moved on (for example after lifecycle expiration) is not.
        ConditionExpression: '#status IN (:scanned, :status)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'WEBP_CREATED',
          ':scanned': 'SCANNED',
          ':variantStatus': 'WEBP_CREATED',
          ':processedBucket': PROCESSED_BUCKET_NAME,
          ':safeOriginalKey': safeOriginalKey,
          ':safeOriginalSizeBytes': originalBuffer.length,
          ':safeOriginalContentType': contentType,
          ':webpKey': webpKey,
          ':webpSizeBytes': webpBuffer.length,
          ':webpWidth': webpMetadata.width || null,
          ':webpHeight': webpMetadata.height || null,
          ':webpQuality': Number(WEBP_QUALITY),
          ':sourceWidth': metadata.width || null,
          ':sourceHeight': metadata.height || null,
          ':processedAt': nowIso,
          ':updatedAt': nowIso,
          ':processedExpiresAt': expiresAtIso,
          ':processedExpiresAtEpoch': expiresAtEpoch,
          ':retentionDays': Number(OBJECT_RETENTION_DAYS),
          ':retentionSeconds': retentionSeconds,
          ':lifecycleStatus': 'AWAITING_LIFECYCLE_EXPIRATION',
          ':retentionStatus': 'ACTIVE',
        },
      }),
    );
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
    console.warn(
      'Not recording WebP result; the image is no longer waiting for conversion.',
      { imageId },
    );
  }
}

// SQS moves the message to the DLQ after this attempt; record that in the
// status so clients stop waiting.
async function recordRetriesExhausted(record, error) {
  try {
    const message = JSON.parse(record.body || '{}');
    const imageId =
      message.imageId || (message.key && imageIdFromKey(message.key));
    if (imageId)
      await recordVariantOutcome(
        imageId,
        'WEBP_FAILED',
        `Retries exhausted: ${error.message}`,
      );
  } catch (recordError) {
    console.error('Could not record WEBP_FAILED status:', recordError);
  }
}

export async function handler(event) {
  const batchItemFailures = [];
  for (const record of event.Records || []) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error('Failed to create WebP variant:', record.messageId, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      const receiveCount = Number(
        record.attributes?.ApproximateReceiveCount || 0,
      );
      if (receiveCount >= Number(MAX_RECEIVE_COUNT))
        await recordRetriesExhausted(record, error);
    }
  }
  return { batchItemFailures };
}
