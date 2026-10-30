import { t } from './i18n';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { NodeHttpHandler, streamCollector } from '@smithy/node-http-handler';
import { readableStreamHasher } from '@smithy/core/checksum';
import { digest } from './images';
import { identifyAsset } from './assets';
import { referenceFromKey } from './references';
import { ByteSource, CheckedAsset, bufferSource } from './storage';
import { LocalResetError } from './reset';

export interface RemoteImage {
  bytes: Uint8Array;
  sha256: string;
}
export interface RemoteSource {
  body: ByteSource;
  sha256: string;
  size?: number;
}
export interface CloudBackup {
  readonly target: string;
  get(key: string): Promise<RemoteImage | null>;
  putIfAbsent(key: string, bytes: Uint8Array): Promise<void>;
  getSource?(key: string): Promise<RemoteSource | null>;
  putSourceIfAbsent?(key: string, asset: CheckedAsset, source: ByteSource): Promise<void>;
}
export class BackupConflict extends Error {}
export class CloudConfigurationError extends Error {}
export class CloudAttachmentMissing extends Error {}
export class CloudConnectionError extends Error {}
export function validateR2SecretReferences(accessKeySecret: string, secretKeySecret: string): void {
  if (accessKeySecret && accessKeySecret === secretKeySecret)
    throw new CloudConfigurationError(
      t(
        'Access Key ID 和 Secret Access Key 指向同一个凭据条目。请在设置中重新填写两项并点击“保存凭据”，然后重新加载插件。',
      ),
    );
}
export function validateR2Endpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CloudConfigurationError(t('OSS Endpoint 必须是有效的 HTTPS S3 API 地址。'));
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new CloudConfigurationError(
      t('OSS Endpoint 必须是 HTTPS 地址，不能包含凭据、路径或查询参数。'),
    );
  return url;
}
export function validateR2Bucket(bucket: string): void {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new CloudConfigurationError(t('OSS Bucket 名称无效，请填写 Bucket 名称而非 URL。'));
}
// Exact allowlists: even syntactically valid arbitrary names/codes may contain secrets.
const CLOUD_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'RangeError',
  'AggregateError',
  'CredentialsProviderError',
  'TokenProviderError',
  'S3ServiceException',
  'ServiceException',
  'NoSuchBucket',
  'NoSuchKey',
  'NotFound',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AccessDenied',
  'InvalidArgument',
  'InvalidRequest',
  'PermanentRedirect',
  'IncorrectEndpoint',
  'AuthorizationHeaderMalformed',
  'RequestTimeTooSkewed',
  'RequestExpired',
  'ExpiredToken',
  'InvalidToken',
  'TimeoutError',
  'AbortError',
  'NetworkingError',
  'UnknownEndpoint',
]);
const CLOUD_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EACCES',
  'EPERM',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_CHAR',
  'ERR_INVALID_PROTOCOL',
  'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_MISSING_ARGS',
  'ERR_NOT_IMPLEMENTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
