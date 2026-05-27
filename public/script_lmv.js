/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright (C) 2025 MundoGIS.
 */


// --- Global State Variables (LMV) ---
// DOM elements are declared after DOMContentLoaded
let lmvForm, prepareBtn, resultMessage, downloadSection, downloadBtn;
let foundCollectionName, foundItemCount, downloadInfo, downloadLinksList;
let minLonInput, maxLonInput, minLatInput, maxLatInput;

// State variables
let currentCollectionId = null;
let currentWKTGeometry = null;
let currentApiKey = null;
let currentItemsCount = 0;

// --- Leaflet Map Initialisation ---
let map = null;
let drawnItems = null;

function initializeMap() {
    if (map) return; // Prevent re-initialisation

    map = L.map('mapid').setView([62, 15], 4); // Centred approximately on Sweden
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 18,
    }).addTo(map);

    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    const drawControl = new L.Control.Draw({
        edit: { featureGroup: drawnItems, remove: true },
        draw: {
            polygon: false, polyline: false, circle: false, marker: false, circlemarker: false,
            rectangle: { shapeOptions: { color: '#007bff' } }
        }
    });
    map.addControl(drawControl);

    // --- Map events ---
    map.on(L.Draw.Event.CREATED, function (event) {
        const layer = event.layer;
        const bounds = layer.getBounds();
        const southWest = bounds.getSouthWest(); const northEast = bounds.getNorthEast();
        const minLon = southWest.lng; const minLat = southWest.lat;
        const maxLon = northEast.lng; const maxLat = northEast.lat;

        // Store as GeoJSON instead of WKT
        currentWKTGeometry = {
            type: 'Polygon',
            coordinates: [[
                [minLon, minLat],
                [maxLon, minLat],
                [maxLon, maxLat],
                [minLon, maxLat],
                [minLon, minLat]
            ]]
        };
        console.log("Geometry from map (GeoJSON):", JSON.stringify(currentWKTGeometry));

        minLonInput.value = minLon.toFixed(6); maxLonInput.value = maxLon.toFixed(6);
        minLatInput.value = minLat.toFixed(6); maxLatInput.value = maxLat.toFixed(6);

        drawnItems.clearLayers();
        drawnItems.addLayer(layer);
        showMessage("Område definierat på kartan. Koordinatfälten har uppdaterats.", "success");
    });

    map.on(L.Draw.Event.DELETED, function() {
        currentWKTGeometry = null;
        minLonInput.value = ''; maxLonInput.value = '';
        minLatInput.value = ''; maxLatInput.value = '';
        console.log("WKT Geometry and coordinate fields cleared");
        showMessage("Området har tagits bort från kartan.", "info");
    });

    map.on(L.Draw.Event.EDITED, function (event) {
        event.layers.eachLayer(function (layer) {
            const bounds = layer.getBounds();
            const southWest = bounds.getSouthWest(); const northEast = bounds.getNorthEast();
            const minLon = southWest.lng; const minLat = southWest.lat;
            const maxLon = northEast.lng; const maxLat = northEast.lat;
            
            currentWKTGeometry = {
                type: 'Polygon',
                coordinates: [[
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat]
                ]]
            };
            console.log("Edited geometry (GeoJSON):", JSON.stringify(currentWKTGeometry));
            minLonInput.value = minLon.toFixed(6); maxLonInput.value = maxLon.toFixed(6);
            minLatInput.value = minLat.toFixed(6); maxLatInput.value = maxLat.toFixed(6);
        });
        showMessage("Området har redigerats på kartan. Koordinatfälten har uppdaterats.", "success");
    });
}

