// Vercel serverless proxy. APOD uses NASA's apod-basic feed (no API key).
// DONKI stays on api.nasa.gov and keeps the key server-side.
const APOD_BASIC = 'https://science.nasa.gov/wp-json/wp/v2/apod-basic';

function stripHtml(html) {
    if (html == null) return '';
    let text = String(html);
    text = text.replace(/<br\s*\/?>/gi, ' ');
    text = text.replace(/<[^>]*>/g, '');
    text = text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
    return text.replace(/\s+/g, ' ').trim();
}

function toYYMMDD(isoDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || '').trim());
    if (!match) return null;
    return match[1].slice(2) + match[2] + match[3];
}

function todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
}

function firstQuery(value) {
    if (Array.isArray(value)) return value[0];
    return value;
}

function findVideoUrl(html) {
    if (!html) return '';
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    let match;
    while ((match = re.exec(html))) {
        let url = match[1];
        if (url.startsWith('//')) url = `https:${url}`;
        const lower = url.toLowerCase();
        const path = lower.split('?')[0].split('#')[0];
        if (
            lower.includes('youtube.com/embed') ||
            lower.includes('player.vimeo') ||
            path.endsWith('.mp4') ||
            path.endsWith('.webm')
        ) {
            return url;
        }
    }
    return '';
}

function cleanExplanation(html) {
    let text = stripHtml(html);
    text = text.replace(/^Explanation:\s*/i, '');
    text = text.replace(/\s*Tomorrow['\u2019]s picture:[\s\S]*$/i, '');
    return text.trim();
}

function toLegacyApod(item) {
    const isImage = item?.media_type === 'image';
    const copyright = stripHtml(item?.copyright || item?.credit);
    const legacy = {
        date: item?.date,
        title: stripHtml(item?.title),
        explanation: cleanExplanation(item?.explanation),
        media_type: isImage ? 'image' : 'video',
        url: isImage ? (item?.hdurl || '') : (findVideoUrl(item?.basic_html) || item?.permalink || ''),
        permalink: item?.permalink,
        service_version: 'apod-basic'
    };
    if (isImage) {
        legacy.hdurl = item?.hdurl || '';
    } else if (item?.hdurl) {
        legacy.thumbnail_url = item.hdurl;
    }
    if (copyright) legacy.copyright = copyright;
    return legacy;
}

function setApodHeaders(res, cache) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');
    if (cache) {
        res.setHeader('Cache-Control', 'public, max-age=1800');
    }
}

async function handleApod(query, res) {
    const startDate = firstQuery(query.start_date);
    const date = firstQuery(query.date);
    let feedUrl;
    let asList = false;

    if (startDate) {
        const from = toYYMMDD(String(startDate));
        const endRaw = firstQuery(query.end_date) || todayIsoDate();
        const to = toYYMMDD(String(endRaw));
        if (!from || !to) {
            setApodHeaders(res, false);
            return res.status(400).json({ error: 'Invalid APOD date' });
        }
        feedUrl = `${APOD_BASIC}?date_from=${from}&date_to=${to}&per_page=25`;
        asList = true;
    } else if (date) {
        const yymmdd = toYYMMDD(String(date));
        if (!yymmdd) {
            setApodHeaders(res, false);
            return res.status(400).json({ error: 'Invalid APOD date' });
        }
        feedUrl = `${APOD_BASIC}/${yymmdd}`;
    } else {
        feedUrl = `${APOD_BASIC}?per_page=1`;
    }

    const response = await fetch(feedUrl, {
        headers: { 'User-Agent': 'AstroCalTT/1.0' }
    });

    if (!response.ok) {
        setApodHeaders(res, false);
        return res.status(response.status).json({ error: `APOD feed error: ${response.status}` });
    }

    const data = await response.json();

    if (asList) {
        const items = Array.isArray(data) ? data : [];
        setApodHeaders(res, true);
        return res.status(200).json(items.filter((item) => item && item.date).map(toLegacyApod));
    }

    const item = Array.isArray(data) ? data[0] : data;
    if (!item || !item.date) {
        setApodHeaders(res, false);
        return res.status(404).json({ error: 'No APOD for that date' });
    }
    setApodHeaders(res, true);
    return res.status(200).json(toLegacyApod(item));
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (req.query?.path === 'planetary/apod') {
        try {
            return await handleApod(req.query, res);
        } catch (error) {
            console.error('APOD proxy error:', error);
            return res.status(500).json({ error: 'Failed to fetch APOD data' });
        }
    }

    const apiKey = process.env.NASA_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: 'NASA_API_KEY not configured',
            hint: 'Set NASA_API_KEY in Vercel project environment variables'
        });
    }

    const { path, ...rest } = req.query;
    if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'Missing path query parameter' });
    }

    const allowedPrefixes = ['planetary/apod', 'DONKI/FLR', 'DONKI/CME'];
    if (!allowedPrefixes.some((p) => path.startsWith(p))) {
        return res.status(400).json({ error: 'Unsupported NASA API path' });
    }

    try {
        const params = new URLSearchParams({ api_key: apiKey });
        Object.entries(rest).forEach(([key, value]) => {
            if (value != null && key !== 'path') {
                params.set(key, String(value));
            }
        });

        const nasaUrl = `https://api.nasa.gov/${path}?${params.toString()}`;
        const response = await fetch(nasaUrl, {
            headers: {
                'User-Agent': 'AstroCalTT/1.0',
                'Referer': 'https://astrocal.vercel.app/'
            }
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            return res.status(response.status).json({
                error: `NASA API error: ${response.statusText}`,
                details: body.substring(0, 200)
            });
        }

        const data = await response.json();

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=3600');

        return res.status(200).json(data);
    } catch (error) {
        console.error('NASA proxy error:', error);
        return res.status(500).json({ error: 'Failed to fetch NASA data' });
    }
}
