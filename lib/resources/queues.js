import { Duration } from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export function createQueueResources(scope, config) {
  const variantCandidateDlq = createDlq(scope, 'VariantCandidateDlq', config);
  const variantCandidateQueue = new sqs.Queue(scope, 'VariantCandidateQueue', {
    visibilityTimeout: Duration.seconds(60),
    retentionPeriod: Duration.days(config.queues.workQueueRetentionDays),
    deadLetterQueue: {
      queue: variantCandidateDlq,
      maxReceiveCount: config.queues.maxReceiveCount,
    },
    removalPolicy: config.removalPolicy,
  });

  const variantDlq = createDlq(scope, 'VariantDlq', config);
  const variantQueue = new sqs.Queue(scope, 'VariantQueue', {
    visibilityTimeout: Duration.seconds(
      config.lambdas.createWebp.timeoutSeconds * 6,
    ),
    retentionPeriod: Duration.days(config.queues.workQueueRetentionDays),
    deadLetterQueue: {
      queue: variantDlq,
      maxReceiveCount: config.queues.maxReceiveCount,
    },
    removalPolicy: config.removalPolicy,
  });

  const lifecycleExpirationDlq = createDlq(
    scope,
    'LifecycleExpirationDlq',
    config,
  );
  const lifecycleExpirationQueue = new sqs.Queue(
    scope,
    'LifecycleExpirationQueue',
    {
      visibilityTimeout: Duration.seconds(
        config.lambdas.lifecycleExpirationStatus.timeoutSeconds * 6,
      ),
      retentionPeriod: Duration.days(config.queues.workQueueRetentionDays),
      deadLetterQueue: {
        queue: lifecycleExpirationDlq,
        maxReceiveCount: config.queues.maxReceiveCount,
      },
      removalPolicy: config.removalPolicy,
    },
  );

  return {
    variantCandidateDlq,
    variantCandidateQueue,
    variantDlq,
    variantQueue,
    lifecycleExpirationDlq,
    lifecycleExpirationQueue,
  };
}

function createDlq(scope, id, config) {
  return new sqs.Queue(scope, id, {
    retentionPeriod: Duration.days(config.queues.dlqRetentionDays),
    removalPolicy: config.removalPolicy,
  });
}
