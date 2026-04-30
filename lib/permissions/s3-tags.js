import * as iam from 'aws-cdk-lib/aws-iam';

export function grantObjectTagReadWrite(functionOrRole, bucket, keyPattern) {
  functionOrRole.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        's3:GetObjectTagging',
        's3:PutObjectTagging',
        's3:GetObjectVersionTagging',
        's3:PutObjectVersionTagging',
      ],
      resources: [bucket.arnForObjects(keyPattern)],
    }),
  );
}
