import path from 'node:path';

import { RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

// Hosts test-ui/index.html as a public S3 static website. The bucket holds only
// the page and a config.json naming this stack's API, so it is always created
// and destroyed with the stack, even with -c prod=true.
export function createTestUiResources(scope, config, resources) {
  const { api, projectRoot } = resources;

  const testUiBucket = new s3.Bucket(scope, 'TestUiBucket', {
    websiteIndexDocument: 'index.html',
    publicReadAccess: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS_ONLY,
    // No enforceSSL: S3 website endpoints only serve HTTP, so it would deny
    // every page request.
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });

  new s3deploy.BucketDeployment(scope, 'TestUiDeployment', {
    destinationBucket: testUiBucket,
    sources: [
      s3deploy.Source.asset(path.join(projectRoot, 'test-ui'), {
        exclude: ['README.md'],
      }),
      // Lets the page connect to this stack's API without any setup.
      s3deploy.Source.jsonData('config.json', {
        uploadUrlEndpoint: `${api.url}upload-url`,
      }),
    ],
    // Always serve the latest page after a redeploy.
    cacheControl: [s3deploy.CacheControl.noCache()],
  });

  return { testUiBucket };
}
