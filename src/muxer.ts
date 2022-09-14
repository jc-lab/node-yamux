import * as streams from 'stream'
import type { Stream, StreamMuxer, StreamMuxerInit } from './types'
import errcode from 'err-code'
import { Flag, FrameHeader, FrameType, GoAwayCode, stringifyHeader } from './frame'
import { StreamState, YamuxStream } from './stream'
import { encodeFrame } from './encode'
import {
  ERR_BOTH_CLIENTS,
  ERR_INVALID_FRAME,
  ERR_MAX_OUTBOUND_STREAMS_EXCEEDED,
  ERR_MUXER_LOCAL_CLOSED,
  ERR_MUXER_REMOTE_CLOSED,
  ERR_NOT_MATCHING_PING,
  ERR_STREAM_ALREADY_EXISTS,
  ERR_UNREQUESTED_PING
} from './constants'
import { Config, defaultConfig, verifyConfig } from './config'
import { Decoder } from './decode'
import type { Logger } from './logger'
import type { Uint8ArrayList } from './thirdparty/uint8arraylist'
import { trackedMap, AbortController } from './utils'

export interface YamuxMuxerInit extends StreamMuxerInit, Partial<Config> {
}

export class Yamux {
  private readonly _init: YamuxMuxerInit

  constructor (init: YamuxMuxerInit = {}) {
    this._init = init
  }

  createStreamMuxer (init?: YamuxMuxerInit): YamuxMuxer {
    return new YamuxMuxer({
      ...this._init,
      ...init
    })
  }
}

export class YamuxMuxer extends streams.Duplex implements StreamMuxer {
  private readonly _init: YamuxMuxerInit
  private readonly config: Config
  private readonly log?: Logger

  /** Used to close the muxer from either the sink or source */
  private readonly closeController: AbortController

  /** The next stream id to be used when initiating a new stream */
  private nextStreamID: number
  /** Primary stream mapping, streamID => stream */
  private readonly _streams: Map<number, YamuxStream>

  /** The next ping id to be used when pinging */
  private nextPingID: number
  /** Tracking info for the currently active ping */
  private activePing?: { id: number, promise: Promise<void>, resolve: () => void }
  /** Round trip time */
  private rtt: number

  /** True if client, false if server */
  private readonly client: boolean

  private localGoAway?: GoAwayCode
  private remoteGoAway?: GoAwayCode

  /** Number of tracked inbound streams */
  private numInboundStreams: number
  /** Number of tracked outbound streams */
  private numOutboundStreams: number

  private readonly onIncomingStream?: (stream: Stream) => void
  private readonly onStreamEnd?: (stream: Stream) => void

  private readonly decoder = new Decoder()

  constructor (init: YamuxMuxerInit) {
    super({
      autoDestroy: true
    })
    this._init = init
    this.client = init.direction === 'outbound'
    this.config = { ...defaultConfig, ...init }
    this.log = this.config.log
    verifyConfig(this.config)

    this.closeController = new AbortController()

    this.onIncomingStream = init.onIncomingStream
    this.onStreamEnd = init.onStreamEnd

    this._streams = trackedMap({ metrics: init.metrics, component: 'yamux', metric: 'streams' })

    this.numInboundStreams = 0
    this.numOutboundStreams = 0

    // client uses odd streamIDs, server uses even streamIDs
    this.nextStreamID = this.client ? 1 : 2

    this.nextPingID = 0
    this.rtt = 0

    this.log?.('muxer created')

    if (this.config.enableKeepAlive) {
      this.keepAliveLoop().catch(e => this.log?.error('keepalive error: %s', e))
    }
  }

  get streams (): YamuxStream[] {
    return Array.from(this._streams.values())
  }

