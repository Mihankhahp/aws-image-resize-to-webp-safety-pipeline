# Test UI

## Hosted by the stack

`npx cdk deploy` publishes this page as a public S3 static website and prints its address as the `TestUiUrl` output. It deploys a `config.json` next to the page that names the stack's API, so the page is connected as soon as it opens. The website is deleted with the stack, and `-c deployTestUi=false` leaves it out.

## Running it locally

```powershell
cd test-ui
python -m http.server 5173
```

Open:

```text
http://localhost:5173
```

On first visit, paste your `ImagePipelineStack.UploadUrlEndpoint` stack output (or the API base URL) and choose **Save**. The page remembers it in this browser. You can also pass it in the URL:

```text
http://localhost:5173/?endpoint=https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/v1/upload-url
```

The endpoint comes from `?endpoint=` first, then `config.json`, then the one remembered in the browser.

## Using it

Drop, browse for, or paste a JPEG, PNG, WebP, GIF, AVIF, or TIFF image and choose **Upload and process**. The page:

1. Requests a single-use upload URL and uploads the file to S3, sending the signed `Content-Type` and `If-None-Match: *` headers from the presign response.
2. Tracks the malware scan and the WebP conversion until a final status (see "Processing statuses" in the main README).
3. Shows the original and the WebP side by side, with download links that expire after `downloadUrlExpiresSeconds`.

**Technical details** shows the image ID, an activity log, and the latest raw status response.
