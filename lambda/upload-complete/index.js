import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
async function updateUnlessConditionFails(input) {
  try {
    await ddb.send(new UpdateCommand(input));
    return true;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

// This Lambda runs at the same time as post-scan, so it deliberately writes no
// S3 object tags: tag writes replace the whole tag set and would race.
export async function handler(event) {
  console.log('S3 upload event:', JSON.stringify(event));
  const detail = event.detail || {};
  const bucket = detail.bucket?.name || ORIGINAL_BUCKET_NAME;
  const key = decodeS3Key(detail.object?.key);
  const versionId = detail.object?.['version-id'];
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

  // Upload metadata is safe to re-apply on retries and duplicate events, but
  // not once lifecycle expiration has started for the record.
  await updateUnlessConditionFails({
    TableName: TABLE_NAME,
    Key: { imageId },
    UpdateExpression:
      'SET uploadStatus = :uploadStatus, sizeBytes = :sizeBytes, contentType = :contentType, uploadedAt = if_not_exists(uploadedAt, :uploadedAt), updatedAt = :updatedAt, originalBucket = :bucket, originalKey = :key, originalVersionId = :versionId, originalLifecycleExpiresAfter = if_not_exists(originalLifecycleExpiresAfter, :expiresAt), originalLifecycleExpiresAfterEpoch = if_not_exists(originalLifecycleExpiresAfterEpoch, :expiresAtEpoch), objectRetentionDays = :retentionDays, objectRetentionSeconds = :retentionSeconds, lifecycleStatus = :lifecycleStatus, retentionStatus = :retentionStatus',
    ConditionExpression: 'attribute_not_exists(lastLifecycleExpiredAt)',
    ExpressionAttributeValues: {
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
  });

  // Status only moves forward: post-scan may already have recorded the scan
  // result, and a retried or duplicate event must not roll it back.
  await updateUnlessConditionFails({
    TableName: TABLE_NAME,
    Key: { imageId },
    UpdateExpression: 'SET #status = :status',
    ConditionExpression:
      'attribute_not_exists(#status) OR #status = :presigned',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'UPLOADED',
      ':presigned': 'PRESIGNED',
    },
  });
}
