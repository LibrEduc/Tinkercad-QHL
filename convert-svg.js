const sharp = require('sharp');
const path = require('path');

const svgPath = path.join(__dirname, 'Arduino_IDE_logo.svg');
const pngPath = path.join(__dirname, 'Arduino_IDE_logo.png');

// Convert SVG to PNG with 24x24 dimensions (matching the size used in the notification)
sharp(svgPath)
  .resize(24, 24)
  .png()
  .toFile(pngPath)
  .then(() => console.log('Conversion completed successfully'))
  .catch(err => console.error('Error during conversion:', err));