/**
 * Minimal S3 client for persisting AP state to MinIO.
 *
 * Uses s3-lite-client for lightweight S3 operations.
 * Config from env: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION.
 */

import { S3Client } from "@bradenmacdonald/s3-lite-client";

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export function loadS3Config(): S3Config | null {
  const endpoint = Deno.env.get("S3_ENDPOINT");
  const bucket = Deno.env.get("S3_BUCKET");
  const accessKey = Deno.env.get("S3_ACCESS_KEY");
  const secretKey = Deno.env.get("S3_SECRET_KEY");
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return {
    endpoint,
    bucket,
    accessKey,
    secretKey,
    region: Deno.env.get("S3_REGION") ?? "us-east-1",
  };
}

export class ApS3Client {
  private client: S3Client;
  private prefix: string;

  constructor(config: S3Config, prefix = "porter-ap/") {
    const url = new URL(config.endpoint);
    this.client = new S3Client({
      endPoint: url.hostname,
      port: parseInt(url.port) || (url.protocol === "https:" ? 443 : 9000),
      useSSL: url.protocol === "https:",
      region: config.region,
      bucket: config.bucket,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
    this.prefix = prefix;
  }

  async getObject(key: string): Promise<string | null> {
    try {
      const resp = await this.client.getObject(this.prefix + key);
      return await resp.text();
    } catch {
      return null;
    }
  }

  async putObject(key: string, body: string): Promise<void> {
    await this.client.putObject(this.prefix + key, body);
  }
}
