import type * as streams from 'stream'

export interface Stream extends streams.Duplex {
  /**
   * Close a stream for reading and writing
   */
  close: () => void

  /**
   * Close a stream for reading only
   */
  closeRead: () => void

  /**
   * Close a stream for writing only
   */
  closeWrite: () => void

  /**
   * Call when a local error occurs, should close the stream for reading and writing
   */
  abort: (err: Error) => void

  /**
   * Call when a remote error occurs, should close the stream for reading and writing
   */
  reset: () => void

  /**
   * Unique identifier for a stream
   */
  id: string

  /**
   * User defined stream metadata
   */
  metadata: Record<string, any>
}

/**
 * A libp2p stream muxer
 */
export interface StreamMuxer extends streams.Duplex {
  readonly streams: Stream[]
  /**
   * Initiate a new stream with the given name. If no name is
   * provided, the id of the stream will be used.
   */
  newStream: (name?: string) => Stream

  /**
   * Close or abort all tracked streams and stop the muxer
   */
  close: (err?: Error) => void
}

export interface StreamMuxerInit {
  direction?: 'outbound' | 'inbound'
  metrics?: any
  onIncomingStream?: (stream: Stream) => void
  onStreamEnd?: (stream: Stream) => void
}
