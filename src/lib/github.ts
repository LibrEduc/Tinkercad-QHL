/**
 * @file github.ts
 * @description Appels à `api.github.com` (releases) : dernière version d’Arduino CLI, URLs des HEX MicroPython
 * micro:bit v1/v2, dernière release de l’app, comparaison sémantique de versions.
 * @remarks En cas d’échec réseau ou rate limit, les HEX micro:bit utilisent des URL de secours codées en dur.
 * @module lib/github
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

import https from 'https';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_OPTIONS = {
    hostname: 'api.github.com',
    method: 'GET',
    headers: {
        'User-Agent': 'Tinkercad-QHL',
        'Accept': 'application/vnd.github.v3+json'
    }
};

/**
 * GET JSON sur `api.github.com` avec en-têtes User-Agent / Accept attendus par GitHub.
 * @param apiPath - Chemin API, ex. `/repos/arduino/arduino-cli/releases/latest`
 */
function fetchJsonFromGitHubApi(apiPath: string): Promise<unknown> {
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

/** Retourne le tag de la dernière release Arduino CLI (sans préfixe `v`), ou `null` si erreur. */
async function getLatestArduinoCliVersion(): Promise<string | null> {
    try {
        const release = (await fetchJsonFromGitHubApi('/repos/arduino/arduino-cli/releases/latest')) as { tag_name?: string };
        return release.tag_name ? release.tag_name.replace(/^v/, '') : null;
    } catch (e) {
        return null;
    }
}

// Fallback URLs si l'API GitHub est indisponible (rate limit, réseau)
const MICROBIT_V1_FALLBACK_URL = 'https://github.com/bbcmicrobit/micropython/releases/download/v1.1.1/micropython-microbit-v1.1.1.hex';
const MICROBIT_V2_FALLBACK_URL = 'https://github.com/microbit-foundation/micropython-microbit-v2/releases/download/v2.1.2/MICROBIT.hex';

/** URL de téléchargement du HEX MicroPython v1 ; fallback si l’API ne répond pas. */
async function getMicrobitV1HexUrl(): Promise<string> {
    try {
        const release = (await fetchJsonFromGitHubApi('/repos/bbcmicrobit/micropython/releases/latest')) as { assets?: { name?: string; browser_download_url?: string }[] };
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

/** URL du HEX v2 (`MICROBIT.hex`) ; fallback si l’API ne répond pas. */
async function getMicrobitV2HexUrl(): Promise<string> {
    try {
        // V2 : dépôt microbit-foundation/micropython-microbit-v2
        const release = (await fetchJsonFromGitHubApi('/repos/microbit-foundation/micropython-microbit-v2/releases/latest')) as { assets?: { name?: string; browser_download_url?: string }[] };
        const assets = release.assets || [];
        const asset = assets.find(a => a.name && (a.name === 'MICROBIT.hex' || (a.name.endsWith('.hex') && a.name.toUpperCase().includes('MICROBIT'))));
        return asset ? asset.browser_download_url : MICROBIT_V2_FALLBACK_URL;
    } catch (e) {
        return MICROBIT_V2_FALLBACK_URL;
    }
}

/** Lit `repository` du `package.json` et renvoie `owner/repo` pour l’API releases. */
function getAppRepositorySlug(): string | null {
    try {
        const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { repository?: string | { url?: string } };
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

/** Dernière version taguée sur GitHub pour cette app, ou `null`. */
async function getLatestAppReleaseVersion(): Promise<string | null> {
    const slug = getAppRepositorySlug();
    if (!slug) return null;
    try {
        const release = (await fetchJsonFromGitHubApi(`/repos/${slug}/releases/latest`)) as { tag_name?: string };
        return release.tag_name ? release.tag_name.replace(/^v/, '') : null;
    } catch (e) {
        return null;
    }
}

/** Comparaison de versions « semver simple » : nombre négatif si `a < b`, positif si `a > b`, 0 si égales. */
function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na - nb;
    }
    return 0;
}

export {
    fetchJsonFromGitHubApi,
    getLatestArduinoCliVersion,
    getMicrobitV1HexUrl,
    getMicrobitV2HexUrl,
    getAppRepositorySlug,
    getLatestAppReleaseVersion,
    compareVersions
};
