#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import { ImagePipelineStack } from '../lib/image-pipeline-stack.js';

const app = new cdk.App();

new ImagePipelineStack(app, 'ImagePipelineStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:
      process.env.CDK_DEFAULT_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      'us-east-2',
  },
});
