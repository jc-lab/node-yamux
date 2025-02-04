import { concat } from 'uint8arrays/concat'
import { equals } from 'uint8arrays/equals'
import { allocUnsafe, alloc } from 'uint8arrays/alloc'

const symbol = Symbol.for('@achingbrain/uint8arraylist')

type Appendable = Uint8ArrayList | Uint8Array

function findBufAndOffset (bufs: Uint8Array[], index: number) {
  if (index == null || index < 0) {
    throw new RangeError('index is out of bounds')
  }

  let offset = 0

  for (const buf of bufs) {
    const bufEnd = offset + buf.byteLength

    if (index < bufEnd) {
      return {
        buf,
        index: index - offset
      }
    }

    offset = bufEnd
  }

  throw new RangeError('index is out of bounds')
}

/**
 * Check if object is a CID instance
 */
export function isUint8ArrayList (value: any): value is Uint8ArrayList {
  return Boolean(value?.[symbol])
}

export class Uint8ArrayList implements Iterable<Uint8Array> {
  private bufs: Uint8Array[]
  public length: number

  constructor (...data: Appendable[]) {
    // Define symbol
    Object.defineProperty(this, symbol, { value: true })

    this.bufs = []
    this.length = 0

    if (data.length > 0) {
      this.appendAll(data)
    }
  }

  * [Symbol.iterator] () {
    yield * this.bufs
  }

  get byteLength () {
    return this.length
  }

  /**
   * Add one or more `bufs` to the end of this Uint8ArrayList
   */
  append (...bufs: Appendable[]) {
    this.appendAll(bufs)
  }

  /**
   * Add all `bufs` to the end of this Uint8ArrayList
   */
  appendAll (bufs: Appendable[]) {
    let length = 0

    for (const buf of bufs) {
      if (buf instanceof Uint8Array) {
        length += buf.byteLength
        this.bufs.push(buf)
      } else if (isUint8ArrayList(buf)) {
        length += buf.byteLength
        this.bufs.push(...buf.bufs)
      } else {
        throw new Error('Could not append value, must be an Uint8Array or a Uint8ArrayList')
      }
    }

    this.length += length
  }

  /**
   * Add one or more `bufs` to the start of this Uint8ArrayList
   */
  prepend (...bufs: Appendable[]) {
    this.prependAll(bufs)
  }

  /**
   * Add all `bufs` to the start of this Uint8ArrayList
   */
  prependAll (bufs: Appendable[]) {
    let length = 0

    for (const buf of bufs.reverse()) {
      if (buf instanceof Uint8Array) {
        length += buf.byteLength
        this.bufs.unshift(buf)
      } else if (isUint8ArrayList(buf)) {
        length += buf.byteLength
        this.bufs.unshift(...buf.bufs)
      } else {
        throw new Error('Could not prepend value, must be an Uint8Array or a Uint8ArrayList')
      }
    }

    this.length += length
  }

  /**
   * Read the value at `index`
   */
  get (index: number) {
    const res = findBufAndOffset(this.bufs, index)

    return res.buf[res.index]
  }

  /**
   * Set the value at `index` to `value`
   */
  set (index: number, value: number) {
    const res = findBufAndOffset(this.bufs, index)

    res.buf[res.index] = value
  }

  /**
   * Copy bytes from `buf` to the index specified by `offset`
   */
  write (buf: Appendable, offset: number = 0) {
    if (buf instanceof Uint8Array) {
      for (let i = 0; i < buf.length; i++) {
        this.set(offset + i, buf[i])
      }
    } else if (isUint8ArrayList(buf)) {
      for (let i = 0; i < buf.length; i++) {
        this.set(offset + i, buf.get(i))
      }
    } else {
      throw new Error('Could not write value, must be an Uint8Array or a Uint8ArrayList')
    }
  }

  /**
   * Remove bytes from the front of the pool
   */
  consume (bytes: number) {
    // first, normalize the argument, in accordance with how Buffer does it
    bytes = Math.trunc(bytes)

    // do nothing if not a positive number
    if (Number.isNaN(bytes) || bytes <= 0) {
      return
    }

    while (this.bufs.length > 0) {
      if (bytes >= this.bufs[0].byteLength) {
        bytes -= this.bufs[0].byteLength
        this.length -= this.bufs[0].byteLength
        this.bufs.shift()
      } else {
        this.bufs[0] = this.bufs[0].subarray(bytes)
        this.length -= bytes
        break
      }
    }
  }

