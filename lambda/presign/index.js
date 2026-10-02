import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

// By default the SDK puts a CRC32 of the presign request's empty body into the
// URL, and S3 would reject every real upload for not matching it.
const s3 = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const {
  ORIGINAL_BUCKET_NAME,
  TABLE_NAME,
  UPLOAD_PREFIX = 'uploads/',
  URL_EXPIRES_SECONDS = '900',
  ALLOWED_CONTENT_TYPES = 'image/jpeg,image/png,image/webp,image/gif,image/avif,image/tiff',
  OBJECT_RETENTION_DAYS = '1',
  OBJECT_RETENTION_SECONDS = '86400',
} = process.env;
const allowedContentTypes = new Set(ALLOWED_CONTENT_TYPES.split(','));
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
function parseJsonBody(raw) {
  try {
    const body = JSON.parse(raw || '{}');
    return body && typeof body === 'object' ? body : undefined;
  } catch {
    return undefined;
  }
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
    const body = parseJsonBody(event.body);
    if (!body)
      return response(400, { message: 'Request body must be a JSON object.' });
    const filename = sanitizeFilename(
      typeof body.filename === 'string' && body.filename
        ? body.filename
        : 'image',
    );
    const contentType =
      typeof body.contentType === 'string'
        ? body.contentType.trim().toLowerCase()
        : '';
    // The upload URL signs this Content-Type, so the PUT must use it. post-scan
    // and the WebP Lambda still re-check what was actually uploaded.
    if (!allowedContentTypes.has(contentType))
      return response(400, {
        message: `Unsupported contentType. Allowed: ${[...allowedContentTypes].join(', ')}.`,
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
      // Conditional write: S3 answers 412 if the key already exists, so the
      // URL can create the object once and never replace a scanned upload.
      IfNoneMatch: '*',
    });
    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: Number(URL_EXPIRES_SECONDS),
      // The S3 presigner leaves Content-Type unsigned unless asked.
      signableHeaders: new Set(['content-type']),
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
      // Both headers are signed into uploadUrl; the PUT fails without them.
      requiredHeaders: { 'Content-Type': contentType, 'If-None-Match': '*' },
    });
  } catch (error) {
    console.error(error);
    return response(500, { message: 'Failed to create presigned URL.' });
  }
}
