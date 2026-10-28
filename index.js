/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {EventEmitter} from 'node:events';
import os from 'node:os';

// BSER uses the local endianness to reduce byte swapping overheads
// (the protocol is expressly local IPC only).  We need to tell node
// to use the native endianness when reading various native values.
const isBigEndian = os.endianness() === 'BE';

// int64 values are decoded as BigInt.  Values that can be exactly
// represented as a JS number are converted back to numbers; anything
// outside this range stays a BigInt.
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER = BigInt(-Number.MAX_SAFE_INTEGER);

// Find the next power-of-2 >= size
function nextPow2(size) {
  return Math.pow(2, Math.ceil(Math.log(size) / Math.LN2));
}

// Expandable buffer that we can provide a size hint for
export class Accumulator {
  constructor(initsize) {
    this.buf = Buffer.alloc(nextPow2(initsize || 8192));
    this.readOffset = 0;
    this.writeOffset = 0;
  }

  // How much we can write into this buffer without allocating
  writeAvail() {
    return this.buf.length - this.writeOffset;
  }

  // How much we can read
  readAvail() {
    return this.writeOffset - this.readOffset;
  }

  // Ensure that we have enough space for size bytes
  reserve(size) {
    if (size < this.writeAvail()) {
      return;
    }

    // If we can make room by shunting down, do so
    if (this.readOffset > 0) {
      this.buf.copy(this.buf, 0, this.readOffset, this.writeOffset);
      this.writeOffset -= this.readOffset;
      this.readOffset = 0;
    }

    // If we made enough room, no need to allocate more
    if (size < this.writeAvail()) {
      return;
    }

    // Allocate a replacement and copy it in
    const buf = Buffer.alloc(nextPow2(this.buf.length + size - this.writeAvail()));
    this.buf.copy(buf);
    this.buf = buf;
  }

  // Append buffer or string.  Will resize as needed
  append(buf) {
    if (Buffer.isBuffer(buf)) {
      this.reserve(buf.length);
      buf.copy(this.buf, this.writeOffset, 0, buf.length);
      this.writeOffset += buf.length;
    } else {
      const size = Buffer.byteLength(buf);
      this.reserve(size);
      this.buf.write(buf, this.writeOffset);
      this.writeOffset += size;
    }
  }

  assertReadableSize(size) {
    if (this.readAvail() < size) {
      throw new Error(
        'wanted to read ' + size + ' bytes but only have ' + this.readAvail(),
      );
    }
  }

  peekString(size) {
    this.assertReadableSize(size);
    return this.buf.toString('utf-8', this.readOffset, this.readOffset + size);
  }

  readString(size) {
    const str = this.peekString(size);
    this.readOffset += size;
    return str;
  }

  peekInt(size) {
    this.assertReadableSize(size);
    switch (size) {
      case 1:
        return this.buf.readInt8(this.readOffset);
      case 2:
        return isBigEndian
          ? this.buf.readInt16BE(this.readOffset)
          : this.buf.readInt16LE(this.readOffset);
      case 4:
        return isBigEndian
          ? this.buf.readInt32BE(this.readOffset)
          : this.buf.readInt32LE(this.readOffset);
      case 8:
        return isBigEndian
          ? this.buf.readBigInt64BE(this.readOffset)
          : this.buf.readBigInt64LE(this.readOffset);
      default:
        throw new Error('invalid integer size ' + size);
    }
  }

  readInt(bytes) {
    const ival = this.peekInt(bytes);
    this.readOffset += bytes;
    if (
      typeof ival === 'bigint' &&
      ival <= MAX_SAFE_INTEGER &&
      ival >= MIN_SAFE_INTEGER
    ) {
      return Number(ival);
    }
    return ival;
  }

  peekDouble() {
    this.assertReadableSize(8);
    return isBigEndian
      ? this.buf.readDoubleBE(this.readOffset)
      : this.buf.readDoubleLE(this.readOffset);
  }

  readDouble() {
    const dval = this.peekDouble();
    this.readOffset += 8;
    return dval;
  }

