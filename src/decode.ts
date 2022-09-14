import { Uint8ArrayList } from './thirdparty/uint8arraylist'
import errcode from 'err-code'
import { FrameHeader, HEADER_LENGTH, YAMUX_VERSION } from './frame'
import { ERR_DECODE_INVALID_VERSION, ERR_DECODE_IN_PROGRESS } from './constants'

// used to bitshift in decoding
// native bitshift can overflow into a negative number, so we bitshift by multiplying by a power of 2
const twoPow24 = 2 ** 24

export interface DecodedMessage {
  header: FrameHeader
  data: Uint8ArrayList
}

/**
 * Decode a header from the front of a buffer
 *
 * @param data - Assumed to have enough bytes for a header
 */
export function decodeHeader (data: Uint8Array): FrameHeader {
  if (data[0] !== YAMUX_VERSION) {
    throw errcode(new Error('Invalid frame version'), ERR_DECODE_INVALID_VERSION)
  }
  return {
    type: data[1],
    flag: (data[2] << 8) + data[3],
    streamID: (data[4] * twoPow24) + (data[5] << 16) + (data[6] << 8) + data[7],
    length: (data[8] * twoPow24) + (data[9] << 16) + (data[10] << 8) + data[11]
  }
}

/**
 * Decodes yamux frames from a source
 */
export class Decoder {
  /** Buffer for in-progress frames */
  private readonly buffer: Uint8ArrayList
  /** Used to sanity check against decoding while in an inconsistent state */
  private readonly frameInProgress: boolean

  private _headerInfo: FrameHeader | undefined = undefined

  constructor () {
    // Normally, when entering a for-await loop with an iterable/async iterable, the only ways to exit the loop are:
    // 1. exhaust the iterable
    // 2. throw an error - slow, undesireable if there's not actually an error
    // 3. break or return - calls the iterable's `return` method, finalizing the iterable, no more iteration possible
    //
    // In this case, we want to enter (and exit) a for-await loop per chunked data frame and continue processing the iterable.
    // To do this, we strip the `return` method from the iterator and can now `break` early and continue iterating.
    // Exiting the main for-await is still possible via 1. and 2.
    this.buffer = new Uint8ArrayList()
    this.frameInProgress = false
  }

  /**
   * Emits frames from the decoder source.
   *
   * Note: If `readData` is emitted, it _must_ be called before the next iteration
   * Otherwise an error is thrown
   */
  emitFrames (chunk: Uint8Array): DecodedMessage[] {
    if (!chunk || chunk.length === 0) {
      return []
    }

    this.buffer.append(chunk)
    const msgs: DecodedMessage[] = []

    while (true) {
      if (!this._headerInfo) {
        this._headerInfo = this.readHeader()
      }
      if (!this._headerInfo) {
        break
      }

      const header = this._headerInfo
      if (this.buffer.length < header.length) {
        break
      }

      const data = this.buffer.sublist(0, header.length)
      this.buffer.consume(header.length)

      msgs.push({ header, data })
      this._headerInfo = undefined
    }

    return msgs
  }

  private readHeader (): FrameHeader | undefined {
    // Sanity check to ensure a header isn't read when another frame is partially decoded
    // In practice this shouldn't happen
    if (this.frameInProgress) {
      throw errcode(new Error('decoding frame already in progress'), ERR_DECODE_IN_PROGRESS)
    }

    if (this.buffer.length < HEADER_LENGTH) {
      // not enough data yet
      return
    }

    const header = decodeHeader(this.buffer.slice(0, HEADER_LENGTH))
    this.buffer.consume(HEADER_LENGTH)
    return header
  }
}
