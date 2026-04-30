import path from 'node:path';

import { Duration, Size } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';

import { grantObjectTagReadWrite } from '../permissions/s3-tags.js';

export function createLambdaResources(scope, config, resources) {
  const {
    originalBucket,
    processedBucket,
    imagesTable,
    variantCandidateQueue,
    variantQueue,
    lifecycleExpirationQueue,
    projectRoot,
  } = resources;

  const commonBundling = createCommonBundling(projectRoot);

  const presignFn = createNodeFunction(
    scope,
    'PresignUrlFunction',
    config.lambdas.presign,
    {
      projectRoot,
      entry: 'lambda/presign/index.js',
      bundling: commonBundling,
      environment: {
        ORIGINAL_BUCKET_NAME: originalBucket.bucketName,
        TABLE_NAME: imagesTable.tableName,
        UPLOAD_PREFIX: config.prefixes.upload,
        URL_EXPIRES_SECONDS: config.urls.uploadUrlExpiresSeconds,
        OBJECT_RETENTION_DAYS: String(config.retention.objectRetentionDays),
        OBJECT_RETENTION_SECONDS: String(
          config.retention.objectRetentionSeconds,
        ),
      },
    },
  );
  originalBucket.grantPut(presignFn, `${config.prefixes.upload}*`);
  imagesTable.grantWriteData(presignFn);

  const uploadCompleteFn = createNodeFunction(
    scope,
    'UploadCompleteFunction',
    config.lambdas.uploadComplete,
    {
      projectRoot,
      entry: 'lambda/upload-complete/index.js',
      bundling: commonBundling,
      environment: {
        ORIGINAL_BUCKET_NAME: originalBucket.bucketName,
        TABLE_NAME: imagesTable.tableName,
        OBJECT_RETENTION_DAYS: String(config.retention.objectRetentionDays),
        OBJECT_RETENTION_SECONDS: String(
          config.retention.objectRetentionSeconds,
        ),
      },
    },
  );
  originalBucket.grantRead(uploadCompleteFn, `${config.prefixes.upload}*`);
  grantObjectTagReadWrite(
    uploadCompleteFn,
    originalBucket,
    `${config.prefixes.upload}*`,
  );
  imagesTable.grantReadWriteData(uploadCompleteFn);

  const postScanFn = createNodeFunction(
    scope,
    'PostScanTaggerFunction',
    config.lambdas.postScan,
    {
      projectRoot,
      entry: 'lambda/post-scan/index.js',
      bundling: commonBundling,
      environment: {
        ORIGINAL_BUCKET_NAME: originalBucket.bucketName,
        TABLE_NAME: imagesTable.tableName,
        VARIANT_CANDIDATE_QUEUE_URL: variantCandidateQueue.queueUrl,
        RESIZE_THRESHOLD_BYTES: config.imageProcessing.resizeThresholdBytes,
      },
    },
  );
  originalBucket.grantRead(postScanFn, `${config.prefixes.upload}*`);
  grantObjectTagReadWrite(
    postScanFn,
    originalBucket,
    `${config.prefixes.upload}*`,
  );
  imagesTable.grantReadWriteData(postScanFn);
  variantCandidateQueue.grantSendMessages(postScanFn);

  const createWebpFn = createNodeFunction(
    scope,
    'CreateWebpVariantsFunction',
    config.lambdas.createWebp,
    {
      projectRoot,
      entry: 'lambda/create-webp-variants/index.js',
      ephemeralStorageSize: Size.mebibytes(1024),
      bundling: createSharpBundling(projectRoot, commonBundling),
      environment: {
        ORIGINAL_BUCKET_NAME: originalBucket.bucketName,
        PROCESSED_BUCKET_NAME: processedBucket.bucketName,
        TABLE_NAME: imagesTable.tableName,
        WEB_MAX_WIDTH: config.imageProcessing.webMaxWidth,
        WEBP_QUALITY: config.imageProcessing.webpQuality,
        PROCESSED_PREFIX: config.prefixes.processed,
        OBJECT_RETENTION_DAYS: String(config.retention.objectRetentionDays),
        OBJECT_RETENTION_SECONDS: String(
          config.retention.objectRetentionSeconds,
        ),
      },
    },
  );
  originalBucket.grantRead(createWebpFn, `${config.prefixes.upload}*`);
  processedBucket.grantPut(createWebpFn, `${config.prefixes.processed}*`);
  imagesTable.grantReadWriteData(createWebpFn);
  variantQueue.grantConsumeMessages(createWebpFn);
  grantObjectTagReadWrite(
    createWebpFn,
    originalBucket,
    `${config.prefixes.upload}*`,
  );
  createWebpFn.addEventSource(
    createSqsEventSource(variantQueue, config.consumers.webp),
  );

  const statusFn = createNodeFunction(
    scope,
    'ImageStatusFunction',
    config.lambdas.status,
    {
      projectRoot,
      entry: 'lambda/status/index.js',
      bundling: commonBundling,
      environment: {
        TABLE_NAME: imagesTable.tableName,
        PROCESSED_BUCKET_NAME: processedBucket.bucketName,
        DOWNLOAD_URL_EXPIRES_SECONDS: config.urls.downloadUrlExpiresSeconds,
      },
    },
  );
  imagesTable.grantReadData(statusFn);
  processedBucket.grantRead(statusFn, `${config.prefixes.processed}*`);

  const lifecycleExpirationStatusFn = createNodeFunction(
    scope,
    'LifecycleExpirationStatusFunction',
    config.lambdas.lifecycleExpirationStatus,
    {
      projectRoot,
      entry: 'lambda/lifecycle-expiration-status/index.js',
      bundling: commonBundling,
      environment: {
        TABLE_NAME: imagesTable.tableName,
        ORIGINAL_BUCKET_NAME: originalBucket.bucketName,
        PROCESSED_BUCKET_NAME: processedBucket.bucketName,
        UPLOAD_PREFIX: config.prefixes.upload,
        PROCESSED_PREFIX: config.prefixes.processed,
      },
    },
  );
  imagesTable.grantReadWriteData(lifecycleExpirationStatusFn);
  lifecycleExpirationQueue.grantConsumeMessages(lifecycleExpirationStatusFn);
  lifecycleExpirationStatusFn.addEventSource(
    createSqsEventSource(
      lifecycleExpirationQueue,
      config.consumers.lifecycleExpirationStatus,
    ),
  );

  return {
    presignFn,
    uploadCompleteFn,
    postScanFn,
    createWebpFn,
    statusFn,
    lifecycleExpirationStatusFn,
  };
}

