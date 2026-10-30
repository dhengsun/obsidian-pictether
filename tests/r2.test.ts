import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHash } from 'node:crypto';
import { CloudConnectionError, R2Backup, cloudFailureMessage, validateR2Endpoint, validateR2Bucket, validateR2SecretReferences } from '../src/core/r2';
import { bufferSource } from '../src/core/storage';
import { digest } from '../src/core/images';

afterEach(()=>vi.restoreAllMocks());
const key='vault/2026-10-29/120000-abcdef.png';
const cloud=()=>new R2Backup('https://example.r2.cloudflarestorage.com','test-bucket','placeholder-id','placeholder-secret');

describe('R2 S3 requests without network access',()=>{
  it('signs a non-R2 S3 endpoint with its configured region',async()=>{
    const handle=vi.spyOn(NodeHttpHandler.prototype,'handle').mockImplementation(async request=>{
      expect(request.hostname).toBe('storage.example');expect(request.headers.authorization).toContain('/eu-west-1/s3/aws4_request');
      return{response:{statusCode:200,headers:{'content-type':'application/xml'},body:Readable.from([Buffer.from('<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>')])}};
    });
    const backup=new R2Backup('https://storage.example','test-bucket','placeholder-id','placeholder-key','eu-west-1');
    try{await backup.checkConnection();expect(handle).toHaveBeenCalledOnce();}finally{backup.destroy();}
  });
  it.each([200,403])('runs real SDK signing and XML decoding for HTTP %i with only the transport mocked',async status=>{
    const xml=status===200
      ?'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>'
      :'<Error><Code>AccessDenied</Code><Message>credential-marker</Message></Error>';
    const handle=vi.spyOn(NodeHttpHandler.prototype,'handle').mockImplementation(async request=>{
      expect(request.method).toBe('GET');expect(request.path).toBe('/test-bucket/');
      expect(request.query).toMatchObject({'list-type':'2','max-keys':'1'});
      expect(request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')).toBe(true);
      return {response:{statusCode:status,headers:{'content-type':'application/xml'},body:Readable.from([Buffer.from(xml)])}};
    });
    const backup=cloud();
    try{
      if(status===200)await expect(backup.checkConnection()).resolves.toBeUndefined();
      else{
        let failure:unknown;try{await backup.checkConnection();}catch(error){failure=error;}
        expect(cloudFailureMessage(failure)).toContain('SDK=AccessDenied; HTTP=403');
        expect(cloudFailureMessage(failure)).not.toContain('credential-marker');
      }
      expect(handle).toHaveBeenCalledOnce();
    }finally{backup.destroy();}
  });
  it('checks a configured empty bucket with a read-only list limited to one item',async()=>{
    const send=vi.spyOn(S3Client.prototype,'send').mockResolvedValue({Contents:[]} as never),backup=cloud();
    try{
      await backup.checkConnection();
      expect(send).toHaveBeenCalledOnce();
      const command=send.mock.calls[0]![0] as ListObjectsV2Command;
      expect(command).toBeInstanceOf(ListObjectsV2Command);expect(command.input).toEqual({Bucket:'test-bucket',MaxKeys:1});
    }finally{backup.destroy();}
  });
  it('preserves a failed connection cause for safe stage-specific diagnostics',async()=>{
    vi.spyOn(S3Client.prototype,'send').mockRejectedValue(Object.assign(new TypeError('credential-marker'),{code:'ERR_INVALID_ARG_TYPE'}));
    const backup=cloud();
    try{
      let failure:unknown;
      try{await backup.checkConnection();}catch(error){failure=error;}
      expect(failure).toBeInstanceOf(CloudConnectionError);
      expect(cloudFailureMessage(failure)).toContain('OSS 连接检查失败');
      expect(cloudFailureMessage(failure)).toContain('SDK=TypeError; HTTP=NONE; Code=ERR_INVALID_ARG_TYPE');
      expect(cloudFailureMessage(failure)).not.toContain('credential-marker');
    }finally{backup.destroy();}
  });
  it('streams a conditional upload with checksum metadata, content type and length',async()=>{
    const bytes=Buffer.from('test stream'),sha256=digest(bytes),md5=createHash('md5').update(bytes).digest('base64');
    const send=vi.spyOn(S3Client.prototype,'send').mockImplementation(async command=>{
      expect(command).toBeInstanceOf(PutObjectCommand);
      const input=(command as PutObjectCommand).input;
      expect(input).toMatchObject({Bucket:'test-bucket',Key:key,ContentLength:bytes.length,ContentType:'image/png',ContentMD5:md5,Metadata:{sha256},IfNoneMatch:'*'});
      const received:Buffer[]=[];for await(const chunk of input.Body as Readable)received.push(Buffer.from(chunk));
      expect(Buffer.concat(received)).toEqual(bytes);return {} as never;
    });
    const backup=cloud();
    try{await backup.putSourceIfAbsent(key,{path:'unused',size:bytes.length,sha256,md5,format:{kind:'image',extension:'png',mime:'image/png'}},bufferSource(bytes));expect(send).toHaveBeenCalledOnce();}
    finally{backup.destroy();}
  });
  it('preserves an existing object on a conditional write failure',async()=>{
    vi.spyOn(S3Client.prototype,'send').mockRejectedValue({$metadata:{httpStatusCode:412}});
    const backup=cloud();
    try{await expect(backup.putSourceIfAbsent(key,{path:'unused',size:1,sha256:'a'.repeat(64),md5:'unused',format:{kind:'image',extension:'png',mime:'image/png'}},bufferSource(new Uint8Array([1])))).resolves.toBeUndefined();}
    finally{backup.destroy();}
  });
  it('returns missing only for a missing object and propagates authentication/bucket failures',async()=>{
    const send=vi.spyOn(S3Client.prototype,'send'),backup=cloud();
    try{
      send.mockRejectedValueOnce({name:'NoSuchKey'});
      await expect(backup.getSource(key)).resolves.toBeNull();
      for(const name of ['AccessDenied','NoSuchBucket']){
        send.mockRejectedValueOnce({name});await expect(backup.getSource(key)).rejects.toMatchObject({name});
      }
      expect(send.mock.calls.every(call=>call[0] instanceof GetObjectCommand)).toBe(true);
    }finally{backup.destroy();}
  });
  it('checks streamed object bytes against metadata and rejects missing checksum metadata',async()=>{
    const bytes=Buffer.from('test stream'),send=vi.spyOn(S3Client.prototype,'send'),backup=cloud();
    try{
      send.mockResolvedValueOnce({Body:Readable.from([bytes]),Metadata:{sha256:digest(bytes)},ContentLength:bytes.length} as never);
      await expect(backup.get(key)).resolves.toMatchObject({bytes,sha256:digest(bytes)});
      send.mockResolvedValueOnce({Body:Readable.from([bytes]),Metadata:{},ContentLength:bytes.length} as never);
      await expect(backup.getSource(key)).rejects.toThrow('checksum');
    }finally{backup.destroy();}
  });
});

describe('safe cloud diagnostics',()=>{
  it('rejects shared credential references without displaying either secret name or requiring secret values',()=>{
    expect(()=>validateR2SecretReferences('credential-marker','credential-marker')).toThrow('同一个凭据条目');
    try{validateR2SecretReferences('credential-marker','credential-marker');}catch(error){expect(cloudFailureMessage(error)).not.toContain('credential-marker');}
    expect(()=>validateR2SecretReferences('access-reference','secret-reference')).not.toThrow();
    expect(()=>validateR2SecretReferences('','')).not.toThrow();
    expect(()=>validateR2SecretReferences('access-reference','')).not.toThrow();
  });
  it('describes InvalidArgument as a request configuration failure rather than a generic network error',()=>{
    const message=cloudFailureMessage({name:'InvalidArgument',$metadata:{httpStatusCode:400},message:'credential-marker'});
    expect(message).toContain('OSS 拒绝了请求参数');expect(message).toContain('SDK=InvalidArgument; HTTP=400');
    expect(message).not.toContain('credential-marker');
  });
  it('reports HTTP details from SDK response metadata without exposing response bodies or headers',()=>{
    const error=Object.assign(new SyntaxError('credential-marker response body'),{$response:{statusCode:400,body:'credential-marker',headers:{'content-type':'text/html; charset=utf-8',authorization:'credential-marker'}}});
    const message=cloudFailureMessage(error);
    expect(message).toContain('非预期响应');expect(message).toContain('SDK=SyntaxError; HTTP=400; Code=NONE; Response=HTML');
    expect(message).not.toContain('credential-marker');
  });
  it('uses exact allowlists and rejects arbitrary names, codes and invalid HTTP values',()=>{
    const message=cloudFailureMessage({name:'credential-marker',code:'CREDENTIAL_MARKER',$metadata:{httpStatusCode:'credential-marker'},message:'credential-marker',cause:{name:'Error'}});
    expect(message).toContain('SDK=Error; HTTP=NONE; Code=NONE');
    expect(message).not.toContain('credential-marker');expect(message).not.toContain('CREDENTIAL_MARKER');
  });
  it('recognizes nested aggregate network errors and handles circular causes',()=>{
    const error:{name:string;cause?:unknown;errors:unknown[]}={name:'AggregateError',errors:[{code:'ECONNREFUSED',message:'credential-marker'}]};
    error.cause=error;
    expect(cloudFailureMessage(error)).toContain('无法连接');expect(cloudFailureMessage(error)).toContain('Code=ECONNREFUSED');
    expect(cloudFailureMessage(error)).not.toContain('credential-marker');
  });
  it.each([
    [{code:'CERT_HAS_EXPIRED'},'证书验证失败'],
    [{name:'RequestTimeTooSkewed'},'系统时间'],
    [new Error('Resolved credential object is not valid'),'凭据未能被 SDK 正确读取']
  ])('distinguishes TLS, clock and credential-shape failures', (error,category)=>{
    expect(cloudFailureMessage(error)).toContain(category);
  });
  it.each([
    [{name:'NoSuchBucket'},'Bucket 不存在'],
    [{name:'SignatureDoesNotMatch'},'凭据无效或权限不足'],
    [{$metadata:{httpStatusCode:403}},'凭据无效或权限不足'],
    [{code:'ENOTFOUND'},'无法连接'],
    [{cause:{code:'ECONNRESET'}},'无法连接'],
    [{$metadata:{httpStatusCode:503}},'暂时不可用'],
    [new Error('credential-marker signed URL request headers'),'云端操作失败']
  ])('reports a controlled category without exposing SDK details', (error,category)=>{
    expect(cloudFailureMessage(error)).toContain(category);
    expect(cloudFailureMessage(error)).not.toContain('credential-marker');
  });
  it('rejects invalid settings with controlled messages and allows a bare HTTPS endpoint',()=>{
    expect(validateR2Endpoint('https://example.r2.cloudflarestorage.com/').origin).toBe('https://example.r2.cloudflarestorage.com');
    for(const input of ['not a URL','http://example.com','https://user:credential-marker@example.com','https://example.com/bucket','https://example.com/?token=credential-marker']){
      expect(()=>validateR2Endpoint(input)).toThrow('OSS Endpoint');
      try{validateR2Endpoint(input);}catch(error){expect(cloudFailureMessage(error)).not.toContain('credential-marker');}
    }
    expect(()=>validateR2Bucket('https://example.com/bucket')).toThrow('Bucket');
  });
});
