document.addEventListener('DOMContentLoaded', async () => {
    /*
     * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
     * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
     * Copyright (C) 2025 MundoGIS.
     */

    
    // 1. Initialise map
    const map = L.map('mapid').setView([62, 15], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    const drawControl = new L.Control.Draw({
        draw: { polygon: true, marker: false, circle: false, rectangle: true, polyline: false, circlemarker: false },
        edit: { featureGroup: drawnItems }
    });
    map.addControl(drawControl);

    const lanSelect = document.getElementById('lan-select');
    const hojdCollectionSelect = document.getElementById('hojd-collection-select');
    const hojdCollectionLicenseDiv = document.getElementById('hojd-collection-license');
    const hojdAcceptLicenseCheckbox = document.getElementById('hojd-accept-license');
    const clearGeometryBtn = document.getElementById('clear-geometry-btn');
    const geometryIndicator = document.getElementById('geometry-indicator');

    const defaultLanStyle = { color: '#5c6f82', weight: 1, fillOpacity: 0, interactive: false };
    const selectedLanStyle = { color: '#ff6b00', weight: 2, fillOpacity: 0.1, interactive: false };
    const lanLayer = L.geoJSON(null, {
        style: () => defaultLanStyle,
        pane: 'overlayPane',
        onEachFeature: (feature, layer) => {
            const lanName = feature.properties.Lan || feature.properties.lan || `Län ${feature.properties.id}`;
            const center = layer.getBounds().getCenter();
            L.marker(center, {
                icon: L.divIcon({
                    className: 'lan-label',
                    html: `<div style="font-size:11px;font-weight:600;color:#333;text-shadow:1px 1px 2px white,-1px -1px 2px white,1px -1px 2px white,-1px 1px 2px white;white-space:nowrap;pointer-events:none;">${lanName}</div>`,
                    iconSize: [0, 0]
                }),
                interactive: false
            }).addTo(map);
        }
    }).addTo(map);

    let lanFeatures = [];
    let selectedLanId = null;
    let currentGeometry = null;
    let currentGeometryLabel = 'Ingen geometri vald.';
    let currentGeometryName = null;

    function updateGeometryIndicator() {
        geometryIndicator.textContent = currentGeometryLabel;
    }

    function applyLanStyle() {
        lanLayer.eachLayer(layer => {
            const isSelected = selectedLanId !== null && String(layer.feature.properties.id) === String(selectedLanId);
            layer.setStyle(isSelected ? selectedLanStyle : defaultLanStyle);
        });
    }

    function setCurrentGeometry(geometry, label, name = null) {
        currentGeometry = geometry;
        currentGeometryLabel = label || 'Geometri vald.';
        currentGeometryName = name;
        updateGeometryIndicator();
    }

    function clearGeometry() {
        drawnItems.clearLayers();
        lanSelect.value = '';
        selectedLanId = null;
        currentGeometry = null;
        currentGeometryLabel = 'Ingen geometri vald.';
        currentGeometryName = null;
        applyLanStyle();
        updateGeometryIndicator();
    }

    map.on(L.Draw.Event.CREATED, (e) => {
        drawnItems.clearLayers();
        drawnItems.addLayer(e.layer);
        const geojson = e.layer.toGeoJSON();
        lanSelect.value = '';
        selectedLanId = null;
        applyLanStyle();
        setCurrentGeometry(geojson.geometry, 'Ritad polygon');
        console.log('Geometría capturada (GeoJSON):', geojson.geometry);
    });

    map.on(L.Draw.Event.DELETED, () => {
        if (!lanSelect.value) {
            currentGeometry = null;
            currentGeometryLabel = 'Ingen geometri vald.';
            currentGeometryName = null;
            updateGeometryIndicator();
        }
    });

    clearGeometryBtn.addEventListener('click', () => {
        clearGeometry();
    });

    async function loadLanData() {
        try {
            const res = await fetch('/lmv/lan');
            const payload = await res.json();
            if (!payload.success || !payload.data) {
                throw new Error('Ogiltigt svar från servern');
            }

            lanFeatures = payload.data.features || [];
            lanLayer.addData(payload.data);
            lanFeatures.forEach(feature => {
                const opt = document.createElement('option');
                const lanName = feature.properties.Lan || feature.properties.lan || `Län ${feature.properties.id}`;
                opt.value = feature.properties.id;
                opt.textContent = lanName;
                lanSelect.appendChild(opt);
            });
            applyLanStyle();
        } catch (err) {
            console.error('Kunde inte ladda län:', err.message);
        }
    }

    await loadLanData();

    // Load height (höjd) collections via the API (requires API Key in header)
    async function loadHojdCollections() {
        const authMethod = document.querySelector('input[name="auth-method"]:checked').value;
        const apiKey = document.getElementById('apiKey').value;
        const apiToken = document.getElementById('apiToken').value;
        if (!hojdCollectionSelect) return; // nothing to do if select is removed from DOM
        try {
            const headers = {};
            if (authMethod === 'token' && apiToken) headers['Authorization'] = `Bearer ${apiToken}`;
            if (authMethod === 'userpass' && apiKey) headers['X-API-Key'] = apiKey;
            const res = await fetch('/lmv/hojd/collections', { headers });
            const json = await res.json();
            if (!json.success || !Array.isArray(json.collections)) return;

            hojdCollectionSelect.innerHTML = '';
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.selected = true;
            noneOpt.textContent = '– Ingen samling vald –';
            hojdCollectionSelect.appendChild(noneOpt);

            json.collections.forEach(col => {
                const opt = document.createElement('option');
                opt.value = col.id || col.title || '';
                opt.textContent = col.title || col.id || opt.value;
                if (col.license) opt.dataset.license = col.license;
                hojdCollectionSelect.appendChild(opt);
            });
        } catch (e) {
            console.warn('Kunde inte ladda höjd-kollektioner:', e.message);
        }
    }

    // Reload collections when the API key or token changes
    document.getElementById('apiKey').addEventListener('change', loadHojdCollections);
    document.getElementById('apiKey').addEventListener('blur', loadHojdCollections);
    document.getElementById('apiToken').addEventListener('change', loadHojdCollections);
    document.getElementById('apiToken').addEventListener('blur', loadHojdCollections);
    const authRadios = document.getElementsByName('auth-method');
    Array.from(authRadios).forEach(r => r.addEventListener('change', loadHojdCollections));

    if (hojdCollectionSelect) {
        hojdCollectionSelect.addEventListener('change', () => {
            const sel = hojdCollectionSelect.selectedOptions[0];
            const lic = sel ? sel.dataset.license : null;
            if (lic) {
                hojdCollectionLicenseDiv.style.display = 'block';
                hojdCollectionLicenseDiv.innerHTML = 'Licens: ' + lic + ' — <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC-BY-4.0</a>';
            } else {
                hojdCollectionLicenseDiv.style.display = 'none';
                hojdCollectionLicenseDiv.textContent = '';
            }
            hojdAcceptLicenseCheckbox.checked = false;
        });
    }

    lanSelect.addEventListener('change', () => {
        const selectedId = lanSelect.value;
        if (!selectedId) {
            selectedLanId = null;
            if (!drawnItems.getLayers().length) {
                currentGeometry = null;
                currentGeometryLabel = 'Ingen geometri vald.';
                updateGeometryIndicator();
            }
            applyLanStyle();
            return;
        }

        const feature = lanFeatures.find(f => String(f.properties.id) === String(selectedId));
        if (!feature) return;

        selectedLanId = selectedId;
        applyLanStyle();
        drawnItems.clearLayers();
        const layer = L.geoJSON(feature);
        map.fitBounds(layer.getBounds().pad(0.05));
        const lanName = feature.properties.Lan || feature.properties.lan || selectedId;
        setCurrentGeometry(feature.geometry, `Län: ${lanName}`, lanName);
    });

    // 2. Initialise download controls
    const messageDiv = document.getElementById('result-message');
    const btn = document.getElementById('start-download-btn');
    const downloadAllBtn = document.getElementById('download-all-btn');
    const stopBtn = document.getElementById('stop-download-btn');

    let currentDownloadId = null;

    function showMsg(text, type) {
        const g = document.getElementById('global-notification');
        if (g) {
            let cls = 'is-info';
            if (type === 'error') cls = 'is-danger';
            else if (type === 'success') cls = 'is-success';
            g.className = `notification ${cls}`;
            g.textContent = text;
            g.style.display = 'block';
            clearTimeout(g._hideTimeout);
            g._hideTimeout = setTimeout(() => { g.style.display = 'none'; }, 6000);
        } else {
            messageDiv.style.display = 'block';
            messageDiv.textContent = text;
            messageDiv.style.backgroundColor = type === 'error' ? '#f8d7da' : '#d4edda';
            messageDiv.style.color = type === 'error' ? '#721c24' : '#155724';
        }
    }

    // 3. Handle download button click
    async function triggerDownload(payload, button, label) {
        button.disabled = true;
        button.textContent = 'Startar...';
        try {
                // Preflight validation from client
                try {
                    const vres = await fetch('/lmv/validate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ apiUsername: payload.apiUsername, apiKey: payload.apiKey, apiToken: payload.apiToken, collectionId: payload.collectionId, apiType: payload.apiType })
                    });
                    if (vres.status === 401 || vres.status === 403) {
                        showMsg('Fel: Ogiltigt systemkonto eller lösenord. Kontrollera dina uppgifter.', 'error');
                        return;
                    }
                } catch (e) {
                    console.warn('Validering misslyckades (client):', e.message);
                }

                const res = await fetch('/lmv/start-full-download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (res.status === 401 || res.status === 403) {
                    showMsg('Fel: Ogiltigt systemkonto eller lösenord. Kontrollera dina uppgifter.', 'error');
                    return;
                }

                const json = await res.json();
                if (json.success) {
                    showMsg(json.message, 'success');
                    if (json.downloadId) {
                        currentDownloadId = json.downloadId;
                        stopBtn.style.display = 'inline-block';
                    }
                } else {
                    showMsg('Fel: ' + json.error, 'error');
                }
        } catch (e) {
            showMsg('Nätverksfel.', 'error');
        } finally {
            setTimeout(() => { button.disabled = false; button.textContent = label; }, 3000);
        }
    }

    stopBtn.addEventListener('click', async () => {
        if (!currentDownloadId) return;
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stoppar...';
        try {
            const res = await fetch('/lmv/cancel-download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ downloadId: currentDownloadId })
            });
            const json = await res.json();
            if (json.success) {
                showMsg('Nedladdning stoppad.', 'success');
            } else {
                showMsg('Kunde inte stoppa: ' + json.error, 'error');
            }
        } catch (e) {
            showMsg('Nätverksfel.', 'error');
        } finally {
            currentDownloadId = null;
            stopBtn.style.display = 'none';
            stopBtn.disabled = false;
            stopBtn.textContent = '⏹ Stoppa Nedladdning';
        }
    });

    btn.addEventListener('click', () => {
        const authMethod = document.querySelector('input[name="auth-method"]:checked').value;
        const apiUsername = document.getElementById('apiUsername').value;
        const apiKey = document.getElementById('apiKey').value;
        const apiToken = document.getElementById('apiToken').value;
        if (authMethod === 'userpass' && (!apiUsername || !apiKey)) return showMsg('Ange systemkonto och lösenord.', 'error');
        if (authMethod === 'token' && !apiToken) return showMsg('Ange Auth token.', 'error');
        if (!currentGeometry) return showMsg('Välj ett län eller rita ett område på kartan.', 'error');
        
        const geometryPayload = currentGeometry || null;
        // Check license acceptance if a collection is selected
        const selOpt = hojdCollectionSelect ? hojdCollectionSelect.selectedOptions[0] : null;
        const license = selOpt ? selOpt.dataset.license : null;
        if (license && !hojdAcceptLicenseCheckbox.checked) {
            return showMsg('Du måste godkänna licensvillkoren för den valda samlingen innan du fortsätter.', 'error');
        }

        triggerDownload({
            apiUsername,
            apiKey,
            apiToken: apiToken || undefined,
            collectionId: hojdCollectionSelect && hojdCollectionSelect.value ? hojdCollectionSelect.value : 'ALL_MARKHOJD', // use the selected collection if one is chosen
            apiType: 'hojd',
            geometry: geometryPayload,
            geometryLabel: currentGeometryName
        }, btn, 'Starta Nedladdning');
    });

    downloadAllBtn.addEventListener('click', () => {
        const authMethod = document.querySelector('input[name="auth-method"]:checked').value;
        const apiUsername = document.getElementById('apiUsername').value;
        const apiKey = document.getElementById('apiKey').value;
        const apiToken = document.getElementById('apiToken').value;
        if (authMethod === 'userpass' && (!apiUsername || !apiKey)) return showMsg('Ange systemkonto och lösenord.', 'error');
        if (authMethod === 'token' && !apiToken) return showMsg('Ange Auth token.', 'error');
        // For a full download, require license acceptance if a collection is selected
        const selOpt = hojdCollectionSelect ? hojdCollectionSelect.selectedOptions[0] : null;
        const license = selOpt ? selOpt.dataset.license : null;
        if (license && !hojdAcceptLicenseCheckbox.checked) {
            return showMsg('Du måste godkänna licensvillkoren för den valda samlingen innan du fortsätter.', 'error');
        }
        triggerDownload({
            apiUsername,
            apiKey,
            apiToken: apiToken || undefined,
            collectionId: hojdCollectionSelect && hojdCollectionSelect.value ? hojdCollectionSelect.value : 'ALL_MARKHOJD',
            apiType: 'hojd',
            geometry: null,
            geometryLabel: null
        }, downloadAllBtn, 'Ladda ner hela Sverige');
    });
});