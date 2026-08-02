# vantage-data-lake

Source repository for `@vantageos/data-lake` — the VantageOS shared Convex
data-lake component (memories, episodes, search: vector/BM25/hybrid RAG +
embeddings), consumed as a Convex component across the VantageOS fleet.

## Status

The live published version on npm is `0.3.1`. The source for `0.3.1` was
never committed to git prior to publish; this repository reconstitutes it
from the npm tarball (see PR "[T1] reconstitute @vantageos/data-lake 0.3.1
source from npm tarball"). Byte-for-byte parity with the published tarball
is proven in that PR's description.

## Package

The Convex component itself lives at the repository root (`package.json`,
`convex.config.ts`, `component/`). See `component/README.md` for the
component-level documentation shipped with the npm package.

## License

MIT — see `LICENSE`.
