const crypto = require('crypto')
const { decryptSpadeA, hexToBuffer } = require('./decrypt-utils')

const encryptedBoxTypes = new Set(['senc', 'saio', 'saiz', 'sinf', 'schi', 'tenc', 'schm', 'frma'])
const containerBoxTypes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])
const maxSampleCount = 200000
const maxChunkCount = 200000
const maxStscEntryCount = 20000

function readUint32BE(data, offset) {
  if (offset < 0 || offset + 4 > data.length) throw new Error('Container structure invalid')
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, false)
}

function writeUint32BE(value) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, false)
  return out
}

function readAscii(data, start, end) {
  return Buffer.from(data.subarray(start, end)).toString('ascii')
}

function concatUint8Arrays(arrays) {
  const totalLength = arrays.reduce((s, a) => s + a.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const a of arrays) { result.set(a, offset); offset += a.length }
  return result
}

function findBox(data, boxType, offset = 0, end = null) {
  const searchEnd = end === null ? data.length : end
  let pos = offset
  while (pos < searchEnd) {
    if (pos + 8 > searchEnd) break
    const boxSize = readUint32BE(data, pos)
    if (boxSize === 0 || boxSize > searchEnd - pos || boxSize < 8) break
    if (readAscii(data, pos + 4, pos + 8) === boxType) return { offset: pos, size: boxSize, data: data.subarray(pos + 8, pos + boxSize) }
    pos += boxSize
  }
  return null
}

function requireBox(box, name) {
  if (!box) throw new Error(`Missing ${name} box`)
  return box
}

function parseStsz(stszData) {
  const sampleSize = readUint32BE(stszData, 4)
  const sampleCount = readUint32BE(stszData, 8)
  if (sampleCount > maxSampleCount) throw new Error('Sample count exceeds limit')
  if (sampleSize !== 0) return new Array(sampleCount).fill(sampleSize)
  const sizes = []
  for (let i = 0; i < sampleCount; i++) sizes.push(readUint32BE(stszData, 12 + i * 4))
  return sizes
}

function parseStsc(stscData) {
  const entryCount = readUint32BE(stscData, 4)
  if (entryCount > maxStscEntryCount) throw new Error('stsc entry count exceeds limit')
  const entries = []
  for (let i = 0; i < entryCount; i++) {
    const base = 8 + i * 12
    entries.push({ firstChunk: readUint32BE(stscData, base), samplesPerChunk: readUint32BE(stscData, base + 4), id: readUint32BE(stscData, base + 8) })
  }
  return entries
}

function parseSenc(sencData) {
  const sampleCount = readUint32BE(sencData, 4)
  if (sampleCount > maxSampleCount) throw new Error('senc sample count exceeds limit')
  const ivs = []
  let pos = 8
  for (let i = 0; i < sampleCount; i++) {
    const iv = new Uint8Array(16)
    iv.set(sencData.subarray(pos, pos + 8))
    ivs.push(iv)
    pos += 8
  }
  return ivs
}

function calculateChunkOffsets(sampleSizes, stscEntries, chunkCount, baseOffset) {
  const offsets = []
  let currentOffset = baseOffset
  let sampleIndex = 0
  for (let chunkIndex = 1; chunkIndex <= chunkCount; chunkIndex++) {
    offsets.push(currentOffset)
    let samplesPerChunk = 0
    for (let ei = 0; ei < stscEntries.length; ei++) {
      const entry = stscEntries[ei]
      const next = stscEntries[ei + 1]
      if (chunkIndex >= entry.firstChunk && (!next || chunkIndex < next.firstChunk)) {
        samplesPerChunk = entry.samplesPerChunk
        break
      }
    }
    for (let s = 0; s < samplesPerChunk; s++) {
      if (sampleIndex < sampleSizes.length) currentOffset += sampleSizes[sampleIndex]
      sampleIndex++
    }
  }
  return offsets
}

function updateStco(stcoData, offsets) {
  const chunkCount = readUint32BE(stcoData, 4)
  const header = stcoData.subarray(0, 8)
  const body = new Uint8Array(chunkCount * 4)
  const view = new DataView(body.buffer)
  for (let i = 0; i < chunkCount; i++) view.setUint32(i * 4, offsets[i], false)
  return concatUint8Arrays([header, body])
}

