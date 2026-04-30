import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const {
  ORIGINAL_BUCKET_NAME,
  TABLE_NAME,
  UPLOAD_PREFIX = 'uploads/',
  URL_EXPIRES_SECONDS = '900',
  OBJECT_RETENTION_DAYS = '1',
  OBJECT_RETENTION_SECONDS = '86400',
} = process.env;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,POST',
};

function response(statusCode, body) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(body) };
}
function sanitizeFilename(filename = 'image') {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 150);
}
function secondsFromNow(seconds, now = new Date()) {
  const expiresAt = new Date(now.getTime() + Number(seconds) * 1000);
  return {
    expiresAtIso: expiresAt.toISOString(),
    expiresAtEpoch: Math.floor(expiresAt.getTime() / 1000),
  };
}

export async function handler(event) {
  try {
    const body = JSON.parse(event.body || '{}');
    const filename = sanitizeFilename(body.filename || 'image');
    const contentType = body.contentType || 'application/octet-stream';
    if (!contentType.startsWith('image/'))
      return response(400, {
        message: 'Only image/* content types are allowed.',
      });

    const imageId = randomUUID();
    const key = `${UPLOAD_PREFIX}${imageId}/${filename}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const presignExpiry = secondsFromNow(Number(URL_EXPIRES_SECONDS), now);

    const command = new PutObjectCommand({
      Bucket: ORIGINAL_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      Metadata: { imageid: imageId },
    });
    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: Number(URL_EXPIRES_SECONDS),
    });

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          imageId,
          originalBucket: ORIGINAL_BUCKET_NAME,
          originalKey: key,
          originalFilename: filename,
          contentType,
          status: 'PRESIGNED',
          scanResult: 'UNKNOWN',
          securityStatus: 'UNKNOWN',
          variantRequired: null,
          objectRetentionDays: Number(OBJECT_RETENTION_DAYS),
          objectRetentionSeconds: Number(OBJECT_RETENTION_SECONDS),
          presignUrlExpiresAt: presignExpiry.expiresAtIso,
          presignUrlExpiresAtEpoch: presignExpiry.expiresAtEpoch,
          lifecycleStatus: 'WAITING_FOR_UPLOAD',
          retentionStatus: 'NOT_CREATED_IN_S3',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      }),
    );

    return response(200, {
      imageId,
      key,
      uploadUrl,
      uploadUrlExpiresIn: Number(URL_EXPIRES_SECONDS),
      objectRetentionDays: Number(OBJECT_RETENTION_DAYS),
      objectRetentionSeconds: Number(OBJECT_RETENTION_SECONDS),
      requiredHeaders: { 'Content-Type': contentType },
    });
  } catch (error) {
    console.error(error);
    return response(500, { message: 'Failed to create presigned URL.' });
  }
}
