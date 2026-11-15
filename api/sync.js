const https = require('https');

const BLOB_URL = 'https://ngvcmsvsuwlo2pjj.public.blob.vercel-storage.com/sugoi-data.json';
const BLOB_API = 'https://blob.vercel-storage.com/sugoi-data.json';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;

  // 1. GET: Lấy dữ liệu chia sẻ mới nhất từ Vercel Cloud Blob
  if (req.method === 'GET') {
    return new Promise((resolve) => {
      https.get(`${BLOB_URL}?t=${Date.now()}`, (blobRes) => {
        if (blobRes.statusCode === 200) {
          let body = '';
          blobRes.on('data', (d) => (body += d));
          blobRes.on('end', () => {
            try {
              const data = JSON.parse(body);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, data }));
              return resolve();
            } catch (e) {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, data: null }));
              return resolve();
            }
          });
        } else {
          // Chưa có file hoặc trống
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, data: null }));
          return resolve();
        }
      }).on('error', (err) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, data: null, error: err.message }));
        return resolve();
      });
    });
  }

  // 2. POST: Lưu cập nhật toàn đoàn lên Vercel Cloud Blob
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    try {
      const parsed = JSON.parse(body || '{}');
      if (!token) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'Missing BLOB_READ_WRITE_TOKEN on server' }));
      }

      return new Promise((resolve) => {
        const putReq = https.request(
          BLOB_API,
          {
            method: 'PUT',
            headers: {
              authorization: 'Bearer ' + token,
              'x-add-random-suffix': '0',
              'x-content-type': 'application/json',
              'Content-Type': 'application/json'
            }
          },
          (putRes) => {
            let respBody = '';
            putRes.on('data', (d) => (respBody += d));
            putRes.on('end', () => {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, savedAt: new Date().toISOString() }));
              return resolve();
            });
          }
        );

        putReq.on('error', (err) => {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
          return resolve();
        });

        putReq.write(JSON.stringify(parsed));
        putReq.end();
      });
    } catch (err) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
    }
  }

  res.statusCode = 405;
  res.end('Method Not Allowed');
};
