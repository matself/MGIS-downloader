
/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Copyright (C) 2025 MundoGIS.
 */


 const Service = require('node-windows').Service;

 // Create a new Windows service object
 const svc = new Service({
   name: 'MGIS-Downloader',
   description: 'ArtData och LMV data',
   script: 'server.js',
   nodeOptions: [
     '--harmony',
     '--max-old-space-size=8192' // Increase Node.js heap limit
   ]
 });

 // Start the service automatically after installation
 svc.on('install', function() {
   svc.start();
 });

 // Install the Windows service
 svc.install();
 
