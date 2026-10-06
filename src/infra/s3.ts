import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateBucketCommand, CreateMultipartUploadCommand, DeleteObjectCommand,
  GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { env } from '../config/env';

/** S3 (MinIO locally, AWS in prod): multipart uploads from the browser, and file transfer for the media workers. */
@Injectable()
export class S3Service {
  readonly bucket = env.S3_BUCKET;
  private readonly client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT }),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ACCESS_KEY && { credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } }),
  });

  /** Dev/test convenience; production buckets are created by infrastructure. */
  async ensureBucket() {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); }
    catch { await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })); }
  }

  async createMultipart(key: string, contentType: string) {
    const r = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    return r.UploadId!;
  }

  presignPart(key: string, uploadId: string, partNumber: number, ttlSec = 3600) {
    return getSignedUrl(this.client, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: ttlSec });
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }));
  }

  async abortMultipart(key: string, uploadId: string) {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => null);
  }

  async size(key: string): Promise<number | null> {
    try { return (await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))).ContentLength ?? 0; } catch { return null; }
  }

  async download(key: string, path: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    await pipeline(r.Body as Readable, createWriteStream(path));
  }

  async getBuffer(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  /** Immutable, versioned keys: cache for a year. */
  async uploadFile(key: string, path: string, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(path), ContentLength: (await stat(path)).size, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
  }

  async putBuffer(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
  }

  async remove(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => null); }

  /** A link that works for `ttlSec` (user data exports). */
  presignGet(key: string, ttlSec = 86_400) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSec });
  }

  /** Every key under a prefix (a user's exports). */
  async listKeys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      out.push(...(r.Contents ?? []).map((o) => o.Key!));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  destroy() { this.client.destroy(); }
}
