# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # install dependencies
npm start         # start server at http://localhost:3003
node server.js    # alternative start (same thing)
```

No test suite exists. Manual testing via browser at `http://localhost:3003`.

## Environment setup

Copy `.env.example` to `.env` and set paths before starting:

```ini
GDAL="C:/QGIS/apps/gdal/"   # path to GDAL binaries (gdalbuildvrt, gdalinfo, etc.)
QGIS="C:/QGIS/bin/"          # QGIS bin takes precedence over GDAL if both set
PORT=3003
```

GDAL tools (`gdalbuildvrt`, `gdalinfo`, `gdal_translate`, `gdaladdo`) are invoked as child processes via `spawn`. If neither `GDAL` nor `QGIS` env vars are set, the server assumes the tools are on `PATH`.

## Architecture

Single-file backend: **`server.js`** — an Express app with no router modules or controllers.  
All frontend lives in **`public/`** as static HTML/JS/CSS files.  
`data/lan.geojson` holds Swedish county boundaries served at `/lmv/lan`.

### Frontend pages

| URL | File | Purpose |
|-----|------|---------|
| `/` | `index.html` | Landing page |
| `/artdata.html` | `artdata.html` | GBIF species occurrence downloader |
| `/lmv.html` | `lmv.html` | Lantmäteriet vector data downloader |
| `/lmv_hojd.html` | `lmv_hojd.html` | Lantmäteriet height data (DEM) downloader |
| `/downloads.html` | `downloads.html` | Manage completed downloads |
| `/hjalp.html` | `hjalp.html` | Help/guide (Swedish) |

### Backend route groups

- **`/check-species`, `/get-occurrence-count`, `/create-download`** — GBIF proxy endpoints; forward requests to `api.gbif.org` using Basic Auth.
- **`/lmv/collections`**, **`/lmv/hojd/collections`**, **`/lmv/lan`** — catalogue endpoints; proxy to Lantmäteriet STAC APIs.
- **`/lmv/start-full-download`** — main download trigger. Validates credentials, then runs `fetchDownloadAndUnzipAll()` in the background (202 response, fire-and-forget). Special case: `collectionId === 'ALL_MARKHOJD'` downloads all Markhöjdmodell collections into a single timestamped `MHM_YYYYMMDD_HHMMSS/` folder.
- **`/lmv/cancel-download`** — aborts a running download via `AbortController`.
- **`/lmv/progress/:downloadId`** — polling endpoint; reads from `downloadProgress` Map (in-memory).
- **`/lmv/downloads/*`** — list, zip-download, delete, and open completed download folders (folders named `LMV_DOWNLOADS_*`).
- **`/lmv/validate`**, **`/lmv/test-dl1`** — credential validation and diagnostics.

### Download flow (`fetchDownloadAndUnzipAll`)

1. **STAC pagination** — POST to `/search` then follow `next` links until exhausted.
2. **File download** — `downloadWithRedirects()` manually follows HTTP redirects to preserve `Authorization` headers (axios strips them on cross-domain redirects). Supports Bearer token, Basic Auth, and X-API-Key. 401 from dl1 with Bearer → automatic fallback to Basic Auth if both credential types are present.
3. **ZIP extraction** — inline via `unzipper`.
4. **Tile index** — `tile_index.geojson` written with bbox features for each downloaded tile.
5. **Post-processing** (`runPostProcessing`) — calls `gdalbuildvrt` to build a VRT mosaic, then `gdalinfo -stats` to derive min/max for an auto-generated QGIS `.qml` colour-ramp style. `ALL_MARKHOJD` runs post-processing once on the combined folder after all sub-collections complete.

### Progress tracking

`downloadProgress` Map keyed by `downloadId`. Structure: `{ total, done, failed, currentFile, status }`.  
For `ALL_MARKHOJD`, `total` accumulates as each sub-collection's STAC search returns its file count.  
Progress entries auto-delete 10 minutes after completion.

### Authentication modes (Lantmäteriet)

- **Bearer token** — sent as `Authorization: Bearer <token>` to both STAC search and file downloads.
- **Basic Auth (Geotorget systemkonto)** — `apiUsername` + `apiKey` sent as HTTP Basic Auth against dl1.
- Fallback: if Bearer is rejected (401) on a file download but Geotorget credentials are also present, the server automatically retries with Basic Auth.
