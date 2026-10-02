import {
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({});
const sqs = new SQSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const {
  ORIGINAL_BUCKET_NAME,
  TABLE_NAME,
  VARIANT_CANDIDATE_QUEUE_URL,
  RESIZE_THRESHOLD_BYTES = '0',
  ALLOWED_CONTENT_TYPES = 'image/jpeg,image/png,image/webp,image/gif,image/avif,image/tiff',
  OBJECT_RETENTION_DAYS = '1',
  OBJECT_RETENTION_SECONDS = '86400',
} = process.env;
const allowedContentTypes = new Set(ALLOWED_CONTENT_TYPES.split(','));

function decodeS3Key(key) {
  return decodeURIComponent(String(key || '').replace(/\+/g, ' '));
}
function imageIdFromKey(key) {
  const parts = key.split('/');
  return parts[0] === 'uploads' && parts[1] ? parts[1] : key;
}
function baseContentType(contentType) {
  return String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}
function toSecurityStatus(scanResult) {
  if (scanResult === 'NO_THREATS_FOUND') return 'CLEAN';
  if (scanResult === 'THREATS_FOUND') return 'MALICIOUS';
  return 'UNVERIFIED';
}
function toPipelineStatus(securityStatus, scanStatus, variantRequired) {
  if (securityStatus === 'MALICIOUS') return 'BLOCKED';
  if (securityStatus === 'CLEAN')
    return variantRequired ? 'SCANNED' : 'NO_VARIANT_REQUIRED';
  if (scanStatus === 'FAILED') return 'SCAN_FAILED';
  if (scanStatus === 'SKIPPED') return 'SCAN_SKIPPED';
  return 'SCAN_UNKNOWN';
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

export async function handler(event) {
  console.log('GuardDuty scan event:', JSON.stringify(event));
  const detail = event.detail || {};
  const objectDetails = detail.s3ObjectDetails || {};
  const scanDetails = detail.scanResultDetails || {};
  const bucket = objectDetails.bucketName || ORIGINAL_BUCKET_NAME;
  const key = decodeS3Key(objectDetails.objectKey);
  const versionId = objectDetails.versionId;
  const scanStatus = detail.scanStatus || 'UNKNOWN';
  const scanResult = scanDetails.scanResultStatus || 'UNKNOWN';
  if (!key || bucket !== ORIGINAL_BUCKET_NAME) return;

  const versionArgs = versionId ? { VersionId: versionId } : {};
  const imageId = imageIdFromKey(key);
  const now = new Date().toISOString();
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key, ...versionArgs }),
  );
  const sizeBytes = Number(head.ContentLength || 0);
  const contentType = head.ContentType || 'application/octet-stream';
  const securityStatus = toSecurityStatus(scanResult);
  const meetsSizeThreshold = sizeBytes >= Number(RESIZE_THRESHOLD_BYTES);
  const supportedContentType = allowedContentTypes.has(
    baseContentType(contentType),
  );
  const sizeCategory = meetsSizeThreshold ? 'LARGE' : 'SMALL';
  const variantRequired =
    securityStatus === 'CLEAN' && meetsSizeThreshold && supportedContentType;
  let variantSkipReason = null;
  if (securityStatus === 'CLEAN' && !variantRequired)
    variantSkipReason = supportedContentType
      ? 'BELOW_SIZE_THRESHOLD'
      : 'UNSUPPORTED_CONTENT_TYPE';
  const pipelineStatus = toPipelineStatus(
    securityStatus,
    scanStatus,
    variantRequired,
  );

  // Record the result before tagging, and only while the image has not moved
  // past scanning. Re-applying the same status keeps Lambda retries working;
  // anything else is a duplicate or late result (GuardDuty delivers at least
  // once) and must not roll the status back or queue the image again.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { imageId },
        UpdateExpression:
          'SET #status = :status, scanStatus = :scanStatus, scanResult = :scanResult, securityStatus = :securityStatus, sizeBytes = :sizeBytes, sizeCategory = :sizeCategory, variantRequired = :variantRequired, variantSkipReason = :variantSkipReason, contentType = :contentType, threats = :threats, statusReasons = :statusReasons, scannedAt = :scannedAt, updatedAt = :updatedAt, originalBucket = :bucket, originalKey = :key, originalVersionId = if_not_exists(originalVersionId, :versionId)',
        ConditionExpression:
          'attribute_not_exists(#status) OR #status IN (:presigned, :uploaded, :status)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': pipelineStatus,
          ':presigned': 'PRESIGNED',
          ':uploaded': 'UPLOADED',
          ':scanStatus': scanStatus,
          ':scanResult': scanResult,
          ':securityStatus': securityStatus,
          ':sizeBytes': sizeBytes,
          ':sizeCategory': sizeCategory,
          ':variantRequired': variantRequired,
          ':variantSkipReason': variantSkipReason,
          ':contentType': contentType,
          ':threats': scanDetails.threats || null,
          ':statusReasons': scanDetails.statusReasons || null,
          ':scannedAt': now,
          ':updatedAt': now,
          ':bucket': bucket,
          ':key': key,
          ':versionId': versionId || null,
        },
      }),
    );
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
    console.warn(
      'Ignoring scan result; the image already moved past scanning.',
      {
        imageId,
        key,
        pipelineStatus,
      },
    );
    return;
  }

  // Tag writes replace the whole tag set. Before conversion only post-scan
  // writes tags (upload-complete deliberately does not), so this
  // read-modify-write does not race another pipeline Lambda.
  const retentionSeconds = Number(OBJECT_RETENTION_SECONDS);
  const objectCreatedAt = head.LastModified
    ? new Date(head.LastModified)
    : new Date();
  const expiresAtEpoch =
    Math.floor(objectCreatedAt.getTime() / 1000) + retentionSeconds;
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
          'scan-result': securityStatus,
          'variant-required': variantRequired ? 'TRUE' : 'FALSE',
          'size-category': sizeCategory,
          'processed-status': pipelineStatus,
          'expires-at-epoch': String(expiresAtEpoch),
          'retention-seconds': String(retentionSeconds),
          'retention-days': String(OBJECT_RETENTION_DAYS),
        }),
      },
    }),
  );

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: VARIANT_CANDIDATE_QUEUE_URL,
      MessageBody: JSON.stringify({
        imageId,
        bucket,
        key,
        versionId: versionId || '',
        scanStatus,
        scanResult,
        securityStatus,
        sizeBytes,
        sizeCategory,
        variantRequired,
        contentType,
        updatedAt: now,
      }),
    }),
  );
}
