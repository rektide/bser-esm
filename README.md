# bser-esm

ESM BSER binary-serialization decoder for Watchman clients, extracted from
Facebook's watchman node client. Plain JavaScript — no build step, no
dependencies, no `dist/`: this repository ships the raw ESM source that
Node.js runs directly.

## What it is

BSER is a binary serialization scheme usable as an alternative to JSON. It
uses a framed encoding that makes it simpler to use for streaming a sequence
of encoded values, and is intended for local IPC only; strings are
represented as binary with no specific encoding, matching the convention
most operating systems use for filename storage.

For the serialization scheme itself, see
[Watchman's BSER docs](https://facebook.github.io/watchman/docs/bser.html).

## Lineage

1. **Facebook watchman** — the BSER module lived at `watchman/node/bser` in
   [facebook/watchman](https://github.com/facebook/watchman), MIT licensed,
   authored by Wez Furlong.
2. **watchman-esm fork** — an ESM rewrite of the watchman node client
   (`"type": "module"`, native `BigInt` int64 handling instead of
   `node-int64`), published as `@superbfowle/bser-esm` v3.0.0.
3. **This repository** — that decoder extracted verbatim as a standalone
   package. Code and version are unchanged from the fork.

The npm package name `@superbfowle/bser-esm` is kept for attribution
honesty; it names the fork the code was extracted from.

## Install

No npm publication — consume it as a git dependency; there is nothing to
build:

```sh
npm install github:rektide/bser-esm
```

or in `package.json`:

```json
{
  "dependencies": {
    "@superbfowle/bser-esm": "github:rektide/bser-esm"
  }
}
```

Requires Node.js >= 20.19 (CommonJS consumers can still `require()` it
thanks to `require(esm)`).

## API

```js
import * as bser from '@superbfowle/bser-esm';
```

### bser.loadFromBuffer

The synchronous decoder; given an input string or buffer, decodes a single
value and returns it. Throws an error if the input is invalid.

```js
const obj = bser.loadFromBuffer(buf);
```

### bser.dumpToBuffer

Synchronously encodes a value as BSER.

```js
const encoded = bser.dumpToBuffer(['hello']);
console.log(bser.loadFromBuffer(encoded)); // ['hello']
```

### Integer handling

`BigInt` values are encoded as BSER int64. On decode, int64 values that fit
exactly in a JS number (within `Number.MAX_SAFE_INTEGER`) are returned as
numbers; anything larger (or smaller) is returned as a `BigInt`. In versions
prior to 3.0.0, `node-int64` objects were used for the out-of-range case.

### BunserBuf

The asynchronous decoder API is implemented in the `BunserBuf` object. You
may incrementally append data to this object and it will emit the decoded
values via its `value` event.

```js
import {BunserBuf} from '@superbfowle/bser-esm';
import net from 'node:net';

const bunser = new BunserBuf();

bunser.on('value', obj => {
  console.log('data from socket', obj);
});

const socket = net.connect('/socket');

socket.on('data', buf => {
  bunser.append(buf);
});
```

To write BSER to the socket: `socket.write(bser.dumpToBuffer(obj));`

## Tests

```sh
node test/bser.js
```

## Benchmarks

This decoder is characterized and benched in the rektide effect-watch
workspace against stock npm `bser` 2.1.2 and a UTF-8 + `JSON.parse` arm,
using byte-identical captured Watchman reply frames. The measurement record
lives in that workspace at
`design/filesystem-watch/bser-bench1.sol61x.md`
(`opencode-watch-rebuild` repository) and is not part of this package.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) Meta Platforms, Inc. and its
affiliates, carried forward from the upstream watchman source tree.
