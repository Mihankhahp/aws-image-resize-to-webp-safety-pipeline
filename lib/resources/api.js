import * as apigateway from 'aws-cdk-lib/aws-apigateway';

export function createApiResources(scope, config, functions) {
  const api = new apigateway.RestApi(scope, 'ImageUploadApi', {
    restApiName: 'image-upload-api',
    deployOptions: {
      stageName: 'v1',
      throttlingRateLimit: config.api.throttlingRateLimit,
      throttlingBurstLimit: config.api.throttlingBurstLimit,
    },
    defaultCorsPreflightOptions: {
      allowOrigins: apigateway.Cors.ALL_ORIGINS,
      allowMethods: ['OPTIONS', 'GET', 'POST'],
      allowHeaders: ['Content-Type', 'Authorization'],
    },
  });

  const corsGatewayResponseHeaders = {
    'Access-Control-Allow-Origin': "'*'",
    'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
    'Access-Control-Allow-Methods': "'OPTIONS,GET,POST'",
  };

  api.addGatewayResponse('Default4xxCorsResponse', {
    type: apigateway.ResponseType.DEFAULT_4XX,
    responseHeaders: corsGatewayResponseHeaders,
  });

  api.addGatewayResponse('Default5xxCorsResponse', {
    type: apigateway.ResponseType.DEFAULT_5XX,
    responseHeaders: corsGatewayResponseHeaders,
  });

  api.root
    .addResource('upload-url')
    .addMethod('POST', new apigateway.LambdaIntegration(functions.presignFn));

  api.root
    .addResource('images')
    .addResource('{imageId}')
    .addMethod('GET', new apigateway.LambdaIntegration(functions.statusFn));

  return { api };
}
