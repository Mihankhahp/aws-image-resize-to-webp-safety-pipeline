import {
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const {
  ORIGINAL_BUCKET_NAME,
  TABLE_NAME,
  OBJECT_RETENTION_DAYS = '1',
  OBJECT_RETENTION_SECONDS = '86400',
} = process.env;

function decodeS3Key(key) {
  return decodeURIComponent(String(key || '').replace(/\+/g, ' '));
}
function imageIdFromKey(key) {
  const parts = key.split('/');
  return parts[0] === 'uploads' && parts[1] ? parts[1] : key;
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
function mergeTags(existingTagSet, nextTags) {
  const map = new Map(
    (existingTagSet || []).map((tag) => [tag.Key, tag.Value]),
  );
  for (const [key, value] of Object.entries(nextTags))
    map.set(key, String(value).slice(0, 256));
  const preferred = [
    'GuardDutyMalwareScanStatus',
    'upload-status',
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

export async function handler(event) {
  console.log('S3 upload event:', JSON.stringify(event));
  const detail = event.detail || {};
  const bucket = detail.bucket?.name || ORIGINAL_BUCKET_NAME;
  const key = decodeS3Key(detail.object?.key);
  const versionId = detail.object?.versionId;
  if (!key || bucket !== ORIGINAL_BUCKET_NAME) return;

  const versionArgs = versionId ? { VersionId: versionId } : {};
  const imageId = imageIdFromKey(key);
  const now = new Date();
  const nowIso = now.toISOString();
  const { retentionSeconds, expiresAtIso, expiresAtEpoch } =
    expectedLifecycleExpiry(now);
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key, ...versionArgs }),
  );
  const existingTags = await s3.send(
    new GetObjectTaggingCommand({ Bucket: bucket, Key: key, ...versionArgs }),
  );

  await s3.send(
    new PutObjectTaggingCommand({
      Bucket: bucket,
      Key: key,
      ...versionArgs,
      Tagging: {
        TagSet: mergeTags(existingTags.TagSet, {
          'upload-status': 'UPLOADED',
          'expires-at-epoch': String(expiresAtEpoch),
          'retention-seconds': String(retentionSeconds),
          'retention-days': String(OBJECT_RETENTION_DAYS),
        }),
      },
    }),
  );

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { imageId },
      UpdateExpression:
        'SET #status = :status, uploadStatus = :uploadStatus, sizeBytes = :sizeBytes, contentType = :contentType, uploadedAt = :uploadedAt, updatedAt = :updatedAt, originalBucket = :bucket, originalKey = :key, originalVersionId = :versionId, originalLifecycleExpiresAfter = :expiresAt, originalLifecycleExpiresAfterEpoch = :expiresAtEpoch, objectRetentionDays = :retentionDays, objectRetentionSeconds = :retentionSeconds, lifecycleStatus = :lifecycleStatus, retentionStatus = :retentionStatus REMOVE originalDeletedAt, originalLifecycleExpiredAt, expiredAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'UPLOADED',
        ':uploadStatus': 'UPLOADED',
        ':sizeBytes': Number(head.ContentLength || 0),
        ':contentType': head.ContentType || 'application/octet-stream',
        ':uploadedAt': nowIso,
        ':updatedAt': nowIso,
        ':bucket': bucket,
        ':key': key,
        ':versionId': versionId || null,
        ':expiresAt': expiresAtIso,
        ':expiresAtEpoch': expiresAtEpoch,
        ':retentionDays': Number(OBJECT_RETENTION_DAYS),
        ':retentionSeconds': retentionSeconds,
        ':lifecycleStatus': 'AWAITING_LIFECYCLE_EXPIRATION',
        ':retentionStatus': 'ACTIVE',
      },
    }),
  );
}