function createNodeFunction(scope, id, lambdaConfig, props) {
  return new nodejs.NodejsFunction(scope, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.X86_64,
    timeout: Duration.seconds(lambdaConfig.timeoutSeconds),
    memorySize: lambdaConfig.memorySize,
    entry: path.join(props.projectRoot, props.entry),
    bundling: props.bundling,
    environment: props.environment,
    ephemeralStorageSize: props.ephemeralStorageSize,
  });
}

function createSqsEventSource(queue, consumerConfig) {
  return new lambdaEventSources.SqsEventSource(queue, {
    batchSize: consumerConfig.batchSize,
    maxBatchingWindow: Duration.seconds(
      consumerConfig.maxBatchingWindowSeconds,
    ),
    maxConcurrency: consumerConfig.maxConcurrency,
    reportBatchItemFailures: true,
  });
}

function createCommonBundling(projectRoot) {
  return {
    minify: true,
    sourceMap: false,
    target: 'node22',
    format: nodejs.OutputFormat.CJS,
    commandHooks: {
      beforeBundling() {
        return [];
      },
      beforeInstall() {
        return [];
      },
      afterBundling(_inputDir, outputDir) {
        return [
          `node "${path.join(projectRoot, 'scripts/write-commonjs-package.cjs')}" "${outputDir}"`,
        ];
      },
    },
  };
}

function createSharpBundling(projectRoot, commonBundling) {
  return {
    ...commonBundling,
    externalModules: ['sharp'],
    commandHooks: {
      beforeBundling() {
        return [];
      },
      beforeInstall() {
        return [];
      },
      afterBundling(_inputDir, outputDir) {
        return [
          `node "${path.join(projectRoot, 'scripts/write-commonjs-package.cjs')}" "${outputDir}"`,
          `node "${path.join(projectRoot, 'scripts/install-lambda-sharp.cjs')}" "${outputDir}"`,
        ];
      },
    },
  };
}
