import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipes from 'aws-cdk-lib/aws-pipes';

export function wireEventResources(scope, config, resources, functions) {
  const {
    originalBucket,
    processedBucket,
    variantCandidateQueue,
    variantQueue,
    lifecycleExpirationQueue,
  } = resources;

  new events.Rule(scope, 'S3ObjectUploadedRule', {
    description: 'Updates DynamoDB when an upload is written to S3.',
    eventPattern: {
      source: ['aws.s3'],
      detailType: ['Object Created'],
      detail: {
        bucket: { name: [originalBucket.bucketName] },
        object: { key: [{ prefix: config.prefixes.upload }] },
      },
    },
  }).addTarget(
    new targets.LambdaFunction(functions.uploadCompleteFn, {
      retryAttempts: 2,
    }),
  );

  new events.Rule(scope, 'GuardDutyScanResultRule', {
    description: 'Processes GuardDuty Malware Protection scan results.',
    eventPattern: {
      source: ['aws.guardduty'],
      detailType: ['GuardDuty Malware Protection Object Scan Result'],
      detail: {
        resourceType: ['S3_OBJECT'],
        s3ObjectDetails: { bucketName: [originalBucket.bucketName] },
      },
    },
  }).addTarget(
    new targets.LambdaFunction(functions.postScanFn, { retryAttempts: 2 }),
  );

  addLifecycleExpirationRule(scope, 'OriginalObjectLifecycleExpiredRule', {
    description: 'Queues lifecycle expiration events for uploaded originals.',
    bucketName: originalBucket.bucketName,
    prefix: config.prefixes.upload,
    queue: lifecycleExpirationQueue,
  });

  addLifecycleExpirationRule(scope, 'ProcessedObjectLifecycleExpiredRule', {
    description: 'Queues lifecycle expiration events for processed artifacts.',
    bucketName: processedBucket.bucketName,
    prefix: config.prefixes.processed,
    queue: lifecycleExpirationQueue,
  });

  const pipeRole = new iam.Role(scope, 'VariantFilterPipeRole', {
    assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
  });
  variantCandidateQueue.grantConsumeMessages(pipeRole);
  variantQueue.grantSendMessages(pipeRole);

  new pipes.CfnPipe(scope, 'VariantRequiredPipe', {
    name: `${scope.stackName}-variant-required-pipe`,
    description: 'Forwards clean images that require WebP conversion.',
    roleArn: pipeRole.roleArn,
    source: variantCandidateQueue.queueArn,
    target: variantQueue.queueArn,
    desiredState: 'RUNNING',
    sourceParameters: {
      sqsQueueParameters: {
        batchSize: 10,
        maximumBatchingWindowInSeconds: 30,
      },
      filterCriteria: {
        filters: [
          {
            pattern: JSON.stringify({
              body: {
                securityStatus: ['CLEAN'],
                scanResult: ['NO_THREATS_FOUND'],
                variantRequired: [true],
              },
            }),
          },
        ],
      },
    },
    targetParameters: {
      inputTemplate:
        '{"bucket":<$.body.bucket>,"key":<$.body.key>,"versionId":<$.body.versionId>,"imageId":<$.body.imageId>,"sizeBytes":<$.body.sizeBytes>,"contentType":<$.body.contentType>}',
    },
  });
}

function addLifecycleExpirationRule(
  scope,
  id,
  { description, bucketName, prefix, queue },
) {
  new events.Rule(scope, id, {
    description,
    eventPattern: {
      source: ['aws.s3'],
      detailType: ['Object Deleted'],
      detail: {
        reason: ['Lifecycle Expiration'],
        bucket: { name: [bucketName] },
        object: { key: [{ prefix }] },
      },
    },
  }).addTarget(new targets.SqsQueue(queue));
}
