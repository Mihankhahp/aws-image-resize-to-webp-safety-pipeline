# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run check        # node --check on every .js/.cjs/.mjs under bin/, lib/, lambda/, scripts/, test/, docs/
npm run format:check # Prettier (single quotes); `npm run format` fixes. Markdown is not formatted.
npx cdk synth        # also bundles every Lambda with esbuild and installs Linux sharp
npm test             # pipeline suite; needs a synthesized cdk.out/ and Node 22.15+
npm run test:ui      # browser suite for test-ui/ (Edge on Windows, else `npx playwright install chromium`)
npm run diagram      # regenerates docs/architecture.png from docs/diagram/build.mjs
npx cdk deploy       # region must support GuardDuty Malware Protection for S3 (no detector needed)
npx cdk destroy
npx cdk deploy -c objectRetentionDays=2 -c webpMaxConcurrency=2   # override context values
```

CI (`.github/workflows/ci.yml`) runs check, format:check, synth and `npm test` on every pull request. If synth fails around sharp, delete `cdk.out/` and rerun `npm install && npx cdk synth`.

The tests run the real Lambda handlers against in-memory fakes (`test/fakes/`, wired up in `test/sim.mjs` with `module.registerHooks`). The presign handler uses the real S3 SDK offline, and `s3Put` verifies its URLs with SigV4 the way S3 does. `test/sim.mjs` reads Lambda environment values and the Pipe filter from the synthesized template, so re-run synth after infra changes. Each scenario in `test/pipeline.test.mjs` is one `scenario()` with `check()` assertions; `LAMBDA_ROOT=<old checkout> npm test` runs the suite against older handler code.

Manual end-to-end testing uses the curl flow in README.md or the page in `test-ui/`, which the stack hosts as a public S3 website (`TestUiUrl` output, `lib/resources/test-ui.js`; skip with `-c deployTestUi=false`). Locally, run `python -m http.server 5173` inside `test-ui/`. The page takes its endpoint from `?endpoint=`, then a deployed `config.json`, then localStorage. The S3 website is HTTP-only, so the page must not depend on secure-context APIs (the copy button has a non-Clipboard-API fallback).

Requires Node.js 22+. Default region is `us-east-2` when `CDK_DEFAULT_REGION`/`AWS_DEFAULT_REGION` are unset (`bin/app.js`).

## Architecture

Single CDK stack (`ImagePipelineStack`), plain JavaScript ESM (no TypeScript). `lib/image-pipeline-stack.js` only composes; each `lib/resources/*.js` module exports a `create*`/`wire*` function taking `(scope, config, resources)` and returning the constructs it made, which are spread into later calls. Add new resources the same way rather than inlining into the stack class.

### Configuration

All tunables are CDK context values: defaults in `cdk.json`, read and range-validated in `lib/pipeline-config.js` via `numberContext` (integers only, throws on out-of-range). Lambda timeouts/memory use the key pattern `<name>TimeoutSeconds`/`<name>MemorySize`; SQS consumers use `<name>BatchSize`/`<name>MaxBatchingWindowSeconds`/`<name>MaxConcurrency`. Values passed to Lambda env vars are pre-stringified in the config object. `-c prod=true` (or `"prod": true` in `cdk.json`) switches removal policy from DESTROY to RETAIN and turns off bucket `autoDeleteObjects`. The upload content-type allowlist is `ALLOWED_CONTENT_TYPES` in `pipeline-config.js` (passed to presign and post-scan); the WebP Lambda separately maps *decoded* sharp formats to content types.

### Event flow (async pipeline)

1. `presign` (API `POST /upload-url`) → DynamoDB `PRESIGNED`, returns PUT URL for `uploads/{imageId}/{filename}`.
2. S3 `Object Created` → EventBridge rule → `upload-complete` → records upload metadata, DynamoDB `UPLOADED` (only from `PRESIGNED`). Writes no tags.
3. GuardDuty Malware Protection scan result → EventBridge rule → `post-scan` → DynamoDB `SCANNED`/`NO_VARIANT_REQUIRED`/`BLOCKED`/`SCAN_FAILED`/`SCAN_SKIPPED`/`SCAN_UNKNOWN`, then tags the object, then sends **every** outcome to `VariantCandidateQueue`.
4. EventBridge Pipe (`lib/resources/events.js`) filters on `securityStatus=CLEAN`, `scanResult=NO_THREATS_FOUND`, `variantRequired=true` and reshapes the message via `inputTemplate` → `VariantQueue`. Changing the post-scan message shape requires updating the pipe filter and template.
5. `create-webp-variants` (SQS consumer) re-checks the original's S3 tags, decodes the image with sharp before writing anything, writes a safe original (stored with the *decoded* format's content type) + WebP under `processed/`, DynamoDB `WEBP_CREATED`. Decode failures → `WEBP_FAILED` without retry; failed tag check → `WEBP_SKIPPED`; last failed SQS attempt (`ApproximateReceiveCount >= MAX_RECEIVE_COUNT`) → `WEBP_FAILED` before the message goes to the DLQ.
6. `status` (API `GET /images/{imageId}`) returns presigned GET URLs only for artifacts not marked deleted.
7. S3 Lifecycle expiration `Object Deleted` events (both buckets) → `LifecycleExpirationQueue` → `lifecycle-expiration-status` → `EXPIRED`/`ARTIFACTS_EXPIRED`/`BLOCKED_EXPIRED`/`SCAN_RESULT_EXPIRED`/`PARTIALLY_EXPIRED`. There is no cleanup Lambda; deletion relies on native lifecycle rules.

The README's Mermaid diagrams ("Mermaid architecture map", three flowcharts) and `docs/architecture.mmd` are the source of truth for this flow; update them with any flow change. Quote edge labels and use `<br>` for line breaks (`{...}` in an unquoted label breaks parsing). The README's top image (`docs/architecture.png`) is generated by `npm run diagram` from coordinates in `docs/diagram/build.mjs`; when the flow changes, update it too and check the rendered PNG for crossed labels.

`imageId` is derived from the second path segment of the S3 key in several Lambdas, so the `uploads/{imageId}/...` and `processed/{imageId}/...` key layout is load-bearing.

SQS-consuming Lambdas return `{ batchItemFailures }` (`reportBatchItemFailures: true`); every queue has a DLQ (`lib/resources/queues.js`). The EventBridge-invoked Lambdas (`upload-complete`, `post-scan`) send events that fail delivery or exhaust async retries to `AsyncEventDlq`.

### Upload URL contract

`presign` returns a single-use URL: it signs `Content-Type` (`signableHeaders`) and `If-None-Match: *` (S3 conditional write, 412 on reuse), and returns both in `requiredHeaders`, which clients must send verbatim (the test UI and the README curl do). A bucket policy in `storage.js` denies `s3:PutObject` to `uploads/` without `If-None-Match`, so dropping `IfNoneMatch` from presign breaks uploads rather than silently allowing overwrites. The presign Lambda bundles the lockfile's SDK (`bundleAwsSDK: true`) and sets `requestChecksumCalculation: 'WHEN_REQUIRED'`; without it, recent SDKs sign a CRC32 of the empty body into the URL and every upload fails with `BadDigest`.

### Status transitions

Events arrive at least once and out of order (upload-complete and post-scan run at the same time), so every `status` write is a DynamoDB conditional update that only moves forward: upload-complete only from `PRESIGNED`; post-scan only from `PRESIGNED`/`UPLOADED` or its own status (so retries re-apply, while duplicates after conversion are dropped without re-queueing); WebP only from `SCANNED` (and `WEBP_CREATED` for duplicate messages). A failed condition (`ConditionalCheckFailedException`) means "already moved on", not an error. Lifecycle updates use `ReturnValues: 'ALL_NEW'` so the last of several concurrent expiry events sees every deletion, and never downgrade `retentionStatus` from `EXPIRED`. Keep these conditions when adding statuses, and update the final-status lists in README.md and `test-ui/index.html`.

### Object tags

S3 tag writes replace the whole tag set and have no conditional form, so concurrent read-modify-write updates lose tags. Only GuardDuty, post-scan, and create-webp-variants tag the original, and they run in sequence; upload-complete must not write tags (it races post-scan). The WebP Lambda gates on post-scan's `scan-result`/`variant-required` tags, which also protects against an object overwritten after scanning (a re-PUT drops all tags). S3 allows at most 10 tags per object: `mergeTags` (in `post-scan` and `create-webp-variants`) keeps a `preferred` key ordering capped at 10; keep those lists in sync when adding tags. Tag IAM permissions come from `lib/permissions/s3-tags.js`.

### Lambda bundling quirks

- Handlers are written as ESM but bundled by `NodejsFunction`/esbuild to **CommonJS**. Because the root `package.json` has `"type": "module"`, the `afterBundling` hook runs `scripts/write-commonjs-package.cjs` to drop a `{"type":"commonjs"}` package.json into each asset; without it Lambda crashes on `module.exports`.
- `sharp` is external for the WebP function; `scripts/install-lambda-sharp.cjs` installs `sharp@0.35.5` for linux/x64/glibc into the asset at synth time (has a Windows `cmd.exe` code path). Keep the version in sync with `lambda/create-webp-variants/package.json`. Functions are x86_64 to match. The install runs with `--package-lock=false`, so sharp's transitive deps float and `cdk diff` can report the WebP function's code as changed even when no source changed.
- Four handlers use the AWS SDK v3 shipped in the Lambda Node.js 22 runtime (CDK's default `@aws-sdk/*` external), whose version varies by runtime and region. Presign bundles the lockfile's SDK on purpose (`bundleAwsSDK: true`, see "Upload URL contract"), and the WebP function's `externalModules: ['sharp']` replaces the default external, so its bundle includes the SDK too.

### Deliberate constraints

- Do **not** add Lambda reserved concurrency: new accounts often have a regional quota of 10 and deploys fail.
- SQS event-source `maxConcurrency` minimum is 2 (enforced in config).
- Defaults are intentionally low-throughput/teaching-oriented (API throttle 10 rps / burst 20, WebP batch 1, concurrency 2, 1-day retention).
