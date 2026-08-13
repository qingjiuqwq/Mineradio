'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');
const { TrackDecryptor } = require('../qishui-audio-decryptor/track-decryptor');

function box(type, payload) {
  const output = Buffer.alloc(8 + payload.length);
  output.writeUInt32BE(8 + payload.length, 0);
  output.write(type, 4, 'ascii');
  payload.copy(output, 8);
  return output;
}

function buildEncryptedSampleMp4() {
  const keyHex = '00112233445566778899aabbccddeeff';
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.alloc(16);
  Buffer.from('0102030405060708', 'hex').copy(iv, 0);

  const plaintext = Buffer.from('Mineradio qishui decrypt sample');
  const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const sampleEntryContent = Buffer.concat([
    Buffer.alloc(6),
    Buffer.from([0, 1]),
    box('sinf', Buffer.concat([
      box('frma', Buffer.from('mp4a')),
      box('schm', Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('piff'), Buffer.from([0, 0, 0, 0])])),
      box('schi', box('tenc', Buffer.alloc(20))),
    ])),
  ]);
  const stsdPayload = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0, 0, 1]), box('enca', sampleEntryContent)]);
  const stszPayload = Buffer.alloc(16);
  stszPayload.writeUInt32BE(0, 0);
  stszPayload.writeUInt32BE(0, 4);
  stszPayload.writeUInt32BE(1, 8);
  stszPayload.writeUInt32BE(plaintext.length, 12);
  const stscPayload = Buffer.alloc(20);
  stscPayload.writeUInt32BE(0, 0);
  stscPayload.writeUInt32BE(1, 4);
  stscPayload.writeUInt32BE(1, 8);
  stscPayload.writeUInt32BE(1, 12);
  stscPayload.writeUInt32BE(1, 16);
  const stcoPayload = Buffer.alloc(16);
  stcoPayload.writeUInt32BE(0, 0);
  stcoPayload.writeUInt32BE(1, 4);
  stcoPayload.writeUInt32BE(0, 8);
  const sencPayload = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0, 0, 1]), iv.subarray(0, 8)]);

  const buildMoov = (stco) => {
    const stblPayload = Buffer.concat([
      box('stsd', stsdPayload),
      box('stsz', stszPayload),
      box('stsc', stscPayload),
      box('stco', stco),
      box('senc', sencPayload),
    ]);
    const stbl = box('stbl', stblPayload);
    const minf = box('minf', stbl);
    const mdia = box('mdia', minf);
    const trak = box('trak', mdia);
    return box('moov', trak);
  };

  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.from([0, 0, 0, 0]), Buffer.from('isomiso2mp41')]));
  const moov = buildMoov(stcoPayload);
  const mdatOffset = ftyp.length + moov.length;
  stcoPayload.writeUInt32BE(mdatOffset + 8, 8);

  return Buffer.concat([ftyp, buildMoov(stcoPayload), box('mdat', encrypted)]);
}

function findTopBox(buffer, type) {
  let position = 0;
  while (position + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(position);
    if (size < 8 || position + size > buffer.length) return null;
    if (buffer.toString('ascii', position + 4, position + 8) === type) {
      return { offset: position, size, dataOffset: position + 8 };
    }
    position += size;
  }
  return null;
}

test('TrackDecryptor rebuilds M4A container and decrypts samples', () => {
  const input = buildEncryptedSampleMp4();
  const result = new TrackDecryptor().decrypt({
    encryptedBuffer: input,
    spadeA: '00112233445566778899aabbccddeeff',
  });
  const output = result.buffer;
  const mdat = findTopBox(output, 'mdat');
  const stcoPosition = output.indexOf(Buffer.from('stco'));

  assert.equal(result.extension, '.m4a');
  assert.ok(mdat, 'rebuilt mdat should exist');
  assert.ok(output.includes(Buffer.from('mp4a')), 'enca should become mp4a');
  assert.ok(!output.includes(Buffer.from('enca')), 'enca should be removed');
  assert.ok(!output.includes(Buffer.from('senc')), 'senc should be removed');
  assert.equal(output.subarray(mdat.dataOffset, mdat.offset + mdat.size).toString(), 'Mineradio qishui decrypt sample');
  assert.ok(stcoPosition >= 0, 'stco should be rebuilt');
  assert.equal(output.readUInt32BE(stcoPosition + 12), mdat.dataOffset);
});
