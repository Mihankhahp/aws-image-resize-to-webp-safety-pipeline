// Serves the repo's test-ui/index.html and backs its API with the real Lambda
// handlers (via sim.mjs). Upload URLs from the real presign handler are routed
// through /__put, which verifies them like S3 and then runs the pipeline on a
// timer: upload-complete, GuardDuty (THREATS_FOUND when the key mentions
// "malware"), post-scan, the Pipe, and the WebP Lambda.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import * as sim from './sim.mjs';

const {
  state,
  handlers,
  s3Put,
  s3CreatedEvent,
  guardDutyScan,
  runPipe,
  deliverToWebp,
  invokeAsync,
} = sim;

function simulatePipeline(key) {
  const verdict = /malware|eicar/i.test(key)
    ? 'THREATS_FOUND'
    : 'NO_THREATS_FOUND';
  setTimeout(
    () =>
      invokeAsync(
        'upload-complete',
        handlers.uploadComplete,
        s3CreatedEvent(key),
      ),
    600,
  );
  setTimeout(async () => {
    const event = await guardDutyScan(key, verdict);
    await invokeAsync('post-scan', handlers.postScan, event);
    setTimeout(() => deliverToWebp(runPipe()), 1500);
  }, 2500);
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

// Set uiConfig.endpoint to serve config.json like the stack-hosted website does.
export const uiConfig = { endpoint: null };

export function startUiServer(port) {
  process.env.FAKE_S3_GET_BASE = `http://localhost:${port}/__s3`;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers });
      res.end(body);
    };
    try {
      if (
        req.method === 'GET' &&
        (url.pathname === '/' || url.pathname === '/index.html')
      )
        return send(200, readFileSync(`${sim.repo}/test-ui/index.html`), {
          'Content-Type': 'text/html; charset=utf-8',
        });
      if (req.method === 'GET' && url.pathname === '/config.json')
        return uiConfig.endpoint
          ? send(
              200,
              JSON.stringify({ uploadUrlEndpoint: uiConfig.endpoint }),
              { 'Content-Type': 'application/json' },
            )
          : send(404, 'NoSuchKey');
      if (req.method === 'POST' && url.pathname === '/v1/upload-url') {
        const requestBody = (await readBody(req)).toString();
        const out = await sim.as('presign', () =>
          handlers.presign({ body: requestBody }),
        );
        const body = JSON.parse(out.body);
        if (body.uploadUrl)
          body.uploadUrl = `http://localhost:${port}/__put?u=${encodeURIComponent(body.uploadUrl)}`;
        return send(out.statusCode, JSON.stringify(body), {
          'Content-Type': 'application/json',
        });
      }
      if (req.method === 'PUT' && url.pathname === '/__put') {
        const realUrl = url.searchParams.get('u');
        const result = s3Put(realUrl, req.headers, await readBody(req));
        if (result.status === 200)
          simulatePipeline(
            decodeURIComponent(new URL(realUrl).pathname.slice(1)),
          );
        return send(result.status, result.code || '');
      }
      const image = url.pathname.match(/^\/v1\/images\/([^/]+)$/);
      if (req.method === 'GET' && image) {
        const out = await sim.as('status', () =>
          handlers.status({
            pathParameters: { imageId: decodeURIComponent(image[1]) },
          }),
        );
        return send(out.statusCode, out.body, {
          'Content-Type': 'application/json',
        });
      }
      const object = url.pathname.match(/^\/__s3\/([^/]+)\/(.+)$/);
      if (req.method === 'GET' && object) {
        const stored = state.s3.get(
          `${object[1]}/${decodeURIComponent(object[2])}`,
        );
        if (!stored) return send(404, 'NoSuchKey');
        return send(200, stored.body, {
          'Content-Type':
            url.searchParams.get('response-content-type') || stored.contentType,
        });
      }
      send(404, 'not found');
    } catch (error) {
      // Details go to the test log, not to the browser.
      console.error(error);
      send(500, 'Internal error');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1]?.endsWith('ui-server.mjs')) {
  const port = Number(process.env.PORT || 5180);
  await startUiServer(port);
  console.log(
    `UI test server on http://localhost:${port}/?endpoint=http://localhost:${port}/v1/upload-url`,
  );
}
