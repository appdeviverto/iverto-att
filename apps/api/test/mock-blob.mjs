// Minimal Azure Blob stand-in for local tests (UseDevelopmentStorage=true → 127.0.0.1:10000):
// container creation, block-blob uploads kept in memory, and GET so SAS links open in a browser
// (SAS signatures are not checked). Use Azurite for anything more.
import http from 'node:http';

const PORT = Number(process.env.MOCK_BLOB_PORT || 10000);
const containers = new Set();
const blobs = new Map(); // path -> { body, type }

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname);
    const headers = { 'x-ms-request-id': '1', 'x-ms-version': '2025-01-05', etag: '"0x1"', 'last-modified': new Date().toUTCString(), date: new Date().toUTCString() };
    if (req.method === 'PUT' && url.searchParams.get('restype') === 'container') {
      const exists = containers.has(path);
      containers.add(path);
      res.writeHead(exists ? 409 : 201, { ...headers, ...(exists ? { 'x-ms-error-code': 'ContainerAlreadyExists' } : {}) });
      return res.end();
    }
    if (req.method === 'PUT') {
      blobs.set(path, { body: Buffer.concat(chunks), type: req.headers['x-ms-blob-content-type'] || 'application/octet-stream' });
      res.writeHead(201, { ...headers, 'x-ms-request-server-encrypted': 'true' });
      return res.end();
    }
    if (req.method === 'GET' && blobs.has(path)) {
      const b = blobs.get(path);
      const disposition = url.searchParams.get('rscd');
      res.writeHead(200, { ...headers, 'content-type': b.type, 'content-length': b.body.length, ...(disposition ? { 'content-disposition': disposition } : {}) });
      return res.end(b.body);
    }
    if (req.method === 'DELETE') blobs.delete(path);
    res.writeHead(req.method === 'DELETE' ? 202 : 404, headers);
    res.end();
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock blob on ${PORT}`));
