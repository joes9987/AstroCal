import { DEFAULT_CATEGORIES } from './config.js';
import {
    allEvents,
    filteredEvents,
    selectedCategories,
    eventsContainer,
    searchInput,
    applyFiltersButton,
    eventDetailSection,
    filterCheckboxes,
    locationButton,
    clearLocationButton,
    refreshNASAButton,
    loadingProgress,
    setApplyFiltersCallback
} from './state.js';
import {
    debounce,
    escapeHtml,
    extractYouTubeId,
    formatDateTime,
    formatTimeRemaining,
    getCategoryLabel,
    getTimeUntilEvent
} from './utils.js';
import { clearNASACache, loadAPOD, loadNASADataOther } from './nasa-api.js';
import { loadPlanetVisibility } from './planets.js';
import { requestUserLocation, clearSavedLocation } from './location.js';
import { shareEvent } from './calendar-export.js';
import { navigateToSkyMap } from './navigation.js';

export function updateSelectedCategories() {
    selectedCategories.clear();

    const checkboxes = document.querySelectorAll('.filter-checkbox input[type="checkbox"]');

    if (checkboxes.length === 0) {
        console.warn('No filter checkboxes found! Preserving default APOD selection.');
        selectedCategories.add('apod');
        return;
    }

    checkboxes.forEach(checkbox => {
        if (checkbox.checked) {
            selectedCategories.add(checkbox.value);
        }
    });
}

export function sortEventsByProximity(events) {
    const now = new Date();
    const upcoming = [];
    const past = [];

    events.forEach(event => {
        const eventDate = new Date(event.datetime);
        const diff = eventDate - now;

        if (diff >= 0) {
            upcoming.push({ event, timeUntil: diff });
        } else {
            past.push({ event, timeSince: Math.abs(diff) });
        }
    });

    upcoming.sort((a, b) => a.timeUntil - b.timeUntil);
    past.sort((a, b) => a.timeSince - b.timeSince);

    return [
        ...upcoming.map(item => item.event),
        ...past.map(item => item.event)
    ];
}

function createVisibilityInfo(visibility, visibilityWindow) {
    let info = '<div class="event-visibility">';

    if (visibilityWindow?.bestTime) {
        info += `<div><strong>Best viewing:</strong> ${escapeHtml(visibilityWindow.bestTime)}</div>`;
    }
    if (visibility?.direction) {
        info += `<div><strong>Direction:</strong> ${escapeHtml(visibility.direction)}</div>`;
    }
    if (visibility?.peak) {
        info += `<div><strong>Peak:</strong> ${escapeHtml(visibility.peak)}</div>`;
    }
    if (visibility?.elevation) {
        info += `<div><strong>Elevation:</strong> ${escapeHtml(visibility.elevation)}</div>`;
    }
    if (visibility?.azimuth) {
        info += `<div><strong>Azimuth:</strong> ${escapeHtml(visibility.azimuth)}</div>`;
    }

    info += '</div>';
    return info;
}

