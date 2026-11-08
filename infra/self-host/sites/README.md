Other websites on this server: one file per site, named `<anything>.caddy`, in this directory (or the one
`T3X_SITES_DIR` points at). Caddy imports every `*.caddy` file here as a site block, and every `*.options` file
inside the global options block (for options such as `default_sni`). Other files, like this one, are ignored.
Changes need a reload: see the "这台 VPS 上已经有别的网站" section of ../README.md.
