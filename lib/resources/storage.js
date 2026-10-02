import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

export function createStorageResources(scope, config) {
  const originalBucket = new s3.Bucket(scope, 'OriginalImagesBucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    eventBridgeEnabled: true,
    versioned: false,
    lifecycleRules: [
      createExpirationRule(
        'ExpireUploadedObjects',
        config.prefixes.upload,
        config.retention.objectRetentionDays,
      ),
    ],
    removalPolicy: config.removalPolicy,
    // GuardDuty leaves a validation object at the bucket root that the uploads/
    // lifecycle rule never expires, so a non-prod destroy must empty the bucket.
    autoDeleteObjects: !config.isProd,
    cors: [
      {
        allowedMethods: [s3.HttpMethods.PUT],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3000,
      },
    ],
  });

  // Uploads may only create objects, never replace one: a replaced object would
  // carry no scan of its own. Presigned URLs already sign If-None-Match; this
  // makes S3 enforce it even if a client or a future presign change omits it.
  originalBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'DenyUploadsThatCanOverwrite',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [originalBucket.arnForObjects(`${config.prefixes.upload}*`)],
      conditions: {
        Null: { 's3:if-none-match': 'true' },
        Bool: { 's3:ObjectCreationOperation': 'true' },
      },
    }),
  );

  const processedBucket = new s3.Bucket(scope, 'ProcessedImagesBucket', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    eventBridgeEnabled: true,
    versioned: false,
    lifecycleRules: [
      createExpirationRule(
        'ExpireProcessedObjects',
        config.prefixes.processed,
        config.retention.objectRetentionDays,
      ),
    ],
    removalPolicy: config.removalPolicy,
    autoDeleteObjects: !config.isProd,
    cors: [
      {
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        exposedHeaders: ['Content-Length', 'Content-Type', 'ETag'],
        maxAge: 3000,
      },
    ],
  });

  return { originalBucket, processedBucket };
}

function createExpirationRule(id, prefix, retentionDays) {
  return {
    id,
    prefix,
    expiration: Duration.days(retentionDays),
    abortIncompleteMultipartUploadAfter: Duration.days(1),
  };
}
