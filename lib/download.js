/**
 * Téléchargement HTTP/HTTPS vers fichier (redirections 301, 302, 307, 308)
 * avec callback de progression optionnel.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');

const { safeUnlink, safeClose } = require('./utils');

const PROGRESS_THROTTLE_PERCENT = 5;
const PROGRESS_THROTTLE_MS = 800;

/**
 * @param {string} url - URL du fichier
 * @param {string} destPath - Chemin de destination
 * @param {{ onProgress?: (arg: { percent: number | null; received: number; total: number | null }) => void }} [options]
 * @returns {Promise<void>}
 */
function downloadToFile(url, destPath, options = {}) {
    const { onProgress } = options;
    return new Promise((resolve, reject) => {
        const download = (currentUrl, redirectCount = 0) => {
            if (redirectCount > 5) {
                reject(new Error('Too many redirects'));
                return;
            }
            const urlObj = new URL(currentUrl);
            const protocol = urlObj.protocol === 'https:' ? https : http;
            const file = fs.createWriteStream(destPath);
            file.on('error', err => {
                safeUnlink(destPath);
                reject(err);
            });
            protocol.get(currentUrl, { headers: { 'User-Agent': 'Tinkercad-QHL' } }, res => {
                if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                    safeClose(file);
                    safeUnlink(destPath);
                    const location = res.headers.location;
                    if (location) {
                        const redirectUrl = location.startsWith('http') ? location : new URL(location, currentUrl).toString();
                        download(redirectUrl, redirectCount + 1);
                    } else {
                        reject(new Error('HTTP ' + res.statusCode + ' - No location header'));
                    }
                    return;
                }
                if (res.statusCode !== 200) {
                    safeClose(file);
                    safeUnlink(destPath);
                    reject(new Error('HTTP ' + res.statusCode));
                    return;
                }

                const total = parseInt(res.headers['content-length'], 10) || null;
                let received = 0;
                let lastReportedPercent = -1;
                let lastReportedTime = 0;

                function reportProgress(force = false) {
                    if (typeof onProgress !== 'function') return;
                    const now = Date.now();
                    if (total != null && total > 0) {
                        const percent = Math.min(100, (received / total) * 100);
                        if (force || percent >= 100 || percent - lastReportedPercent >= PROGRESS_THROTTLE_PERCENT) {
                            lastReportedPercent = percent;
                            onProgress({ percent, received, total });
                        }
                    } else {
                        if (force || now - lastReportedTime >= PROGRESS_THROTTLE_MS) {
                            lastReportedTime = now;
                            onProgress({ percent: null, received, total: null });
                        }
                    }
                }

                res.on('data', (chunk) => {
                    received += chunk.length;
                    const ok = file.write(chunk);
                    if (!ok) res.pause();
                    reportProgress();
                });
                file.on('drain', () => res.resume());
                res.on('end', () => {
                    file.end(() => {
                        file.close(() => {
                            reportProgress(true);
                            resolve();
                        });
                    });
                });
                res.on('error', (err) => {
                    safeClose(file);
                    safeUnlink(destPath);
                    reject(err);
                });
            }).on('error', err => {
                safeClose(file);
                safeUnlink(destPath);
                reject(err);
            });
        };
        download(url);
    });
}

module.exports = { downloadToFile };
