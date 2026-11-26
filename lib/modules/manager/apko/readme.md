Renovate updates apk packages in an [apko](https://github.com/chainguard-dev/apko) image configuration.

### Package files

Renovate reads `contents.packages` from `apko.yaml` and `apko.yml`.
Package specs use the [`apk` datasource](../../datasource/apk/index.md) and [`apk` versioning](../../versioning/apk/index.md).

`contents.repositories` and `contents.build_repositories` become registry URLs, one per architecture.
Renovate ignores `contents.runtime_repositories`.
An `archs` list of `all`, or a missing `archs` list, uses apko's default architectures.

`include` is resolved from the root config's directory.
Renovate emits the root first, then each included file depth-first, and reads a file once if includes form a cycle.
The root's packages stay on the root file.
Included files keep their own packages and use the root's merged repositories, architectures, and lock file.
A path that cannot be read, or that leaves the repository, is ignored.
When several roots include the same file, Renovate keeps one entry and unions the registry URLs and lock files in the order the roots were matched.

### Lock file

When `apko.lock.json` (or `<name>.lock.json` beside another YAML name) already exists, Renovate runs `apko lock` to regenerate it.
Renovate does not create a lock file that is absent.

Set [`constraints.apko`](../../../configuration-options.md#constraints) to the apko release Renovate should install.
