// Fake presigner for GET URLs (status Lambda). FAKE_S3_GET_BASE lets the UI
// test server serve the objects back to the browser.
export async function getSignedUrl(_client, cmd, { expiresIn } = {}) {
  const { Bucket, Key, ResponseContentType } = cmd.input;
  const base = process.env.FAKE_S3_GET_BASE || 'https://fake-s3.local';
  const query = new URLSearchParams({ 'X-Amz-Expires': String(expiresIn) });
  if (ResponseContentType)
    query.set('response-content-type', ResponseContentType);
  return `${base}/${Bucket}/${Key.split('/').map(encodeURIComponent).join('/')}?${query}`;
}
