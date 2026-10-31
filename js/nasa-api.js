import { CACHE_KEYS, getNASAConfig } from './config.js';
import {
    allEvents,
    selectedCategories,
    triggerApplyFilters,
    syncWindowAllEvents
} from './state.js';

export async function nasaFetch(path, queryParams = {}) {
    const config = getNASAConfig();
    const params = new URLSearchParams({ path, ...queryParams });
    let url;
    if (config?.useProxy) {
        const proxyBase = config.proxyUrl || '/api/nasa';
        url = `${proxyBase}?${params.toString()}`;
    } else if (config?.apiKey) {
        params.set('api_key', config.apiKey);
        url = `${config.baseUrl}/${path}?${params.toString()}`;
    } else {
        throw new Error('NASA API not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
        return await fetch(url, { mode: 'cors', credentials: 'omit', signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

export function isCacheValid(cacheKey, maxAge) {
    const cached = localStorage.getItem(cacheKey);
    if (!cached) return false;

    try {
        const data = JSON.parse(cached);
        const age = Date.now() - data.timestamp;
        return age < maxAge;
    } catch (e) {
        return false;
    }
}

export function getCachedData(cacheKey) {
    try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            const data = JSON.parse(cached);
            return data.data;
        }
    } catch (e) {
        console.error('Error reading cache:', e);
    }
    return null;
}

export function setCachedData(cacheKey, data) {
    try {
        localStorage.setItem(cacheKey, JSON.stringify({
            data,
            timestamp: Date.now()
        }));
    } catch (e) {
        console.error('Error caching data:', e);
    }
}

export function clearNASACache() {
    localStorage.removeItem(CACHE_KEYS.apod);
    localStorage.removeItem(CACHE_KEYS.donki);
    localStorage.removeItem(CACHE_KEYS.eonet);
    localStorage.removeItem(APOD_FALLBACK_MISS_KEY);
}

const APOD_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const APOD_FALLBACK_DAYS = 30;
const APOD_FALLBACK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const APOD_FALLBACK_MISS_MAX_AGE_MS = 60 * 60 * 1000;
const APOD_FALLBACK_MISS_KEY = 'nasa_apod_fallback_miss';

function looksLikePhotoUrl(url) {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    const lower = trimmed.toLowerCase();
    if (lower.includes('nasa-logo')) return false;
    const path = lower.split('?')[0].split('#')[0];
    return /\.(jpe?g|png|gif|webp|avif|bmp|tiff?)$/.test(path);
}

/** Image APODs whose url/hdurl is a NASA logo or otherwise not a photo. Videos are fine. */
function isUnusableApodImage(apodData) {
    if (!apodData || typeof apodData !== 'object') return true;
    if (apodData.media_type && apodData.media_type !== 'image') return false;
    const present = [apodData.url, apodData.hdurl].filter(url => typeof url === 'string' && url.trim());
    if (present.length === 0) return true;
    return !present.some(looksLikePhotoUrl);
}

function pickPhotoUrl(apodData) {
    return [apodData?.url, apodData?.hdurl].find(looksLikePhotoUrl) || '';
}

function formatApodDay(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!match) return '';
    const month = APOD_MONTHS[Number(match[2]) - 1];
    if (!month) return '';
    return `${month} ${Number(match[3])}, ${match[1]}`;
}

function apodFallbackNote(dateStr) {
    const pretty = formatApodDay(dateStr);
    const dated = pretty ? ` (${pretty})` : '';
    return `Showing the last available picture${dated} - today's image isn't available from NASA yet.`;
}

function shiftIsoDate(isoDate, days) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
    const base = match
        ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
        : new Date();
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
}

function readGoodCachedApod(cacheKey) {
    const cached = getCachedData(cacheKey);
    if (!cached) return null;
    if (isUnusableApodImage(cached)) {
        localStorage.removeItem(cacheKey);
        return null;
    }
    return cached;
}

function convertAPODToEvent(apodData, options = {}) {
    const imageMedia = !apodData.media_type || apodData.media_type === 'image';
    const photoUrl = pickPhotoUrl(apodData);
    const event = {
        id: `apod-${apodData.date}`,
        title: apodData.title || 'NASA Astronomy Picture of the Day',
        category: 'apod',
        datetime: `${apodData.date}T12:00:00Z`,
        description: apodData.explanation || 'Daily astronomy image from NASA.',
        location: 'NASA',
        imageUrl: imageMedia ? (photoUrl || apodData.url) : apodData.url,
        mediaType: apodData.media_type,
        hdImageUrl: imageMedia
            ? (looksLikePhotoUrl(apodData.hdurl) ? apodData.hdurl : undefined)
            : apodData.hdurl,
        thumbnailUrl: apodData.thumbnail_url,
        source: 'NASA APOD'
    };
    if (options.fallback) {
        event.fallbackNote = apodFallbackNote(apodData.date);
    }
    return event;
}

async function fetchApodByDate(dateStr) {
    const response = await nasaFetch('planetary/apod', dateStr ? { date: dateStr } : {});
    if (!response.ok) {
        throw new Error(`APOD API error! status: ${response.status}`);
    }
    return response.json();
}

async function findEarlierGoodApod(fromDate) {
    for (let daysBack = 1; daysBack <= APOD_FALLBACK_DAYS; daysBack++) {
        const dateStr = shiftIsoDate(fromDate, -daysBack);
        try {
            const data = await fetchApodByDate(dateStr);
            if (data && !isUnusableApodImage(data)) {
                return data;
            }
        } catch (error) {
            console.warn(`APOD lookup failed for ${dateStr}:`, error);
        }
    }
    return null;
}

function clearApodFallbackMiss() {
    localStorage.removeItem(APOD_FALLBACK_MISS_KEY);
}

function rememberApodFallbackMiss() {
    setCachedData(APOD_FALLBACK_MISS_KEY, { missed: true });
}

function hasRecentApodFallbackMiss() {
    return isCacheValid(APOD_FALLBACK_MISS_KEY, APOD_FALLBACK_MISS_MAX_AGE_MS);
}

/**
 * Today's picture is unusable. Reuse a fresh cached photo, or walk back one
 * day at a time. A miss is remembered so the next loads do not walk again.
 */
async function resolveApodFallback(cacheKey, fromDate) {
    const cached = readGoodCachedApod(cacheKey);
    if (cached && isCacheValid(cacheKey, APOD_FALLBACK_MAX_AGE_MS)) {
        console.log('Using cached APOD fallback:', cached.date);
        return convertAPODToEvent(cached, { fallback: true });
    }

    if (hasRecentApodFallbackMiss()) {
        if (cached) {
            console.log('Using cached APOD image after a recent search:', cached.date);
            return convertAPODToEvent(cached, { fallback: true });
        }
        console.warn('Skipping APOD walk-back; a recent search found no photo');
        return null;
    }

    const earlier = await findEarlierGoodApod(fromDate);
    if (earlier) {
        setCachedData(cacheKey, earlier);
        clearApodFallbackMiss();
        console.log('Using earlier APOD image:', earlier.date);
        return convertAPODToEvent(earlier, { fallback: true });
    }

    rememberApodFallbackMiss();
    if (cached) {
        console.log('Keeping previous APOD image; walk-back found nothing newer:', cached.date);
        return convertAPODToEvent(cached, { fallback: true });
    }

    console.warn(`No usable APOD image in the last ${APOD_FALLBACK_DAYS} days`);
    return null;
}

export async function loadAPOD(forceRefresh = false) {
    const config = getNASAConfig();
    if (!config) return null;

    const cacheKey = CACHE_KEYS.apod;
    const maxAge = config.cacheSettings.apod;

    if (!forceRefresh && isCacheValid(cacheKey, maxAge)) {
        const cached = readGoodCachedApod(cacheKey);
        if (cached) {
            console.log('Using cached APOD data');
            return convertAPODToEvent(cached);
        }
    }

    try {
        const data = await fetchApodByDate();

        if (!isUnusableApodImage(data)) {
            setCachedData(cacheKey, data);
            clearApodFallbackMiss();
            console.log('Loaded APOD:', data.title);
            return convertAPODToEvent(data);
        }

        console.warn('Today\'s APOD image is not a photo; using the last good picture');
        const fromDate = (data && typeof data.date === 'string') ? data.date : shiftIsoDate(null, 0);
        return resolveApodFallback(cacheKey, fromDate);
    } catch (error) {
        if (error.message.includes('CORS') || error.message.includes('NetworkError')) {
            console.warn('APOD API unavailable (CORS error), using cache if available');
        } else {
            console.error('Error loading APOD:', error);
        }

        const cached = readGoodCachedApod(cacheKey);
        if (cached) {
            console.log('Using cached APOD data due to API unavailability');
            return convertAPODToEvent(cached);
        }
        console.warn('No APOD data available (API failed and no cache)');
        return null;
    }
}

export async function loadAPODPriority() {
    const config = getNASAConfig();
    if (!config) return Promise.resolve();

    const cacheKey = CACHE_KEYS.apod;
    const cached = readGoodCachedApod(cacheKey);

    if (cached) {
        const cachedEvent = convertAPODToEvent(cached);
        allEvents.push(cachedEvent);
        syncWindowAllEvents();
        console.log('Showing cached APOD immediately:', cachedEvent.title);

        const apodCheckbox = document.querySelector('.filter-checkbox input[type="checkbox"][value="apod"]');
        if (apodCheckbox) {
            apodCheckbox.checked = true;
            selectedCategories.add('apod');
        }

        triggerApplyFilters();
    }

    return loadAPOD(true).then(apodEvent => {
        if (apodEvent) {
            if (cached && cached.date) {
                const kept = allEvents.filter(e => !(e.category === 'apod' && e.id === `apod-${cached.date}`));
                allEvents.length = 0;
                allEvents.push(...kept);
            } else {
                const kept = allEvents.filter(e => e.category !== 'apod');
                allEvents.length = 0;
                allEvents.push(...kept);
            }

            allEvents.push(apodEvent);
            syncWindowAllEvents();
            allEvents.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
            triggerApplyFilters();
            console.log('Updated with fresh APOD:', apodEvent.title);
        }
    }).catch(error => {
        console.error('Error refreshing APOD in background:', error);
    });
}

function convertDONKIToEvents(donkiData) {
    if (!Array.isArray(donkiData) || donkiData.length === 0) {
        return [];
    }

    return donkiData.map(event => {
        let datetime, title, description;

        if (event.type === 'solar_flare') {
            datetime = event.peakTime || event.beginTime || new Date().toISOString();
            title = `Solar Flare ${event.classType || 'Event'}`;
            description = `Solar flare detected. Class: ${event.classType || 'Unknown'}. Source location: ${event.sourceLocation || 'Unknown'}.`;
        } else if (event.type === 'cme') {
            datetime = event.startTime || new Date().toISOString();
            title = 'Coronal Mass Ejection (CME)';
            description = `CME detected. Speed: ${event.speed || 'Unknown'} km/s. Type: ${event.cmeType || 'Unknown'}.`;
        } else {
            datetime = event.beginTime || new Date().toISOString();
            title = 'Solar Event';
            description = 'Solar activity detected by NASA DONKI.';
        }

        return {
            id: `donki-${event.flrID || event.activityID || Date.now()}-${Math.random()}`,
            title,
            category: 'solar',
            datetime,
            description,
            location: 'Sun',
            source: 'NASA DONKI',
            eventType: event.type,
            rawData: event
        };
    }).filter(event => event.datetime);
}

export async function loadDONKI(forceRefresh = false) {
    const config = getNASAConfig();
    if (!config) return [];

    const cacheKey = CACHE_KEYS.donki;
    const maxAge = config.cacheSettings.donki;

    if (!forceRefresh && isCacheValid(cacheKey, maxAge)) {
        const cached = getCachedData(cacheKey);
        if (cached && cached.length > 0) {
            console.log('Using cached DONKI data');
            return convertDONKIToEvents(cached);
        }
    }

    try {
        const { startDate, endDate } = config.dateRanges.donki;
        const flrResponse = await nasaFetch('DONKI/FLR', { startDate, endDate });

        let solarEvents = [];

        if (flrResponse.ok) {
            const flrData = await flrResponse.json();
            if (Array.isArray(flrData) && flrData.length > 0) {
                solarEvents = solarEvents.concat(flrData.map(event => ({
                    ...event,
                    type: 'solar_flare'
                })));
            }
        } else {
            console.warn('DONKI FLR failed:', flrResponse.status, flrResponse.statusText);
        }

        const cmeResponse = await nasaFetch('DONKI/CME', { startDate, endDate });

        if (cmeResponse.ok) {
            const cmeData = await cmeResponse.json();
            if (Array.isArray(cmeData) && cmeData.length > 0) {
                solarEvents = solarEvents.concat(cmeData.map(event => ({
                    ...event,
                    type: 'cme'
                })));
            }
        } else {
            console.warn('DONKI CME failed:', cmeResponse.status, cmeResponse.statusText);
        }

        if (solarEvents.length > 0) {
            setCachedData(cacheKey, solarEvents);
        }

        console.log(`Loaded ${solarEvents.length} solar events from DONKI`);
        return convertDONKIToEvents(solarEvents);
    } catch (error) {
        if (error.message.includes('CORS') || error.message.includes('NetworkError')) {
            console.warn('DONKI API unavailable (CORS error), using cache if available');
        } else {
            console.error('Error loading DONKI data:', error);
        }

        const cached = getCachedData(cacheKey);
        if (cached && cached.length > 0) {
            return convertDONKIToEvents(cached);
        }
        return [];
    }
}

function convertEONETToEvents(eonetData) {
    if (!Array.isArray(eonetData) || eonetData.length === 0) {
        return [];
    }

    return eonetData.map(event => {
        const geometry = event.geometry && event.geometry[0];
        const category = event.categories && event.categories[0];

        let location = 'Earth';
        if (geometry && geometry.coordinates) {
            location = `${geometry.coordinates[1].toFixed(2)}°, ${geometry.coordinates[0].toFixed(2)}°`;
        }

        return {
            id: `eonet-${event.id}`,
            title: event.title || 'Natural Event',
            category: 'natural',
            datetime: geometry ? geometry.date : new Date().toISOString(),
            description: `${category ? category.title + ': ' : ''}${event.title || 'Natural event detected by NASA EONET.'}`,
            location,
            source: 'NASA EONET',
            eventType: category ? category.title : 'Natural Event',
            rawData: event
        };
    }).filter(event => event.datetime);
}

export async function loadEONET(forceRefresh = false) {
    const config = getNASAConfig();
    if (!config) return [];

    const cacheKey = CACHE_KEYS.eonet;
    const maxAge = config.cacheSettings.eonet;

    if (!forceRefresh && isCacheValid(cacheKey, maxAge)) {
        const cached = getCachedData(cacheKey);
        if (cached && cached.events && cached.events.length > 0) {
            console.log('Using cached EONET data');
            return convertEONETToEvents(cached.events);
        }
    }

    try {
        const limit = 100;
        const proxyUrl = `/api/eonet?status=open&limit=${limit}`;
        const response = await fetch(proxyUrl, {
            mode: 'cors',
            credentials: 'omit'
        });

        if (!response.ok) {
            let errorDetails = '';
            try {
                const errorData = await response.json();
                errorDetails = errorData.error || errorData.details || '';
            } catch (e) {
                console.error('EONET proxy returned non-JSON error');
            }

            if (response.status === 503) {
                const cached = getCachedData(cacheKey);
                if (cached && cached.events && cached.events.length > 0) {
                    return convertEONETToEvents(cached.events);
                }
            }
            throw new Error(`EONET API error! status: ${response.status}${errorDetails ? ` - ${errorDetails}` : ''}`);
        }

        const data = await response.json();

        const astronomyCategoryIds = [
            'fireballs',
            'aurora',
            'atmospheric',
            'volcanoes'
        ];

        const astronomyEvents = (data.events || []).filter(event => {
            const categories = event.categories || [];
            return categories.some(cat => {
                const id = String(cat.id || '').toLowerCase();
                const title = (cat.title || cat.name || '').toLowerCase();

                if (astronomyCategoryIds.some(astroId => id.includes(astroId) || astroId.includes(id))) {
                    return true;
                }

                return title.includes('fireball') ||
                    title.includes('aurora') ||
                    title.includes('atmospheric') ||
                    title.includes('meteor') ||
                    title.includes('asteroid') ||
                    (title.includes('volcano') && title.includes('ash'));
            });
        });

        if (astronomyEvents.length > 0) {
            setCachedData(cacheKey, { events: astronomyEvents });
        }

        console.log(`Loaded ${astronomyEvents.length} natural events from EONET`);
        return convertEONETToEvents(astronomyEvents);
    } catch (error) {
        if (error.message.includes('CORS') || error.message.includes('NetworkError') || error.message.includes('503')) {
            console.warn('EONET API unavailable via proxy, using cache if available');
        } else {
            console.error('Error loading EONET data:', error);
        }

        const cached = getCachedData(cacheKey);
        if (cached && cached.events && cached.events.length > 0) {
            return convertEONETToEvents(cached.events);
        }
        return [];
    }
}

export async function loadNASADataOther(forceRefresh = false, revalidate = false) {
    try {
        console.log('=== Loading NASA Data (DONKI, EONET) ===');

        if (revalidate && !forceRefresh) {
            const [donkiCached, eonetCached] = await Promise.all([
                loadDONKI(false),
                loadEONET(false)
            ]);
            const cachedEvents = [
                ...(donkiCached || []),
                ...(eonetCached || [])
            ];
            if (cachedEvents.length > 0) {
                allEvents.push(...cachedEvents);
                syncWindowAllEvents();
                triggerApplyFilters();
            }
            forceRefresh = true;
        }

        const [donkiEvents, eonetEvents] = await Promise.all([
            loadDONKI(forceRefresh),
            loadEONET(forceRefresh)
        ]);

        const nasaEvents = [];

        if (donkiEvents && donkiEvents.length > 0) {
            nasaEvents.push(...donkiEvents);
        }

        if (eonetEvents && eonetEvents.length > 0) {
            nasaEvents.push(...eonetEvents);
        }

        const beforeCount = allEvents.length;

        if (forceRefresh) {
            const kept = allEvents.filter(e => e.category !== 'solar' && e.category !== 'natural');
            allEvents.length = 0;
            allEvents.push(...kept);
        }

        allEvents.push(...nasaEvents);
        allEvents.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
        syncWindowAllEvents();

        if (beforeCount > 0) {
            triggerApplyFilters();
        }

        return Promise.resolve();
    } catch (error) {
        console.error('Error loading NASA data:', error);
        return Promise.resolve();
    }
}
