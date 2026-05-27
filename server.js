/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright (C) 2025 MundoGIS.
 */
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const http = require('http');
const unzipper = require('unzipper');
const { spawn, exec } = require('child_process');
const archiver = require('archiver');
const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
const LAN_GEOJSON_PATH = path.join(__dirname, 'data', 'lan.geojson');

const activeDownloads = new Map();
// Tracks per-file download progress keyed by downloadId.
// Structure: { total, done, failed, currentFile, status: 'running'|'done'|'cancelled' }
const downloadProgress = new Map();

app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

// --- CONFIGURATION ---
const GDAL_ROOT = process.env.GDAL ? process.env.GDAL.trim() : null;
const QGIS_ROOT = process.env.QGIS ? process.env.QGIS.trim() : null;
const GDAL_BIN = QGIS_ROOT || GDAL_ROOT || '';

const GDAL_BUILDVRT_CMD = path.join(
    GDAL_BIN,
    process.platform === 'win32' ? 'gdalbuildvrt.exe' : 'gdalbuildvrt'
);
const GDAL_GDALINFO_CMD = path.join(
    GDAL_BIN,
    process.platform === 'win32' ? 'gdalinfo.exe' : 'gdalinfo'
);
// Path to gdal_merge.py: prefer environment override via .env (GDAL_MERGE),
// otherwise fall back to QGIS root or the legacy hard-coded path.
const GDAL_MERGE_CMD = (process.env.GDAL_MERGE && process.env.GDAL_MERGE.trim()) || (QGIS_ROOT ? path.join(QGIS_ROOT, 'apps', 'Python312', 'Scripts', 'gdal_merge.py') : 'C:/QGIS/apps/Python312/Scripts/gdal_merge.py');
console.log('GDAL_MERGE_CMD =', GDAL_MERGE_CMD);
const GDAL_TRANSLATE_CMD = path.join(
    GDAL_BIN,
    process.platform === 'win32' ? 'gdal_translate.exe' : 'gdal_translate'
);
const GDAL_ADDO_CMD = path.join(
    GDAL_BIN,
    process.platform === 'win32' ? 'gdaladdo.exe' : 'gdaladdo'
);
const PYTHON_CMD = QGIS_ROOT ? path.join(QGIS_ROOT, 'python-qgis-ltr.bat') : 'python';

// --- UTILITIES ---
const logFile = path.join(__dirname, 'process.log');
function writeToLog(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${message}\n`;
    try {
        fs.appendFileSync(logFile, logMessage);
        console.log(logMessage.trim());
    } catch (error) {
        console.error("Error writing to log file:", error);
    }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function runGdalBuildVrt(targetDir, listFileName = 'filelist.txt', outputName = 'index.vrt') {
    return new Promise((resolve, reject) => {
        const exe = GDAL_BUILDVRT_CMD;
        const args = ['-input_file_list', listFileName, outputName];
        const child = spawn(exe, args, { cwd: targetDir, windowsHide: true });
        let stderr = '';

        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code === 0) return resolve();
            reject(new Error(stderr.trim() || `gdalbuildvrt exited with code ${code}`));
        });
    });
}

function runGdalInfo(rasterPath) {
    return new Promise((resolve, reject) => {
        const child = spawn(GDAL_GDALINFO_CMD, ['-stats', rasterPath], { windowsHide: true });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code !== 0) {
                return reject(new Error(stderr.trim() || `gdalinfo exited with code ${code}`));
            }

            const minMatch = stdout.match(/STATISTICS_MINIMUM=([-+0-9.eE]+)/);
            const maxMatch = stdout.match(/STATISTICS_MAXIMUM=([-+0-9.eE]+)/);
            const min = minMatch ? parseFloat(minMatch[1]) : null;
            const max = maxMatch ? parseFloat(maxMatch[1]) : null;
            if (Number.isFinite(min) && Number.isFinite(max)) {
                resolve({ min, max });
            } else {
                reject(new Error('Could not read statistics from gdalinfo.'));
            }
        });
    });
}

function runGdalMerge(targetDir, tifFiles, outputName) {
    return new Promise((resolve, reject) => {
        // Create a file list to avoid command-line length limits
        const mergeListPath = path.join(targetDir, 'merge_list.txt');
        fs.writeFileSync(mergeListPath, tifFiles.join('\n'));
        
        const args = [
            '/c', PYTHON_CMD,
            GDAL_MERGE_CMD, '-o', outputName,
            '--optfile', 'merge_list.txt',
            '-co', 'COMPRESS=DEFLATE',
            '-co', 'PREDICTOR=2',
            '-co', 'TILED=YES',
            '-co', 'BIGTIFF=IF_SAFER'
        ];
        const child = spawn('cmd.exe', args, { cwd: targetDir, windowsHide: true });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code === 0) return resolve();
            reject(new Error(stderr.trim() || `gdal_merge.py exited with code ${code}`));
        });
    });
}

function runGdalTranslate(targetDir, inputFile, outputFile) {
    return new Promise((resolve, reject) => {
        const args = [inputFile, outputFile, '-co', 'COMPRESS=LZW', '-co', 'TILED=YES', '-co', 'BIGTIFF=YES'];
        const child = spawn(GDAL_TRANSLATE_CMD, args, { cwd: targetDir, windowsHide: true });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code === 0) return resolve();
            reject(new Error(stderr.trim() || `gdal_translate exited with code ${code}`));
        });
    });
}

function runGdalAddo(targetDir, rasterPath) {
    return new Promise((resolve, reject) => {
        const args = ['-r', 'average', rasterPath, '2', '4', '8', '16', '32'];
        const child = spawn(GDAL_ADDO_CMD, args, { cwd: targetDir, windowsHide: true });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', err => reject(err));
        child.on('close', code => {
            if (code === 0) return resolve();
            reject(new Error(stderr.trim() || `gdaladdo exited with code ${code}`));
        });
    });
}

function buildDynamicQml(minVal, maxVal, step = 5) {
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
        throw new Error('Invalid min/max values for style generation.');
    }

    const start = Math.floor(minVal / step) * step;
    const end = Math.ceil(maxVal / step) * step;
    const stops = [];
    for (let v = start; v <= end; v += step) {
        stops.push(Number(v.toFixed(2)));
    }
    if (stops.length < 2) {
        stops.push(start + step);
    }

    const items = stops.map((value, index) => {
        const ratio = stops.length === 1 ? 0 : index / (stops.length - 1);
        const shade = Math.round(250 - ratio * 230);
        const hex = shade.toString(16).padStart(2, '0');
        const color = `#${hex}${hex}${hex}`;
        const label = index === 0
            ? `<= ${value}`
            : index === stops.length - 1
                ? `> ${stops[index - 1]}`
                : `${stops[index - 1]} - ${value}`;
        return { value, color, label };
    }).slice(1); // Skip the synthetic first entry used only for label generation

    const itemsXml = items.map(item =>
        `          <item label="${item.label}" value="${item.value}" color="${item.color}" alpha="255"/>`
    ).join('\n');

    return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.38" styleCategories="Symbology">
  <pipe>
    <rasterrenderer classificationMax="${end}" classificationMin="${start}" band="1" type="singlebandpseudocolor" opacity="1">
      <rastershader>
        <colorrampshader colorRampType="DISCRETE" classificationMode="2" minimumValue="${start}" maximumValue="${end}">
