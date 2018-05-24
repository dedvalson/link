const dgram = require('dgram');
const delay = require('delay');
const debug = require('debug')('TuyaRegister');

function TuyaRegister(options) {
  return options;
}

TuyaRegister.prototype.registerSmartLink = function (options) {
  // Check arguments
  if (options.region.length !== 2) {
    throw new Error('Invalid region');
  }
  if (options.token.length !== 8) {
    throw new Error('Invalid token');
  }
  if (options.secret.length !== 4) {
    throw new Error('Invalid secret');
  }
  if (options.ssid.length > 32) {
    throw new Error('Invalid SSID');
  }
  if (options.wifiPassword > 64) {
    throw new Error('Invalid WiFi password');
  }

  debug('Sending SmartLink initialization packets');
  const that = this;
  return new Promise(async (resolve, reject) => {
    try {
      await this.sendSmartLinkStart();
      debug('Sending SmartLink data packets');
      await this.sendSmartLinkData(that.smartLinkEncode(options));
      debug('Finished sending packets.');
      resolve();
    } catch (err) {
      reject(err);
    }
  });
};

TuyaRegister.prototype.sendSmartLinkStart = function () {
  const that = this;
  return new Promise((async (resolve, reject) => {
    try {
      /* eslint-disable no-await-in-loop */
      for (let x = 0; x < 144; x++) {
        await that.broadcastUDP(1);
        await that.broadcastUDP(3);
        await that.broadcastUDP(6);
        await that.broadcastUDP(10);
        await delay((x % 8) + 33);
      }
      /* eslint-enable no-await-in-loop */

      resolve();
    } catch (err) {
      reject(err);
    }
  }));
};

TuyaRegister.prototype.sendSmartLinkData = function (data) {
  const that = this;
  return new Promise(async (resolve, reject) => {
    try {
      let delayMs = 0;

      /* eslint-disable no-await-in-loop */
      for (let x = 0; x < 30; x++) {
        if (delayMs > 26) {
          delayMs = 6;
        }

        await that.asyncForEach(data, async b => {
          await that.broadcastUDP(b);
          await delay(delayMs);
        }); // 17, 40, 53, 79

        await delay(200);
        delayMs += 3;
      }
      /* eslint-enable no-await-in-loop */

      resolve();
    } catch (err) {
      reject(err);
    }
  });
};

