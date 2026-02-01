const fs = require('fs');
const path = require('path');
const { MicropythonFsHex, microbitBoardId } = require('@microbit/microbit-fs');

(async () => {
  try {
    const base = path.join(__dirname, '..', 'microbit-cache');
    const v1Path = path.join(base, 'MICROBIT_v1.hex');
    const v2Path = path.join(base, 'MICROBIT.hex');
    const v1 = fs.existsSync(v1Path) ? fs.readFileSync(v1Path,'utf8') : null;
    const v2 = fs.existsSync(v2Path) ? fs.readFileSync(v2Path,'utf8') : null;
    console.log('v1 present:', !!v1, v1 ? v1.slice(0,80) : '');
    console.log('v2 present:', !!v2, v2 ? v2.slice(0,80) : '');
    const code = `print('hello')`;
    if (v1 && v2) {
      const fsHex = new MicropythonFsHex([
        { hex: v1, boardId: microbitBoardId.V1 },
        { hex: v2, boardId: microbitBoardId.V2 }
      ]);
      fsHex.write('main.py', code);
      const u = fsHex.getUniversalHex();
      console.log('Got universal hex length', u.length);
    } else if (v1) {
      const fsHex = new MicropythonFsHex([{ hex: v1, boardId: microbitBoardId.V1 }]);
      fsHex.write('main.py', code);
      const u = fsHex.getIntelHex(microbitBoardId.V1);
      console.log('Got V1 hex length', u.length);
    } else if (v2) {
      const fsHex = new MicropythonFsHex([{ hex: v2, boardId: microbitBoardId.V2 }]);
      fsHex.write('main.py', code);
      const u = fsHex.getIntelHex(microbitBoardId.V2);
      console.log('Got V2 hex length', u.length);
    } else {
      console.error('No hex files');
    }
  } catch (err) {
    console.error('TEST ERROR:', err && err.stack ? err.stack : err);
  }
})();