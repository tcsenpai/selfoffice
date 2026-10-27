# Brand artwork

- `source-lumo.png`: the original artwork, supplied by the maintainer (generated with Lumo on 2026-10-27).
- `mark.png`: the same artwork with the cream paper background removed (`tools/cut-brand-art.py`).
- Everything else (SVG icon and logo, `.png`, `.ico`, `.icns`, the site favicon) is generated from
  `mark.png` by `node tools/gen-brand.mjs`.
