import * as cdk from 'aws-cdk-lib';

// Raster formats the WebP Lambda can decode. SVG is excluded because it can carry
// script, and HEIC because the prebuilt sharp binaries cannot decode HEVC.
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
];

export function readPipelineConfig(scope) {
  // -c prod=true arrives as a string; "prod": true in cdk.json as a boolean.
  const prodContext = scope.node.tryGetContext('prod');
  const isProd = prodContext === true || prodContext === 'true';
  const testUiContext = scope.node.tryGetContext('deployTestUi');
  const objectRetentionDays = numberContext(scope, 'objectRetentionDays', 1, {
    min: 1,
    max: 7,
  });

  return {
    isProd,
    removalPolicy: isProd
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY,

    prefixes: {
      upload: 'uploads/',
      processed: 'processed/',
    },

    // Public S3 website for test-ui/; -c deployTestUi=false leaves it out.
    testUi: {
      enabled: testUiContext !== false && testUiContext !== 'false',
    },

    retention: {
      objectRetentionDays,
      objectRetentionSeconds: objectRetentionDays * 24 * 60 * 60,
    },

    imageProcessing: {
      resizeThresholdBytes: String(
        numberContext(scope, 'resizeThresholdBytes', 0, {
          min: 0,
          max: 104_857_600,
        }),
      ),
      webMaxWidth: String(
        numberContext(scope, 'webMaxWidth', 1280, { min: 64, max: 4096 }),
      ),
      webpQuality: String(
        numberContext(scope, 'webpQuality', 72, { min: 1, max: 100 }),
      ),
      allowedContentTypes: ALLOWED_CONTENT_TYPES.join(','),
    },

    api: {
      throttlingRateLimit: numberContext(scope, 'apiThrottleRateLimit', 10, {
        min: 1,
        max: 50,
      }),
      throttlingBurstLimit: numberContext(scope, 'apiThrottleBurstLimit', 20, {
        min: 1,
        max: 100,
      }),
    },

    lambdas: {
      presign: lambdaLimits(scope, 'presign', {
        timeoutSeconds: 10,
        maxTimeoutSeconds: 30,
        memorySize: 128,
      }),
      uploadComplete: lambdaLimits(scope, 'uploadComplete', {
        timeoutSeconds: 15,
        maxTimeoutSeconds: 30,
        memorySize: 128,
      }),
      postScan: lambdaLimits(scope, 'postScan', {
        timeoutSeconds: 30,
        maxTimeoutSeconds: 45,
        memorySize: 128,
      }),
      createWebp: lambdaLimits(scope, 'createWebp', {
        timeoutSeconds: 60,
        maxTimeoutSeconds: 120,
        memorySize: 512,
      }),
      status: lambdaLimits(scope, 'status', {
        timeoutSeconds: 10,
        maxTimeoutSeconds: 30,
        memorySize: 128,
      }),
      lifecycleExpirationStatus: lambdaLimits(
        scope,
        'lifecycleExpirationStatus',
        { timeoutSeconds: 15, maxTimeoutSeconds: 30, memorySize: 128 },
      ),
    },

    queues: {
      workQueueRetentionDays: numberContext(
        scope,
        'workQueueRetentionDays',
        1,
        { min: 1, max: 4 },
      ),
      dlqRetentionDays: numberContext(scope, 'dlqRetentionDays', 4, {
        min: 1,
        max: 14,
      }),
      maxReceiveCount: numberContext(scope, 'queueMaxReceiveCount', 3, {
        min: 1,
        max: 5,
      }),
    },

    consumers: {
      webp: sqsConsumer(scope, 'webp', {
        batchSize: 1,
        maxBatchingWindowSeconds: 5,
        maxConcurrency: 2,
      }),
      lifecycleExpirationStatus: sqsConsumer(
        scope,
        'lifecycleExpirationStatus',
        { batchSize: 5, maxBatchingWindowSeconds: 10, maxConcurrency: 2 },
      ),
    },

    urls: {
      uploadUrlExpiresSeconds: String(
        numberContext(scope, 'uploadUrlExpiresSeconds', 900, {
          min: 60,
          max: 3600,
        }),
      ),
      downloadUrlExpiresSeconds: String(
        numberContext(scope, 'downloadUrlExpiresSeconds', 900, {
          min: 60,
          max: 3600,
        }),
      ),
    },
  };
}

function lambdaLimits(scope, name, defaults) {
  return {
    timeoutSeconds: numberContext(
      scope,
      `${name}TimeoutSeconds`,
      defaults.timeoutSeconds,
      {
        min: 1,
        max: defaults.maxTimeoutSeconds,
      },
    ),
    memorySize: numberContext(scope, `${name}MemorySize`, defaults.memorySize, {
      min: 128,
      max: Math.max(defaults.memorySize, 1024),
    }),
  };
}

function sqsConsumer(scope, name, defaults) {
  return {
    batchSize: numberContext(scope, `${name}BatchSize`, defaults.batchSize, {
      min: 1,
      max: 10,
    }),
    maxBatchingWindowSeconds: numberContext(
      scope,
      `${name}MaxBatchingWindowSeconds`,
      defaults.maxBatchingWindowSeconds,
      { min: 0, max: 30 },
    ),
    maxConcurrency: numberContext(
      scope,
      `${name}MaxConcurrency`,
      defaults.maxConcurrency,
      { min: 2, max: 10 },
    ),
  };
}

function numberContext(scope, key, defaultValue, { min, max }) {
  const raw = scope.node.tryGetContext(key);
  const value = raw === undefined ? defaultValue : Number(raw);

  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(
      `Context value ${key} must be an integer. Received: ${raw}`,
    );
  }

  if (value < min || value > max) {
    throw new Error(
      `Context value ${key} must be between ${min} and ${max}. Received: ${value}`,
    );
  }

  return value;
}