  /**
   * Extracts a section of an array and returns a new array.
   *
   * This is a copy operation as it is with Uint8Arrays and Arrays
   * - note this is different to the behaviour of Node Buffers.
   */
  slice (beginInclusive?: number, endExclusive?: number): Uint8Array {
    const { bufs, length } = this._subList(beginInclusive, endExclusive)

    return concat(bufs, length)
  }

  /**
   * Returns a alloc from the given start and end element index.
   *
   * In the best case where the data extracted comes from a single Uint8Array
   * internally this is a no-copy operation otherwise it is a copy operation.
   */
  subarray (beginInclusive?: number, endExclusive?: number): Uint8Array {
    const { bufs, length } = this._subList(beginInclusive, endExclusive)

    if (bufs.length === 1) {
      return bufs[0]
    }

    return concat(bufs, length)
  }

  /**
   * Returns a allocList from the given start and end element index.
   *
   * This is a no-copy operation.
   */
  sublist (beginInclusive?: number, endExclusive?: number): Uint8ArrayList {
    const { bufs, length } = this._subList(beginInclusive, endExclusive)

    const list = new Uint8ArrayList()
    list.length = length
    // don't loop, just set the bufs
    list.bufs = bufs

    return list
  }

  private _subList (beginInclusive?: number, endExclusive?: number) {
    beginInclusive = beginInclusive ?? 0
    endExclusive = endExclusive ?? this.length

    if (beginInclusive < 0) {
      beginInclusive = this.length + beginInclusive
    }

    if (endExclusive < 0) {
      endExclusive = this.length + endExclusive
    }

    if (beginInclusive < 0 || endExclusive > this.length) {
      throw new RangeError('index is out of bounds')
    }

    if (beginInclusive === endExclusive) {
      return { bufs: [], length: 0 }
    }

    if (beginInclusive === 0 && endExclusive === this.length) {
      return { bufs: [...this.bufs], length: this.length }
    }

    const bufs: Uint8Array[] = []
    let offset = 0

    for (let i = 0; i < this.bufs.length; i++) {
      const buf = this.bufs[i]
      const bufStart = offset
      const bufEnd = bufStart + buf.byteLength

      // for next loop
      offset = bufEnd

      if (beginInclusive >= bufEnd) {
        // start after this buf
        continue
      }

      const sliceStartInBuf = beginInclusive >= bufStart && beginInclusive < bufEnd
      const sliceEndsInBuf = endExclusive > bufStart && endExclusive <= bufEnd

      if (sliceStartInBuf && sliceEndsInBuf) {
        // slice is wholly contained within this buffer
        if (beginInclusive === bufStart && endExclusive === bufEnd) {
          // requested whole buffer
          bufs.push(buf)
          break
        }

        // requested part of buffer
        const start = beginInclusive - bufStart
        bufs.push(buf.subarray(start, start + (endExclusive - beginInclusive)))
        break
      }

      if (sliceStartInBuf) {
        // slice starts in this buffer
        if (beginInclusive === 0) {
          // requested whole buffer
          bufs.push(buf)
          continue
        }

        // requested part of buffer
        bufs.push(buf.subarray(beginInclusive - bufStart))
        continue
      }

      if (sliceEndsInBuf) {
        if (endExclusive === bufEnd) {
          // requested whole buffer
          bufs.push(buf)
          break
        }

        // requested part of buffer
        bufs.push(buf.subarray(0, endExclusive - bufStart))
        break
      }

      // slice started before this buffer and ends after it
      bufs.push(buf)
    }

    return { bufs, length: endExclusive - beginInclusive }
  }

  getInt8 (byteOffset: number): number {
    const buf = this.subarray(byteOffset, byteOffset + 1)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    return view.getInt8(0)
  }

  setInt8 (byteOffset: number, value: number): void {
    const buf = allocUnsafe(1)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setInt8(0, value)

    this.write(buf, byteOffset)
  }

  getInt16 (byteOffset: number, littleEndian?: boolean): number {
    const buf = this.subarray(byteOffset, byteOffset + 2)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    return view.getInt16(0, littleEndian)
  }

