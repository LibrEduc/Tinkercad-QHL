const fs = require('fs');
const path = require('path');
const { MicropythonFsHex, microbitBoardId } = require('@microbit/microbit-fs');

async function ensureHexes() {
  const base = path.join(__dirname, '..', 'microbit-cache');
  const v1Path = path.join(base, 'MICROBIT_V1.hex');
  const v2Path = path.join(base, 'MICROBIT.hex');
  const v1 = fs.existsSync(v1Path) ? fs.readFileSync(v1Path,'utf8') : null;
  const v2 = fs.existsSync(v2Path) ? fs.readFileSync(v2Path,'utf8') : null;
  return { v1, v2 };
}

function compileWithCache(code, v1, v2) {
  if (!v1 && !v2) throw new Error('No runtime hex available');
  if (v1 && v2) {
    const fsHex = new MicropythonFsHex([
      { hex: v1, boardId: microbitBoardId.V1 },
      { hex: v2, boardId: microbitBoardId.V2 }
    ]);
    fsHex.write('main.py', code);
    return fsHex.getUniversalHex();
  }
  if (v1) {
    const fsHex = new MicropythonFsHex([{ hex: v1, boardId: microbitBoardId.V1 }]);
    fsHex.write('main.py', code);
    return fsHex.getIntelHex(microbitBoardId.V1);
  }
  const fsHex = new MicropythonFsHex([{ hex: v2, boardId: microbitBoardId.V2 }]);
  fsHex.write('main.py', code);
  return fsHex.getIntelHex(microbitBoardId.V2);
}

function writeAtomically(drive, content) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(drive, 'PROGRAM.TMP');
    const final = path.join(drive, 'PROGRAM.HEX');
    fs.writeFile(tmp, content, (err) => {
      if (err) return reject(err);
      fs.rename(tmp, final, (err2) => {
        if (err2) return reject(err2);
        resolve(final);
      });
    });
  });
}

function checkFlashResult(drive) {
  const failPath = path.join(drive, 'FAIL.TXT');
  const detailsPath = path.join(drive, 'DETAILS.TXT');
  if (fs.existsSync(failPath)) {
    return { status: 'fail', message: fs.readFileSync(failPath,'utf8').slice(0,200) };
  }
  if (fs.existsSync(detailsPath)) {
    return { status: 'details', message: fs.readFileSync(detailsPath,'utf8').slice(0,200) };
  }
  if (fs.existsSync(path.join(drive, 'PROGRAM.HEX'))) {
    return { status: 'ok' };
  }
  return { status: 'unknown' };
}

(async () => {
  try {
    console.log('Starting micro:bit upload simulation test');
    const drive = path.join(__dirname, '..', 'simulated-drive');
    if (!fs.existsSync(drive)) fs.mkdirSync(drive, { recursive: true });
    // Clean old files
    ['PROGRAM.HEX','PROGRAM.TMP','FAIL.TXT','DETAILS.TXT'].forEach(f => {
      try { fs.unlinkSync(path.join(drive,f)); } catch(e) {}
    });

    const { v1, v2 } = await ensureHexes();
    console.log('Runtimes presence: v1=', !!v1, 'v2=', !!v2);

    // Test 1: python compile + upload
    const code = `# hello\nprint('Hello micro:bit from test')\n`;
    console.log('Compiling python code to hex...');
    const hex = compileWithCache(code, v1, v2);
    console.log('Got hex length', hex.length);
    console.log('Writing hex atomically to simulated drive...');
    await writeAtomically(drive, hex);
    console.log('Write complete. Checking flash result...');
    const res1 = checkFlashResult(drive);
    console.log('Result after write:', res1);

    // simulate micro:bit writing DETAILS after some processing
    console.log('Simulate micro:bit writing DETAILS.TXT...');
    fs.writeFileSync(path.join(drive, 'DETAILS.TXT'), 'OK: flashed', 'utf8');
    const res2 = checkFlashResult(drive);
    console.log('Result after micro:bit update:', res2);

    // Cleanup
    ['PROGRAM.HEX','PROGRAM.TMP','FAIL.TXT','DETAILS.TXT'].forEach(f => {
      try { fs.unlinkSync(path.join(drive,f)); } catch(e) {}
    });

    // Test 2: upload when source is already HEX
    console.log('Test 2: uploading preexisting HEX content');
    const sampleHex = ':1000000000000000000000000000000000000000\n';
    await writeAtomically(drive, sampleHex);
    console.log('Wrote sample HEX; check:', checkFlashResult(drive));

    console.log('Upload simulation tests completed successfully');
  } catch (err) {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
})();