  readAdvance(size) {
    if (size > 0) {
      this.assertReadableSize(size);
    } else if (size < 0 && this.readOffset + size < 0) {
      throw new Error(
        'advance with negative offset ' +
          size +
          ' would seek off the start of the buffer',
      );
    }
    this.readOffset += size;
  }

  writeByte(value) {
    this.reserve(1);
    this.buf.writeInt8(value, this.writeOffset);
    ++this.writeOffset;
  }

  writeInt(value, size) {
    this.reserve(size);
    switch (size) {
      case 1:
        this.buf.writeInt8(value, this.writeOffset);
        break;
      case 2:
        if (isBigEndian) {
          this.buf.writeInt16BE(value, this.writeOffset);
        } else {
          this.buf.writeInt16LE(value, this.writeOffset);
        }
        break;
      case 4:
        if (isBigEndian) {
          this.buf.writeInt32BE(value, this.writeOffset);
        } else {
          this.buf.writeInt32LE(value, this.writeOffset);
        }
        break;
      default:
        throw new Error('unsupported integer size ' + size);
    }
    this.writeOffset += size;
  }

  writeBigInt(value) {
    this.reserve(8);
    if (isBigEndian) {
      this.buf.writeBigInt64BE(value, this.writeOffset);
    } else {
      this.buf.writeBigInt64LE(value, this.writeOffset);
    }
    this.writeOffset += 8;
  }

  writeDouble(value) {
    this.reserve(8);
    if (isBigEndian) {
      this.buf.writeDoubleBE(value, this.writeOffset);
    } else {
      this.buf.writeDoubleLE(value, this.writeOffset);
    }
    this.writeOffset += 8;
  }
}

const BSER_ARRAY = 0x00;
const BSER_OBJECT = 0x01;
const BSER_STRING = 0x02;
const BSER_INT8 = 0x03;
const BSER_INT16 = 0x04;
const BSER_INT32 = 0x05;
const BSER_INT64 = 0x06;
const BSER_REAL = 0x07;
const BSER_TRUE = 0x08;
const BSER_FALSE = 0x09;
const BSER_NULL = 0x0a;
const BSER_TEMPLATE = 0x0b;
const BSER_SKIP = 0x0c;

const ST_NEED_PDU = 0; // Need to read and decode PDU length
const ST_FILL_PDU = 1; // Know the length, need to read whole content

const MAX_INT8 = 127;
const MAX_INT16 = 32767;
const MAX_INT32 = 2147483647;

export class BunserBuf extends EventEmitter {
  constructor() {
    super();
    this.buf = new Accumulator();
    this.state = ST_NEED_PDU;
    this.pduLen = 0;
  }

  append(buf, synchronous) {
    if (synchronous) {
      this.buf.append(buf);
      return this.process(synchronous);
    }

    try {
      this.buf.append(buf);
    } catch (err) {
      this.emit('error', err);
      return;
    }
    // Arrange to decode later.  This allows the consuming
    // application to make progress with other work in the
    // case that we have a lot of subscription updates coming
    // in from a large tree.
    this.processLater();
  }

  processLater() {
    process.nextTick(() => {
      try {
        this.process(false);
      } catch (err) {
        this.emit('error', err);
      }
    });
  }

  // Do something with the buffer to advance our state.
  // If we're running synchronously we'll return either
  // the value we've decoded or undefined if we don't
  // yet have enought data.
  // If we're running asynchronously, we'll emit the value
  // when it becomes ready and schedule another invocation
  // of process on the next tick if we still have data we
  // can process.
  process(synchronous) {
    if (this.state === ST_NEED_PDU) {
      if (this.buf.readAvail() < 2) {
        return;
      }
      // Validate BSER header
      this.expectCode(0);
      this.expectCode(1);
      this.pduLen = this.decodeInt(true /* relaxed */);
      if (this.pduLen === false) {
        // Need more data, walk backwards
        this.buf.readAdvance(-2);
        return;
      }
      // Ensure that we have a big enough buffer to read the rest of the PDU
      this.buf.reserve(this.pduLen);
      this.state = ST_FILL_PDU;
    }

    if (this.state === ST_FILL_PDU) {
      if (this.buf.readAvail() < this.pduLen) {
        // Need more data
        return;
      }

      // We have enough to decode it
      const val = this.decodeAny();
      if (synchronous) {
        return val;
      }
      this.emit('value', val);
      this.state = ST_NEED_PDU;
    }

    if (!synchronous && this.buf.readAvail() > 0) {
      this.processLater();
    }
  }