${itemsXml}
        </colorrampshader>
      </rastershader>
    </rasterrenderer>
  </pipe>
</qgis>`;
}

function getStacBase(apiType) {
    return apiType === 'hojd' 
        ? 'https://api.lantmateriet.se/stac-hojd/v1' 
        : 'https://api.lantmateriet.se/stac-vektor/v1';
}

function wktPolygonToGeoJSON(wkt) {
    if (!wkt || typeof wkt !== 'string' || !wkt.toUpperCase().startsWith('POLYGON((')) return null;
    try {
        const coordsString = wkt.substring(wkt.indexOf('((') + 2, wkt.indexOf('))'));
        const pairs = coordsString.split(',').map(pair => pair.trim());
        const coordinates = pairs.map(pair => {
            const [lon, lat] = pair.split(' ').map(parseFloat);
            return [lon, lat];
        });
        return { type: 'Polygon', coordinates: [coordinates] };
    } catch (e) { return null; }
}

function slugify(text) {
    if (!text) return '';
    return text
        .toString()
        .normalize('NFD')
        .replace(/[^\w\s-]/g, '')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60);
}

function normalizeGeometryPayload(rawGeometry) {
    if (!rawGeometry) return null;
    
    // If it is a string, try to convert from WKT to GeoJSON
    if (typeof rawGeometry === 'string') {
        const geoJson = wktPolygonToGeoJSON(rawGeometry);
        console.log('[normalizeGeometryPayload] WKT converted to GeoJSON:', JSON.stringify(geoJson));
        return geoJson;
    }

    // If it is already a GeoJSON object, validate and return
    if (typeof rawGeometry === 'object' && rawGeometry.type && rawGeometry.coordinates) {
        console.log('[normalizeGeometryPayload] GeoJSON received directly:', JSON.stringify(rawGeometry));
        return rawGeometry;
    }

    console.warn('[normalizeGeometryPayload] Unrecognised geometry format:', typeof rawGeometry, rawGeometry);
    return null;
}

// --- LMV CREDENTIAL VALIDATION ---
async function validateLmvCredentials(apiUsername, apiKey, apiToken, apiType, collectionId) {
    const STAC_BASE = getStacBase(apiType);

    // 1) STAC search: 200 → token valid, 401/403 → token invalid
    try {
        const searchUrl = `${STAC_BASE}/search`;
        const body = { collections: [collectionId], limit: 1 };
        const headers = {};
        const validateConfig = { headers, timeout: 10000 };
        if (apiToken) {
            headers['Authorization'] = `Bearer ${apiToken}`;
        } else if (apiUsername && apiKey) {
            // Basic Auth (X-API-Key is no longer supported by LMV)
            validateConfig.auth = { username: apiUsername, password: apiKey };
        } else if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }
        const searchRes = await axios.post(searchUrl, body, validateConfig);
        // A 200 response (regardless of hit count) confirms the token is accepted by the STAC API
        return { ok: true, status: searchRes.status };
    } catch (err) {
        const status = err.response ? err.response.status : null;
        try {
            const respBody = err.response && err.response.data ? JSON.stringify(err.response.data).slice(0,800) : err.message;
            writeToLog(`[VALIDATION] Search failed for collection=${collectionId} apiType=${apiType} status=${status} detail=${respBody}`);
        } catch (e) {
            writeToLog(`[VALIDATION] Search failed for collection=${collectionId} apiType=${apiType} status=${status} (could not stringify response)`);
        }
        if (status === 401 || status === 403) return { ok: false, status, message: err.message };
        // Other errors (network error, unknown collection, etc.) → fall back
    }

    // Fallback: try the collections endpoint (e.g. when the collection has no items)
    try {
        const testUrl = `${STAC_BASE}/collections`;
        const colHeaders = {};
        const colConfig = { headers: colHeaders, timeout: 10000 };
        if (apiToken) {
            colHeaders['Authorization'] = `Bearer ${apiToken}`;
        } else if (apiUsername && apiKey) {
            colConfig.auth = { username: apiUsername, password: apiKey };
        } else if (apiKey) {
            colHeaders['X-API-Key'] = apiKey;
        }
        const res = await axios.get(testUrl, colConfig);
        return { ok: true, status: res.status };
    } catch (err) {
        const status = err.response ? err.response.status : null;
        try {
            const respBody = err.response && err.response.data ? JSON.stringify(err.response.data).slice(0,800) : err.message;
            writeToLog(`[VALIDATION] Collections check failed for apiType=${apiType} status=${status} detail=${respBody}`);
        } catch (e) {
            writeToLog(`[VALIDATION] Collections check failed for apiType=${apiType} status=${status} (could not stringify response)`);
        }
        return { ok: false, status, message: err.message };
    }
}

// --- GBIF/ARTDATA ROUTES ---

// Endpoint: check whether a species exists in GBIF
app.post('/check-species', async (req, res) => {
    const { username, password, speciesName } = req.body;
    
    if (!username || !password || !speciesName) {
        return res.status(400).json({
            success: false,
            error: 'Missing parameters: username, password and speciesName are required'
        });
    }

    try {
        // Search for the species in the GBIF Species API
        const searchUrl = `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(speciesName)}`;
        const response = await axios.get(searchUrl, {
            auth: { username, password }
        });

        if (response.data && response.data.usageKey) {
            res.json({
                success: true,
                exists: true,
                speciesKey: response.data.usageKey,
                scientificName: response.data.scientificName || speciesName,
                rank: response.data.rank,
                status: response.data.status
            });
        } else {
            res.json({
                success: true,
                exists: false
            });
        }
    } catch (error) {
        console.error('Error verifying species:', error.message);
        res.status(500).json({
            success: false,
            error: 'Error verifying species in GBIF',
            details: error.message
        });
    }
});

// Endpoint: get the occurrence count for a species in GBIF
app.post('/get-occurrence-count', async (req, res) => {
    const { username, password, speciesKey, geometry, basisOfRecord } = req.body;
    
    if (!username || !password || !speciesKey) {
        return res.status(400).json({
            success: false,
            error: 'Missing parameters: username, password and speciesKey are required'
        });
    }

    try {
        // Build the occurrence search URL
        let searchUrl = 'https://api.gbif.org/v1/occurrence/search?limit=0';

        // Add taxonKey (or ALL)
        if (speciesKey !== 'ALL') {
            searchUrl += `&taxonKey=${speciesKey}`;
        }

        // Add basisOfRecord if specified
        if (basisOfRecord) {
            searchUrl += `&basisOfRecord=${basisOfRecord}`;
        }

        // Add geometry if specified
        if (geometry) {
            // GBIF accepts geometry in WKT format
            const wktString = typeof geometry === 'string' ? geometry : JSON.stringify(geometry);
            searchUrl += `&geometry=${encodeURIComponent(wktString)}`;
        }

        const response = await axios.get(searchUrl, {
            auth: { username, password }
        });

        if (response.data && typeof response.data.count === 'number') {
            res.json({
                success: true,
                count: response.data.count
            });
        } else {
            res.json({
                success: false,
                error: 'Could not retrieve occurrence count'
            });
        }
    } catch (error) {
        console.error('Error fetching occurrence count:', error.message);
        res.status(500).json({
            success: false,
            error: 'Error fetching occurrence count from GBIF',
            details: error.message
        });
    }
});

// Endpoint: create a download request in GBIF
app.post('/create-download', async (req, res) => {
    const { username, password, speciesKey, geometry, basisOfRecord } = req.body;
    
    if (!username || !password || !speciesKey || !geometry) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameters'
        });
    }

    try {
        // Build the GBIF download predicate
        const downloadRequest = {
            creator: username,
            notificationAddresses: [username],
            sendNotification: true,
            format: "SIMPLE_CSV",
            predicate: {
                type: "and",
                predicates: []
            }
        };

        // Add species filter
        if (speciesKey !== 'ALL') {
            downloadRequest.predicate.predicates.push({
                type: "equals",
                key: "TAXON_KEY",
                value: speciesKey
            });
        }

        // Add basisOfRecord filter
        if (basisOfRecord) {
            downloadRequest.predicate.predicates.push({
                type: "equals",
                key: "BASIS_OF_RECORD",
                value: basisOfRecord
            });
        }

        // Add geometry filter
        if (geometry) {
            downloadRequest.predicate.predicates.push({
                type: "within",
                geometry: typeof geometry === 'string' ? geometry : JSON.stringify(geometry)
            });
        }

        // Simplify to a single predicate when only one filter was added
        if (downloadRequest.predicate.predicates.length === 1) {
            downloadRequest.predicate = downloadRequest.predicate.predicates[0];
        }

        // Submit the download request to GBIF
        const response = await axios.post(
            'https://api.gbif.org/v1/occurrence/download/request',
            downloadRequest,
            {
                auth: { username, password },
                headers: { 'Content-Type': 'application/json' }
            }
        );

        res.json({
            success: true,
            downloadKey: response.data,
            message: 'Nedladdning skapad i GBIF'
        });

    } catch (error) {
        console.error('Error creating download:', error.message);
        res.status(500).json({
            success: false,
            error: 'Error creating download in GBIF',
            details: error.response?.data || error.message
        });
    }
});

// --- COLLECTIONS ROUTES ---

// Vector collections route (used by lmv.html)
app.get('/lmv/collections', async (req, res) => {
    try {
        const response = await axios.get('https://api.lantmateriet.se/stac-vektor/v1/collections');
        res.json({ success: true, collections: response.data.collections });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Height data collections route (used by lmv_hojd.html)
app.get('/lmv/hojd/collections', async (req, res) => {
    try {
        const apiKey = req.headers['x-api-key'];
        const authHeader = req.headers['authorization'];
        if (!apiKey && !authHeader) {
            return res.status(401).json({ success: false, error: 'API Key required in header X-API-Key or Authorization: Bearer <token>' });
        }

        const headers = {};
        if (apiKey) headers['X-API-Key'] = apiKey;
        if (authHeader) headers['Authorization'] = authHeader;

        const response = await axios.get('https://api.lantmateriet.se/stac-hojd/v1/collections', {
            headers
        });
        res.json({ success: true, collections: response.data.collections });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/lmv/lan', (req, res) => {
    fs.readFile(LAN_GEOJSON_PATH, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).json({ success: false, error: 'Could not read county data.' });
        }
        try {
            const json = JSON.parse(data);
            res.json({ success: true, data: json });
        } catch (parseErr) {
            res.status(500).json({ success: false, error: 'County GeoJSON is invalid.' });
        }
    });
});

// --- DOWNLOAD LOGIC ---

// Manually follows HTTP redirects to preserve the Authorization header
// (axios strips auth headers automatically on cross-domain redirects)
async function downloadWithRedirects(url, headers, auth, timeout = 60000) {
    let currentUrl = url;
    for (let i = 0; i < 10; i++) {
        const agent = new http.Agent({ keepAlive: false });
        const res = await axios({
            method: 'GET',
            url: currentUrl,
            responseType: 'stream',
            httpAgent: agent,
            timeout,
            headers,
            auth,
            maxRedirects: 0,
            validateStatus: s => true
        });
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
            res.data.destroy();
            currentUrl = new URL(res.headers.location, currentUrl).href;
            continue;
        }
        if (res.status >= 400) {
            let body = '';
            try {
                const chunks = [];
                for await (const chunk of res.data) {
                    chunks.push(Buffer.from(chunk));
                    if (Buffer.concat(chunks).length > 800) break;
                }
                body = Buffer.concat(chunks).toString('utf8');
            } catch (e) { body = '(could not read response body)'; }
            writeToLog(`[DOWNLOAD] ${res.status} from ${currentUrl} | auth-header: ${headers['Authorization'] ? headers['Authorization'].substring(0,20)+'...' : 'none'} | basic-auth: ${auth ? auth.username : 'none'} | body: ${body.substring(0,400)}`);
            const err = new Error(`Request failed with status code ${res.status}`);
            err.response = { status: res.status };
            throw err;
        }
        return res;
    }
    throw new Error('Too many redirects');
}

// --- Merge, overview, VRT and style generation for a completed raster folder ---
async function runPostProcessing(folderName, vrtBaseName, label) {
    const tifFiles = fs.readdirSync(folderName)
        .filter(name => name.toLowerCase().endsWith('.tif') || name.toLowerCase().endsWith('.tiff'))
        .sort();
    if (tifFiles.length === 0) return; // nothing to process (vector-only collection)

    const vrtFileName = `${vrtBaseName}.vrt`;
    const mergedFileName = `merged_${vrtBaseName}.tif`;
    const mergedPath = path.join(folderName, mergedFileName);

    writeToLog(`[${label}] Post-processing: merging ${tifFiles.length} tiles → ${mergedFileName}`);
    await runGdalMerge(folderName, tifFiles, mergedFileName);
    writeToLog(`[${label}] Merge complete.`);

    writeToLog(`[${label}] Removing ${tifFiles.length} original tiles...`);
    tifFiles.forEach(f => { try { fs.unlinkSync(path.join(folderName, f)); } catch(e) {} });

    writeToLog(`[${label}] Building overviews (gdaladdo)...`);
    await runGdalAddo(folderName, mergedFileName);
    writeToLog(`[${label}] Overviews complete.`);

    fs.writeFileSync(path.join(folderName, 'filelist.txt'), mergedFileName);
    await runGdalBuildVrt(folderName, 'filelist.txt', vrtFileName);
    writeToLog(`[${label}] VRT generated: ${vrtFileName}`);

    try {
        const stats = await runGdalInfo(mergedPath);
        const qmlContent = buildDynamicQml(stats.min, stats.max, 5);
        fs.writeFileSync(path.join(folderName, `${vrtFileName}.qml`), qmlContent, 'utf8');
        writeToLog(`[${label}] Style generated (5-unit intervals).`);
    } catch (styleErr) {
        console.warn(`[${label}] Could not generate style: ${styleErr.message}`);
    }
}

async function fetchDownloadAndUnzipAll(apiKey, apiUsername, apiToken, collectionId, apiType, geometry, geometryLabel = null, downloadId = null, abortSignal = null, overrideFolderName = null, skipPostProcessing = false) {
    const STAC_BASE = getStacBase(apiType);
    const slugFromLabel = geometryLabel ? slugify(geometryLabel) : '';
    let areaSlug = slugFromLabel;
    // For unnamed drawn geometries (no label), generate a compact bbox string so
    // different areas don't share the same download folder.
    if (!areaSlug && geometry) {
        try {
            const gj = normalizeGeometryPayload(geometry);
            if (gj && gj.coordinates && gj.coordinates[0]) {
                const coords = gj.coordinates[0];
                const lons = coords.map(c => c[0]);
                const lats = coords.map(c => c[1]);
                const toTag = v => v.toFixed(2).replace('-', 'm').replace('.', '_');
                areaSlug = `${toTag(Math.min(...lons))}-${toTag(Math.min(...lats))}-${toTag(Math.max(...lons))}-${toTag(Math.max(...lats))}`;
            }
        } catch (e) { /* ignore — will fall back to no suffix */ }
    }
    const folderSuffix = areaSlug ? `_${areaSlug}` : '';
    // Use overrideFolderName when provided (e.g. MHM_YYYYMMDD_HHMMSS shared folder)
    const downloadFolderName = overrideFolderName || `LMV_DOWNLOADS_${collectionId}${folderSuffix}`;
    const vrtBaseName = areaSlug ? `index_${areaSlug}` : 'index';
    const vrtFileName = `${vrtBaseName}.vrt`;

    // Only skip if a fully-merged raster already exists in this folder.
    // Individual tiles being present (incomplete previous run) is NOT a reason to skip.
    // When writing to an override folder (shared MHM run), never skip — always add tiles.
    if (!overrideFolderName && fs.existsSync(downloadFolderName)) {
        try {
            const hasMerged = fs.readdirSync(downloadFolderName)
                .some(f => f.startsWith('merged_') && f.toLowerCase().endsWith('.tif'));
            if (hasMerged) {
                writeToLog(`[${collectionId}] Merged raster already exists in ${downloadFolderName}. Skipping.`);
                return;
            }
        } catch (err) {
            console.warn(`[${collectionId}] Could not inspect existing folder: ${err.message}`);
        }
    }
    const maxRetries = 5;
    
    // Full item objects are stored in the queue, not just URLs
    let downloadQueue = [];
    
    let searchRequestBody = { collections: [collectionId], limit: 1000 };
    
    if (geometry) {
        const geoJson = normalizeGeometryPayload(geometry);
        if (geoJson) {
            searchRequestBody.intersects = geoJson;
            writeToLog(`[${collectionId}] Search with geometry: ${JSON.stringify(geoJson)}`);
        } else {
            console.warn(`[${collectionId}] Invalid geometry ignored.`);
            writeToLog(`[${collectionId}] Invalid geometry ignored: ${JSON.stringify(geometry)}`);
        }
    } else {
        writeToLog(`[${collectionId}] Search without geometry filter (all of Sweden).`);
    }

    let nextUrl = `${STAC_BASE}/search`;
    writeToLog(`[${collectionId}] (${apiType}) Starting search/pagination...`);

    // 1. PAGINATION
    while (nextUrl) {
        if (abortSignal && abortSignal.aborted) {
            writeToLog(`[${collectionId}] Download cancelled by user.`);
            return;
        }
        try {
            const headers = { 'Content-Type': 'application/json' };
            const config = { headers };
            if (apiToken) {
                // Token mode: Bearer token for STAC search
                headers['Authorization'] = `Bearer ${apiToken}`;
            } else if (apiUsername && apiKey) {
                // Userpass mode: Basic Auth for STAC search (X-API-Key no longer supported by LMV)
                config.auth = { username: apiUsername, password: apiKey };
            } else if (apiKey) {
                // Fallback: try X-API-Key when only a key is available
                headers['X-API-Key'] = apiKey;
            }
            let response;

            if (nextUrl === `${STAC_BASE}/search`) {
                response = await axios.post(nextUrl, searchRequestBody, config);
            } else {
                response = await axios.get(nextUrl, config);
            }

            const items = response.data.features || [];
            writeToLog(`[${collectionId}] Page received: ${items.length} items found.`);
            items.forEach(item => {
                if (!item.assets) {
                    writeToLog(`[${collectionId}] Item without assets: ${item.id || 'no ID'}`);
                    return;
                }
                
                let assetsFound = 0;
                Object.keys(item.assets).forEach(key => {
                    const asset = item.assets[key];
                    if (!asset.href) return;

                    const hrefLower = asset.href.toLowerCase();
                    
                    // Vector data: accept gpkg, geojson, gml, shp
                    const isVector = hrefLower.endsWith('.gpkg') || hrefLower.endsWith('.geojson') ||
                                    hrefLower.endsWith('.gml') || hrefLower.endsWith('.zip') ||
                                    hrefLower.includes('.gpkg?') || hrefLower.includes('.geojson?');

                    // Raster data: accept tif/tiff
                    const isRaster = hrefLower.endsWith('.tif') || hrefLower.endsWith('.tiff');
                    
                    if (!isVector && !isRaster) return;

                    const selfLink = item.links ? item.links.find(link => link.rel === 'self') : null;
                    let absoluteUrl = asset.href;
                    if (selfLink && selfLink.href && !asset.href.startsWith('http')) {
                        absoluteUrl = new URL(asset.href, selfLink.href).href;
                    }

                    downloadQueue.push({
                        url: absoluteUrl,
                        bbox: item.bbox,
                        id: item.id,
                        assetKey: key,
                        type: isVector ? 'vector' : 'raster'
                    });
                    assetsFound++;
                });
                
                if (assetsFound === 0) {
                    writeToLog(`[${collectionId}] Item ${item.id || 'no ID'} has no downloadable assets. Available assets: ${Object.keys(item.assets).join(', ')}`);
                }
            });

            const nextLink = response.data.links ? response.data.links.find(link => link.rel === 'next') : null;
            nextUrl = nextLink ? nextLink.href : null;
            
            await delay(500); 

        } catch (error) {
            if (error.response && error.response.status === 429) {
                writeToLog(`[${collectionId}] Rate limit (429) during pagination. Waiting 10s...`);
                await delay(10000);
                continue;
            }
            writeToLog(`[${collectionId}] Error during pagination: ${error.message}. Aborting search.`);
            nextUrl = null;
        }
    }

    // Remove duplicates based on URL
    downloadQueue = downloadQueue.filter((v,i,a)=>a.findIndex(t=>(t.url===v.url))===i);

    if (downloadQueue.length > 0) {
        writeToLog(`[${collectionId}] Done! Found ${downloadQueue.length} files to download.`);
    } else {
        writeToLog(`[${collectionId}] No results for the given geometry. Continuing with the next collection.`);
        return;
    }

    // Register progress so the client can poll /lmv/progress/:downloadId
    if (downloadId) {
        downloadProgress.set(downloadId, {
            total: downloadQueue.length, done: 0, failed: 0,
            currentFile: '', status: 'running'
        });
    }

    if (!folderAlreadyExists) fs.mkdirSync(downloadFolderName, { recursive: true });

    // Array to hold features for the final tile index GeoJSON
    let tileIndexFeatures = [];

    // 2. DOWNLOAD
    for (let i = 0; i < downloadQueue.length; i++) {
        if (abortSignal && abortSignal.aborted) {
            writeToLog(`[${collectionId}] Download cancelled by user.`);
            return;
        }
        const itemData = downloadQueue[i];
        const url = itemData.url;
        const filename = path.basename(new URL(url).pathname);
        const filePath = path.join(downloadFolderName, filename);

        // Update the progress indicator so the UI shows the current filename
        if (downloadId) {
            const p = downloadProgress.get(downloadId);
            if (p) p.currentFile = filename;
        }

        await delay(1000);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            let bearerFallbackAttempted = false;
            try {
                if (!fs.existsSync(filePath) && !fs.existsSync(filePath + '.done')) {
                    const downloadHeaders = {};
                    let downloadAuth = undefined;
                    let dlMethod = '';
                    if (apiToken) {
                        // Token mode: try Bearer first against dl1.
                        // Some dataset paths on dl1 reject Bearer (401) even though the
                        // STAC catalogue accepts it — in that case we fall back to
                        // Basic Auth (Geotorget) automatically if credentials are available.
                        downloadHeaders['Authorization'] = `Bearer ${apiToken}`;
                        dlMethod = 'Bearer token';
                    } else if (apiUsername && apiKey) {
                        // Userpass mode: Geotorget system account → Basic Auth against dl1
                        downloadAuth = { username: apiUsername, password: apiKey };
                        dlMethod = `Basic Auth (${apiUsername})`;
                    } else if (apiKey) {
                        downloadHeaders['X-API-Key'] = apiKey;
                        dlMethod = 'X-API-Key';
                    }
                    writeToLog(`[DOWNLOAD] Attempting ${url} | method: ${dlMethod}`);

                    let response;
                    try {
                        response = await downloadWithRedirects(url, downloadHeaders, downloadAuth, 60000);
                    } catch (firstErr) {
                        // Bearer → Basic Auth fallback:
                        // dl1 sometimes rejects Bearer (401) for specific dataset paths
                        // even when the same token works fine for the STAC catalogue.
                        // If Geotorget credentials are available, retry immediately with Basic Auth.
                        const firstStatus = firstErr.response ? firstErr.response.status : null;
                        if (firstStatus === 401 && apiToken && apiUsername && apiKey) {
                            writeToLog(`[DOWNLOAD] Bearer rejected (401) for ${filename} — falling back to Basic Auth (${apiUsername})...`);
                            // Remove any partial file left by the failed attempt
                            if (fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch (e) {}
                            bearerFallbackAttempted = true;
                            response = await downloadWithRedirects(url, {}, { username: apiUsername, password: apiKey }, 60000);
                            writeToLog(`[DOWNLOAD] Basic Auth fallback succeeded for ${filename}`);
                        } else {
                            throw firstErr; // Re-throw for standard error handling in the outer catch
                        }
                    }

                    const writer = fs.createWriteStream(filePath);
                    response.data.pipe(writer);
                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });
                    console.log(`[${i+1}/${downloadQueue.length}] Downloaded: ${filename}`);
                } else {
                    console.log(`[${i+1}/${downloadQueue.length}] Already exists (skipping): ${filename}`);
                }

                // If the file is a ZIP, extract it then leave a .done marker so
                // subsequent runs know extraction already happened (the ZIP itself is deleted).
                if (filename.toLowerCase().endsWith('.zip')) {
                    await fs.createReadStream(filePath)
                        .pipe(unzipper.Extract({ path: downloadFolderName }))
                        .promise();
                    try { fs.unlinkSync(filePath); } catch(e){}
                    try { fs.writeFileSync(filePath + '.done', ''); } catch(e){}
                }

                // Build a Feature for the Tile Index, only when we have a valid bbox
                if (itemData.bbox && itemData.bbox.length === 4) {
                    const [minx, miny, maxx, maxy] = itemData.bbox;
                    tileIndexFeatures.push({
                        type: "Feature",
                        properties: {
                            id: itemData.id,
                            filename: filename,
                            // Relative path so QGIS can find the file if the folder is moved
                            location: `./${filename}`
                        },
                        geometry: {
                            type: "Polygon",
                            coordinates: [[
                                [minx, miny],
                                [maxx, miny],
                                [maxx, maxy],
                                [minx, maxy],
                                [minx, miny]
                            ]]
                        }
                    });
                }

                break;
            } catch (error) {
                const status = error.response ? error.response.status : null;
                if (status === 401) {
                    // 401 = auth rejected by dl1. Retrying won't help — bail out immediately.
                    const hint = bearerFallbackAttempted
                        ? `Both Bearer token and Basic Auth (${apiUsername}) rejected by dl1 for this file. Check Geotorget subscription.`
                        : apiToken
                            ? 'Bearer token rejected by dl1. Add Geotorget credentials (systemkonto + lösenord) to enable automatic fallback.'
                            : 'Invalid credentials for dl1. Check your Geotorget account and dataset subscription.';
                    writeToLog(`[DOWNLOAD] 401 – skipping ${filename}: ${hint}`);
                    console.warn(`[${collectionId}] 401 – skipping ${filename}: ${hint}`);
                    if (downloadId) { const p = downloadProgress.get(downloadId); if (p) p.failed++; }
                    break; // Do not retry
                } else if (status === 403) {
                    // 403 = authenticated but no subscription for this dataset.
                    writeToLog(`[DOWNLOAD] 403 – skipping ${filename}: account has no subscription for this dataset in Geotorget.`);
                    console.warn(`[${collectionId}] 403 – skipping ${filename}: no dataset subscription in Geotorget.`);
                    if (downloadId) { const p = downloadProgress.get(downloadId); if (p) p.failed++; }
                    break; // Do not retry
                } else if (status === 429) {
                    const waitTime = 30000;
                    console.warn(`[${collectionId}] 429 Rate Limit. Waiting ${waitTime/1000}s...`);
                    await delay(waitTime);
                } else {
                    console.warn(`[${collectionId}] Error downloading ${filename}: ${error.message}. Attempt ${attempt}/${maxRetries}`);
                    await delay(2000 * attempt);
                }
            }
        }
        // Count this file as processed regardless of outcome (downloaded, skipped, or failed)
        if (downloadId) { const p = downloadProgress.get(downloadId); if (p) p.done++; }
    }

    // Generate (or append to) tile_index.geojson
    if (tileIndexFeatures.length > 0) {
        const indexFile = path.join(downloadFolderName, 'tile_index.geojson');
        // When multiple collections share a folder, merge with any existing features
        let existingFeatures = [];
        if (overrideFolderName && fs.existsSync(indexFile)) {
            try { existingFeatures = JSON.parse(fs.readFileSync(indexFile, 'utf8')).features || []; } catch(e) {}
        }
        const geoJSON = {
            type: "FeatureCollection",
            name: overrideFolderName ? 'TileIndex_MHM' : `TileIndex_${collectionId}`,
            crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
            features: [...existingFeatures, ...tileIndexFeatures]
        };
        try {
            fs.writeFileSync(indexFile, JSON.stringify(geoJSON, null, 2));
            writeToLog(`[${collectionId}] Tile index: ${geoJSON.features.length} features → ${indexFile}`);
        } catch (err) {
            console.error(`Error writing tile index: ${err.message}`);
        }
    }

    // POST-PROCESSING: only run when not delegated to an outer caller
    if (!skipPostProcessing) {
        try {
            await runPostProcessing(downloadFolderName, vrtBaseName, collectionId);
        } catch (postErr) {
            console.warn(`[${collectionId}] Post-processing error: ${postErr.message}`);
        }
    }

    writeToLog(`[${collectionId}] Process complete.`);
    if (downloadId) {
        const p = downloadProgress.get(downloadId);
        if (p) { p.status = 'done'; p.currentFile = ''; }
        // Remove progress entry after 10 minutes so the Map doesn't grow forever
        setTimeout(() => downloadProgress.delete(downloadId), 10 * 60 * 1000);
    }
}

// --- DOWNLOAD START ROUTE ---
app.post('/lmv/start-full-download', async (req, res) => {
    const { apiKey, apiUsername, apiToken, collectionId, apiType, geometry, geometryLabel } = req.body;

    // Default: if apiType is missing, use 'vektor' (backwards compatibility)
    const type = apiType || 'vektor';

    // Accept either apiKey or apiToken when using token-based auth
    if (!(apiKey || apiToken) || !collectionId) return res.status(400).json({ success: false, error: 'Saknas data.' });

    // Validate credentials before starting any background process
    try {
        const valid = await validateLmvCredentials(apiUsername, apiKey, apiToken, type, collectionId);
        if (!valid.ok) {
            const status = valid.status || 401;
            writeToLog(`[VALIDATION] Invalid LMV credentials (status: ${status}). Aborting start.`);
            return res.status(401).json({ success: false, error: 'Ogiltigt användarnamn eller API-nyckel mot Lantmäteriet. Kontrollera dina uppgifter.' });
        }
    } catch (e) {
        writeToLog(`[VALIDATION] Error validating LMV credentials: ${e.message}`);
        return res.status(502).json({ success: false, error: 'Fel vid kontakt med LMV API. Försök senare.' });
    }

    // Create identifier and controller only after successful validation
    const downloadId = `${type}_${collectionId}_${geometryLabel || 'default'}_${Date.now()}`;
    const abortController = new AbortController();
    activeDownloads.set(downloadId, abortController);

    // Special case: download ALL Markhöjdmodell collections (or filter by area across all of them)
        if (type === 'hojd' && collectionId === 'ALL_MARKHOJD') {
            
            let msg = 'Söker Markhöjdmodell-data... (Detta kan ta några minuter)';
            res.status(202).json({ success: true, message: msg, downloadId });
            
            (async () => {
                try {
                    const listHeaders = {};
                    if (apiKey) listHeaders['X-API-Key'] = apiKey;
                    if (apiToken) listHeaders['Authorization'] = `Bearer ${apiToken}`;
                    const listRes = await axios.get('https://api.lantmateriet.se/stac-hojd/v1/collections', {
                        headers: listHeaders
                    });
                    const allMarkhojdCols = listRes.data.collections.filter(col =>
                        col.id.toLowerCase().includes('markhojd') || col.title.toLowerCase().includes('markhöjd')
                    );
                    writeToLog(`[ALL_MARKHOJD] Found ${allMarkhojdCols.length} Markhöjdmodell collections in catalogue.`);

                    // --- Upfront STAC search: find which collections have tiles in the requested area ---
                    // This replaces 76 individual searches with a single request.
                    let markhojdCols = allMarkhojdCols; // default: all (used for full-Sweden or if preflight fails)
                    if (geometry) {
                        try {
                            const geoJson = normalizeGeometryPayload(geometry);
                            if (geoJson) {
                                const preHeaders = { 'Content-Type': 'application/json' };
                                const preConfig = { headers: preHeaders };
                                if (apiToken) preHeaders['Authorization'] = `Bearer ${apiToken}`;
                                else if (apiUsername && apiKey) preConfig.auth = { username: apiUsername, password: apiKey };
                                const preBody = {
                                    collections: allMarkhojdCols.map(c => c.id),
                                    intersects: geoJson,
                                    limit: 1000,
                                    fields: { include: ['collection'], exclude: ['geometry', 'assets', 'links'] }
                                };
                                const preRes = await axios.post('https://api.lantmateriet.se/stac-hojd/v1/search', preBody, preConfig);
                                const hitColIds = new Set((preRes.data.features || []).map(f => f.collection).filter(Boolean));
                                if (hitColIds.size > 0) {
                                    markhojdCols = allMarkhojdCols.filter(c => hitColIds.has(c.id));
                                    writeToLog(`[ALL_MARKHOJD] Preflight search: ${hitColIds.size} collections have tiles in the requested area (skipping ${allMarkhojdCols.length - hitColIds.size}).`);
                                } else {
                                    writeToLog(`[ALL_MARKHOJD] Preflight search returned 0 hits — no tiles in the requested area.`);
                                    markhojdCols = []; // nothing to download
                                }
                            }
                        } catch (preErr) {
                            writeToLog(`[ALL_MARKHOJD] Preflight search failed (${preErr.message}). Falling back to scanning all ${allMarkhojdCols.length} collections.`);
                        }
                    }

                    if (markhojdCols.length === 0) {
                        writeToLog(`[ALL_MARKHOJD] No collections to process. Done.`);
                        const pEmpty = downloadProgress.get(downloadId);
                        if (pEmpty) { pEmpty.status = 'done'; pEmpty.total = 0; }
                        setTimeout(() => downloadProgress.delete(downloadId), 10 * 60 * 1000);
                        activeDownloads.delete(downloadId);
                        return;
                    }

                    // One timestamped folder for all tiles from this run
                    const _now = new Date();
                    const _p = n => String(n).padStart(2, '0');
                    const mhmFolder = `MHM_${_now.getFullYear()}${_p(_now.getMonth()+1)}${_p(_now.getDate())}_${_p(_now.getHours())}${_p(_now.getMinutes())}${_p(_now.getSeconds())}`;
                    fs.mkdirSync(mhmFolder, { recursive: true });
                    writeToLog(`[ALL_MARKHOJD] Output folder: ${mhmFolder}`);

                    writeToLog(`[ALL_MARKHOJD] Starting download for ${markhojdCols.length} collections.`);

                    // Track collection-level progress for the UI
                    downloadProgress.set(downloadId, {
                        total: markhojdCols.length, done: 0, failed: 0,
                        currentFile: '', status: 'running', type: 'collections'
                    });

                    // Process strictly in series with detailed logging
                    let processed = 0;
                    for (const col of markhojdCols) {
                        if (abortController.signal.aborted) {
                            writeToLog(`[ALL_MARKHOJD] Process cancelled by user.`);
                            const p = downloadProgress.get(downloadId);
                            if (p) p.status = 'cancelled';
                            break;
                        }
                        processed++;
                        writeToLog(`[ALL_MARKHOJD] (${processed}/${markhojdCols.length}) -> ${col.id} — starting fetch.`);
                        const p = downloadProgress.get(downloadId);
                        if (p) p.currentFile = col.title || col.id;
                        try {
                            // Inner calls share the MHM folder; post-processing runs once at the end
                            await fetchDownloadAndUnzipAll(apiKey, apiUsername, apiToken, col.id, 'hojd', geometry, geometryLabel, null, abortController.signal, mhmFolder, true);
                            writeToLog(`[ALL_MARKHOJD] (${col.id}) complete.`);
                        } catch (err) {
                            writeToLog(`[ALL_MARKHOJD] (${col.id}) failed: ${err.message}`);
                            if (p) p.failed++;
                        }
                        if (p) p.done++;
                        await delay(2000); // brief pause between collections
                    }

                    // Run post-processing once on the combined MHM folder
                    if (!abortController.signal.aborted) {
                        const pProc = downloadProgress.get(downloadId);
                        if (pProc) pProc.currentFile = 'Bearbetar raster (merge + overview + VRT)...';
                        writeToLog(`[ALL_MARKHOJD] Running post-processing on ${mhmFolder}...`);
                        try {
                            await runPostProcessing(mhmFolder, 'index', 'ALL_MARKHOJD');
                        } catch(ppErr) {
                            writeToLog(`[ALL_MARKHOJD] Post-processing error: ${ppErr.message}`);
                        }
                    }

                    const pFinal = downloadProgress.get(downloadId);
                    if (pFinal) { pFinal.status = 'done'; pFinal.currentFile = ''; }
                    setTimeout(() => downloadProgress.delete(downloadId), 10 * 60 * 1000);
                    writeToLog(`[ALL_MARKHOJD] COMPLETE. Folder: ${mhmFolder}`);
                } catch (err) {
                    writeToLog(`[ALL_MARKHOJD] Critical error: ${err.message}`);
                } finally {
                    activeDownloads.delete(downloadId);
                }
            })();
            return;
        }

    // Normal path: single collection
    res.status(202).json({ success: true, message: `Process startad för '${collectionId}'.`, downloadId });
    fetchDownloadAndUnzipAll(apiKey, apiUsername, apiToken, collectionId, type, geometry, geometryLabel, downloadId, abortController.signal)
        .catch(err => console.error(`[${collectionId}] Background task error:`, err))
        .finally(() => activeDownloads.delete(downloadId));
});
app.post('/lmv/cancel-download', (req, res) => {
    const { downloadId } = req.body;
    if (!downloadId) {
        return res.status(400).json({ success: false, error: 'downloadId krävs' });
    }
    const controller = activeDownloads.get(downloadId);
    if (controller) {
        controller.abort();
        activeDownloads.delete(downloadId);
        writeToLog(`[CANCEL] Download cancelled: ${downloadId}`);
        res.json({ success: true, message: 'Nedladdning avbröts.' });
    } else {
        res.json({ success: false, error: 'Nedladdning hittades inte eller är redan slutförd.' });
    }
});

// --- DOWNLOAD MANAGEMENT ---
app.get('/lmv/downloads/list', (req, res) => {
    try {
        const entries = fs.readdirSync(__dirname, { withFileTypes: true });
        const downloads = entries
            .filter(entry => entry.isDirectory() && entry.name.startsWith('LMV_DOWNLOADS_'))
            .map(entry => {
                const folderPath = path.join(__dirname, entry.name);
                const stats = fs.statSync(folderPath);
                const files = fs.readdirSync(folderPath);
                
                // Calculate total folder size
                let totalSize = 0;
                files.forEach(file => {
                    try {
                        const filePath = path.join(folderPath, file);
                        const fileStats = fs.statSync(filePath);
                        if (fileStats.isFile()) totalSize += fileStats.size;
                    } catch (e) {}
                });
                
                // Detect important files
                const hasMerged = files.some(f => f.startsWith('merged_') && f.endsWith('.tif'));
                const hasVrt = files.some(f => f.endsWith('.vrt'));
                const hasTileIndex = files.includes('tile_index.geojson');
                const tifCount = files.filter(f => f.toLowerCase().endsWith('.tif') || f.toLowerCase().endsWith('.tiff')).length;
                
                return {
                    name: entry.name,
                    created: stats.birthtime,
                    modified: stats.mtime,
                    size: totalSize,
                    fileCount: files.length,
                    tifCount,
                    hasMerged,
                    hasVrt,
                    hasTileIndex
                };
            })
            .sort((a, b) => b.modified - a.modified);
        
        res.json({ success: true, downloads });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/lmv/downloads/download/:folderName', (req, res) => {
    const folderName = req.params.folderName;
    if (!folderName.startsWith('LMV_DOWNLOADS_')) {
        return res.status(400).json({ success: false, error: 'Ogiltigt mappnamn' });
    }
    
    const folderPath = path.join(__dirname, folderName);
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
        return res.status(404).json({ success: false, error: 'Mapp hittades inte' });
    }
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.on('error', err => {
        console.error('Error creating ZIP archive:', err);
        res.status(500).end();
    });
    
    archive.pipe(res);
    archive.directory(folderPath, folderName);
    archive.finalize();
});

app.delete('/lmv/downloads/delete/:folderName', (req, res) => {
    const folderName = req.params.folderName;
    if (!folderName.startsWith('LMV_DOWNLOADS_')) {
        return res.status(400).json({ success: false, error: 'Ogiltigt mappnamn' });
    }
    
    const folderPath = path.join(__dirname, folderName);
    if (!fs.existsSync(folderPath)) {
        return res.status(404).json({ success: false, error: 'Mapp hittades inte' });
    }
    
    try {
        fs.rmSync(folderPath, { recursive: true, force: true });
        writeToLog(`[DELETE] Folder deleted: ${folderName}`);
        res.json({ success: true, message: 'Mappen raderades' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- DIAGNOSTIC ENDPOINT: test dl1 access directly ---
// POST /lmv/test-dl1 { url, apiUsername, apiKey, apiToken }
// Makes a HEAD request against dl1 with the given authentication and returns HTTP status + headers.
app.post('/lmv/test-dl1', async (req, res) => {
    const { url, apiUsername, apiKey, apiToken } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'url krävs' });

    const testResults = [];

    async function tryMethod(label, hdrs, auth) {
        try {
            const r = await axios({
                method: 'HEAD',
                url,
                headers: hdrs,
                auth,
                maxRedirects: 5,
                timeout: 15000,
                validateStatus: () => true
            });
            testResults.push({ method: label, status: r.status, contentType: r.headers['content-type'] || null, contentLength: r.headers['content-length'] || null });
        } catch (e) {
            testResults.push({ method: label, status: null, error: e.message });
        }
    }

    // Try Bearer token
    if (apiToken) {
        await tryMethod('Bearer token', { 'Authorization': `Bearer ${apiToken}` }, undefined);
    }
    // Try Basic Auth
    if (apiUsername && apiKey) {
        await tryMethod(`Basic Auth (${apiUsername})`, {}, { username: apiUsername, password: apiKey });
    }
    // Try without auth
    await tryMethod('No auth', {}, undefined);

    const success = testResults.some(r => r.status >= 200 && r.status < 300);
    writeToLog(`[TEST-DL1] ${url} → ${JSON.stringify(testResults)}`);
    res.json({ success, url, results: testResults });
});

// --- PROGRESS POLLING ---
// GET /lmv/progress/:downloadId — returns current progress for a running download.
app.get('/lmv/progress/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    const progress = downloadProgress.get(downloadId);
    if (!progress) {
        // Not in the progress map — check if it is still active (just started, queue not built yet)
        return res.json({ found: false, active: activeDownloads.has(downloadId) });
    }
    res.json({ found: true, ...progress });
});

// --- OPEN DOWNLOAD FOLDER IN FILE MANAGER ---
// POST /lmv/downloads/open/:folderName — opens the folder in Windows Explorer (or equivalent).
app.post('/lmv/downloads/open/:folderName', (req, res) => {
    const folderName = req.params.folderName;
    if (!folderName.startsWith('LMV_DOWNLOADS_')) {
        return res.status(400).json({ success: false, error: 'Invalid folder name' });
    }
    const folderPath = path.join(__dirname, folderName);
    if (!fs.existsSync(folderPath)) {
        return res.status(404).json({ success: false, error: 'Folder not found' });
    }
    const cmd = process.platform === 'win32'  ? `explorer.exe "${folderPath}"`
              : process.platform === 'darwin' ? `open "${folderPath}"`
              : `xdg-open "${folderPath}"`;
    exec(cmd, err => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`- Vektor:    http://localhost:${port}/lmv.html`);
    console.log(`- Höjd:      http://localhost:${port}/lmv_hojd.html`);
    console.log(`- Nedladdningar: http://localhost:${port}/downloads.html`);
});
// Endpoint: quickly validate LMV credentials from the client
app.post('/lmv/validate', async (req, res) => {
    const { apiKey, apiUsername, apiToken, collectionId, apiType } = req.body;
    const type = apiType || 'vektor';
    // Accept either apiKey or apiToken
    if (!(apiKey || apiToken) || !collectionId) return res.status(400).json({ success: false, error: 'Saknas data.' });

    try {
        const valid = await validateLmvCredentials(apiUsername, apiKey, apiToken, type, collectionId);
        if (!valid.ok) {
            const status = valid.status || 401;
            writeToLog(`[VALIDATE-ENDPOINT] Validation failed (status: ${status}) for collection ${collectionId}`);
            return res.status(401).json({ success: false, error: 'Ogiltigt användarnamn eller API-nyckel mot Lantmäteriet. Kontrollera dina uppgifter.' });
        }
        return res.json({ success: true, message: 'Validering OK' });
    } catch (e) {
        writeToLog(`[VALIDATE-ENDPOINT] Error during validation: ${e.message}`);
        return res.status(502).json({ success: false, error: 'Fel vid kontakt med LMV API. Försök senare.' });
    }
});