// --- Validate coordinate inputs and build a GeoJSON geometry ---
function validateAndGetWKTFromInputs() {
    if (!minLonInput || !maxLonInput || !minLatInput || !maxLatInput) return null;
    
    const minLonStr = minLonInput.value; const maxLonStr = maxLonInput.value;
    const minLatStr = minLatInput.value; const maxLatStr = maxLatInput.value;

    if (!minLonStr || !maxLonStr || !minLatStr || !maxLatStr) { return null; }

    const minLon = parseFloat(minLonStr); const maxLon = parseFloat(maxLonStr);
    const minLat = parseFloat(minLatStr); const maxLat = parseFloat(maxLatStr);

    if (isNaN(minLon) || isNaN(maxLon) || isNaN(minLat) || isNaN(maxLat) ||
        minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90 ||
        minLon >= maxLon || minLat >= maxLat) {
        return null;
    }
    
    // Return GeoJSON directly instead of WKT
    const geoJson = {
        type: 'Polygon',
        coordinates: [[
            [minLon, minLat],
            [maxLon, minLat],
            [maxLon, maxLat],
            [minLon, maxLat],
            [minLon, minLat]
        ]]
    };
    console.log("GeoJSON generated from coordinates:", JSON.stringify(geoJson));
    return geoJson;
}

// --- Message helpers ---
function showMessage(message, type) {
    const g = document.getElementById('global-notification');
    if (g) {
        // Map message type to Bulma CSS class
        let cls = 'is-info';
        if (type === 'error') cls = 'is-danger';
        else if (type === 'success') cls = 'is-success';
        g.className = `notification ${cls}`;
        g.textContent = message;
        g.style.display = 'block';
        // Auto-hide after 6 seconds
        clearTimeout(g._hideTimeout);
        g._hideTimeout = setTimeout(() => { g.style.display = 'none'; }, 6000);
    } else if (resultMessage) {
        resultMessage.textContent = message;
        resultMessage.className = '';
        resultMessage.classList.add('message', type);
    }
    if (downloadSection) downloadSection.style.display = 'none';
    if (downloadInfo) downloadInfo.style.display = 'none';
    if (downloadLinksList) downloadLinksList.innerHTML = '';
}

function clearMessages() {
    const g = document.getElementById('global-notification');
    if (g) { g.style.display = 'none'; clearTimeout(g._hideTimeout); }
    if (!resultMessage) return;
    resultMessage.textContent = '';
    resultMessage.className = '';
    if (downloadSection) downloadSection.style.display = 'none';
    if (downloadInfo) downloadInfo.style.display = 'none';
    if (downloadLinksList) downloadLinksList.innerHTML = '';
}

function disableButtons(disable) {
    if (prepareBtn) prepareBtn.disabled = disable;
    if (downloadBtn) downloadBtn.disabled = disable;
}

// --- Progress bar polling ---
// Polls /lmv/progress/:downloadId every 2 s and animates the progress bar.
function startProgressPolling(downloadId) {
    const section  = document.getElementById('progress-section');
    const label    = document.getElementById('progress-label');
    const bar      = document.getElementById('progress-bar');
    const detail   = document.getElementById('progress-detail');
    if (!section) return;

    section.style.display = 'block';
    bar.style.background  = '#3273dc';
    bar.style.width       = '0%';
    label.textContent     = 'Startar nedladdning...';
    detail.textContent    = '';

    const timer = setInterval(async () => {
        try {
            const res  = await fetch(`/lmv/progress/${encodeURIComponent(downloadId)}`);
            const data = await res.json();

            if (!data.found) {
                // Not in map yet (queue still being built) — keep waiting
                if (!data.active) {
                    // Download finished or was never registered
                    clearInterval(timer);
                    label.textContent    = 'Nedladdning klar ✓';
                    bar.style.width      = '100%';
                    bar.style.background = '#48c78e';
                    detail.textContent   = '';
                    setTimeout(() => { section.style.display = 'none'; }, 5000);
                }
                return;
            }

            const isCollectionMode = data.type === 'collections';
            const unit  = isCollectionMode ? 'samlingar' : 'filer';
            const pct   = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
            bar.style.width   = pct + '%';
            label.textContent = `${data.done} / ${data.total} ${unit} (${pct}%)`;
            if (data.currentFile) detail.textContent = data.currentFile;

            if (data.status === 'done' || data.status === 'cancelled') {
                clearInterval(timer);
                const failNote = data.failed > 0 ? ` — ${data.failed} misslyckades` : '';
                label.textContent    = data.status === 'cancelled'
                    ? 'Nedladdning avbruten.'
                    : `Klar! ${data.done} ${unit} hämtade${failNote}.`;
                bar.style.width      = '100%';
                bar.style.background = data.status === 'cancelled' ? '#f14668' : '#48c78e';
                detail.textContent   = '';
                setTimeout(() => { section.style.display = 'none'; }, 6000);
            }
        } catch (e) {
            console.warn('Progress poll error:', e.message);
        }
    }, 2000);
}

