# Store listing (OStore)

How Signal4KaiOS is distributed through
[OStore](https://github.com/Samenal-sys/Store) (KaiOS 3.0+), and what a
catalogue maintainer needs on each release. KaiOS 2.5 has no OStore; 2.5 users
sideload a release ZIP (see [Getting started](getting-started.md#2-install)).

## Two sources, one package

Every release publishes **one** package, `signal4kaios-<version>.zip`, as an
immutable [GitHub Release](https://github.com/ambercaravalho/signal4kaios/releases)
asset. Two OStore sources point at it:

- **This project's source**, rebuilt by
  [`release.yml`](../.github/workflows/release.yml) on every tag and served from
  GitHub Pages at `https://ambercaravalho.github.io/signal4kaios/`.
- **The community catalogue** ([Samenal-sys/Store](https://github.com/Samenal-sys/Store)),
  updated by its maintainer from the `store-entry.json` attached to each
  release.

```text
<source>/
  webapps.json
  Apps-directory/Signal4KaiOS/
    manifest.webmanifest   # copy of app/manifest.webmanifest
    update.webmanifest     # version, package_path, exact packaged_size, b2g_features
```

[`scripts/build-store-source.sh`](../scripts/build-store-source.sh) generates
all of it from [`store/catalog.json`](../store/catalog.json) (the listing text
and category, edited by hand) and the packaged ZIP. Run it locally with:

```sh
sh app/scripts/package.sh
sh scripts/build-store-source.sh dist/signal4kaios.zip https://example.invalid/signal4kaios.zip /tmp/site
```

## Listing text

- **Name:** Signal4KaiOS
- **Category:** utilities
- **Description:** starts with the backend requirement, so nobody installs it
  expecting a standalone Signal app. The canonical text is in
  [`store/catalog.json`](../store/catalog.json).

## For catalogue maintainers

Each release has a `store-entry.json` asset. It is the complete `webapps.json`
app entry, with `folder`, `name`, `version`, `category`, `description`,
`package_url` (the release asset), and `sha256`. Per release:

1. Replace the Signal4KaiOS entry in your `webapps.json` with `store-entry.json`.
2. Update `Apps-directory/Signal4KaiOS/update.webmanifest`: `version`,
   `package_path` (= `package_url`), and `packaged_size` / `size` (the asset's
   exact byte size). Copy `b2g_features` from the released
   `manifest.webmanifest`. You can also copy both files straight from
   `https://ambercaravalho.github.io/signal4kaios/Apps-directory/Signal4KaiOS/`
   and keep your own `package_path`.
3. Keep the folder name `Signal4KaiOS` and its `update.webmanifest` path stable.
   KaiOS records that URL as the installed app's update URL.

The app identity never changes: `id` / `origin` is `signal4kaios`, and
`b2g_features.version` increases with every release.

## Caveats

- **One source per phone.** The two sources record different update URLs.
  Installing the same app from the other source can fail as a duplicate install,
  and an installed copy only checks for updates at the source it came from.
- **Pre-release tags** (`v1.2.0-rc1`) are marked as pre-releases on GitHub but
  still update this project's source. Use them for device testing before
  telling the catalogue maintainer about a release.
- **Privileged package.** The app is `privileged` (it needs cross-origin
  `systemXHR` to reach your gateway, plus push, alarms, and the camera). Verify
  on a real handset that OStore installs grant these permissions, because
  OStore notes that its packages' signatures are not cryptographically
  verified.
