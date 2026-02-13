/**
 * Constantes partagées
 */
const CONSTANTS = {
    EMPTY_CODE: 'empty',
    PROGRAM_HEX_FILENAME: 'PROGRAM.HEX',
    LINE_BREAK: '\\r\\n',
    NOTIFICATION_DELAY: 300,
    NOTIFICATION_DURATION: 3000,
    DEFAULT_MICROBIT_VOLUME_NAME: 'MICROBIT'
};

const DETECTION_INTERVAL = 2000;
const PWM_DUTY_CYCLE = 512;

const MICROBIT_DETAILS_PATTERNS = [
    'DAPLink',
    'Interface Version',
    'HIC ID',
    'Unique ID:',
    'Version:'
];

const MAKECODE_PATTERNS = [
    'basic.',
    'IconNames.',
    'basic.forever',
    'input.on_',
    'pins.analog_pitch'
];

const REGEX_MAKECODE = {
    showIcon: /basic\.show_icon\s*\(\s*IconNames\.(\w+)\s*\)/g,
    clearScreen: /basic\.clear_screen\s*\(\s*\)/g,
    forever: /basic\.forever\s*\(\s*(\w+)\s*\)/g,
    buttonPressed: /input\.on_button_pressed\s*\(\s*Button\.([AB])\s*,\s*(\w+)\s*\)/g,
    analogPitch: /pins\.analog_pitch\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/,
    showString: /basic\.show_string\s*\(\s*([^)]+)\s*\)/g,
    showNumber: /basic\.show_number\s*\(\s*([^)]+)\s*\)/g,
    show: /basic\.show\s*\(/g,
    clear: /basic\.clear\s*\(/g,
    pause: /basic\.pause\s*\(/g,
    onGesture: /input\.on_gesture\s*\(\s*Gesture\.(\w+)\s*,\s*(\w+)\s*\)/g,
    buttonIsPressed: /input\.button_is_pressed\s*\(\s*Button\.([AB])\s*\)/g,
    acceleration: /input\.acceleration\s*\(\s*Dimension\.([XYZ])\s*\)/g,
    compassHeading: /input\.compass_heading\s*\(\s*\)/g,
    calibrateCompass: /input\.calibrate_compass\s*\(\s*\)/g,
    temperature: /input\.temperature\s*\(\s*\)/g,
    digitalWritePin: /pins\.digital_write_pin\s*\(\s*DigitalPin\.P(\d+)\s*,\s*([^)]+)\s*\)/g,
    digitalReadPin: /pins\.digital_read_pin\s*\(\s*DigitalPin\.P(\d+)\s*\)/g,
    analogWritePin: /pins\.analog_write_pin\s*\(\s*AnalogPin\.P(\d+)\s*,\s*([^)]+)\s*\)/g,
    analogReadPin: /pins\.analog_read_pin\s*\(\s*AnalogPin\.P(\d+)\s*\)/g,
    playTone: /music\.play_tone\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/g,
    stopAllSounds: /music\.stop_all_sounds\s*\(\s*\)/g,
    sendString: /radio\.send_string\s*\(\s*([^)]+)\s*\)/g,
    receiveString: /radio\.receive_string\s*\(\s*\)/g,
    sendValue: /radio\.send_value\s*\(\s*[^,]+,\s*([^)]+)\s*\)/g,
    receiveValue: /radio\.receive_value\s*\(\s*\)/g,
    setGroup: /radio\.set_group\s*\(\s*([^)]+)\s*\)/g,
    onLogoEvent: /input\.on_logo_event\s*\(\s*TouchButtonEvent\.(\w+)\s*,\s*(\w+)\s*\)/g,
    importMicrobit: /^(from microbit import \*)/m
};

module.exports = {
    CONSTANTS,
    DETECTION_INTERVAL,
    PWM_DUTY_CYCLE,
    MICROBIT_DETAILS_PATTERNS,
    MAKECODE_PATTERNS,
    REGEX_MAKECODE
};
