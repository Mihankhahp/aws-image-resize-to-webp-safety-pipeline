import { Duration } from 'aws-cdk-lib';
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
