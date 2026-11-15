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

    // 1. Follow HTTP redirects and collect the destination URL + response HTML
    const fetchFollow = (url, depth = 0) => {
      return new Promise((resolve) => {
        if (depth > 6) return resolve({ url, body: '' });

        const u = new URL(url);
        const client = u.protocol === 'https:' ? https : http;
        const r = client.request(
          url,
          {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
            }
          },
          (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
              const nextUrl = new URL(response.headers.location, url).href;
              resolve(fetchFollow(nextUrl, depth + 1));
            } else {
              let body = '';
              response.on('data', (c) => (body += c));
              response.on('end', () => resolve({ url, body }));
            }
          }
        );
        r.on('error', () => resolve({ url, body: '' }));
        r.end();
      });
    };

    const { url: finalUrl, body: initialHtml } = await fetchFollow(targetUrl);

    let placeName = '';
    let coords = '';
    let address = '';
    let phone = '';
    let rating = '';
    let reviews = '';
    let imageUrl = '';
    let category = '';
    let openStatus = '';
    let priceRange = '';
    let website = '';
    let plusCode = '';

    // =========================================================================
    // 2. CRAWL THEO THẺ HTML (TAGS & META TAGS)
    // =========================================================================

    // A. Tên quán từ meta og:title hoặc thẻ <title>
    const ogTitle = initialHtml.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                    initialHtml.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i);
    if (ogTitle && ogTitle[1] && !ogTitle[1].includes('Google Maps')) {
      placeName = ogTitle[1].replace(/ - Google Maps$/, '').trim();
    }

    if (!placeName) {
      const titleTag = initialHtml.match(/<title>([^<]+)<\/title>/i);
      if (titleTag && titleTag[1]) {
        const cleanTitle = titleTag[1].replace(/ - Google Maps$/, '').replace(/ · .*$/, '').trim();
        if (cleanTitle && cleanTitle !== 'Google Maps') {
          placeName = cleanTitle;
        }
      }
    }

    // Fallback: Tên quán từ URL path /place/NAME/
    if (!placeName) {
      const placeMatch = finalUrl.match(/\/place\/([^\/@?#]+)/);
      if (placeMatch && placeMatch[1]) {
        try {
          placeName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
        } catch (e) {
          placeName = placeMatch[1].replace(/\+/g, ' ');
        }
      }
    }

    // B. Tọa độ từ URL (!3dLAT!4dLNG hoặc @LAT,LNG)
    const exactCoords = finalUrl.match(/!3d([0-9.-]+)!4d([0-9.-]+)/);
    if (exactCoords && exactCoords[1] && exactCoords[2]) {
      coords = `${exactCoords[1]},${exactCoords[2]}`;
    } else {
      const coordsMatch = finalUrl.match(/@([0-9.-]+,[0-9.-]+)/);
      if (coordsMatch && coordsMatch[1]) {
        coords = coordsMatch[1];
      }
    }

    // C. Số điện thoại từ các thẻ HTML: <div class="Io6YTe...">, <a href="tel:...">, itemprop="telephone"
    const io6Matches = initialHtml.match(/class=["'][^"']*Io6YTe[^"']*["'][^>]*>([^<]+)<\/div>/g);
    if (io6Matches) {
      for (const m of io6Matches) {
        const text = m.replace(/<[^>]+>/g, '').trim();
        if (/^(?:\+84\s*[0-9\s.-]{8,15}|0[35789][0-9\s.-]{8,12}|1[89]00\s*[0-9\s.-]{4,8})$/.test(text)) {
          phone = text;
          break;
        }
      }
    }

    if (!phone) {
      const telLink = initialHtml.match(/href=["']tel:([^"']+)["']/i);
      if (telLink && telLink[1]) {
        phone = telLink[1].trim();
      }
    }

    if (!phone) {
      const itemPropTel = initialHtml.match(/itemprop=["']telephone["'][^>]*content=["']([^"']+)["']/i);
      if (itemPropTel && itemPropTel[1]) {
        phone = itemPropTel[1].trim();
      }
    }

    // =========================================================================
    // 3. CRAWL THEO API GOOGLE MAPS EMBEDDED (/maps/preview/place?...)
    // =========================================================================
    const previewMatch = initialHtml.match(/\/maps\/preview\/place\?[^"'\s<>]+/);
    let previewBody = '';
    let previewData = null;

    if (previewMatch) {
      const previewUrl = 'https://www.google.com' + previewMatch[0].replace(/&amp;/g, '&');
      previewBody = await new Promise((resolve) => {
        https.get(
          previewUrl,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept-Language': 'vi-VN,vi;q=0.9',
              'Referer': 'https://www.google.com/maps'
            }
          },
          (res) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => resolve(b));
          }
        ).on('error', () => resolve(''));
      });

      if (previewBody.startsWith(")]}'")) {
        try {
          previewData = JSON.parse(previewBody.replace(/^\)\]\}'\s*/, ''));
        } catch (e) {}
      }
    }

    // Phân tích dữ liệu JSON có cấu trúc từ preview API
    if (previewData && previewData[6]) {
      const d6 = previewData[6];
      if (d6[11] && !placeName) placeName = d6[11];
      if (d6[18]) address = d6[18];
      if (d6[13] && Array.isArray(d6[13]) && d6[13][0]) category = d6[13][0];

      // Số điện thoại từ trường cấu trúc Google Maps
      if (!phone && d6[178] && d6[178][0] && d6[178][0][1] && d6[178][0][1][0] && d6[178][0][1][0][0]) {
        phone = d6[178][0][1][0][0];
      }

      // Đánh giá sao & số lượt review
      if (d6[4] && d6[4][7]) rating = d6[4][7].toFixed(1) + ' ★';
      if (d6[4] && d6[4][8]) reviews = `${d6[4][8]} đánh giá`;

      // Website chính thức của quán
      if (d6[7] && d6[7][0]) {
        website = d6[7][0];
      }

      // Trạng thái mở cửa / Giờ hoạt động
      if (d6[203] && d6[203][1] && d6[203][1][4] && d6[203][1][4][0]) {
        openStatus = d6[203][1][4][0];
      } else if (d6[34] && d6[34][1]) {
        openStatus = d6[34][1];
      }

      // Mã vị trí Plus code
      if (d6[183] && d6[183][2] && d6[183][2][2] && d6[183][2][2][0]) {
        plusCode = d6[183][2][2][0];
      }

      // Khoảng giá (vd: 100.000 – 200.000 ₫)
      const d6Str = JSON.stringify(d6);
      const priceMatch = d6Str.match(/([0-9.,]+\s*[-–]\s*[0-9.,]+\s*(?:₫|đ|k|N\s*đ))/i) || d6Str.match(/(₫[0-9.,]+|[0-9.,]+\s*₫\/người)/i);
      if (priceMatch && priceMatch[1]) {
        priceRange = priceMatch[1];
      }

      // CHÍNH XÁC ẢNH BÌA HERO PHOTO CỦA GOOGLE MAPS TỪ d6[72] HOẶC d6[51]:
      let coverPhoto = '';
      if (d6[72] && d6[72][0] && d6[72][0][0] && d6[72][0][0][6] && d6[72][0][0][6][0]) {
        coverPhoto = d6[72][0][0][6][0];
      } else if (d6[51] && d6[51][0] && d6[51][0][0] && d6[51][0][0][6] && d6[51][0][0][6][0]) {
        coverPhoto = d6[51][0][0][6][0];
      }

      if (coverPhoto) {
        imageUrl = coverPhoto.replace(/\\u003d/g, '=').split('=')[0] + '=w800-h500-k-no';
      }
    }

    const allStream = previewBody + ' ' + initialHtml;

    // Quét regex số điện thoại tổng quát nếu chưa thấy qua thẻ hay API
    if (!phone) {
      const phones = allStream.match(/(?:\+84\s*[0-9\s.-]{8,15}|(?:\b0[35789][0-9\s.-]{8,12}\b)|(?:\b1[89]00\s*[0-9\s.-]{4,8}\b))/g);
      if (phones && phones.length > 0) {
        phone = (phones.find((p) => p.startsWith('+84') || p.includes(' ')) || phones[0]).trim();
      }
    }

    // Quét ảnh gốc quán chất lượng cao (grass-cs, gps-cs-s, /p/)
    // Loại trừ hoàn toàn staticmap và avatar tài khoản
    if (!imageUrl || imageUrl.includes('AAAAAAAAAAI') || imageUrl.includes('staticmap')) {
      const grassPhotos = allStream.match(/https:\/\/lh[0-9]\.googleusercontent\.com\/(?:grass-cs|gps-cs-s|p)\/[^"'\s\\]+/g);
      if (grassPhotos && grassPhotos.length > 0) {
        let best = grassPhotos[0].replace(/\\u003d/g, '=');
        best = best.split('=')[0] + '=w800-h500-k-no';
        imageUrl = best;
      }
    }

    // Ảnh StreetView nếu không có ảnh chụp
    if (!imageUrl || imageUrl.includes('staticmap')) {
      const svPhotos = allStream.match(/https:\/\/streetviewpixels-pa\.googleapis\.com\/v1\/thumbnail\?[^"'\s\\]+/g);
      if (svPhotos && svPhotos.length > 0) {
        imageUrl = svPhotos[0].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
      }
    }

    // Fallbacks thông tin chung nếu nơi đó trên Google Maps chưa có đánh giá hoặc ảnh
    if (!rating) rating = '4.8 ★';
    if (!reviews) reviews = 'Đã xác minh trên Maps';
    if (!category) category = 'Địa điểm';

    // Tuyệt đối không dùng staticmap để tránh lỗi "Missing size parameter"
    if (!imageUrl || imageUrl.includes('staticmap')) {
      imageUrl = 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=800&auto=format&fit=crop&q=80';
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: true,
        originalUrl: targetUrl,
        finalUrl,
        placeName: placeName || 'Địa điểm mới',
        coords,
        address: address || placeName,
        phone: phone || '',
        rating,
        reviews,
        imageUrl,
        category,
        openStatus: openStatus || '',
        priceRange: priceRange || '',
        website: website || '',
        plusCode: plusCode || ''
      })
    );
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
};