  raise(reason) {
    throw new Error(
      reason +
        ', in Buffer of length ' +
        this.buf.buf.length +
        ' (' +
        this.buf.readAvail() +
        ' readable) at offset ' +
        this.buf.readOffset +
        ' buffer: ' +
        JSON.stringify(
          this.buf.buf
            .slice(this.buf.readOffset, this.buf.readOffset + 32)
            .toJSON(),
        ),
    );
  }

  expectCode(expected) {
    const code = this.buf.readInt(1);
    if (code !== expected) {
      this.raise('expected bser opcode ' + expected + ' but got ' + code);
    }
  }

  decodeAny() {
    const code = this.buf.peekInt(1);
    switch (code) {
      case BSER_INT8:
      case BSER_INT16:
      case BSER_INT32:
      case BSER_INT64:
        return this.decodeInt();
      case BSER_REAL:
        this.buf.readAdvance(1);
        return this.buf.readDouble();
      case BSER_TRUE:
        this.buf.readAdvance(1);
        return true;
      case BSER_FALSE:
        this.buf.readAdvance(1);
        return false;
      case BSER_NULL:
        this.buf.readAdvance(1);
        return null;
      case BSER_STRING:
        return this.decodeString();
      case BSER_ARRAY:
        return this.decodeArray();
      case BSER_OBJECT:
        return this.decodeObject();
      case BSER_TEMPLATE:
        return this.decodeTemplate();
      default:
        this.raise('unhandled bser opcode ' + code);
    }
  }

  decodeArray() {
    this.expectCode(BSER_ARRAY);
    const nitems = this.decodeInt();
    const arr = [];
    for (let i = 0; i < nitems; ++i) {
      arr.push(this.decodeAny());
    }
    return arr;
  }

  decodeObject() {
    this.expectCode(BSER_OBJECT);
    const nitems = this.decodeInt();
    const res = {};
    for (let i = 0; i < nitems; ++i) {
      const key = this.decodeString();
      const val = this.decodeAny();
      res[key] = val;
    }
    return res;
  }

  decodeTemplate() {
    this.expectCode(BSER_TEMPLATE);
    const keys = this.decodeArray();
    const nitems = this.decodeInt();
    const arr = [];
    for (let i = 0; i < nitems; ++i) {
      const obj = {};
      for (let keyidx = 0; keyidx < keys.length; ++keyidx) {
        if (this.buf.peekInt(1) === BSER_SKIP) {
          this.buf.readAdvance(1);
          continue;
        }
        const val = this.decodeAny();
        obj[keys[keyidx]] = val;
      }
      arr.push(obj);
    }
    return arr;
  }

  decodeString() {
    this.expectCode(BSER_STRING);
    const len = this.decodeInt();
    return this.buf.readString(len);
  }

  // This is unusual compared to the other decode functions in that
  // we may not have enough data available to satisfy the read, and
  // we don't want to throw.  This is only true when we're reading
  // the PDU length from the PDU header; we'll set relaxSizeAsserts
  // in that case.
  decodeInt(relaxSizeAsserts) {
    if (relaxSizeAsserts && this.buf.readAvail() < 1) {
      return false;
    } else {
      this.buf.assertReadableSize(1);
    }
    const code = this.buf.peekInt(1);
    let size = 0;
    switch (code) {
      case BSER_INT8:
        size = 1;
        break;
      case BSER_INT16:
        size = 2;
        break;
      case BSER_INT32:
        size = 4;
        break;
      case BSER_INT64:
        size = 8;
        break;
      default:
        this.raise('invalid bser int encoding ' + code);
    }

    if (relaxSizeAsserts && this.buf.readAvail() < 1 + size) {
      return false;
    }
    this.buf.readAdvance(1);
    return this.buf.readInt(size);
  }
}

