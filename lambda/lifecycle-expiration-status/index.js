import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const {
  TABLE_NAME,
  ORIGINAL_BUCKET_NAME,
  PROCESSED_BUCKET_NAME,
  UPLOAD_PREFIX = 'uploads/',
  PROCESSED_PREFIX = 'processed/',
} = process.env;

function decodeS3Key(key) {
  return decodeURIComponent(String(key || '').replace(/\+/g, ' '));
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function parseSqsBody(record) {
  try {
    return JSON.parse(record.body || '{}');
  } catch (error) {
    throw new Error(`Invalid SQS message body: ${error.message}`);
  }
}

function classifyObject(bucket, key) {
  const uploadPrefix = stripTrailingSlash(UPLOAD_PREFIX);
  const processedPrefix = stripTrailingSlash(PROCESSED_PREFIX);

  if (bucket === ORIGINAL_BUCKET_NAME && key.startsWith(`${uploadPrefix}/`)) {
    const [, imageId] = key.split('/');
    return imageId ? { imageId, artifactType: 'original' } : undefined;
  }

  if (
    bucket === PROCESSED_BUCKET_NAME &&
    key.startsWith(`${processedPrefix}/`)
  ) {
    const [, imageId, variantType] = key.split('/');
    if (!imageId) return undefined;
    if (variantType === 'original')
      return { imageId, artifactType: 'safeOriginal' };
    if (variantType === 'web') return { imageId, artifactType: 'webp' };
    return { imageId, artifactType: 'processedUnknown' };
  }

  return undefined;
}

// `item` already includes this event's deletion (read back from the update).
function terminalStatusAfterExpiration(item) {
  const hasSafeOriginal = Boolean(item.safeOriginalKey);
  const hasWebp = Boolean(item.webpKey);
  const hasProcessedArtifacts = hasSafeOriginal || hasWebp;

  const safeOriginalGone =
    !hasSafeOriginal || Boolean(item.safeOriginalDeletedAt);
  const webpGone = !hasWebp || Boolean(item.webpDeletedAt);
  const originalGone = Boolean(item.originalDeletedAt);

  if (hasProcessedArtifacts)
    return safeOriginalGone && webpGone ? 'ARTIFACTS_EXPIRED' : undefined;
  if (!originalGone) return undefined;
  // Duplicate lifecycle events must keep the status chosen the first time.
  if (item.status === 'BLOCKED' || item.status === 'BLOCKED_EXPIRED')
    return 'BLOCKED_EXPIRED';
  if (String(item.status || '').startsWith('SCAN_'))
    return 'SCAN_RESULT_EXPIRED';
  return 'EXPIRED';
}

function updatePiecesForArtifact(artifactType, nowIso) {
  const setParts = [
    'updatedAt = :updatedAt',
    'lifecycleStatus = :lifecycleStatus',
    'lastLifecycleExpiredAt = :expiredAt',
  ];
  const values = {
    ':updatedAt': nowIso,
    ':expiredAt': nowIso,
    ':lifecycleStatus': 'EXPIRED_EVENT_RECEIVED',
  };

  if (artifactType === 'original') {
    setParts.push(
      'originalDeletedAt = :expiredAt',
      'originalLifecycleExpiredAt = :expiredAt',
    );
  } else if (artifactType === 'safeOriginal') {
    setParts.push(
      'safeOriginalDeletedAt = :expiredAt',
      'safeOriginalLifecycleExpiredAt = :expiredAt',
    );
  } else if (artifactType === 'webp') {
    setParts.push(
      'webpDeletedAt = :expiredAt',
      'webpLifecycleExpiredAt = :expiredAt',
    );
  } else {
    setParts.push('unknownProcessedLifecycleExpiredAt = :expiredAt');
  }

  return { setParts, values };
}

async function updateImageStatus({
  imageId,
  artifactType,
  bucket,
  key,
  nowIso,
  eventDetail,
}) {
  const { setParts, values } = updatePiecesForArtifact(artifactType, nowIso);
  values[':lastExpiredBucket'] = bucket;
  values[':lastExpiredKey'] = key;
  values[':lastExpirationReason'] =
    eventDetail.reason || 'Lifecycle Expiration';
  values[':lastDeletionType'] = eventDetail['deletion-type'] || 'Unknown';
  setParts.push(
    'lastExpiredBucket = :lastExpiredBucket',
    'lastExpiredKey = :lastExpiredKey',
    'lastExpirationReason = :lastExpirationReason',
    'lastDeletionType = :lastDeletionType',
  );

  // Record this deletion and read the result back in one atomic step.
  // DynamoDB serializes updates to an item, so the last of several concurrent
  // events for the same image sees every deletion and sets the final status.
  let item;
  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { imageId },
        UpdateExpression: `SET ${setParts.join(', ')}`,
        ConditionExpression: 'attribute_exists(imageId)',
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    item = result.Attributes;
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
    console.warn('Lifecycle event did not match an image record.', {
      imageId,
      bucket,
      key,
    });
    return { imageId, skipped: 'IMAGE_NOT_FOUND' };
  }

  const finalStatus = terminalStatusAfterExpiration(item);
  if (finalStatus) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { imageId },
        UpdateExpression:
          'SET #status = :finalStatus, retentionStatus = :retentionStatus, expiredAt = if_not_exists(expiredAt, :expiredAt)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':finalStatus': finalStatus,
          ':retentionStatus': 'EXPIRED',
          ':expiredAt': nowIso,
        },
      }),
    );
    return {
      imageId,
      artifactType,
      status: finalStatus,
      retentionStatus: 'EXPIRED',
    };
  }

  // A concurrent event for the same image may already have marked the record
  // EXPIRED; never downgrade it.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { imageId },
        UpdateExpression: 'SET retentionStatus = :retentionStatus',
        ConditionExpression:
          'attribute_not_exists(retentionStatus) OR retentionStatus <> :expired',
        ExpressionAttributeValues: {
          ':retentionStatus': 'PARTIALLY_EXPIRED',
          ':expired': 'EXPIRED',
        },
      }),
    );
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
  }
  return {
    imageId,
    artifactType,
    status: item.status,
    retentionStatus: 'PARTIALLY_EXPIRED',
  };
}

async function processLifecycleEvent(event) {
  const detail = event.detail || {};
  const bucket = detail.bucket?.name;
  const key = decodeS3Key(detail.object?.key);

  if (detail.reason !== 'Lifecycle Expiration')
    return { ignored: true, reason: detail.reason };

  const classification = classifyObject(bucket, key);
  if (!classification) return { ignored: true, bucket, key };

  return updateImageStatus({
    ...classification,
    bucket,
    key,
    nowIso: new Date().toISOString(),
    eventDetail: detail,
  });
}

export async function handler(event) {
  if (!Array.isArray(event.Records)) return processLifecycleEvent(event);

  const batchItemFailures = [];
  for (const record of event.Records) {
    try {
      await processLifecycleEvent(parseSqsBody(record));
    } catch (error) {
      console.error('Failed to process lifecycle expiration event.', {
        messageId: record.messageId,
        error,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
