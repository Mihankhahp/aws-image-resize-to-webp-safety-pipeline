import * as cdk from 'aws-cdk-lib';

export function createStackOutputs(scope, resources) {
  const { api, originalBucket, processedBucket, imagesTable } = resources;

  new cdk.CfnOutput(scope, 'UploadUrlEndpoint', {
    value: `${api.url}upload-url`,
  });
  new cdk.CfnOutput(scope, 'StatusEndpointExample', {
    value: `${api.url}images/{imageId}`,
  });
  new cdk.CfnOutput(scope, 'OriginalBucketName', {
    value: originalBucket.bucketName,
  });
  new cdk.CfnOutput(scope, 'ProcessedBucketName', {
    value: processedBucket.bucketName,
  });
  new cdk.CfnOutput(scope, 'ImagesTableName', { value: imagesTable.tableName });
}
