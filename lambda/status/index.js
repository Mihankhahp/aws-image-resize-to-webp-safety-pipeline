import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const { TABLE_NAME, DOWNLOAD_URL_EXPIRES_SECONDS = '900' } = process.env;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,GET',
};
function response(statusCode, body) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(body) };
}
async function signedGet(bucket, key, responseContentType) {
  if (!bucket || !key) return undefined;
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: responseContentType,
    }),
    { expiresIn: Number(DOWNLOAD_URL_EXPIRES_SECONDS) },
  );
}

export async function handler(event) {
  try {
    const imageId = event.pathParameters?.imageId;
    if (!imageId)
      return response(400, { message: 'Missing imageId path parameter.' });
    const result = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { imageId } }),
    );
    if (!result.Item)
      return response(404, { message: 'Image not found.', imageId });
    const item = result.Item;
    const variants = {};
    if (
      item.safeOriginalBucket &&
      item.safeOriginalKey &&
      !item.safeOriginalDeletedAt
    ) {
      variants.original = {
        bucket: item.safeOriginalBucket,
        key: item.safeOriginalKey,
        sizeBytes: item.safeOriginalSizeBytes,
        downloadUrl: await signedGet(
          item.safeOriginalBucket,
          item.safeOriginalKey,
        ),
      };
    }
    if (item.webpBucket && item.webpKey && !item.webpDeletedAt) {
      variants.webp = {
        bucket: item.webpBucket,
        key: item.webpKey,
        sizeBytes: item.webpSizeBytes,
        width: item.webpWidth,
        height: item.webpHeight,
        quality: item.webpQuality,
        downloadUrl: await signedGet(
          item.webpBucket,
          item.webpKey,
          'image/webp',
        ),
      };
    }
    return response(200, {
      ...item,
      variants,
      downloadUrlExpiresSeconds: Number(DOWNLOAD_URL_EXPIRES_SECONDS),
    });
  } catch (error) {
    console.error(error);
    return response(500, { message: 'Failed to read image status.' });
  }
}
