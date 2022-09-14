# node-yamux

> stream implementation of <https://github.com/ChainSafe/js-libp2p-yamux>

> JavaScript implementation of [yamux](https://github.com/hashicorp/yamux/blob/master/spec.md).

## Install

```sh
yarn add node-yamux
```

## Usage

```typescript
import { Stream, YamuxMuxer } from 'node-yamux'

function createPair (onStream: (stream: Stream) => void): [YamuxMuxer, YamuxMuxer] {
  const server = new YamuxMuxer({
    direction: 'inbound',
    onIncomingStream: onStream
  })

  const client = new YamuxMuxer({
    direction: 'outbound'
  })

  server.pipe(client).pipe(server)

  return [server, client]
}

const [server, client] = createPair((stream) => {
  let received = ''
  console.log('onStream')
  stream.on('data', (data) => {
    received += Buffer.from(data).toString('utf8')
  })
  stream.on('end', () => {
    console.log('SERVER: received: ' + received)
    stream.close()
  })
  stream.on('close', () => {
    console.log('SERVER: CLOSED')
    server.close()
  })
})
void server

const s1 = client.newStream('hello')
console.log('CLIENT: new stream', s1.id)

s1.on('close', () => {
  console.log('CLIENT: CLOSED')
})
s1.write('aaaaaaaaaa', (err) => {
  console.log('CLIENT: WRITE OK')
  s1.end(() => {
    console.log('CLIENT: END OK')
    s1.close()
  })
})
```

## License

Licensed under either of

 * Apache 2.0, ([LICENSE-APACHE](LICENSE-APACHE) / http://www.apache.org/licenses/LICENSE-2.0)
 * MIT ([LICENSE-MIT](LICENSE-MIT) / http://opensource.org/licenses/MIT)

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