export function createEventCard(event) {
    const date = new Date(event.datetime);
    const formattedDate = formatDateTime(date);
    const categoryClass = `category-${event.category}`;
    const categoryLabel = getCategoryLabel(event.category);

    let imageHtml = '';
    if (event.category === 'apod' && event.imageUrl) {
        if (event.mediaType === 'video') {
            const isYouTube = event.imageUrl.includes('youtube.com') || event.imageUrl.includes('youtu.be');
            if (isYouTube) {
                const videoId = extractYouTubeId(event.imageUrl);
                if (videoId) {
                    const thumbnailUrl = event.thumbnailUrl || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
                    const fallbackThumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                    imageHtml = `
                        <div class="event-image-container">
                            <a href="${escapeHtml(event.imageUrl)}" target="_blank" rel="noopener noreferrer" class="event-video-thumbnail">
                                <img src="${escapeHtml(thumbnailUrl)}" alt="${escapeHtml(event.title)}" class="event-image" loading="lazy" onerror="this.src='${escapeHtml(fallbackThumbnail)}'">
                                <div class="video-play-overlay">▶</div>
                            </a>
                            <span class="video-label">Video</span>
                        </div>
                    `;
                } else {
                    imageHtml = `<div class="event-video-link"><a href="${escapeHtml(event.imageUrl)}" target="_blank" rel="noopener noreferrer">Watch Video →</a></div>`;
                }
            } else {
                imageHtml = `
                    <div class="event-video-container">
                        <video class="event-image" controls preload="metadata" loading="lazy">
                            <source src="${escapeHtml(event.imageUrl)}" type="video/mp4">
                            Your browser does not support the video tag.
                        </video>
                    </div>
                `;
            }
        } else {
            const hdFallback = event.hdImageUrl && event.hdImageUrl !== event.imageUrl
                ? event.hdImageUrl
                : '';
            const onerror = hdFallback
                ? `this.onerror=function(){this.onerror=null;this.style.display='none';};this.src='${escapeHtml(hdFallback)}'`
                : `this.onerror=null;this.style.display='none'`;
            imageHtml = `<img src="${escapeHtml(event.imageUrl)}" alt="${escapeHtml(event.title)}" class="event-image" loading="lazy" onerror="${onerror}">`;
        }
    } else if (event.imageUrl && event.mediaType === 'image') {
        imageHtml = `<img src="${escapeHtml(event.imageUrl)}" alt="${escapeHtml(event.title)}" class="event-image" loading="lazy">`;
    }

    const timeInfo = getTimeUntilEvent(event.datetime);
    const timeDisplay = formatTimeRemaining(timeInfo.timeRemaining, timeInfo.passed);
    const timeClass = timeInfo.passed ? 'event-time-passed' : 'event-time-upcoming';
    const timeIcon = timeInfo.passed ? '⏰' : '⏳';
    const passedBadge = timeInfo.passed ? '<span class="event-passed-badge">Past Event</span>' : '';
    const issBadge = event.approximate ? '<span class="event-passed-badge">Approximate visibility</span>' : '';
    const skyMapBtn = (event.category === 'planet' && event.planetName)
        ? `<button type="button" class="filter-action-btn sky-map-link" data-sky-target="${escapeHtml(event.planetName)}">Show in Sky Map</button>`
        : '';

    return `
        <article class="event-card ${timeInfo.passed ? 'event-card-passed' : ''}" role="listitem" tabindex="0" aria-label="${event.title}" data-event-datetime="${event.datetime}">
            <div class="event-header">
                <h3 class="event-title">${escapeHtml(event.title)}</h3>
                <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
                    ${passedBadge}
                    ${issBadge}
                    <span class="event-category ${categoryClass}">${categoryLabel}</span>
                </div>
            </div>
            ${imageHtml}
            ${event.fallbackNote ? `<p class="apod-fallback-note">${escapeHtml(event.fallbackNote)}</p>` : ''}
            <div class="event-datetime">
                📅 ${formattedDate}
            </div>
            <div class="event-countdown ${timeClass}" data-event-datetime="${event.datetime}">
                ${timeIcon} <span class="countdown-text">${timeDisplay}</span>
            </div>
            <p class="event-description">${escapeHtml(event.description)}</p>
            ${event.location ? `<div class="event-location">📍 ${escapeHtml(event.location)}</div>` : ''}
            ${event.visibility || event.visibilityWindow ? createVisibilityInfo(event.visibility, event.visibilityWindow) : ''}
            ${skyMapBtn}
            ${event.source ? `<div class="event-source">Source: ${escapeHtml(event.source)}</div>` : ''}
        </article>
    `;
}

function updateCountdowns() {
    document.querySelectorAll('.event-countdown').forEach(countdownEl => {
        const eventDateTime = countdownEl.getAttribute('data-event-datetime');
        if (!eventDateTime) return;

        const timeInfo = getTimeUntilEvent(eventDateTime);
        const timeDisplay = formatTimeRemaining(timeInfo.timeRemaining, timeInfo.passed);
        const timeClass = timeInfo.passed ? 'event-time-passed' : 'event-time-upcoming';
        const timeIcon = timeInfo.passed ? '⏰' : '⏳';

        countdownEl.className = `event-countdown ${timeClass}`;
        const textSpan = countdownEl.querySelector('.countdown-text');
        if (textSpan) {
            textSpan.textContent = timeDisplay;
        } else {
            countdownEl.innerHTML = `${timeIcon} <span class="countdown-text">${timeDisplay}</span>`;
        }

        const card = countdownEl.closest('.event-card');
        if (card) {
            if (timeInfo.passed) {
                card.classList.add('event-card-passed');
            } else {
                card.classList.remove('event-card-passed');
            }
        }
    });
}

function startCountdownTimers() {
    if (window.countdownInterval) {
        clearInterval(window.countdownInterval);
    }

    updateCountdowns();
    window.countdownInterval = setInterval(updateCountdowns, 1000);
}