function cloudErrorFacts(error: unknown): {
  name: string;
  code: string;
  status?: number;
  html: boolean;
} {
  let name = 'UNKNOWN',
    code = 'NONE',
    status: number | undefined,
    html = false;
  const visited = new Set<object>(),
    pending = [error];
  for (let index = 0; index < pending.length && index < 8; index++) {
    const value = pending[index];
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    const item = value as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
      $metadata?: { httpStatusCode?: unknown };
      $response?: { statusCode?: unknown; headers?: Record<string, unknown> };
    };
    if (
      typeof item.name === 'string' &&
      CLOUD_ERROR_NAMES.has(item.name) &&
      (name === 'UNKNOWN' || name === 'Error')
    )
      name = item.name;
    if (typeof item.code === 'string' && CLOUD_ERROR_CODES.has(item.code)) code = item.code;
    if (item.message === 'Resolved credential object is not valid')
      code = 'INVALID_CREDENTIAL_OBJECT';
    const http = item.$metadata?.httpStatusCode ?? item.$response?.statusCode;
    if (typeof http === 'number' && Number.isInteger(http) && http >= 100 && http <= 599)
      status = http;
    const contentType = item.$response?.headers?.['content-type'];
    if (typeof contentType === 'string' && /^text\/html(?:;|$)/i.test(contentType)) html = true;
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) {
      const errors: unknown[] = item.errors;
      pending.push(...errors.slice(0, 3));
    }
  }
  return { name, code, status, html };
}
/** Only controlled text may reach notices or persisted backup errors. */
export function cloudFailureMessage(error: unknown): string {
  if (error instanceof CloudConfigurationError || error instanceof LocalResetError)
    return error.message;
  if (error instanceof CloudAttachmentMissing) return t('云端未找到该附件，笔记引用已保留。');
  if (error instanceof BackupConflict)
    return t('附件内容或校验信息不一致，已停止处理并保留原文件。');
  const { name, code, status, html } = cloudErrorFacts(error);
  let message = t('云端操作失败，请检查本地权限、网络和 OSS 配置后重试。');
  if (name === 'NoSuchBucket') message = t('OSS Bucket 不存在，请检查 Endpoint 和 Bucket 名称。');
  else if (name === 'InvalidArgument')
    message = t(
      'OSS 拒绝了请求参数，请检查两项 S3 凭据是否分别对应 Access Key ID 和 Secret Access Key，以及 Endpoint 是否为目标账户的 S3 API 地址。',
    );
  else if (name === 'RequestTimeTooSkewed' || name === 'RequestExpired')
    message = t('OSS 请求时间校验失败，请检查系统时间后重试。');
  else if (
    code === 'INVALID_CREDENTIAL_OBJECT' ||
    name === 'CredentialsProviderError' ||
    name === 'TokenProviderError'
  )
    message = t('OSS 凭据未能被 SDK 正确读取，请重新选择两项凭据并重新加载插件。');
  else if (
    name === 'InvalidAccessKeyId' ||
    name === 'SignatureDoesNotMatch' ||
    name === 'AccessDenied' ||
    name === 'ExpiredToken' ||
    name === 'InvalidToken' ||
    status === 401 ||
    status === 403
  )
    message = t('OSS 凭据无效或权限不足，请检查 AK、Secret Key 和目标 Bucket 的读写权限。');
  else if (
    html ||
    name === 'PermanentRedirect' ||
    name === 'IncorrectEndpoint' ||
    name === 'AuthorizationHeaderMalformed'
  )
    message = t('OSS 返回了非预期响应，请核对 S3 API Endpoint 和代理配置。');
  else if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    name === 'NetworkingError' ||
    name === 'UnknownEndpoint' ||
    [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EHOSTUNREACH',
    ].includes(code)
  )
    message = t('无法连接 OSS，请检查网络、Endpoint 或代理设置后重试。');
  else if (
    [
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    ].includes(code)
  )
    message = t('OSS TLS 证书验证失败，请检查 Endpoint、系统时间或代理证书。');
  else if (status !== undefined && status >= 500) message = t('OSS 服务暂时不可用，请稍后重试。');
  const stage = error instanceof CloudConnectionError ? t('OSS 连接检查失败：') : '';
  return `${stage}${message} [SDK=${name}; HTTP=${status ?? 'NONE'}; Code=${code}${html ? '; Response=HTML' : ''}]`;
}
export async function remoteSource(cloud: CloudBackup, key: string): Promise<RemoteSource | null> {
  if (cloud.getSource) return cloud.getSource(key);
  const object = await cloud.get(key);
  return object
    ? { body: bufferSource(object.bytes), sha256: object.sha256, size: object.bytes.length }
    : null;
}
export async function verifyRemote(object: RemoteSource, expected: string): Promise<void> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of object.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  if (
    object.sha256 !== expected ||
    hash.digest('hex') !== expected ||
    (object.size !== undefined && size !== object.size)
  )
    throw new BackupConflict('Cloud content differs from local attachment.');
}
export class S3Backup implements CloudBackup {
  readonly target: string;
  private readonly client: S3Client;
  constructor(
    endpoint: string,
    private bucket: string,
    accessKeyId: string,
    secretAccessKey: string,
    region = 'auto',
  ) {
    const url = validateR2Endpoint(endpoint);
    validateR2Bucket(bucket);
    this.target = `${url.origin}/${bucket}`;
    this.client = new S3Client({
      endpoint: url.origin,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 10_000, requestTimeout: 60_000 }),
      streamCollector,
      streamHasher: readableStreamHasher,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  async checkConnection(): Promise<void> {
    // Read-only: an empty bucket succeeds too. This does not prove PUT access.
    try {
      await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
    } catch (error) {
      throw new CloudConnectionError('OSS connection check failed.', { cause: error });
    }
  }
  async getSource(key: string): Promise<RemoteSource | null> {
    referenceFromKey(key);
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!object.Body) throw new Error('Empty cloud response.');
      const body = object.Body;
      const source: ByteSource = {
        async *[Symbol.asyncIterator]() {
          if (Symbol.asyncIterator in body) {
            yield* body as AsyncIterable<Uint8Array>;
            return;
          }
          const reader = body.transformToWebStream().getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              yield next.value;
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
        },
      };
      const sha256 = object.Metadata?.sha256 ?? '';
      if (!/^[a-f0-9]{64}$/.test(sha256)) {
        // Consume/close the stream before reporting an untrusted object.
        for await (const chunk of source) {
          void chunk; /* bounded-memory drain */
        }
        throw new BackupConflict('Cloud checksum missing or invalid.');
      }
      return { body: source, sha256, size: object.ContentLength };
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }
  async get(key: string): Promise<RemoteImage | null> {
    const object = await this.getSource(key);
    if (!object) return null;
    const bytes: Buffer[] = [];
    for await (const chunk of object.body) bytes.push(Buffer.from(chunk));
    const data = Buffer.concat(bytes);
    if (digest(data) !== object.sha256) throw new BackupConflict('Cloud checksum mismatched.');
    return { bytes: data, sha256: object.sha256 };
  }
  async putSourceIfAbsent(key: string, asset: CheckedAsset, source: ByteSource): Promise<void> {
    referenceFromKey(key);
    const body = Readable.from(source);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: asset.size,
          ContentType: asset.format.mime,
          ContentMD5: asset.md5,
          Metadata: { sha256: asset.sha256 },
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412)
        throw error;
    } finally {
      body.destroy();
    }
  }
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<void> {
    await this.putSourceIfAbsent(
      key,
      {
        path: '',
        size: bytes.length,
        format: identifyAsset(bytes, key),
        sha256: digest(bytes),
        md5: createHash('md5').update(bytes).digest('base64'),
      },
      bufferSource(bytes),
    );
  }
  destroy(): void {
    this.client.destroy();
  }
}
export { S3Backup as R2Backup };