// synchronously BSER decode a string and return the value
export function loadFromBuffer(input) {
  const buf = new BunserBuf();
  const result = buf.append(input, true);
  if (buf.buf.readAvail()) {
    throw Error('excess data found after input buffer, use BunserBuf instead');
  }
  if (typeof result === 'undefined') {
    throw Error('no bser found in string and no error raised!?');
  }
  return result;
}

function dump_int64(buf, val) {
  buf.writeByte(BSER_INT64);
  buf.writeBigInt(val);
}

function dump_int(buf, val) {
  if (typeof val === 'bigint') {
    dump_int64(buf, val);
    return;
  }
  const abs = Math.abs(val);
  if (abs <= MAX_INT8) {
    buf.writeByte(BSER_INT8);
    buf.writeInt(val, 1);
  } else if (abs <= MAX_INT16) {
    buf.writeByte(BSER_INT16);
    buf.writeInt(val, 2);
  } else if (abs <= MAX_INT32) {
    buf.writeByte(BSER_INT32);
    buf.writeInt(val, 4);
  } else {
    dump_int64(buf, BigInt(val));
  }
}

function dump_any(buf, val) {
  switch (typeof val) {
    case 'bigint':
      dump_int64(buf, val);
      return;
    case 'number':
      // check if it is an integer or a float
      if (isFinite(val) && Math.floor(val) === val) {
        dump_int(buf, val);
      } else {
        buf.writeByte(BSER_REAL);
        buf.writeDouble(val);
      }
      return;
    case 'string':
      buf.writeByte(BSER_STRING);
      dump_int(buf, Buffer.byteLength(val));
      buf.append(val);
      return;
    case 'boolean':
      buf.writeByte(val ? BSER_TRUE : BSER_FALSE);
      return;
    case 'object':
      if (val === null) {
        buf.writeByte(BSER_NULL);
        return;
      }
      if (Array.isArray(val)) {
        buf.writeByte(BSER_ARRAY);
        dump_int(buf, val.length);
        for (let i = 0; i < val.length; ++i) {
          dump_any(buf, val[i]);
        }
        return;
      }
      buf.writeByte(BSER_OBJECT);
      const keys = Object.keys(val);

      // First pass to compute number of defined keys
      let num_keys = keys.length;
      for (let i = 0; i < keys.length; ++i) {
        const v = val[keys[i]];
        if (typeof v === 'undefined') {
          num_keys--;
        }
      }
      dump_int(buf, num_keys);
      for (let i = 0; i < keys.length; ++i) {
        const key = keys[i];
        const v = val[key];
        if (typeof v === 'undefined') {
          // Don't include it
          continue;
        }
        dump_any(buf, key);
        try {
          dump_any(buf, v);
        } catch (e) {
          throw new Error(
            e.message +
              ' (while serializing object property with name `' +
              key +
              "')",
          );
        }
      }
      return;

    default:
      throw new Error('cannot serialize type ' + typeof val + ' to BSER');
  }
}

// BSER encode value and return a buffer of the contents
export function dumpToBuffer(val) {
  const buf = new Accumulator();
  // Build out the header
  buf.writeByte(0);
  buf.writeByte(1);
  // Reserve room for an int32 to hold our PDU length
  buf.writeByte(BSER_INT32);
  buf.writeInt(0, 4); // We'll come back and fill this in at the end

  dump_any(buf, val);

  // Compute PDU length
  const off = buf.writeOffset;
  const len = off - 7 /* the header length */;
  buf.writeOffset = 3; // The length value to fill in
  buf.writeInt(len, 4); // write the length in the space we reserved
  buf.writeOffset = off;

  return buf.buf.slice(0, off);
}
