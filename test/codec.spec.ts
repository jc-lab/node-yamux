import { expect } from 'chai'

import { decodeHeader } from '../src/decode'
import { encodeFrame } from '../src/encode'
import { Flag, FrameHeader, FrameType, GoAwayCode, stringifyHeader } from '../src/frame'
import { decodeHeaderNaive, encodeFrameNaive } from './codec.util'

const frames: Array<{header: FrameHeader, data?: Uint8Array}> = [
  { header: { type: FrameType.Ping, flag: Flag.SYN, streamID: 0, length: 1 } },
  { header: { type: FrameType.WindowUpdate, flag: Flag.SYN, streamID: 1, length: 1 } },
  { header: { type: FrameType.GoAway, flag: 0, streamID: 0, length: GoAwayCode.NormalTermination } },
  { header: { type: FrameType.Ping, flag: Flag.ACK, streamID: 0, length: 100 } },
  { header: { type: FrameType.WindowUpdate, flag: 0, streamID: 99, length: 1000 } },
  { header: { type: FrameType.WindowUpdate, flag: 0, streamID: 0xffffffff, length: 0xffffffff } },
  { header: { type: FrameType.GoAway, flag: 0, streamID: 0, length: GoAwayCode.ProtocolError } }
]

describe('codec', () => {
  for (const { header } of frames) {
    it(`should round trip encode/decode header ${stringifyHeader(header)}`, () => {
      expect(decodeHeader(encodeFrame(header))).to.deep.equal(header)
    })
  }

  for (const { header } of frames) {
    it(`should match naive implementations of encode/decode for header ${stringifyHeader(header)}`, () => {
      expect(encodeFrame(header)).to.deep.equal(encodeFrameNaive(header))
      expect(decodeHeader(encodeFrame(header))).to.deep.equal(decodeHeaderNaive(encodeFrameNaive(header)))
    })
  }
})