function processBoxTree(data, offset, size, newMdatOffset, context) {
  const parts = []
  let pos = offset + 8
  const end = offset + size

  while (pos < end) {
    if (pos + 8 > end) { parts.push(data.subarray(pos, end)); break }
    const boxSize = readUint32BE(data, pos)
    if (boxSize < 8 || boxSize > end - pos) { parts.push(data.subarray(pos, end)); break }
    const type = readAscii(data, pos + 4, pos + 8)

    if (encryptedBoxTypes.has(type)) { pos += boxSize; continue }

    if (type === 'enca') {
      const inner = processBoxTree(data, pos, boxSize, newMdatOffset, context)
      parts.push(writeUint32BE(inner.length + 8), Buffer.from('mp4a'), inner)
      pos += boxSize
      continue
    }

    if (type === 'stco') {
      const offsets = calculateChunkOffsets(context.sampleSizes, context.stscEntries, context.chunkCount, newMdatOffset)
      const updatedBody = updateStco(data.subarray(pos + 8, pos + boxSize), offsets)
      parts.push(writeUint32BE(updatedBody.length + 8), Buffer.from('stco'), updatedBody)
      pos += boxSize
      continue
    }

    if (containerBoxTypes.has(type)) {
      const inner = processBoxTree(data, pos, boxSize, newMdatOffset, context)
      parts.push(writeUint32BE(inner.length + 8), Buffer.from(type), inner)
      pos += boxSize
      continue
    }

    parts.push(data.subarray(pos, pos + boxSize))
    pos += boxSize
  }

  return concatUint8Arrays(parts)
}

function scanForFlacMetadata(stsdData) {
  const marker = Buffer.from('dfLa')
  for (let i = 4; i < stsdData.length - 4; i++) {
    if (stsdData[i] === marker[0] && stsdData[i + 1] === marker[1] && stsdData[i + 2] === marker[2] && stsdData[i + 3] === marker[3]) {
      const boxSize = readUint32BE(stsdData, i - 4)
      if (boxSize >= 8 && i - 4 + boxSize <= stsdData.length) return stsdData.subarray(i + 4, i - 4 + boxSize)
    }
  }
  return null
}

function decryptCtr(encryptedSample, keyBytes, iv) {
  const decipher = crypto.createDecipheriv(`aes-${keyBytes.length * 8}-ctr`, keyBytes, Buffer.from(iv))
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(Buffer.from(encryptedSample)), decipher.final()])
}