  newStream (name?: string | undefined): YamuxStream {
    if (this.remoteGoAway !== undefined) {
      throw errcode(new Error('muxer closed remotely'), ERR_MUXER_REMOTE_CLOSED)
    }
    if (this.localGoAway !== undefined) {
      throw errcode(new Error('muxer closed locally'), ERR_MUXER_LOCAL_CLOSED)
    }

    const id = this.nextStreamID
    this.nextStreamID += 2

    // check against our configured maximum number of outbound streams
    if (this.numOutboundStreams >= this.config.maxOutboundStreams) {
      throw errcode(new Error('max outbound streams exceeded'), ERR_MAX_OUTBOUND_STREAMS_EXCEEDED)
    }

    this.log?.('new outgoing stream id=%s', id)

    const stream = this._newStream(id, name, StreamState.Init, 'outbound')
    this._streams.set(id, stream)

    this.numOutboundStreams++

    // send a window update to open the stream on the receiver end
    stream.sendWindowUpdate()

    return stream
  }

  /**
   * Initiate a ping and wait for a response
   *
   * Note: only a single ping will be initiated at a time.
   * If a ping is already in progress, a new ping will not be initiated.
   *
   * @returns the round-trip-time in milliseconds
   */
  async ping (): Promise<number> {
    if (this.remoteGoAway !== undefined) {
      throw errcode(new Error('muxer closed remotely'), ERR_MUXER_REMOTE_CLOSED)
    }
    if (this.localGoAway !== undefined) {
      throw errcode(new Error('muxer closed locally'), ERR_MUXER_LOCAL_CLOSED)
    }

    // An active ping does not yet exist, handle the process here
    if (this.activePing === undefined) {
      // create active ping
      let _resolve = () => {}
      this.activePing = {
        id: this.nextPingID++,
        // this promise awaits resolution or the close controller aborting
        promise: new Promise<void>((resolve, reject) => {
          const closed = () => {
            reject(errcode(new Error('muxer closed locally'), ERR_MUXER_LOCAL_CLOSED))
          }
          this.closeController.once('abort', closed) // this.closeController.signal.addEventListener('abort', closed, { once: true })
          _resolve = () => {
            this.closeController.off('abort', closed) // this.closeController.signal.removeEventListener('abort', closed)
            resolve()
          }
        }),
        resolve: _resolve
      }
      // send ping
      const start = Date.now()
      this.sendPing(this.activePing.id)
      // await pong
      try {
        await this.activePing.promise
      } finally {
        // clean-up active ping
        delete this.activePing
      }
      // update rtt
      const end = Date.now()
      this.rtt = end - start
    } else {
      // an active ping is already in progress, piggyback off that
      await this.activePing.promise
    }
    return this.rtt
  }

  /**
   * Get the ping round trip time
   *
   * Note: Will return 0 if no successful ping has yet been completed
   *
   * @returns the round-trip-time in milliseconds
   */
  getRTT (): number {
    return this.rtt
  }

  /**
   * Close the muxer
   *
   * @param err
   * @param reason - The GoAway reason to be sent
   */
  close (err?: Error, reason?: GoAwayCode): void {
    if (this.closeController.signal.aborted) {
      // already closed
      return
    }

    // If reason was provided, use that, otherwise use the presence of `err` to determine the reason
    reason = reason ?? (err === undefined ? GoAwayCode.InternalError : GoAwayCode.NormalTermination)

    this.log?.('muxer close reason=%s error=%s', GoAwayCode[reason], err)

    // If err is provided, abort all underlying streams, else close all underlying streams
    if (err === undefined) {
      for (const stream of this._streams.values()) {
        stream.close()
      }
    } else {
      for (const stream of this._streams.values()) {
        stream.abort(err)
      }
    }

    // send reason to the other side, allow the other side to close gracefully
    this.sendGoAway(reason)

    this._closeMuxer()
  }

  isClosed (): boolean {
    return this.closeController.signal.aborted
  }

  _read (size: number) {}

