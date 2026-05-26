
/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright (C) 2025 MundoGIS.
 */


// --- DOM elements ---
const speciesForm = document.getElementById('species-form');
const checkBtn = document.getElementById('check-btn');
const resultMessage = document.getElementById('result-message');
const downloadSection = document.getElementById('download-section');
const downloadBtn = document.getElementById('download-btn');
const foundSpeciesName = document.getElementById('found-species-name');
const downloadInfo = document.getElementById('download-info');
const downloadKeySpan = document.getElementById('download-key');
const acceptGbifCheckbox = document.getElementById('accept-gbif-license');
// Coordinate inputs
const minLonInput = document.getElementById('min-lon');
const maxLonInput = document.getElementById('max-lon');
const minLatInput = document.getElementById('min-lat');
const maxLatInput = document.getElementById('max-lat');

// --- Global state variables ---
let currentSpeciesKey = null; // "ALL" or a numeric taxon key
let currentBasisOfRecord = null;
let currentWKTGeometry = null; // Stores the active WKT geometry (from map or manual inputs)
let currentUsername = null;
let currentPassword = null;
let map = null; // Leaflet map instance
let drawnItems = null; // Layer group for drawn shapes

// --- Leaflet map initialisation ---
function initializeMap() {
    if (map) return; // Prevent re-initialisation

    map = L.map('mapid').setView([62, 15], 4); // Centred approximately on Sweden
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 18,
    }).addTo(map);

    // Layer to hold the user's drawn shape
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Draw controls — rectangle only
    const drawControl = new L.Control.Draw({
        edit: {
            featureGroup: drawnItems, // Allow editing and deleting the drawn shape
            remove: true
        },
        draw: {
            polygon: false, polyline: false, circle: false, marker: false, circlemarker: false,
            rectangle: { shapeOptions: { color: '#007bff' } }
        }
    });
    map.addControl(drawControl);

    // --- Event: rectangle created ---
    map.on(L.Draw.Event.CREATED, function (event) {
        const layer = event.layer;
        const bounds = layer.getBounds();
        const southWest = bounds.getSouthWest(); const northEast = bounds.getNorthEast();
        const minLon = southWest.lng; const minLat = southWest.lat;
        const maxLon = northEast.lng; const maxLat = northEast.lat;

        // Build WKT and store it
        const wkt = `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`;
        currentWKTGeometry = wkt;
        console.log("WKT Geometry (from map):", currentWKTGeometry);

        // Sync coordinate input fields
        minLonInput.value = minLon.toFixed(6); maxLonInput.value = maxLon.toFixed(6);
        minLatInput.value = minLat.toFixed(6); maxLatInput.value = maxLat.toFixed(6);

        drawnItems.clearLayers();
        drawnItems.addLayer(layer);
        showMessage("Område definierat på kartan. Koordinatfälten har uppdaterats.", "success");
    });

    // --- Event: shape deleted ---
    map.on(L.Draw.Event.DELETED, function() {
        currentWKTGeometry = null; // Clear stored WKT
        minLonInput.value = ''; maxLonInput.value = ''; // Clear inputs
        minLatInput.value = ''; maxLatInput.value = '';
        console.log("WKT Geometry och koordinatfält rensade");
        showMessage("Området har tagits bort från kartan.", "info");
    });

    // --- Event: shape edited ---
     map.on(L.Draw.Event.EDITED, function (event) {
        event.layers.eachLayer(function (layer) { // Assumes a single editable layer
             const bounds = layer.getBounds();
             const southWest = bounds.getSouthWest(); const northEast = bounds.getNorthEast();
             const minLon = southWest.lng; const minLat = southWest.lat;
             const maxLon = northEast.lng; const maxLat = northEast.lat;
             // Update WKT and coordinate inputs
             currentWKTGeometry = `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`;
             console.log("WKT Geometry (edited map):", currentWKTGeometry);
             minLonInput.value = minLon.toFixed(6); maxLonInput.value = maxLon.toFixed(6);
             minLatInput.value = minLat.toFixed(6); maxLatInput.value = maxLat.toFixed(6);
        });
        showMessage("Området har redigerats på kartan. Koordinatfälten har uppdaterats.", "success");
    });
}
// Initialise map when DOM is ready
document.addEventListener('DOMContentLoaded', initializeMap);


