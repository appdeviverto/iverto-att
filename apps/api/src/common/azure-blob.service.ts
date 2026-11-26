import { BlobSASPermissions, BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Private Azure Blob containers. `selfies` (default) holds punch and field-visit
 * selfies; `documents` holds confidential HR files (documents, letters, payslips,
 * receipts). Reads go through short-lived SAS URLs, so the connection string must
 * carry an AccountKey.
 */
export type BlobContainer = 'selfies' | 'documents';

@Injectable()
export class AzureBlobService {
  private readonly logger = new Logger(AzureBlobService.name);
  private readonly clients = new Map<BlobContainer, ContainerClient>();
  private readonly ensured = new Set<BlobContainer>();

  private container(which: BlobContainer): ContainerClient {
    let client = this.clients.get(which);
    if (!client) {
      const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!conn) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
      const name =
        which === 'documents'
          ? process.env.AZURE_STORAGE_CONTAINER_DOCUMENTS || 'hr-documents'
          : process.env.AZURE_STORAGE_CONTAINER_SELFIES || 'punch-selfies';
      client = BlobServiceClient.fromConnectionString(conn).getContainerClient(name);
      this.clients.set(which, client);
    }
    return client;
  }

  async upload(key: string, body: Buffer, contentType: string, which: BlobContainer = 'selfies') {
    if (!this.ensured.has(which)) {
      // Private container (no public access level), created on first write.
      await this.container(which).createIfNotExists();
      this.ensured.add(which);
    }
    await this.container(which).getBlockBlobClient(key).uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  readUrl(key: string, expiresInSeconds = 3600, which: BlobContainer = 'selfies', downloadName?: string) {
    return this.container(which).getBlockBlobClient(key).generateSasUrl({
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + expiresInSeconds * 1000),
      ...(downloadName ? { contentDisposition: `attachment; filename="${downloadName.replace(/["\\\r\n]/g, '_')}"` } : {}),
    });
  }

  async download(key: string, which: BlobContainer = 'selfies') {
    return this.container(which).getBlockBlobClient(key).downloadToBuffer();
  }

  async remove(keys: string[], which: BlobContainer = 'selfies') {
    for (const key of keys) {
      try {
        await this.container(which).deleteBlob(key, { deleteSnapshots: 'include' });
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 404) this.logger.warn(`Blob remove failed for ${key}: ${(err as Error).message}`);
      }
    }
  }
}