  _final (callback: (error?: (Error | null)) => void) {
    this.close(undefined, GoAwayCode.NormalTermination)
    super._final(callback)
  }

  _destroy (error: any, callback: (error: (Error | null)) => void) {
    this.log?.('muxer source ended')
    this.close(error)
    callback(null)
  }

  _write (chunk: any, encoding: BufferEncoding, callback: (error?: (Error | null)) => void) {
    const messages = this.decoder.emitFrames(chunk)
    messages.reduce(async (prev, cur) => await prev.then(async () => {
      return await this.handleFrame(cur.header, cur.data)
    }), Promise.resolve())
      .then(() => callback())
      .catch((err) => callback(err))
  }

  /**
   * Called when either the local or remote shuts down the muxer
   */
  private _closeMuxer (): void {
    // stop the sink and any other processes
    this.closeController.abort()

    // stop the source
    this.emit('end') // this.source.end()
  }

  /** Create a new stream */
  private _newStream (id: number, name: string | undefined, state: StreamState, direction: 'inbound' | 'outbound'): YamuxStream {
    if (this._streams.get(id) != null) {
      throw errcode(new Error('Stream already exists'), ERR_STREAM_ALREADY_EXISTS, { id })
    }

    const stream = new YamuxStream({
      id,
      name,
      state,
      direction,
      sendFrame: this.sendFrame.bind(this),
      onStreamEnd: () => {
        this.closeStream(id)
        this.onStreamEnd?.(stream)
      },
      log: this.log,
      config: this.config,
      getRTT: this.getRTT.bind(this)
    })

    return stream
  }

  /**
   * closeStream is used to close a stream once both sides have
   * issued a close.
   */
  private closeStream (id: number): void {
    if (this.client === (id % 2 === 0)) {
      this.numInboundStreams--
    } else {
      this.numOutboundStreams--
    }
    this._streams.delete(id)
  }

  private async keepAliveLoop (): Promise<void> {
    const abortPromise = new Promise((_resolve, reject) => {
      this.closeController.once('abort', reject) // this.closeController.signal.addEventListener('abort', reject, { once: true })
    })
    this.log?.('muxer keepalive enabled interval=%s', this.config.keepAliveInterval)
    while (true) {
      let timeoutId
      try {
        await Promise.race([
          abortPromise,
          new Promise((resolve) => {
            timeoutId = setTimeout(resolve, this.config.keepAliveInterval)
          })
        ])
        this.ping().catch(e => this.log?.error('ping error: %s', e))
      } catch (e) {
        // closed
        clearInterval(timeoutId)
        return
      }
    }
  }

  private async handleFrame (header: FrameHeader, data: Uint8ArrayList): Promise<void> {
    const {
      streamID,
      type,
      length
    } = header
    this.log?.trace('received frame %s', stringifyHeader(header))

    if (streamID === 0) {
      switch (type) {
        case FrameType.Ping:
          return this.handlePing(header)
        case FrameType.GoAway:
          return this.handleGoAway(length)
        default:
          // Invalid state
          throw errcode(new Error('Invalid frame type'), ERR_INVALID_FRAME, { header })
      }
    } else {
      switch (header.type) {
        case FrameType.Data:
        case FrameType.WindowUpdate:
          return await this.handleStreamMessage(header, data)
        default:
          // Invalid state
          throw errcode(new Error('Invalid frame type'), ERR_INVALID_FRAME, { header })
      }
    }
  }

  private handlePing (header: FrameHeader): void {
    // If the ping  is initiated by the sender, send a response
    if (header.flag === Flag.SYN) {
      this.log?.('received ping request pingId=%s', header.length)
      this.sendPing(header.length, Flag.ACK)
    } else if (header.flag === Flag.ACK) {
      this.log?.('received ping response pingId=%s', header.length)
      this.handlePingResponse(header.length)
    } else {
      // Invalid state
      throw errcode(new Error('Invalid frame flag'), ERR_INVALID_FRAME, { header })
    }
  }

