// Fake @aws-sdk/client-s3 backed by state.s3. Enforces S3's 10-tag limit.
import { state, simulate, awsError, clone } from './state.mjs';

class Command {
  constructor(input) {
    this.input = input;
  }
}
export class PutObjectCommand extends Command {}
export class GetObjectCommand extends Command {}
export class HeadObjectCommand extends Command {}
export class GetObjectTaggingCommand extends Command {}
export class PutObjectTaggingCommand extends Command {}

function get(Bucket, Key) {
  const obj = state.s3.get(`${Bucket}/${Key}`);
  if (!obj) throw awsError('NoSuchKey', `NoSuchKey ${Bucket}/${Key}`);
  return obj;
}
function checkTags(tags) {
  if (tags.length > 10)
    throw awsError('BadRequest', 'Object tags cannot be greater than 10');
}

export class S3Client {
  constructor() {}
  async send(cmd) {
    const i = cmd.input;
    switch (cmd.constructor.name) {
      case 'PutObjectCommand':
        return simulate('S3.PutObject', i.Key, () => {
          const tags = i.Tagging
            ? [...new URLSearchParams(i.Tagging)].map(([Key, Value]) => ({
                Key,
                Value,
              }))
            : [];
          checkTags(tags);
          state.s3.set(`${i.Bucket}/${i.Key}`, {
            body: Buffer.from(i.Body),
            contentType: i.ContentType,
            metadata: clone(i.Metadata) || {},
            tags,
          });
          return {};
        });
      case 'HeadObjectCommand':
        return simulate('S3.HeadObject', i.Key, () => {
          const o = get(i.Bucket, i.Key);
          return {
            ContentLength: o.body.length,
            ContentType: o.contentType,
            Metadata: clone(o.metadata),
          };
        });
      case 'GetObjectCommand':
        return simulate('S3.GetObject', i.Key, () => {
          const o = get(i.Bucket, i.Key);
          const bytes = new Uint8Array(o.body);
          return {
            ContentType: o.contentType,
            ContentLength: o.body.length,
            Body: { transformToByteArray: async () => bytes },
          };
        });
      case 'GetObjectTaggingCommand':
        return simulate('S3.GetObjectTagging', i.Key, () => ({
          TagSet: clone(get(i.Bucket, i.Key).tags),
        }));
      case 'PutObjectTaggingCommand':
        return simulate('S3.PutObjectTagging', i.Key, () => {
          const o = get(i.Bucket, i.Key);
          checkTags(i.Tagging.TagSet);
          o.tags = clone(i.Tagging.TagSet); // full replacement, like real S3
          return {};
        });
      default:
        throw new Error(`fake S3: unsupported ${cmd.constructor.name}`);
    }
  }
}
