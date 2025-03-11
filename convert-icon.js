const sharp = require('sharp');
const path = require('path');

const inputPath = path.join(__dirname, 'autodesk-tinkercad.png');
const outputPath = path.join(__dirname, 'build', 'autodesk-tinkercad.png');

// Create 256x256 PNG icon
sharp(inputPath)
  .resize(256, 256)
  .toFile(outputPath)
  .then(() => console.log('Icon converted successfully'))
  .catch(err => console.error('Error converting icon:', err));