export function renderEvents() {
    if (!eventsContainer) return;

    if (filteredEvents.length === 0) {
        eventsContainer.innerHTML = `
            <div class="no-events">
                <div class="no-events-icon">🔭</div>
                <p>No events found matching your criteria.</p>
                <p style="margin-top: 0.5rem; font-size: 0.9rem; opacity: 0.7;">Try adjusting your filters or search terms.</p>
            </div>
        `;
        return;
    }

    const hasISSEvents = filteredEvents.some(e => e.category === 'iss');
    const issCategorySelected = selectedCategories.has('iss');
    let issNote = '';

    if (issCategorySelected && !hasISSEvents && allEvents.length > 0) {
        const hasAnyISS = allEvents.some(e => e.category === 'iss');
        if (!hasAnyISS) {
            issNote = `
                <div style="grid-column: 1 / -1; padding: 1rem; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 1rem;">
                    <p style="color: var(--text-secondary); font-size: 0.9rem;">
                        <strong>Note:</strong> ISS passes are currently unavailable due to API access restrictions.
                        Other events are still available.
                    </p>
                </div>
            `;
        }
    }

    eventsContainer.innerHTML = issNote + filteredEvents.map(event => createEventCard(event)).join('');

    document.querySelectorAll('.event-card').forEach((card, index) => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.sky-map-link')) return;
            const actualIndex = issNote ? index - 1 : index;
            if (actualIndex >= 0 && actualIndex < filteredEvents.length) {
                showEventDetail(filteredEvents[actualIndex]);
            }
        });
    });

    document.querySelectorAll('.sky-map-link').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const target = btn.getAttribute('data-sky-target');
            if (target) navigateToSkyMap(target);
        });
    });

    startCountdownTimers();
}