  private handlePingResponse (pingId: number): void {
    if (this.activePing === undefined) {
      // this ping was not requested
      throw errcode(new Error('ping not requested'), ERR_UNREQUESTED_PING)
    }
    if (this.activePing.id !== pingId) {
      // this ping doesn't match our active ping request
      throw errcode(new Error('ping doesn\'t match our id'), ERR_NOT_MATCHING_PING)
    }

    // valid ping response
    this.activePing.resolve()
  }

  private handleGoAway (reason: GoAwayCode): void {
    this.log?.('received GoAway reason=%s', GoAwayCode[reason] ?? 'unknown')
    this.remoteGoAway = reason

    // If the other side is friendly, they would have already closed all streams before sending a GoAway
    // In case they weren't, reset all streams
    for (const stream of this._streams.values()) {
      stream.reset()
    }

    this._closeMuxer()
  }

  private async handleStreamMessage (header: FrameHeader, data: Uint8ArrayList): Promise<void> {
    const { streamID, flag, type } = header

    if ((flag & Flag.SYN) === Flag.SYN) {
      this.incomingStream(streamID)
    }

    const stream = this._streams.get(streamID)
    if (stream === undefined) {
      if (type === FrameType.Data) {
        this.log?.('discarding data for stream id=%s', streamID)
        if (!data) {
          throw new Error('unreachable')
        }
      } else {
        this.log?.('frame for missing stream id=%s', streamID)
      }
      return
    }

    switch (type) {
      case FrameType.WindowUpdate: {
        return stream.handleWindowUpdate(header)
      }
      case FrameType.Data: {
        if (!data) {
          throw new Error('unreachable')
        }

        return await stream.handleData(header, data)
      }
      default:
        throw new Error('unreachable')
    }
  }

  private incomingStream (id: number): void {
    if (this.client !== (id % 2 === 0)) {
      throw errcode(new Error('both endpoints are clients'), ERR_BOTH_CLIENTS)
    }
    if (this._streams.has(id)) {
      return
    }

    this.log?.('new incoming stream id=%s', id)

    if (this.localGoAway !== undefined) {
      // reject (reset) immediately if we are doing a go away
      return this.sendFrame({
        type: FrameType.WindowUpdate,
        flag: Flag.RST,
        streamID: id,
        length: 0
      })
    }

    // check against our configured maximum number of inbound streams
    if (this.numInboundStreams >= this.config.maxInboundStreams) {
      this.log?.('maxIncomingStreams exceeded, forcing stream reset')
      return this.sendFrame({
        type: FrameType.WindowUpdate,
        flag: Flag.RST,
        streamID: id,
        length: 0
      })
    }

    // allocate a new stream
    const stream = this._newStream(id, undefined, StreamState.SYNReceived, 'inbound')

    this.numInboundStreams++
    // the stream should now be tracked
    this._streams.set(id, stream)

    this.onIncomingStream?.(stream)
  }

  private sendFrame (header: FrameHeader, data?: Uint8Array): void {
    this.log?.trace('sending frame %s', stringifyHeader(header))
    this.push(encodeFrame(header, data))
  }

  private sendPing (pingId: number, flag: Flag = Flag.SYN): void {
    if (flag === Flag.SYN) {
      this.log?.('sending ping request pingId=%s', pingId)
    } else {
      this.log?.('sending ping response pingId=%s', pingId)
    }
    this.sendFrame({
      type: FrameType.Ping,
      flag,
      streamID: 0,
      length: pingId
    })
  }

  private sendGoAway (reason: GoAwayCode = GoAwayCode.NormalTermination): void {
    this.log?.('sending GoAway reason=%s', GoAwayCode[reason])
    this.localGoAway = reason
    this.sendFrame({
      type: FrameType.GoAway,
      flag: 0,
      streamID: 0,
      length: reason
    })
  }
}