// --- Validate coordinate inputs and return a WKT string ---
function validateAndGetWKTFromInputs() {
    const minLonStr = minLonInput.value; const maxLonStr = maxLonInput.value;
    const minLatStr = minLatInput.value; const maxLatStr = maxLatInput.value;

    if (!minLonStr || !maxLonStr || !minLatStr || !maxLatStr) { return null; } // Incomplete

    const minLon = parseFloat(minLonStr); const maxLon = parseFloat(maxLonStr);
    const minLat = parseFloat(minLatStr); const maxLat = parseFloat(maxLatStr);

    if (isNaN(minLon) || isNaN(maxLon) || isNaN(minLat) || isNaN(maxLat) ||
        minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90 ||
        minLon >= maxLon || minLat >= maxLat) {
        return null; // Invalid
    }
    // Valid — return WKT
    return `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`;
}

// --- Main form submit handler ---
speciesForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessages();
    disableButtons(true);

    // Check GBIF licence acceptance
    if (acceptGbifCheckbox && !acceptGbifCheckbox.checked) {
        showMessage('Du måste godkänna licensvillkoren för GBIF-data innan du fortsätter.', 'error');
        disableButtons(false);
        return;
    }

    // 1. Read common fields and validate
    currentUsername = document.getElementById('username').value.trim();
    currentPassword = document.getElementById('password').value;
    currentBasisOfRecord = document.getElementById('basis-of-record-select').value;
    const speciesNameOrAll = document.getElementById('species-select').value;

    if (!currentUsername || !currentPassword) { showMessage('Vänligen ange GBIF användarnamn och lösenord.', 'error'); disableButtons(false); return; }
    if (!speciesNameOrAll) { showMessage('Vänligen välj en art eller "Alla arter".', 'error'); disableButtons(false); return; }

    // 2. Resolve geometry — prefer manual inputs if valid, fall back to map
    const wktFromInputs = validateAndGetWKTFromInputs();
    if (wktFromInputs) {
        currentWKTGeometry = wktFromInputs;
        console.log("Använder WKT från manuella koordinatfält.");
    } else if (currentWKTGeometry) {
        console.log("Manuella koordinatfält ogiltiga/tomma, använder WKT från kartan.");
    } else {
        showMessage("Vänligen definiera ett giltigt område (antingen via fälten eller genom att rita på kartan).", 'error');
        disableButtons(false);
        return;
    }

    // 3. Route: "ALL" species vs. specific species
    if (speciesNameOrAll === "ALL") {
        currentSpeciesKey = "ALL";
        await fetchAndShowCount("ALL", "Alla arter");
    } else {
        // Specific species: verify it exists in GBIF first
        try {
            showMessage(`Verifierar art: ${speciesNameOrAll}...`, 'info');
            const checkResponse = await fetch('/check-species', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: currentUsername, password: currentPassword, speciesName: speciesNameOrAll }),
            });
            const checkData = await checkResponse.json();
            if (checkResponse.status === 401 || checkResponse.status === 403) {
                showMessage('Fel: Ogiltigt användarnamn eller lösenord. Kontrollera dina uppgifter.', 'error');
                disableButtons(false);
                return;
            }
            if (!checkResponse.ok) throw new Error(checkData.error || `Fel vid verifiering (${checkResponse.status})`);

            if (checkData.exists) {
                currentSpeciesKey = checkData.speciesKey; // Store the numeric taxon key
                await fetchAndShowCount(currentSpeciesKey, checkData.scientificName);
            } else {
                showMessage('Art inte hittad i GBIF.', 'error');
                disableButtons(false);
            }
        } catch (error) {
            console.error('Error verifying species:', error);
            showMessage(`Fel vid artverifiering: ${error.message}`, 'error');
            disableButtons(false);
        }
    }
    // Note: disableButtons(false) is called inside fetchAndShowCount or in the catch blocks above
});

