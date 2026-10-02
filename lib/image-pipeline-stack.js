import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Stack } from 'aws-cdk-lib';

import { readPipelineConfig } from './pipeline-config.js';
import { createApiResources } from './resources/api.js';
import { createDatabaseResources } from './resources/database.js';
import { wireEventResources } from './resources/events.js';
import { createLambdaResources } from './resources/functions.js';
import { createMalwareProtectionResources } from './resources/malware-protection.js';
import { createStackOutputs } from './resources/outputs.js';
import { createQueueResources } from './resources/queues.js';
import { createStorageResources } from './resources/storage.js';
import { createTestUiResources } from './resources/test-ui.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

export class ImagePipelineStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const config = readPipelineConfig(this);
    const storage = createStorageResources(this, config);
    const database = createDatabaseResources(this, config);
    const queues = createQueueResources(this, config);

    const functions = createLambdaResources(this, config, {
      ...storage,
      ...database,
      ...queues,
      projectRoot,
    });

    const apiResources = createApiResources(this, config, functions);
    wireEventResources(this, config, { ...storage, ...queues }, functions);
    createMalwareProtectionResources(this, config, storage);
    const testUi = config.testUi.enabled
      ? createTestUiResources(this, config, { ...apiResources, projectRoot })
      : {};
    createStackOutputs(this, {
      ...storage,
      ...database,
      ...apiResources,
      ...testUi,
    });
  }
}