export function showEventDetail(event) {
    if (!eventDetailSection) return;

    const date = new Date(event.datetime);
    const formattedDate = formatDateTime(date);
    const categoryClass = `category-${event.category}`;
    const categoryLabel = getCategoryLabel(event.category);

    let imageHtml = '';
    if (event.category === 'apod' && event.imageUrl) {
        if (event.mediaType === 'video') {
            const isYouTube = event.imageUrl.includes('youtube.com') || event.imageUrl.includes('youtu.be');
            if (isYouTube) {
                const videoId = extractYouTubeId(event.imageUrl);
                if (videoId) {
                    imageHtml = `
                        <div class="event-detail-video">
                            <iframe
                                src="https://www.youtube.com/embed/${videoId}"
                                frameborder="0"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowfullscreen
                                loading="lazy"
                                title="${escapeHtml(event.title)}"
                                referrerpolicy="no-referrer-when-downgrade">
                            </iframe>
                            <a href="${escapeHtml(event.imageUrl)}" target="_blank" rel="noopener noreferrer" class="external-link">Watch on YouTube →</a>
                        </div>
                    `;
                } else {
                    imageHtml = `<div class="event-video-link"><a href="${escapeHtml(event.imageUrl)}" target="_blank" rel="noopener noreferrer">Watch Video on YouTube →</a></div>`;
                }
            } else {
                imageHtml = `
                    <div class="event-detail-video">
                        <video controls preload="metadata" loading="lazy">
                            <source src="${escapeHtml(event.imageUrl)}" type="video/mp4">
                            Your browser does not support the video tag.
                        </video>
                    </div>
                `;
            }
        } else {
            imageHtml = `
                <div class="event-detail-image">
                    <img src="${escapeHtml(event.imageUrl)}" alt="${escapeHtml(event.title)}" loading="lazy">
                    ${event.hdImageUrl ? `<a href="${escapeHtml(event.hdImageUrl)}" target="_blank" rel="noopener noreferrer" class="hd-link">View HD Image</a>` : ''}
                </div>
            `;
        }
    } else if (event.imageUrl && event.mediaType === 'image') {
        imageHtml = `
            <div class="event-detail-image">
                <img src="${escapeHtml(event.imageUrl)}" alt="${escapeHtml(event.title)}" loading="lazy">
            </div>
        `;
    }

    const skyMapBtn = (event.category === 'planet' && event.planetName)
        ? `<button type="button" class="filter-action-btn" id="detailSkyMapBtn" data-sky-target="${escapeHtml(event.planetName)}">Show in Sky Map</button>`
        : '';

    eventDetailSection.innerHTML = `
        <h2>${escapeHtml(event.title)}</h2>
        <div class="event-header">
            <span class="event-category ${categoryClass}">${categoryLabel}</span>
            ${event.approximate ? '<span class="event-passed-badge">Approximate visibility</span>' : ''}
        </div>
        ${imageHtml}
        ${event.fallbackNote ? `<p class="apod-fallback-note">${escapeHtml(event.fallbackNote)}</p>` : ''}
        <div class="event-datetime">📅 ${formattedDate}</div>
        ${event.location ? `<div class="event-location">📍 ${escapeHtml(event.location)}</div>` : ''}
        <p class="event-description">${escapeHtml(event.description)}</p>
        ${event.visibility || event.visibilityWindow ? createVisibilityInfo(event.visibility, event.visibilityWindow) : ''}
        ${event.source ? `<div class="event-source">Source: ${escapeHtml(event.source)}</div>` : ''}
        <div style="display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap;">
            ${skyMapBtn}
            <button type="button" class="filter-action-btn" id="detailShareBtn">Share</button>
        </div>
    `;

    const shareBtn = document.getElementById('detailShareBtn');
    if (shareBtn) shareBtn.addEventListener('click', () => shareEvent(event));
    const skyBtn = document.getElementById('detailSkyMapBtn');
    if (skyBtn) {
        skyBtn.addEventListener('click', () => {
            const target = skyBtn.getAttribute('data-sky-target');
            if (target) navigateToSkyMap(target);
        });
    }

    eventDetailSection.classList.add('active');
    eventDetailSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function hideEventDetail() {
    if (eventDetailSection) {
        eventDetailSection.classList.remove('active');
    }
}

export function applyFilters() {
    updateSelectedCategories();

    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

    const anyCheckboxChecked = Array.from(document.querySelectorAll('.filter-checkbox input[type="checkbox"]')).some(cb => cb.checked);
    if (selectedCategories.size === 0 && !anyCheckboxChecked) {
        selectedCategories.add('apod');
        const apodCheckbox = document.querySelector('.filter-checkbox input[type="checkbox"][value="apod"]');
        if (apodCheckbox) {
            apodCheckbox.checked = true;
        }
    }

    const filtered = allEvents.filter(event => {
        if (!selectedCategories.has(event.category)) {
            return false;
        }

        if (searchTerm) {
            const searchableText = `
                ${event.title}
                ${event.description}
                ${event.location || ''}
                ${event.category}
            `.toLowerCase();

            if (!searchableText.includes(searchTerm)) {
                return false;
            }
        }

        return true;
    });

    filteredEvents.length = 0;
    filteredEvents.push(...sortEventsByProximity(filtered));

    renderEvents();
}

export function updateFilterCheckboxes(actualCategories) {
    const filterOptions = document.querySelector('.filter-options');
    if (!filterOptions) return;

    const categoryLabels = {
        meteor: 'Meteor Shower',
        planet: 'Planet Visibility',
        iss: 'ISS Passes (Real-time predictions)',
        apod: 'NASA APOD (Daily astronomy image)',
        solar: 'Solar Events (Flares & CMEs)',
        astronomy: 'Open-Meteo Astronomy (Moon phases & sun events)',
        natural: 'Natural Events (Fireballs & aurora)'
    };

    filterOptions.innerHTML = '';

    actualCategories.forEach(category => {
        const label = document.createElement('label');
        label.className = 'filter-checkbox';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = category;
        checkbox.checked = selectedCategories.has(category);

        const span = document.createElement('span');
        span.textContent = categoryLabels[category] || category;

        label.appendChild(checkbox);
        label.appendChild(span);
        filterOptions.appendChild(label);
    });

    setupEventListeners();
}

export function setupEventListeners() {
    if (!searchInput) return;

    searchInput.addEventListener('input', debounce(() => {
        applyFilters();
    }, 300));

    const checkboxes = document.querySelectorAll('.filter-checkbox input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            applyFilters();
        });
    });

    if (applyFiltersButton) {
        applyFiltersButton.addEventListener('click', () => {
            applyFilters();
        });
    }

    if (locationButton) {
        locationButton.addEventListener('click', requestUserLocation);
    }

    if (clearLocationButton) {
        clearLocationButton.addEventListener('click', clearSavedLocation);
    }

    if (refreshNASAButton) {
        refreshNASAButton.addEventListener('click', () => {
            refreshNASAButton.disabled = true;
            refreshNASAButton.textContent = '🔄 Refreshing...';
            clearNASACache();

            loadingProgress.total = 3;
            loadingProgress.completed = 0;
            loadingProgress.tasks = { apod: false, nasaData: false, planetVisibility: false };
            showLoadingProgress();

            Promise.all([
                loadAPOD(true).then(apodEvent => {
                    updateLoadingProgress('apod');
                    if (apodEvent) {
                        const kept = allEvents.filter(e => e.category !== 'apod');
                        allEvents.length = 0;
                        allEvents.push(...kept, apodEvent);
                        window.allEvents = allEvents;
                        allEvents.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
                    }
                    return apodEvent;
                }),
                loadNASADataOther(true).then(() => updateLoadingProgress('nasaData')),
                loadPlanetVisibility(true).then(() => updateLoadingProgress('planetVisibility'))
            ]).then(() => {
                refreshNASAButton.disabled = false;
                refreshNASAButton.textContent = '🔄 Refresh NASA Data';
                hideLoadingProgress();
                applyFilters();
            });
        });
    }

    if (eventDetailSection) {
        document.addEventListener('click', (e) => {
            if (!eventDetailSection.contains(e.target) &&
                !e.target.closest('.event-card')) {
                hideEventDetail();
            }
        });
    }
}

export function switchView(viewType) {
    // Placeholder for future view modes
}

export function registerFilters() {
    setApplyFiltersCallback(applyFilters);
}