// ===== INITIALISATION WHEN DOM IS READY =====
document.addEventListener('DOMContentLoaded', function() {
    // Initialise DOM element references
    lmvForm = document.getElementById('lmv-form');
    prepareBtn = document.getElementById('prepare-btn');
    resultMessage = document.getElementById('result-message');
    downloadSection = document.getElementById('download-section');
    downloadBtn = document.getElementById('download-btn');
    foundCollectionName = document.getElementById('found-collection-name');
    foundItemCount = document.getElementById('found-item-count');
    downloadInfo = document.getElementById('download-info');
    downloadLinksList = document.getElementById('download-links-list');
    
    minLonInput = document.getElementById('min-lon');
    maxLonInput = document.getElementById('max-lon');
    minLatInput = document.getElementById('min-lat');
    maxLatInput = document.getElementById('max-lat');
    
    const fullDownloadBtn = document.getElementById('start-full-download-btn');
    const collectionSelect = document.getElementById('collection-select');
    const collectionLicenseDiv = document.getElementById('collection-license');
    const acceptLicenseCheckbox = document.getElementById('accept-license');
    
    let currentDownloadId = null;
    const stopBtn = document.getElementById('stop-download-btn');

    // Initialise the map
    initializeMap();
    
    // Note: localStorage and field visibility are handled by the inline script in lmv.html

    // ===== EVENT LISTENERS =====

    // Load collections dynamically from the backend
    async function loadCollections() {
        try {
            const res = await fetch('/lmv/collections');
            const json = await res.json();
            if (!json.success || !Array.isArray(json.collections)) return;

            // Clear and populate the select element
            collectionSelect.innerHTML = '';
            const emptyOpt = document.createElement('option');
            emptyOpt.value = '';
            emptyOpt.disabled = true;
            emptyOpt.selected = true;
            emptyOpt.textContent = '-- Välj en kollektion --';
            collectionSelect.appendChild(emptyOpt);

            json.collections.forEach(col => {
                const opt = document.createElement('option');
                opt.value = col.id || col.collection || col.title || '';
                opt.textContent = col.title || col.id || opt.value;
                // Store license in data attribute
                if (col.license) opt.dataset.license = col.license;
                collectionSelect.appendChild(opt);
            });
        } catch (e) {
            console.warn('Kunde inte ladda kollektioner:', e.message);
        }
    }

    // Call on page load
    loadCollections();

    collectionSelect.addEventListener('change', () => {
        const sel = collectionSelect.selectedOptions[0];
        const lic = sel ? sel.dataset.license : null;
        if (lic) {
            collectionLicenseDiv.style.display = 'block';
            collectionLicenseDiv.innerHTML = 'Licens: ' + lic + ' — <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC-BY-4.0</a>';
        } else {
            collectionLicenseDiv.style.display = 'none';
            collectionLicenseDiv.textContent = '';
        }
        // Reset the accept checkbox when the collection changes
        acceptLicenseCheckbox.checked = false;
    });
    
    // Main form submit event listener
    lmvForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearMessages();
        disableButtons(true);

        const authMethod = document.querySelector('input[name="auth-method"]:checked').value;
        const apiUsername = document.getElementById('apiUsername').value.trim();
        const apiKey = document.getElementById('apiKey').value.trim();
        const apiToken = document.getElementById('apiToken').value.trim();
        const collectionId = document.getElementById('collection-select').value;
        if (authMethod === 'userpass') {
            if (!apiUsername) { showMessage('Vänligen ange ditt användarnamn.', 'error'); disableButtons(false); return; }
            if (!apiKey) { showMessage('Ange systemkonto och lösenord.', 'error'); disableButtons(false); return; }
        } else {
            if (!apiToken) { showMessage('Vänligen ange din Auth token.', 'error'); disableButtons(false); return; }
        }
        if (!collectionId) { showMessage('Vänligen välj en datakollektion.', 'error'); disableButtons(false); return; }
        // Check license acceptance
        const selOpt = collectionSelect.selectedOptions[0];
        const license = selOpt ? selOpt.dataset.license : null;
        if (license && !acceptLicenseCheckbox.checked) {
            showMessage('Du måste godkänna licensvillkoren för den valda samlingen innan du fortsätter.', 'error');
            disableButtons(false);
            return;
        }

        let geometry = validateAndGetWKTFromInputs();
        if (!geometry) {
            showMessage('Vänligen rita en rektangel på kartan eller fyll i giltiga koordinater.', 'error');
            disableButtons(false);
            return;
        }

        const payload = {
            apiUsername,
            apiKey,
            apiToken: apiToken || undefined,
            collectionId,
            apiType: 'vektor',
            geometry: geometry
        };

        await triggerDownload(payload, document.getElementById('prepare-btn'), 'Starta nedladdning');

        setTimeout(() => { disableButtons(false); }, 1000);
    });

    async function triggerDownload(payload, button, label) {
        button.disabled = true;
        const originalText = button.textContent;
        button.textContent = 'Startar...';
        try {
            // Preflight validation
            try {
                const vres = await fetch('/lmv/validate', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiUsername: payload.apiUsername, apiKey: payload.apiKey, apiToken: payload.apiToken, collectionId: payload.collectionId, apiType: payload.apiType })
                });
                if (vres.status === 401 || vres.status === 403) {
                    showMessage('Fel: Ogiltigt systemkonto eller lösenord. Kontrollera dina uppgifter.', 'error');
                    return;
                }
            } catch (e) {
                console.warn('Validering misslyckades:', e.message);
            }

            const res = await fetch('/lmv/start-full-download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.status === 401 || res.status === 403) {
                showMessage('Fel: Ogiltigt systemkonto eller lösenord. Kontrollera dina uppgifter.', 'error');
                return;
            }

            const json = await res.json();
            if (json.success) {
                showMessage(json.message || 'Nedladdning startad i bakgrunden.', 'success');
                if (json.downloadId) {
                    currentDownloadId = json.downloadId;
                    if (stopBtn) stopBtn.style.display = 'inline-block';
                    startProgressPolling(json.downloadId);
                }
            } else {
                showMessage('Fel: ' + (json.error || 'okänt fel'), 'error');
            }
        } catch (e) {
            console.error('Fel vid start av nedladdning:', e);
            showMessage('Nätverksfel.', 'error');
        } finally {
            setTimeout(() => { button.disabled = false; button.textContent = originalText; }, 2000);
        }
    }

    // Manejar Stop-knapp
    if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
            if (!currentDownloadId) return;
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stoppar...';
            try {
                const res = await fetch('/lmv/cancel-download', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ downloadId: currentDownloadId })
                });
                const json = await res.json();
                if (json.success) showMessage('Nedladdning stoppad.', 'success');
                else showMessage('Kunde inte stoppa: ' + (json.error || 'okänt fel'), 'error');
            } catch (e) {
                showMessage('Nätverksfel vid stopp.', 'error');
            } finally {
                currentDownloadId = null;
                stopBtn.style.display = 'none';
                stopBtn.disabled = false;
                stopBtn.textContent = '⏹ Stoppa Nedladdning';
            }
        });
    }

    // Download button event listener (button kept for compatibility, directs user to the form)
    if (downloadBtn) {
        downloadBtn.addEventListener('click', async () => {
            showMessage('Använd formuläret ovan för att starta nedladdning.', 'info');
        });
    }

    // Full-country download button event listener — uses triggerDownload to allow cancellation
    fullDownloadBtn.addEventListener('click', async () => {
        console.log("Knappen 'Ladda ner hela Sverige' klickades.");

        const authMethod = document.querySelector('input[name="auth-method"]:checked').value;
        const apiUsername = document.getElementById('apiUsername').value.trim();
        const apiKey = document.getElementById('apiKey').value.trim();
        const apiToken = document.getElementById('apiToken').value.trim();
        const collectionId = document.getElementById('collection-select').value;

        if (authMethod === 'userpass' && (!apiUsername || !apiKey)) {
            showMessage('Ange systemkonto och lösenord innan du startar nedladdningen.', 'error');
            return;
        }
        if (authMethod === 'token' && !apiToken) {
            showMessage('Ange din Auth token innan du startar nedladdningen.', 'error');
            return;
        }
        if (!collectionId) {
            showMessage('Välj en samling innan du startar nedladdningen.', 'error');
            return;
        }
        // Check license acceptance for full-country download
        const selOpt = collectionSelect.selectedOptions[0];
        const license = selOpt ? selOpt.dataset.license : null;
        if (license && !acceptLicenseCheckbox.checked) {
            showMessage('Du måste godkänna licensvillkoren för den valda samlingen innan du fortsätter.', 'error');
            return;
        }

        let geometry = currentWKTGeometry || null;
        if (!geometry) {
            const minLon = parseFloat(minLonInput.value);
            const maxLon = parseFloat(maxLonInput.value);
            const minLat = parseFloat(minLatInput.value);
            const maxLat = parseFloat(maxLatInput.value);
            if (!isNaN(minLon) && !isNaN(maxLon) && !isNaN(minLat) && !isNaN(maxLat)) {
                geometry = {
                    type: 'Polygon',
                    coordinates: [[
                        [minLon, minLat],
                        [maxLon, minLat],
                        [maxLon, maxLat],
                        [minLon, maxLat],
                        [minLon, minLat]
                    ]]
                };
            }
        }

        const payload = {
            apiUsername: apiUsername,
            apiKey: apiKey,
            apiToken: apiToken || undefined,
            collectionId: collectionId,
            apiType: 'vektor',
            geometry: geometry || null
        };

        await triggerDownload(payload, fullDownloadBtn, '🚀 Starta nedladdning för hela Sverige');
        setTimeout(() => { disableButtons(false); }, 3000);
    });

    // --- Diagnostic: test dl1 access ---
    const diagBtn = document.getElementById('diag-test-btn');
    const diagResult = document.getElementById('diag-result');
    if (diagBtn) {
        diagBtn.addEventListener('click', async () => {
            const diagUrl = document.getElementById('diag-url').value.trim();
            if (!diagUrl) { diagResult.textContent = 'Ange en URL att testa.'; diagResult.style.display = 'block'; return; }
            const authMethod = document.querySelector('input[name="auth-method"]:checked').value;
            const apiUsername = document.getElementById('apiUsername').value.trim();
            const apiKey = document.getElementById('apiKey').value.trim();
            const apiToken = document.getElementById('apiToken').value.trim();
            diagBtn.disabled = true;
            diagBtn.textContent = 'Testar...';
            diagResult.style.display = 'none';
            try {
                const res = await fetch('/lmv/test-dl1', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: diagUrl, apiUsername: apiUsername || undefined, apiKey: apiKey || undefined, apiToken: apiToken || undefined })
                });
                const json = await res.json();
                let out = `URL: ${json.url}\n\n`;
                (json.results || []).forEach(r => {
                    out += `[${r.method}] HTTP ${r.status ?? 'FEL'} ${r.error ? '→ ' + r.error : ''}`;
                    if (r.contentLength) out += ` | Storlek: ${(parseInt(r.contentLength)/1024/1024).toFixed(1)} MB`;
                    out += '\n';
                });
                if (json.success) {
                    out += '\n✅ Åtkomst fungerar med en av metoderna ovan.';
                } else {
                    out += '\n❌ Ingen metod gav åtkomst (403/401 = inga rättigheter på detta dataset, kontakta Lantmäteriet).';
                }
                diagResult.textContent = out;
                diagResult.style.display = 'block';
            } catch (e) {
                diagResult.textContent = 'Nätverksfel: ' + e.message;
                diagResult.style.display = 'block';
            } finally {
                diagBtn.disabled = false;
                diagBtn.textContent = 'Testa åtkomst';
            }
        });
    }
});
