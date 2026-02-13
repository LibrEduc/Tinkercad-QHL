/**
 * Détecte les ports COM dont le périphérique est vu par l'OS comme lecteur USB (lettre de lecteur).
 * Utilisé pour filtrer la liste Arduino : n'afficher que les cartes avec port COM qui ne sont
 * pas considérées comme lecteur USB (ex. Arduino = COM seul ; micro:bit = COM + lecteur → exclu).
 * Résultat mis en cache (TTL 10 s) pour ne pas lancer le script lourd à chaque scan (2 s).
 */
const { spawnSync } = require('child_process');
const { isWindows } = require('./platform');
const { logger } = require('./logger');

const CACHE_TTL_MS = 10000;
let cache = { result: null, ts: 0 };

/**
 * Sous Windows, retourne la liste des noms de ports COM (ex. ['COM3']) dont le périphérique
 * a aussi une lettre de lecteur (même appareil USB = port série + stockage).
 * Sur les autres OS, retourne []. Résultat caché 10 s pour limiter les appels au script.
 * @returns {string[]}
 */
function getComPortsWithDriveLetter() {
    if (!isWindows) {
        return [];
    }
    const now = Date.now();
    if (cache.result !== null && (now - cache.ts) < CACHE_TTL_MS) {
        return cache.result;
    }
    try {
        const script = `
$ErrorActionPreference = 'Stop'
$driveParents = @{}

try {
  # Parents des lecteurs amovibles (volumes avec lettre)
  $vols = Get-WmiObject Win32_LogicalDisk -Filter "DriveType=2"
  foreach ($v in $vols) {
    try {
      $part = Get-WmiObject -Query "ASSOCIATORS OF {Win32_LogicalDisk.DeviceID='$($v.DeviceID)'} WHERE AssocClass=Win32_LogicalDiskToPartition ResultClass=Win32_DiskPartition"
      if (-not $part) { continue }
      $drive = Get-WmiObject -Query "ASSOCIATORS OF {$($part.__RELPATH)} WHERE AssocClass=Win32_DiskDriveToDiskPartition ResultClass=Win32_DiskDrive"
      if (-not $drive) { continue }
      $pnp = Get-WmiObject -Query "ASSOCIATORS OF {$($drive.__RELPATH)} WHERE ResultClass=Win32_PnPEntity"
      if (-not $pnp -or -not $pnp.DeviceID) { continue }
      $parent = (Get-PnpDeviceProperty -InstanceId $pnp.DeviceID -KeyName 'DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue).Data
      if ($parent) { $driveParents[$parent] = $true }
    } catch { }
  }

  # Ports COM USB : parent = même périphérique composite que le lecteur ?
  $ports = Get-PnpDevice -Class Ports | Where-Object { $_.InstanceId -like 'USB*' -and $_.Status -eq 'OK' }
  foreach ($p in $ports) {
    if ($p.FriendlyName -match '\\((COM\\d+)\\)') { $comName = $matches[1] } elseif ($p.Name -match '\\((COM\\d+)\\)') { $comName = $matches[1] } else { continue }
    try {
      $parent = (Get-PnpDeviceProperty -InstanceId $p.InstanceId -KeyName 'DEVPKEY_Device_Parent' -ErrorAction SilentlyContinue).Data
      if ($parent -and $driveParents[$parent]) { Write-Output $comName }
    } catch { }
  }
} catch { }
`;
        const result = spawnSync('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-Command', script
        ], {
            encoding: 'utf8',
            timeout: 10000,
            windowsHide: true
        });
        if (result.error) {
            logger.debug('comPortsWithDrive: spawn error', result.error.message);
            return [];
        }
        const lines = (result.stdout || '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const comPorts = lines.filter(l => /^COM\d+$/i.test(l));
        if (comPorts.length > 0) {
            logger.debug('comPortsWithDrive: excluding COM ports (device has drive)', comPorts);
        }
        cache = { result: comPorts, ts: Date.now() };
        return comPorts;
    } catch (e) {
        logger.debug('comPortsWithDrive: error', e.message);
        cache = { result: [], ts: Date.now() };
        return [];
    }
}

module.exports = {
    getComPortsWithDriveLetter
};
