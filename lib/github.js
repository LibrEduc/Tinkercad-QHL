/**
 * Appels API GitHub (releases, versions)
 */
const https = require('https');

const API_OPTIONS = {
    hostname: 'api.github.com',
    method: 'GET',
    headers: {
        'User-Agent': 'Tinkercad-QHL',
        'Accept': 'application/vnd.github.v3+json'
    }
};

function fetchJsonFromGitHubApi(apiPath) {
    return new Promise((resolve, reject) => {
        https.get({ ...API_OPTIONS, path: apiPath }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function getLatestArduinoCliVersion() {
    try {
        const release = await fetchJsonFromGitHubApi('/repos/arduino/arduino-cli/releases/latest');
        return release.tag_name ? release.tag_name.replace(/^v/, '') : null;
    } catch (e) {
        return null;
    }
}

// Fallback URLs si l'API GitHub est indisponible (rate limit, réseau)
const MICROBIT_V1_FALLBACK_URL = 'https://github.com/bbcmicrobit/micropython/releases/download/v1.1.1/micropython-microbit-v1.1.1.hex';
const MICROBIT_V2_FALLBACK_URL = 'https://github.com/microbit-foundation/micropython-microbit-v2/releases/download/v2.1.2/MICROBIT.hex';

async function getMicrobitV1HexUrl() {
    try {
        const release = await fetchJsonFromGitHubApi('/repos/bbcmicrobit/micropython/releases/latest');
        const assets = release.assets || [];
        // Noms réels : "micropython-microbit-v1.1.1.hex" (plus "MICROBIT_V1.hex")
        const asset = assets.find(a => {
            const n = (a.name || '').toLowerCase();
            return n.endsWith('.hex') && (n.includes('microbit') && n.includes('v1') || n.includes('microbit_v1'));
        });
        return asset ? asset.browser_download_url : MICROBIT_V1_FALLBACK_URL;
    } catch (e) {
        return MICROBIT_V1_FALLBACK_URL;
    }
}

async function getMicrobitV2HexUrl() {
    try {
        // V2 : dépôt microbit-foundation/micropython-microbit-v2
        const release = await fetchJsonFromGitHubApi('/repos/microbit-foundation/micropython-microbit-v2/releases/latest');
        const assets = release.assets || [];
        const asset = assets.find(a => a.name && (a.name === 'MICROBIT.hex' || (a.name.endsWith('.hex') && a.name.toUpperCase().includes('MICROBIT'))));
        return asset ? asset.browser_download_url : MICROBIT_V2_FALLBACK_URL;
    } catch (e) {
        return MICROBIT_V2_FALLBACK_URL;
    }
}

function getAppRepositorySlug() {
    try {
        const pkg = require('../package.json');
        const repo = pkg.repository;
        if (!repo) return null;
        if (typeof repo === 'string') {
            const m = repo.match(/github:([^/]+\/[^/]+?)(?:\s|$)/) || repo.match(/^([^/]+\/[^/]+)$/);
            return m ? m[1].replace(/\.git$/, '') : null;
        }
        if (repo.url) {
            const m = repo.url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
            return m ? m[1] : null;
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function getLatestAppReleaseVersion() {
    const slug = getAppRepositorySlug();
    if (!slug) return null;
    try {
        const release = await fetchJsonFromGitHubApi(`/repos/${slug}/releases/latest`);
        return release.tag_name ? release.tag_name.replace(/^v/, '') : null;
    } catch (e) {
        return null;
    }
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na - nb;
    }
    return 0;
}

module.exports = {
    fetchJsonFromGitHubApi,
    getLatestArduinoCliVersion,
    getMicrobitV1HexUrl,
    getMicrobitV2HexUrl,
    getAppRepositorySlug,
    getLatestAppReleaseVersion,
    compareVersions
};
