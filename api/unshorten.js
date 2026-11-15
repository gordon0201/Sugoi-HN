const https = require('https');
const http = require('http');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const targetUrl = reqUrl.searchParams.get('url');

    if (!targetUrl) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Missing url parameter' }));
    }

    const parsed = new URL(targetUrl);
    if (!parsed.protocol.startsWith('http')) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Invalid URL' }));
    }

    const followRedirect = (url, depth = 0) => {
      return new Promise((resolve) => {
        if (depth > 5) return resolve(url);

        const u = new URL(url);
        const client = u.protocol === 'https:' ? https : http;
        const r = client.request(
          url,
          {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          },
          (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
              const nextUrl = new URL(response.headers.location, url).href;
              resolve(followRedirect(nextUrl, depth + 1));
            } else {
              resolve(url);
            }
          }
        );
        r.on('error', () => resolve(url));
        r.end();
      });
    };

    const finalUrl = await followRedirect(targetUrl);

    let placeName = '';
    let coords = '';

    const placeMatch = finalUrl.match(/\/place\/([^\/@?#]+)/);
    if (placeMatch && placeMatch[1]) {
      try {
        placeName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
      } catch (e) {
        placeName = placeMatch[1].replace(/\+/g, ' ');
      }
    }

    const coordsMatch = finalUrl.match(/@([0-9.-]+,[0-9.-]+)/);
    if (coordsMatch && coordsMatch[1]) {
      coords = coordsMatch[1];
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: true,
        originalUrl: targetUrl,
        finalUrl,
        placeName,
        coords
      })
    );
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
};
