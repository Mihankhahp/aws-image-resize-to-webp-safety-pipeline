import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export function createDatabaseResources(scope, config) {
  const imagesTable = new dynamodb.Table(scope, 'ImagesTable', {
    partitionKey: { name: 'imageId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: config.isProd
      ? { pointInTimeRecoveryEnabled: true }
      : undefined,
    removalPolicy: config.removalPolicy,
  });

  return { imagesTable };
}