// --- Helper: fetch occurrence count and update the UI ---
async function fetchAndShowCount(speciesKeyForCount, displayName) {
    try {
        showMessage(`Hämtar antal förekomster för ${displayName}...`, 'info');
        disableButtons(true);

        const countResponse = await fetch('/get-occurrence-count', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: currentUsername,
                password: currentPassword,
                speciesKey: speciesKeyForCount,
                geometry: currentWKTGeometry,
                basisOfRecord: currentBasisOfRecord
            })
        });
           const countData = await countResponse.json();
           if (countResponse.status === 401 || countResponse.status === 403) {
              showMessage('Fel: Ogiltigt användarnamn eller lösenord. Kontrollera dina uppgifter.', 'error');
              throw new Error('Autentisering misslyckades');
           }
           if (!countResponse.ok || !countData.success) {
               throw new Error(countData.error || countData.details?.message || `Fel vid hämtning av antal (${countResponse.status})`);
           }

        // Successfully retrieved occurrence count
        const count = countData.count;
        const formattedCount = count.toLocaleString('sv-SE'); // Swedish number formatting

        showMessage(`Filter inställda. Redo att ladda ner data.`, 'success');
        foundSpeciesName.innerHTML = `${displayName} <span style="font-weight:normal;">(ca ${formattedCount} förekomster)</span>`;
        downloadSection.style.display = 'block';

    } catch (error) {
        console.error("Error fetching occurrence count:", error);
        // Show error but still display the download button so the user can proceed anyway
        showMessage(`Kunde inte hämta antal förekomster: ${error.message}. Du kan försöka starta nedladdningen ändå.`, 'error');
        foundSpeciesName.textContent = displayName + " (antal okänt)";
        downloadSection.style.display = 'block';
        // Preserve the species key even if the count failed
        currentSpeciesKey = speciesKeyForCount;

    } finally {
        disableButtons(false);
    }
}

// --- Download button click handler ---
downloadBtn.addEventListener('click', async () => {
    // Check GBIF licence acceptance before starting download
    if (acceptGbifCheckbox && !acceptGbifCheckbox.checked) {
        showMessage('Du måste godkänna licensvillkoren för GBIF-data innan du startar nedladdningen.', 'error');
        return;
    }

    // Validate that all required state is present
    if (currentSpeciesKey === null || !currentWKTGeometry || !currentUsername || !currentPassword) {
        showMessage('Nödvändig information saknas (art/ALLA, område). Förbered/verifiera igen.', 'error');
        return;
    }
    clearMessages();
    disableButtons(true);

    try {
        // Call the backend /create-download endpoint
        const response = await fetch('/create-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: currentUsername,
                password: currentPassword,
                speciesKey: currentSpeciesKey,
                geometry: currentWKTGeometry,
                basisOfRecord: currentBasisOfRecord ?? "" // Send empty string if null
            }),
        });
        if (response.status === 401 || response.status === 403) {
            showMessage('Fel: Ogiltigt användarnamn eller lösenord. Kontrollera dina uppgifter.', 'error');
            disableButtons(false);
            return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Fel från server (${response.status})`);

        if (data.success) {
            showMessage('Nedladdningsbegäran startad korrekt.', 'success');
            downloadKeySpan.textContent = data.downloadKey;
            downloadInfo.style.display = 'block';
            downloadSection.style.display = 'none';
        } else {
             throw new Error(data.error || 'Servern indikerade ett fel vid skapandet av nedladdningen.');
        }
    } catch (error) {
        console.error('Fel vid skapande av nedladdning:', error);
        showMessage(`Fel vid skapande av nedladdning: ${error.message}`, 'error');
    } finally {
        disableButtons(false);
    }
});


// --- Utility functions ---
function showMessage(message, type = 'info') {
    const g = document.getElementById('global-notification');
    if (g) {
        let cls = 'is-info';
        if (type === 'error') cls = 'is-danger';
        else if (type === 'success') cls = 'is-success';
        g.className = `notification ${cls}`;
        g.textContent = message;
        g.style.display = 'block';
        clearTimeout(g._hideTimeout);
        g._hideTimeout = setTimeout(() => { g.style.display = 'none'; }, 6000);
        return;
    }
    resultMessage.textContent = message;
    resultMessage.className = ''; // Clear any previous classes
    resultMessage.style.display = 'block';
    if (type === 'success') { resultMessage.classList.add('success'); }
    else if (type === 'error') { resultMessage.classList.add('error'); }
    else { resultMessage.classList.add('info'); }
}
function clearMessages() {
    resultMessage.textContent = '';
    resultMessage.style.display = 'none';
    resultMessage.className = '';
    downloadSection.style.display = 'none';
    downloadInfo.style.display = 'none';
}
function disableButtons(disabled) {
    checkBtn.disabled = disabled;
    downloadBtn.disabled = disabled;
}

// Initialise map when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    initializeMap();
});