  setInt16 (byteOffset: number, value: number, littleEndian?: boolean): void {
    const buf = alloc(2)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setInt16(0, value, littleEndian)

    this.write(buf, byteOffset)
  }

  getInt32 (byteOffset: number, littleEndian?: boolean): number {
    const buf = this.subarray(byteOffset, byteOffset + 4)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    return view.getInt32(0, littleEndian)
  }

  setInt32 (byteOffset: number, value: number, littleEndian?: boolean): void {
    const buf = alloc(4)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setInt32(0, value, littleEndian)

    this.write(buf, byteOffset)
  }

  getBigInt64 (byteOffset: number, littleEndian?: boolean): bigint {
    const buf = this.subarray(byteOffset, byteOffset + 8)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    return view.getBigInt64(0, littleEndian)
  }

  setBigInt64 (byteOffset: number, value: bigint, littleEndian?: boolean): void {
    const buf = alloc(8)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setBigInt64(0, value, littleEndian)

    this.write(buf, byteOffset)
  }

  getUint8 (byteOffset: number): number {
    const buf = this.subarray(byteOffset, byteOffset + 1)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    return view.getUint8(0)
  }

  setUint8 (byteOffset: number, value: number): void {
    const buf = allocUnsafe(1)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setUint8(0, value)

    this.write(buf, byteOffset)
  }

  getUint16 (byteOffset: number, littleEndian?: boolean): number {
    const buf = this.subarray(byteOffset, byteOffset + 2)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    return view.getUint16(0, littleEndian)
  }

  setUint16 (byteOffset: number, value: number, littleEndian?: boolean): void {
    const buf = alloc(2)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setUint16(0, value, littleEndian)

    this.write(buf, byteOffset)
  }

  getUint32 (byteOffset: number, littleEndian?: boolean): number {
    const buf = this.subarray(byteOffset, byteOffset + 4)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    return view.getUint32(0, littleEndian)
  }

  setUint32 (byteOffset: number, value: number, littleEndian?: boolean): void {
    const buf = alloc(4)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setUint32(0, value, littleEndian)

    this.write(buf, byteOffset)
  }

  getBigUint64 (byteOffset: number, littleEndian?: boolean): bigint {
    const buf = this.subarray(byteOffset, byteOffset + 8)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    return view.getBigUint64(0, littleEndian)
  }

  setBigUint64 (byteOffset: number, value: bigint, littleEndian?: boolean): void {
    const buf = alloc(8)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setBigUint64(0, value, littleEndian)

    this.write(buf, byteOffset)
  }

  getFloat32 (byteOffset: number, littleEndian?: boolean): number {
    const buf = this.subarray(byteOffset, byteOffset + 4)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    return view.getFloat32(0, littleEndian)
  }

  setFloat32 (byteOffset: number, value: number, littleEndian?: boolean): void {
    const buf = alloc(4)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setFloat32(0, value, littleEndian)

    this.write(buf, byteOffset)
  }

  getFloat64 (byteOffset: number, littleEndian?: boolean): number {
    const buf = this.subarray(byteOffset, byteOffset + 8)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

    return view.getFloat64(0, littleEndian)
  }

  setFloat64 (byteOffset: number, value: number, littleEndian?: boolean): void {
    const buf = alloc(8)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setFloat64(0, value, littleEndian)

    this.write(buf, byteOffset)
  }

  equals (other: any): other is Uint8ArrayList {
    if (other == null) {
      return false
    }

    if (!(other instanceof Uint8ArrayList)) {
      return false
    }

    if (other.bufs.length !== this.bufs.length) {
      return false
    }

    for (let i = 0; i < this.bufs.length; i++) {
      if (!equals(this.bufs[i], other.bufs[i])) {
        return false
      }
    }

    return true
  }

  /**
   * Create a Uint8ArrayList from a pre-existing list of Uint8Arrays.  Use this
   * method if you know the total size of all the Uint8Arrays ahead of time.
   */
  static fromUint8Arrays (bufs: Uint8Array[], length?: number): Uint8ArrayList {
    const list = new Uint8ArrayList()
    list.bufs = bufs

    if (length == null) {
      length = bufs.reduce((acc, curr) => acc + curr.byteLength, 0)
    }

    list.length = length

    return list
  }
}
