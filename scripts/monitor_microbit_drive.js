const fs = require('fs');
const path = require('path');

function normalizeDrive(d) {
  if (!d) return null;
  d = d.replace(/\\/g, '/');
  if (!d.endsWith('/')) d += '/';
  return d;
}

const driveArg = process.argv[2] || process.env.MICROBIT_DRIVE;
if (!driveArg) {
  console.error('Usage: node scripts/monitor_microbit_drive.js <drivePath>');
  console.error('Example: node scripts/monitor_microbit_drive.js D:/');
  process.exit(1);
}

const drive = normalizeDrive(driveArg);
const logFile = path.join(__dirname, '..', 'microbit-upload.log');

function appendLog(line) {
  const ts = new Date().toISOString();
  fs.appendFileSync(logFile, `[${ts}] ${line}\n`);
  console.log(`[${ts}] ${line}`);
}

appendLog(`Starting monitor for drive: ${drive}`);
appendLog('Watching for PROGRAM.HEX, PROGRAM.TMP, FAIL.TXT, DETAILS.TXT');

let previous = {};

function statFile(name) {
  try {
    const p = path.join(drive, name);
    const st = fs.statSync(p);
    return { exists: true, size: st.size, mtime: st.mtimeMs };
  } catch (e) {
    return { exists: false };
  }
}

function checkOnce(isInitial = false) {
  const files = ['PROGRAM.TMP','PROGRAM.HEX','FAIL.TXT','DETAILS.TXT'];
  let change = false;
  files.forEach(f => {
    const s = statFile(f);
    const key = f;
    const prev = previous[key];
    if (!prev && s.exists) {
      if (!isInitial) {
        appendLog(`${f} appeared (size=${s.size})`);
        change = true;
      }
    } else if (prev && s.exists && (s.size !== prev.size || s.mtime !== prev.mtime)) {
      appendLog(`${f} changed (size=${s.size})`);
      change = true;
    } else if (prev && !s.exists) {
      appendLog(`${f} removed`);
      change = true;
    }
    previous[key] = s.exists ? s : null;
  });
  return change;
} 

appendLog('Initial snapshot:');
checkOnce(true);

let polls = 0;
const maxPolls = 60; // poll for up to 60 seconds by default
const interval = setInterval(() => {
  polls++;
  checkOnce();
  // stop if we detect DETAILS.TXT or FAIL.TXT
  const details = statFile('DETAILS.TXT');
  const fail = statFile('FAIL.TXT');
  if (details.exists) {
    appendLog('Details file found; assuming flash completed');
    appendLog('Details content:\n' + fs.readFileSync(path.join(drive,'DETAILS.TXT'),'utf8'));
    clearInterval(interval);
    appendLog('Monitor completed');
    process.exit(0);
  }
  if (fail.exists) {
    appendLog('Fail file found; assuming flash failed');
    appendLog('Fail content:\n' + fs.readFileSync(path.join(drive,'FAIL.TXT'),'utf8'));
    clearInterval(interval);
    appendLog('Monitor completed');
    process.exit(1);
  }
  if (polls >= maxPolls) {
    appendLog('Timeout waiting for drive to report result (no DETAILS.TXT or FAIL.TXT)');
    appendLog('Final snapshot:');
    checkOnce();
    clearInterval(interval);
    appendLog('Monitor completed');
    process.exit(2);
  }
}, 1000);

// Also watch for file system events for faster detection if supported
try {
  fs.watch(drive, (evt, filename) => {
    if (!filename) return;
    if (['PROGRAM.TMP','PROGRAM.HEX','FAIL.TXT','DETAILS.TXT'].includes(filename)) {
      appendLog(`FS event ${evt} on ${filename}`);
      checkOnce();
    }
  });
} catch (e) {
  appendLog('fs.watch not available on this path: ' + (e && e.message ? e.message : e));
}