function asUint8Array(input) {
  if (input instanceof Uint8Array) return input
  if (Buffer.isBuffer(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  throw new Error('Audio data must be Buffer, Uint8Array or ArrayBuffer')
}

class TrackDecryptor {
  resolveKey(spadeA) {
    if (!spadeA) throw new Error('spade_a is required for decryption.')
    const isHex = /^[0-9a-fA-F]+$/.test(spadeA)
    const keyHex = isHex ? spadeA : decryptSpadeA(spadeA)
    if (!keyHex) throw new Error('Failed to resolve decryption key from spade_a.')
    return hexToBuffer(keyHex)
  }

  decrypt({ encryptedBuffer, spadeA, media = {} }) {
    if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0) throw new Error('encryptedBuffer must be a non-empty Buffer.')
    const key = this.resolveKey(spadeA)
    const fileData = asUint8Array(encryptedBuffer)
    const keyBytes = key

    const ftyp = findBox(fileData, 'ftyp')
    const moov = requireBox(findBox(fileData, 'moov'), 'moov')
    const trak = requireBox(findBox(fileData, 'trak', moov.offset + 8, moov.offset + moov.size), 'trak')
    const mdia = requireBox(findBox(fileData, 'mdia', trak.offset + 8, trak.offset + trak.size), 'mdia')
    const minf = requireBox(findBox(fileData, 'minf', mdia.offset + 8, mdia.offset + mdia.size), 'minf')
    const stbl = requireBox(findBox(fileData, 'stbl', minf.offset + 8, minf.offset + minf.size), 'stbl')
    const stsd = requireBox(findBox(fileData, 'stsd', stbl.offset + 8, stbl.offset + stbl.size), 'stsd')
    const stsz = requireBox(findBox(fileData, 'stsz', stbl.offset + 8, stbl.offset + stbl.size), 'stsz')
    const stsc = requireBox(findBox(fileData, 'stsc', stbl.offset + 8, stbl.offset + stbl.size), 'stsc')
    const stco = requireBox(findBox(fileData, 'stco', stbl.offset + 8, stbl.offset + stbl.size), 'stco')
    const mdat = requireBox(findBox(fileData, 'mdat'), 'mdat')

    let senc = findBox(fileData, 'senc', stbl.offset + 8, stbl.offset + stbl.size)
    if (!senc) senc = findBox(fileData, 'senc', moov.offset + 8, moov.offset + moov.size)
    requireBox(senc, 'senc')

    const sampleSizes = parseStsz(stsz.data)
    const stscEntries = parseStsc(stsc.data)
    const chunkCount = readUint32BE(stco.data, 4)
    if (chunkCount > maxChunkCount) throw new Error('Chunk count exceeds limit')
    const ivs = parseSenc(senc.data)
    if (ivs.length < sampleSizes.length) throw new Error('senc IV count less than sample count')
    const encryptedPayloadSize = sampleSizes.reduce((s, sz) => s + sz, 0)
    if (encryptedPayloadSize > mdat.size - 8) throw new Error('Sample total exceeds mdat data range')

    const decryptedSamples = this.decryptSampleList({
      fileData, key: keyBytes, sampleSizes, ivs, mdatOffset: mdat.offset
    })

    const flacMetadata = scanForFlacMetadata(stsd.data)
    if (flacMetadata) {
      const metadataStart = flacMetadata.length > 4 ? 4 : 0
      const outputBuffer = Buffer.from(concatUint8Arrays([Buffer.from('fLaC'), flacMetadata.subarray(metadataStart), ...decryptedSamples]))
      return { buffer: outputBuffer, extension: '.flac', fileName: 'decrypted.flac', meta: { isFlac: true, sampleCount: sampleSizes.length, chunkCount } }
    }

    const context = { sampleSizes, stscEntries, chunkCount }
    const ftypSize = ftyp ? ftyp.size : 0
    const dummyMoovData = processBoxTree(fileData, moov.offset, moov.size, 0, context)
    const newMdatOffset = ftypSize + dummyMoovData.length + 16
    const cleanMoovData = processBoxTree(fileData, moov.offset, moov.size, newMdatOffset, context)
    const cleanMoov = concatUint8Arrays([writeUint32BE(cleanMoovData.length + 8), Buffer.from('moov'), cleanMoovData])
    const mdatData = concatUint8Arrays(decryptedSamples)
    const newMdat = concatUint8Arrays([writeUint32BE(mdatData.length + 8), Buffer.from('mdat'), mdatData])
    const finalParts = []
    if (ftyp) finalParts.push(fileData.subarray(ftyp.offset, ftyp.offset + ftyp.size))
    finalParts.push(cleanMoov, newMdat)

    const outputBuffer = Buffer.from(concatUint8Arrays(finalParts))
    const encaIdx = outputBuffer.indexOf(Buffer.from('enca'))
    if (encaIdx >= 0) {
      Buffer.from('mp4a').copy(outputBuffer, encaIdx)
    }
    return {
      buffer: outputBuffer,
      extension: '.m4a',
      fileName: 'decrypted.m4a',
      meta: { isFlac: false, sampleCount: sampleSizes.length, chunkCount },
    }
  }

  decryptSampleList({ fileData, key, sampleSizes, ivs, mdatOffset }) {
    const decrypted = []
    let offset = mdatOffset + 8
    for (let i = 0; i < sampleSizes.length; i++) {
      const size = sampleSizes[i]
      const iv = ivs[i]
      if (!iv) throw new Error(`Missing IV for sample ${i}`)
      decrypted.push(decryptCtr(fileData.subarray(offset, offset + size), key, iv))
      offset += size
    }
    return decrypted
  }
}

module.exports = { TrackDecryptor }