TuyaRegister.prototype.smartLinkEncode = function (options) {
  // Convert strings to Buffers
  const wifiPasswordBytes = Buffer.from(options.wifiPassword);
  const regionTokenSecretBytes = Buffer.from(options.region +
                                             options.token + options.secret);
  const ssidBytes = Buffer.from(options.ssid);

  // Calculate size of byte array
  const rawByteArray = Buffer.alloc(1 +
                                  wifiPasswordBytes.length +
                                  1 +
                                  regionTokenSecretBytes.length +
                                  ssidBytes.length);

  let rawByteArrayIndex = 0;

  // Write WiFi password length
  rawByteArray.writeInt8(this.getLength(options.wifiPassword), rawByteArrayIndex);
  rawByteArrayIndex++;

  // Write WiFi password
  wifiPasswordBytes.copy(rawByteArray, rawByteArrayIndex);
  rawByteArrayIndex += wifiPasswordBytes.length;

  // Write region token secret length
  rawByteArray.writeInt8(this.getLength(regionTokenSecretBytes), rawByteArrayIndex);
  rawByteArrayIndex++;

  // Write region token secret bytes
  regionTokenSecretBytes.copy(rawByteArray, rawByteArrayIndex);
  rawByteArrayIndex += regionTokenSecretBytes.length;

  // Write WiFi SSID bytes
  ssidBytes.copy(rawByteArray, rawByteArrayIndex);
  rawByteArrayIndex += ssidBytes.length;

  if (rawByteArray.length !== rawByteArrayIndex) {
    throw new Error('Byte buffer filled improperly');
  }

  // Now, encode above data into packet lengths
  const rawDataLengthRoundedUp = this.rounder(rawByteArray.length, 4);

  const encodedData = [];

  // First 4 bytes of header
  const stringLength = (wifiPasswordBytes.length +
                        regionTokenSecretBytes.length + ssidBytes.length + 2) % 256;
  const stringLengthCRC = this.tuyaCRC8([stringLength], 1);

  // Length encoded into the first two bytes based at 16 and then 32
  encodedData[0] = (stringLength / 16) | 16;
  encodedData[1] = (stringLength % 16) | 32;
  // Length CRC encoded into the next two bytes based at 46 and 64
  encodedData[2] = (stringLengthCRC / 16) | 48;
  encodedData[3] = (stringLengthCRC % 16) | 64;

  // Rest of data
  let encodedDataIndex = 4;
  let sequenceCounter = 0;

  for (let x = 0; x < rawDataLengthRoundedUp; x += 4) {
    // Build CRC buffer, using data from rawByteArray or 0 values if too long
    const crcData = [];
    crcData[0] = sequenceCounter++;
    crcData[1] = x + 0 < rawByteArray.length ? rawByteArray[x + 0] : 0;
    crcData[2] = x + 1 < rawByteArray.length ? rawByteArray[x + 1] : 0;
    crcData[3] = x + 2 < rawByteArray.length ? rawByteArray[x + 2] : 0;
    crcData[4] = x + 3 < rawByteArray.length ? rawByteArray[x + 3] : 0;

    // Calculate the CRC
    const crc = this.tuyaCRC8(crcData, 5);

    // Move data to encodedData array
    // CRC
    encodedData[encodedDataIndex++] = (crc % 128) | 128;
    // Sequence number
    encodedData[encodedDataIndex++] = (crcData[0] % 128) | 128;
    // Data
    encodedData[encodedDataIndex++] = (crcData[1] % 256) | 256;
    encodedData[encodedDataIndex++] = (crcData[2] % 256) | 256;
    encodedData[encodedDataIndex++] = (crcData[3] % 256) | 256;
    encodedData[encodedDataIndex++] = (crcData[4] % 256) | 256;
  }

  return encodedData;
};

TuyaRegister.prototype.getLength = function (str) {
  return Buffer.byteLength(str, 'utf8');
};

TuyaRegister.prototype.rounder = function (x, g) {
  return Math.ceil(x / g) * g;
};

TuyaRegister.prototype.tuyaCRC8 = function (p, len) {
  let crc = 0;
  let i = 0;

  while (i < len) {
    crc = this.calcrc1Byte(crc ^ p[i]);
    i++;
  }

  return crc;
};

TuyaRegister.prototype.calcrc1Byte = function (abyte) {
  const crc1Byte = Buffer.alloc(1);
  crc1Byte[0] = 0;

  for (let i = 0; i < 8; i++) {
    if (((crc1Byte[0] ^ abyte) & 0x01) > 0) {
      crc1Byte[0] ^= 0x18;
      crc1Byte[0] >>= 1;
      crc1Byte[0] |= 0x80;
    } else {
      crc1Byte[0] >>= 1;
    }

    abyte >>= 1;
  }

  return crc1Byte[0];
};

TuyaRegister.prototype.broadcastUDP = function (len) {
  // Create and bind UDP socket
  if (!this.udpClient) {
    this.udpClient = dgram.createSocket('udp4');
    this.udpClient.on('listening', function () {
      this.setBroadcast(true);
    });
    this.udpClient.bind(63145);
  }

  // 0-filled buffer
  const message = Buffer.alloc(len);
  return new Promise((resolve, reject) => {
    this.udpClient.send(message, 0, message.length, 30011, 'broadcasthost', err => {
      if (err) {
        reject(err);
      }
      resolve();
    });
  });
};

TuyaRegister.prototype.cleanup = function () {
  this.udpClient.unref();
};

TuyaRegister.prototype.asyncForEach = async function (array, callback) {
  for (let index = 0; index < array.length; index++) {
    // eslint-disable-next-line no-await-in-loop
    await callback(array[index], index, array);
  }
};

module.exports = TuyaRegister;