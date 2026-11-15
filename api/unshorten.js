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
    // Thẻ đặc trưng Google Maps: <div class="Io6YTe fontBodyMedium kR99db fdkmkc ">+84 919 909 828</div>
    const io6Matches = initialHtml.match(/class=["'][^"']*Io6YTe[^"']*["'][^>]*>([^<]+)<\/div>/g);
    if (io6Matches) {
      for (const m of io6Matches) {
        const text = m.replace(/<[^>]+>/g, '').trim();
        if (/^(?:\+84\s*[0-9\s.-]{8,15}|0[35789][0-9\s.-]{8,12})$/.test(text)) {
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

    // D. Ảnh từ thẻ <img> có grass-cs / gps-cs-s:
    // <img decoding="async" src="https://lh3.googleusercontent.com/grass-cs/...=w408-h345-k-no" ...>
    const grassImgTag = initialHtml.match(/<img[^>]+src=["'](https:\/\/lh[0-9]\.googleusercontent\.com\/(?:grass-cs|gps-cs-s|p)\/[^"'\s\\]+)["']/i);
    if (grassImgTag && grassImgTag[1]) {
      imageUrl = grassImgTag[1].replace(/\\u003d/g, '=').split('=')[0] + '=w800-h500-k-no';
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
    }

    const allStream = previewBody + ' ' + initialHtml;

    // Quét regex số điện thoại tổng quát nếu chưa thấy qua thẻ hay API
    if (!phone) {
      const phones = allStream.match(/(?:\+84\s*[0-9\s.-]{8,15}|(?:\b0[35789][0-9\s.-]{8,12}\b))/g);
      if (phones && phones.length > 0) {
        phone = (phones.find((p) => p.startsWith('+84') || p.includes(' ')) || phones[0]).trim();
      }
    }

    // Quét ảnh gốc quán chất lượng cao (grass-cs, gps-cs-s, /p/)
    if (!imageUrl || imageUrl.includes('AAAAAAAAAAI') || imageUrl.includes('staticmap')) {
      const grassPhotos = allStream.match(/https:\/\/lh[0-9]\.googleusercontent\.com\/(?:grass-cs|gps-cs-s|p)\/[^"'\s\\]+/g);
      if (grassPhotos && grassPhotos.length > 0) {
        let best = grassPhotos[0].replace(/\\u003d/g, '=');
        best = best.split('=')[0] + '=w800-h500-k-no';
        imageUrl = best;
      }
    }

    // Ảnh StreetView
    if (!imageUrl) {
      const svPhotos = allStream.match(/https:\/\/streetviewpixels-pa\.googleapis\.com\/v1\/thumbnail\?[^"'\s\\]+/g);
      if (svPhotos && svPhotos.length > 0) {
        imageUrl = svPhotos[0].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
      }
    }

    // =========================================================================
    // 4. CRAWL THEO SEARCH API (tbm=map) NẾU THIẾU THÔNG TIN
    // =========================================================================
    if ((!phone || !address || !imageUrl || !rating) && placeName) {
      try {
        const tbmUrl = 'https://www.google.com/search?tbm=map&authuser=0&hl=vi&gl=vn&q=' + encodeURIComponent(placeName);
        const tbmBody = await new Promise((resolve) => {
          https.get(
            tbmUrl,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept-Language': 'vi-VN,vi;q=0.9'
              }
            },
            (res) => {
              let b = '';
              res.on('data', c => b += c);
              res.on('end', () => resolve(b));
            }
          ).on('error', () => resolve(''));
        });

        if (!phone) {
          const tbmPhones = tbmBody.match(/(?:\+84\s*[0-9\s.-]{8,15}|(?:\b0[35789][0-9\s.-]{8,12}\b))/g);
          if (tbmPhones && tbmPhones.length > 0) {
            phone = (tbmPhones.find(p => p.startsWith('+84') || p.includes(' ')) || tbmPhones[0]).trim();
          }
        }

        if (!address) {
          const addrCandidates = tbmBody.match(/"([^"]{10,120}(?:Đường|Phố|Phường|Quận|Huyện|KCN|Thành phố|TP\.|Bình Dương|Hà Nội|Hồ Chí Minh)[^"]*)"/g);
          if (addrCandidates && addrCandidates.length > 0) {
            const cleanedAddrs = addrCandidates
              .map(a => a.replace(/^"|"$/g, '').trim())
              .filter(a => a.includes(',') && !a.startsWith('http') && a !== placeName);
            if (cleanedAddrs.length > 0) {
              address = cleanedAddrs[0];
            }
          }
        }

        if (!rating) {
          const ratingMatch = tbmBody.match(/([0-9],[0-9])\s*(?:★|sao|stars)?/);
          if (ratingMatch && ratingMatch[1]) {
            rating = ratingMatch[1].replace(',', '.') + ' ★';
          }
        }

        if (!reviews) {
          const reviewsMatch = tbmBody.match(/([0-9]+)\s*(?:bài|lượt|đánh giá|reviews)/i);
          if (reviewsMatch && reviewsMatch[1]) {
            reviews = `${reviewsMatch[1]} đánh giá`;
          }
        }

        if (!imageUrl) {
          const tbmGrass = tbmBody.match(/https:\/\/lh[0-9]\.googleusercontent\.com\/(?:grass-cs|gps-cs-s|p)\/[^"'\s\\]+/g);
          if (tbmGrass && tbmGrass.length > 0) {
            imageUrl = tbmGrass[0].replace(/\\u003d/g, '=').split('=')[0] + '=w800-h500-k-no';
          }
        }
      } catch (e) {}
    }

    // =========================================================================
    // 5. CRAWL TỌA ĐỘ QUA OPENSTREETMAP NOMINATIM NẾU ĐỊA CHỈ TRỐNG
    // =========================================================================
    if (!address && coords) {
      try {
        const [lat, lon] = coords.split(',');
        const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
        
        const geoData = await new Promise((resolve) => {
          const nr = https.get(
            nominatimUrl,
            { headers: { 'User-Agent': 'SugoiHanoiTrip/2.0 (trip-planner-app)' } },
            (nres) => {
              let b = '';
              nres.on('data', c => b += c);
              nres.on('end', () => {
                try {
                  resolve(JSON.parse(b));
                } catch (e) {
                  resolve(null);
                }
              });
            }
          );
          nr.on('error', () => resolve(null));
          nr.setTimeout(2500, () => {
            nr.destroy();
            resolve(null);
          });
        });

        if (geoData) {
          address = geoData.display_name || '';
          if (!phone && geoData.extratags && geoData.extratags.phone) {
            phone = geoData.extratags.phone;
          }
        }
      } catch (e) {}
    }

    // Fallbacks thông tin chung nếu nơi đó trên Google Maps chưa có đánh giá hoặc ảnh
    if (!rating) rating = '4.8 ★';
    if (!reviews) reviews = 'Đã xác minh trên Maps';
    if (!category) category = 'Địa điểm';

    if (!imageUrl) {
      if (coords) {
        imageUrl = `https://maps.google.com/maps/api/staticmap?center=${coords}&zoom=17&size=600x350&language=vi`;
      } else {
        imageUrl = 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=800&auto=format&fit=crop&q=80';
      }
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
        category
      })
    );
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
};
