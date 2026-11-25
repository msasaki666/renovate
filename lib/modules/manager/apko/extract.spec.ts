import { codeBlock } from 'common-tags';
import upath from 'upath';
import { Fixtures } from '~test/fixtures.ts';
import { fs } from '~test/util.ts';
import type {
  ExtractConfig,
  PackageDependency,
  PackageFile,
} from '../types.ts';
import * as apkoManager from './index.ts';
import { extractPackageFile } from './index.ts';

vi.mock('../../../util/fs/index.ts');

const wolfi = 'https://packages.wolfi.dev/os';
const alpineMain = 'https://dl-cdn.alpinelinux.org/alpine/v3.22/main';
const alpineCommunity = 'https://dl-cdn.alpinelinux.org/alpine/v3.22/community';
const edgeMain = 'https://dl-cdn.alpinelinux.org/alpine/edge/main';
const chainguard = 'https://apk.cgr.dev/chainguard';

const defaultArchs = [
  'x86',
  'x86_64',
  'aarch64',
  'armhf',
  'armv7',
  'loongarch64',
  'ppc64le',
  'riscv64',
  's390x',
] as const;

function registryUrl(repository: string, arch: string): string {
  return `${repository}?arch=${arch}`;
}

function wolfiArchs(archs: readonly string[]): string[] {
  return archs.map((arch) => registryUrl(wolfi, arch));
}

const wolfiX86 = registryUrl(wolfi, 'x86_64');

function yaml(options: {
  include?: string;
  repositories?: string[];
  buildRepositories?: string[];
  runtimeRepositories?: string[];
  packages?: string[];
  archs?: string[];
}): string {
  const lines: string[] = [];
  if (options.include) {
    lines.push(`include: ${options.include}`);
  }
  lines.push('contents:');
  function list(key: string, values: string[] | undefined): void {
    if (!values) {
      return;
    }
    if (values.length === 0) {
      lines.push(`  ${key}: []`);
      return;
    }
    lines.push(`  ${key}:`);
    for (const value of values) {
      lines.push(`    - '${value}'`);
    }
  }
  list('repositories', options.repositories);
  list('build_repositories', options.buildRepositories);
  list('runtime_repositories', options.runtimeRepositories);
  list('packages', options.packages);
  if (options.archs) {
    lines.push('archs:');
    for (const arch of options.archs) {
      lines.push(`  - '${arch}'`);
    }
  }
  return `${lines.join('\n')}\n`;
}

type ExtractAllPackageFiles = (
  config: ExtractConfig,
  packageFiles: string[],
) => Promise<PackageFile[] | null>;

function extractAllPackageFiles(
  config: ExtractConfig,
  packageFiles: string[],
): Promise<PackageFile[] | null> {
  const extractAll = (
    apkoManager as { extractAllPackageFiles?: ExtractAllPackageFiles }
  ).extractAllPackageFiles;
  if (!extractAll) {
    return Promise.reject(
      new Error('extractAllPackageFiles is not implemented'),
    );
  }
  return extractAll(config, packageFiles);
}

function mockFiles(files: Record<string, string>): void {
  fs.readLocalFile.mockImplementation(
    (fileName: string): Promise<string | null> =>
      Promise.resolve(files[fileName] ?? null),
  );
}

function extracted(
  packageFile: string,
  deps: PackageDependency[],
  lockFiles?: string[],
): PackageFile {
  const result: PackageFile = { packageFile, deps };
  if (lockFiles) {
    result.lockFiles = lockFiles;
  }
  return result;
}

function lockJson(packages: { name: string; version: string }[]): string {
  return JSON.stringify({ contents: { packages } });
}

function pin(
  spec: string,
  depName: string,
  currentValue: string,
  registryUrls: string[],
  template = `${depName}={{{newValue}}}`,
): PackageDependency {
  return {
    datasource: 'apk',
    depName,
    currentValue,
    replaceString: spec,
    autoReplaceStringTemplate: template,
    registryUrls,
  };
}

describe('modules/manager/apko/extract', () => {
  beforeEach(() => {
    fs.getSiblingFileName.mockImplementation(
      (fileName: string, siblingName: string) =>
        upath.join(upath.dirname(fileName), siblingName),
    );
    fs.readLocalFile.mockResolvedValue(null);
  });

  it('returns null for an empty file', async () => {
    await expect(extractPackageFile('', 'apko.yaml')).resolves.toBeNull();
  });

  it('returns null for malformed YAML', async () => {
    await expect(extractPackageFile(':\n', 'apko.yaml')).resolves.toBeNull();
  });

  it('returns null when packages is not a list', async () => {
    const content = codeBlock`
      contents:
        packages: bash
    `;
    await expect(extractPackageFile(content, 'apko.yaml')).resolves.toBeNull();
  });

  it('returns null when the file has no packages', async () => {
    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toBeNull();
  });

  it('returns null for an empty package list', async () => {
    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: [],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toBeNull();
  });

  it('returns null when every package spec is ignored', async () => {
    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: [
            '!conflicting',
            '.build-deps',
            './bash-5.2.37-r2.apk',
            'https://example.com/bash-5.2.37-r2.apk',
            'so:libc.musl-x86_64.so.1',
            'cmd:node',
            '$PACKAGE',
          ],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toBeNull();
  });

  it('extracts a Wolfi pin for amd64', async () => {
    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: ['bash=5.2.37-r2'],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86])],
    });
  });

  it('keeps an Alpine repository path and appends each arch', async () => {
    await expect(
      extractPackageFile(
        yaml({
          repositories: [alpineMain],
          packages: ['bash=5.2.37-r2'],
          archs: ['amd64', 'arm64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [
          registryUrl(alpineMain, 'x86_64'),
          registryUrl(alpineMain, 'aarch64'),
        ]),
      ],
    });
  });

  it('orders repositories, then build repositories, then YAML archs, and drops query URLs', async () => {
    await expect(
      extractPackageFile(Fixtures.get('order.yaml'), 'apko.yaml'),
    ).resolves.toEqual({
      deps: [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [
          registryUrl(alpineMain, 'aarch64'),
          registryUrl(alpineMain, 'x86_64'),
          registryUrl(alpineCommunity, 'aarch64'),
          registryUrl(alpineCommunity, 'x86_64'),
          registryUrl(wolfi, 'aarch64'),
          registryUrl(wolfi, 'x86_64'),
        ]),
      ],
    });
  });

  it('uses AllArchs order when archs is omitted', async () => {
    await expect(
      extractPackageFile(Fixtures.get('no-archs.yaml'), 'apko.yaml'),
    ).resolves.toEqual({
      deps: [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', wolfiArchs(defaultArchs)),
      ],
    });
  });

  it('uses AllArchs order when archs is all', async () => {
    await expect(
      extractPackageFile(Fixtures.get('all-archs.yaml'), 'apko.yaml'),
    ).resolves.toEqual({
      deps: [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', wolfiArchs(defaultArchs)),
      ],
    });
  });

  it('translates apko arch names and keeps apk arch names', async () => {
    const archs = [
      '386',
      'x86',
      'amd64',
      'x86_64',
      'arm64',
      'aarch64',
      'arm/v6',
      'armhf',
      'arm/v7',
      'loong64',
      'loongarch64',
      'ppc64le',
      'riscv64',
      's390x',
    ];
    const apkArchs = [
      'x86',
      'x86',
      'x86_64',
      'x86_64',
      'aarch64',
      'aarch64',
      'armhf',
      'armhf',
      'armv7',
      'loongarch64',
      'loongarch64',
      'ppc64le',
      'riscv64',
      's390x',
    ];

    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: ['bash=5.2.37-r2'],
          archs,
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', wolfiArchs(apkArchs))],
    });
  });

  it('ignores runtime_repositories', async () => {
    await expect(
      extractPackageFile(Fixtures.get('repos-runtime.yaml'), 'apko.yaml'),
    ).resolves.toEqual({
      deps: [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [
          wolfiX86,
          registryUrl(chainguard, 'x86_64'),
        ]),
      ],
    });
  });

  it('skips a versioned package when every repository URL has a query', async () => {
    await expect(
      extractPackageFile(
        yaml({
          repositories: ['https://mirror.example.com/os?token=secret'],
          packages: ['bash=5.2.37-r2'],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [
        {
          datasource: 'apk',
          depName: 'bash',
          currentValue: '5.2.37-r2',
          replaceString: 'bash=5.2.37-r2',
          autoReplaceStringTemplate: 'bash={{{newValue}}}',
          skipReason: 'unknown-registry',
        },
      ],
    });
  });

  it('skips a versioned package when the file has no repositories', async () => {
    await expect(
      extractPackageFile(
        yaml({
          packages: ['bash=5.2.37-r2'],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [
        {
          datasource: 'apk',
          depName: 'bash',
          currentValue: '5.2.37-r2',
          replaceString: 'bash=5.2.37-r2',
          autoReplaceStringTemplate: 'bash={{{newValue}}}',
          skipReason: 'unknown-registry',
        },
      ],
    });
  });

  it('drops file repositories and keeps http repositories', async () => {
    await expect(
      extractPackageFile(
        yaml({
          repositories: ['./packages', '@local /packages', wolfi],
          packages: ['bash=5.2.37-r2'],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86])],
    });
  });

  it('extracts unversioned names and a pin in file order', async () => {
    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: ['wolfi-base', 'python-3.14', 'bash=5.2.37-r2'],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [
        {
          datasource: 'apk',
          depName: 'wolfi-base',
          skipReason: 'unspecified-version',
        },
        {
          datasource: 'apk',
          depName: 'python-3.14',
          skipReason: 'unspecified-version',
        },
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86]),
      ],
    });
  });

  it('extracts hyphenated names and pins without a revision', async () => {
    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: ['ca-certificates-bundle=20241121-r0', 'nginx=1.24.0'],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [
        pin(
          'ca-certificates-bundle=20241121-r0',
          'ca-certificates-bundle',
          '20241121-r0',
          [wolfiX86],
          'ca-certificates-bundle={{{newValue}}}',
        ),
        pin(
          'nginx=1.24.0',
          'nginx',
          '1.24.0',
          [wolfiX86],
          'nginx={{{newValue}}}',
        ),
      ],
    });
  });

  it('reads a quoted package scalar without the quotes', async () => {
    const content = codeBlock`
      contents:
        repositories:
          - https://packages.wolfi.dev/os
        packages:
          - "bash=5.2.37-r2"
      archs:
        - amd64
    `;

    await expect(extractPackageFile(content, 'apko.yaml')).resolves.toEqual({
      deps: [pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86])],
    });
  });

  it.each`
    spec           | currentValue
    ${'bash=~5.2'} | ${'=~5.2'}
    ${'bash~5.2'}  | ${'~5.2'}
    ${'bash~=5.2'} | ${'~=5.2'}
    ${'bash>5.2'}  | ${'>5.2'}
    ${'bash<5.2'}  | ${'<5.2'}
    ${'bash>=5.2'} | ${'>=5.2'}
    ${'bash<=5.2'} | ${'<=5.2'}
    ${'bash>~5.2'} | ${'>~5.2'}
    ${'bash<~5.2'} | ${'<~5.2'}
  `(
    'extracts $spec as the range $currentValue',
    async ({ spec, currentValue }: { spec: string; currentValue: string }) => {
      await expect(
        extractPackageFile(
          yaml({
            repositories: [wolfi],
            packages: [spec],
            archs: ['amd64'],
          }),
          'apko.yaml',
        ),
      ).resolves.toEqual({
        deps: [
          {
            datasource: 'apk',
            depName: 'bash',
            currentValue,
            replaceString: spec,
            autoReplaceStringTemplate: 'bash{{{newValue}}}',
            registryUrls: [wolfiX86],
          },
        ],
      });
    },
  );

  it.each`
    spec                                  | skipReason
    ${'bash=$VERSION'}                    | ${'contains-variable'}
    ${'bash=not-a-version'}               | ${'unsupported-version'}
    ${'bash><Q12lvT0pPK3aQaUWmI9djiLpFg'} | ${'unsupported-version'}
  `(
    'skips $spec with $skipReason',
    async ({ spec, skipReason }: { spec: string; skipReason: string }) => {
      await expect(
        extractPackageFile(
          yaml({
            repositories: [wolfi],
            packages: [spec],
            archs: ['amd64'],
          }),
          'apko.yaml',
        ),
      ).resolves.toEqual({
        deps: [
          {
            datasource: 'apk',
            depName: 'bash',
            skipReason,
          },
        ],
      });
    },
  );

  it('drops ignored specs and keeps the pin', async () => {
    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: [
            '!conflicting',
            '.build-deps',
            './bash-5.2.37-r2.apk',
            'https://example.com/bash-5.2.37-r2.apk',
            'so:libc.musl-x86_64.so.1',
            'cmd:node',
            '$PACKAGE',
            'bash=5.2.37-r2',
          ],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86])],
    });
  });

  it('limits untagged packages to untagged repositories and puts a declared tag before them', async () => {
    const untagged = [wolfi, alpineCommunity].flatMap((repository) => [
      registryUrl(repository, 'x86_64'),
      registryUrl(repository, 'aarch64'),
    ]);
    const edge = [
      registryUrl(edgeMain, 'x86_64'),
      registryUrl(edgeMain, 'aarch64'),
    ];

    await expect(
      extractPackageFile(Fixtures.get('tags.yaml'), 'apko.yaml'),
    ).resolves.toEqual({
      deps: [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', untagged),
        pin(
          'nodejs@edge=22.13.1-r0',
          'nodejs',
          '22.13.1-r0',
          [...edge, ...untagged],
          'nodejs@edge={{{newValue}}}',
        ),
        {
          datasource: 'apk',
          depName: 'libpcap',
          skipReason: 'local-dependency',
        },
        pin(
          'busybox@missing=1.36.1-r0',
          'busybox',
          '1.36.1-r0',
          untagged,
          'busybox@missing={{{newValue}}}',
        ),
      ],
    });
  });

  it('sets lockedVersion when every arch agrees', async () => {
    fs.readLocalFile.mockResolvedValue(Fixtures.get('lock-agree.json'));

    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: ['bash=5.2.37-r2'],
          archs: ['amd64', 'arm64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [
        {
          ...pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [
            wolfiX86,
            registryUrl(wolfi, 'aarch64'),
          ]),
          lockedVersion: '5.2.37-r2',
        },
      ],
      lockFiles: ['apko.lock.json'],
    });
  });

  it('omits lockedVersion when archs disagree', async () => {
    fs.readLocalFile.mockResolvedValue(Fixtures.get('lock-disagree.json'));

    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: ['bash=5.2.37-r2'],
          archs: ['amd64', 'arm64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [
          wolfiX86,
          registryUrl(wolfi, 'aarch64'),
        ]),
      ],
      lockFiles: ['apko.lock.json'],
    });
  });

  it('does not add packages that appear only in the lock', async () => {
    fs.readLocalFile.mockResolvedValue(Fixtures.get('lock-transitive.json'));

    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: ['bash=5.2.37-r2'],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [
        {
          ...pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86]),
          lockedVersion: '5.2.37-r2',
        },
      ],
      lockFiles: ['apko.lock.json'],
    });
  });

  it('returns deps when the lock file is not valid JSON', async () => {
    fs.readLocalFile.mockResolvedValue('{');

    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: ['bash=5.2.37-r2'],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86])],
    });
  });

  it('reads image.lock.json next to image.yml', async () => {
    fs.readLocalFile.mockImplementation(
      (fileName: string): Promise<string | null> =>
        Promise.resolve(
          fileName === 'dir/image.lock.json'
            ? Fixtures.get('lock-agree.json')
            : null,
        ),
    );

    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: ['bash=5.2.37-r2'],
          archs: ['amd64'],
        }),
        'dir/image.yml',
      ),
    ).resolves.toEqual({
      deps: [
        {
          ...pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86]),
          lockedVersion: '5.2.37-r2',
        },
      ],
      lockFiles: ['dir/image.lock.json'],
    });
  });

  it('returns an unversioned package and its lock file', async () => {
    fs.readLocalFile.mockResolvedValue(Fixtures.get('lock-agree.json'));

    await expect(
      extractPackageFile(
        yaml({
          repositories: [wolfi],
          packages: ['wolfi-base'],
          archs: ['amd64'],
        }),
        'apko.yaml',
      ),
    ).resolves.toEqual({
      deps: [
        {
          datasource: 'apk',
          depName: 'wolfi-base',
          skipReason: 'unspecified-version',
        },
      ],
      lockFiles: ['apko.lock.json'],
    });
  });

  it('returns one package file when the config has no include', async () => {
    const content = yaml({
      repositories: [wolfi],
      packages: ['bash=5.2.37-r2'],
      archs: ['amd64'],
    });
    mockFiles({ 'apko.yaml': content });

    await expect(extractAllPackageFiles({}, ['apko.yaml'])).resolves.toEqual([
      extracted('apko.yaml', [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86]),
      ]),
    ]);
  });

  it('keeps an included package on its own file with the parent lock', async () => {
    // getManagerPackageFiles uses extractAllPackageFiles and does not also
    // call extractPackageFile
    // (lib/workers/repository/extract/manager-files.ts). gradle returns one
    // PackageFile per owning file. Renovate rewrites that file's contents, so
    // a version that lives in the child cannot be updated from the parent
    // entry. patchConfigForArtifactsUpdate
    // (lib/workers/repository/update/branch/get-updated.ts) copies the child
    // entry's lockFiles onto config.lockFiles before updateArtifacts.
    const parent = Fixtures.get('include-parent.yaml');
    const child = Fixtures.get('include-child.yaml');
    const lock = lockJson([
      { name: 'bash', version: '5.2.37-r2' },
      { name: 'curl', version: '8.12.1-r0' },
    ]);
    mockFiles({
      'app/apko.yaml': parent,
      'app/pkgs/apko.yaml': child,
      'app/apko.lock.json': lock,
    });

    await expect(
      extractAllPackageFiles({}, ['app/apko.yaml']),
    ).resolves.toEqual([
      extracted(
        'app/apko.yaml',
        [
          {
            ...pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', [wolfiX86]),
            lockedVersion: '8.12.1-r0',
          },
        ],
        ['app/apko.lock.json'],
      ),
      extracted(
        'app/pkgs/apko.yaml',
        [
          {
            ...pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86]),
            lockedVersion: '5.2.37-r2',
          },
        ],
        ['app/apko.lock.json'],
      ),
    ]);
  });

  it('merges included repositories before the parent and keeps the parent archs', async () => {
    // Included lists are placed before the parent lists, and parent archs win
    // when set. ImageContents.MergeInto and ImageConfiguration.MergeInto in
    // chainguard-dev/apko pkg/build/types/image_configuration.go.
    const child = yaml({
      repositories: [alpineMain, 'https://mirror.example.com/os?token=secret'],
      buildRepositories: [chainguard],
      runtimeRepositories: ['https://example.com/runtime'],
      packages: ['bash=5.2.37-r2'],
      archs: ['arm64'],
    });
    const parent = yaml({
      include: 'pkgs/apko.yaml',
      repositories: [wolfi],
      buildRepositories: [alpineCommunity],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    mockFiles({
      'app/apko.yaml': parent,
      'app/pkgs/apko.yaml': child,
    });
    const registryUrls = [
      registryUrl(alpineMain, 'x86_64'),
      wolfiX86,
      registryUrl(chainguard, 'x86_64'),
      registryUrl(alpineCommunity, 'x86_64'),
    ];

    await expect(
      extractAllPackageFiles({}, ['app/apko.yaml']),
    ).resolves.toEqual([
      extracted('app/apko.yaml', [
        pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', registryUrls),
      ]),
      extracted('app/pkgs/apko.yaml', [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', registryUrls),
      ]),
    ]);
  });

  it('uses included archs when the parent does not set them', async () => {
    const child = yaml({
      repositories: [alpineMain],
      packages: ['bash=5.2.37-r2'],
      archs: ['arm64'],
    });
    const parent = yaml({
      include: 'child.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
    });
    mockFiles({
      'images/apko.yaml': parent,
      'images/child.yaml': child,
    });
    const registryUrls = [
      registryUrl(alpineMain, 'aarch64'),
      registryUrl(wolfi, 'aarch64'),
    ];

    await expect(
      extractAllPackageFiles({}, ['images/apko.yaml']),
    ).resolves.toEqual([
      extracted('images/apko.yaml', [
        pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', registryUrls),
      ]),
      extracted('images/child.yaml', [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', registryUrls),
      ]),
    ]);
  });

  it('resolves nested includes from the root config directory', async () => {
    // paths.ResolvePath stats the include against the process cwd before
    // --include-paths (chainguard-dev/apko pkg/paths/paths.go). Renovate runs
    // `apko lock` with cwd set to the root config directory, so `base.yaml`
    // from pkgs/mid.yaml is app/base.yaml.
    mockFiles({
      'app/apko.yaml': Fixtures.get('include-nested-app.yaml'),
      'app/pkgs/mid.yaml': Fixtures.get('include-nested-mid.yaml'),
      'app/base.yaml': Fixtures.get('include-nested-base.yaml'),
    });
    const registryUrls = [registryUrl(alpineMain, 'x86_64'), wolfiX86];

    await expect(
      extractAllPackageFiles({}, ['app/apko.yaml']),
    ).resolves.toEqual([
      extracted('app/apko.yaml', [
        pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', registryUrls),
      ]),
      extracted('app/pkgs/mid.yaml', [
        pin('busybox=1.36.1-r0', 'busybox', '1.36.1-r0', registryUrls),
      ]),
      extracted('app/base.yaml', [
        pin('alpine-base=3.22.0-r0', 'alpine-base', '3.22.0-r0', registryUrls),
      ]),
    ]);
  });

  it('extracts each file once when includes form a cycle', async () => {
    // ImageConfiguration.parse loads the include recursively and has no
    // visited set (chainguard-dev/apko pkg/build/types/image_configuration.go).
    mockFiles({
      'cycle/a.yaml': Fixtures.get('include-cycle-a.yaml'),
      'cycle/b.yaml': Fixtures.get('include-cycle-b.yaml'),
    });
    const registryUrls = [registryUrl(alpineMain, 'x86_64'), wolfiX86];

    await expect(extractAllPackageFiles({}, ['cycle/a.yaml'])).resolves.toEqual(
      [
        extracted('cycle/a.yaml', [
          pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', registryUrls),
        ]),
        extracted('cycle/b.yaml', [
          pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', registryUrls),
        ]),
      ],
    );
  });

  it('keeps parent packages when the include cannot be read', async () => {
    mockFiles({
      'app/apko.yaml': Fixtures.get('include-parent.yaml'),
    });

    await expect(
      extractAllPackageFiles({}, ['app/apko.yaml']),
    ).resolves.toEqual([
      extracted('app/apko.yaml', [
        pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', [wolfiX86]),
      ]),
    ]);
  });

  it('ignores an include path that leaves the repository', async () => {
    const outside = yaml({
      packages: ['bash=5.2.37-r2'],
    });
    const escaped = yaml({
      include: '../../outside.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    mockFiles({
      'app/apko.yaml': escaped,
      '../outside.yaml': outside,
      '/tmp/outside.yaml': outside,
    });

    await expect(
      extractAllPackageFiles({}, ['app/apko.yaml']),
    ).resolves.toEqual([
      extracted('app/apko.yaml', [
        pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', [wolfiX86]),
      ]),
    ]);
    expect(fs.readLocalFile.mock.calls.map((call) => call[0])).not.toContain(
      '../outside.yaml',
    );

    const absolute = yaml({
      include: '/tmp/outside.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    mockFiles({
      'app/apko.yaml': absolute,
      '/tmp/outside.yaml': outside,
    });
    await expect(
      extractAllPackageFiles({}, ['app/apko.yaml']),
    ).resolves.toEqual([
      extracted('app/apko.yaml', [
        pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', [wolfiX86]),
      ]),
    ]);
    expect(fs.readLocalFile.mock.calls.map((call) => call[0])).not.toContain(
      '/tmp/outside.yaml',
    );
  });

  it('extracts an included file alone without the parent repositories', async () => {
    await expect(
      extractPackageFile(Fixtures.get('include-child.yaml'), 'pkgs/apko.yaml'),
    ).resolves.toEqual({
      deps: [
        {
          datasource: 'apk',
          depName: 'bash',
          currentValue: '5.2.37-r2',
          replaceString: 'bash=5.2.37-r2',
          autoReplaceStringTemplate: 'bash={{{newValue}}}',
        },
      ],
    });
  });

  it('lists one child for every parent and unions registry URLs in parent order', async () => {
    // One child entry. lockFiles lists every root lock, in matched-file
    // order. registryUrls is the union of each parent's merged list in that
    // order. updateArtifacts runs once for the child and receives every
    // lock file (get-updated.ts patchConfigForArtifactsUpdate). pip-compile
    // walks config.lockFiles and returns one result per lock.
    const shared = yaml({
      repositories: [alpineCommunity],
      packages: ['bash=5.2.37-r2'],
      archs: ['arm64'],
    });
    const parentA = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    const parentB = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [alpineMain],
      packages: ['busybox=1.36.1-r0'],
      archs: ['amd64'],
    });
    const lock = lockJson([{ name: 'bash', version: '5.2.37-r2' }]);
    mockFiles({
      'images/a/apko.yaml': parentA,
      'images/b/apko.yaml': parentB,
      'shared/pkgs.yaml': shared,
      'images/a/apko.lock.json': lock,
      'images/b/apko.lock.json': lock,
    });
    const fromA = [registryUrl(alpineCommunity, 'x86_64'), wolfiX86];
    const fromB = [
      registryUrl(alpineCommunity, 'x86_64'),
      registryUrl(alpineMain, 'x86_64'),
    ];

    await expect(
      extractAllPackageFiles({}, ['images/a/apko.yaml', 'images/b/apko.yaml']),
    ).resolves.toEqual([
      extracted(
        'images/a/apko.yaml',
        [pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', fromA)],
        ['images/a/apko.lock.json'],
      ),
      extracted(
        'shared/pkgs.yaml',
        [
          {
            ...pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [
              ...fromA,
              registryUrl(alpineMain, 'x86_64'),
            ]),
            lockedVersion: '5.2.37-r2',
          },
        ],
        ['images/a/apko.lock.json', 'images/b/apko.lock.json'],
      ),
      extracted(
        'images/b/apko.yaml',
        [pin('busybox=1.36.1-r0', 'busybox', '1.36.1-r0', fromB)],
        ['images/b/apko.lock.json'],
      ),
    ]);
  });

  it('omits lockedVersion when parent locks disagree', async () => {
    const shared = yaml({
      packages: ['bash=5.2.37-r2'],
    });
    const parentA = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    const parentB = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    mockFiles({
      'images/a/apko.yaml': parentA,
      'images/b/apko.yaml': parentB,
      'shared/pkgs.yaml': shared,
      'images/a/apko.lock.json': lockJson([
        { name: 'bash', version: '5.2.37-r2' },
      ]),
      'images/b/apko.lock.json': lockJson([
        { name: 'bash', version: '5.2.38-r0' },
      ]),
    });

    const result = await extractAllPackageFiles({}, [
      'images/a/apko.yaml',
      'images/b/apko.yaml',
    ]);
    const child = result?.find(
      (packageFile) => packageFile.packageFile === 'shared/pkgs.yaml',
    );

    expect(child?.deps).toEqual([
      pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86]),
    ]);
  });

  it('uses lockedVersion from the only parent lock that contains the package', async () => {
    const shared = yaml({
      packages: ['bash=5.2.37-r2'],
    });
    const parentA = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    const parentB = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    mockFiles({
      'images/a/apko.yaml': parentA,
      'images/b/apko.yaml': parentB,
      'shared/pkgs.yaml': shared,
      'images/a/apko.lock.json': lockJson([
        { name: 'bash', version: '5.2.37-r2' },
      ]),
      'images/b/apko.lock.json': lockJson([
        { name: 'curl', version: '8.12.1-r0' },
      ]),
    });

    const result = await extractAllPackageFiles({}, [
      'images/a/apko.yaml',
      'images/b/apko.yaml',
    ]);
    const child = result?.find(
      (packageFile) => packageFile.packageFile === 'shared/pkgs.yaml',
    );

    expect(child?.deps).toEqual([
      {
        ...pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86]),
        lockedVersion: '5.2.37-r2',
      },
    ]);
  });

  it('returns null when no package file has dependencies', async () => {
    // gradle's extractAllPackageFiles returns null when it extracts nothing.
    // getManagerPackageFiles returns that null
    // (lib/workers/repository/extract/manager-files.ts).
    mockFiles({
      'empty.yaml': yaml({
        repositories: [wolfi],
        packages: [],
        archs: ['amd64'],
      }),
    });

    await expect(extractAllPackageFiles({}, [])).resolves.toBeNull();
    await expect(
      extractAllPackageFiles({}, ['missing.yaml']),
    ).resolves.toBeNull();
    await expect(
      extractAllPackageFiles({}, ['empty.yaml']),
    ).resolves.toBeNull();
  });

  it('emits a matched include once and appends its own lock and registries', async () => {
    // shared/pkgs.yaml also matches as a root. A second entry would list
    // bash twice. The entry recorded for the first parent keeps one dep.
    // Visiting the matched file appends its own lock and any standalone
    // registry URL that is not already present.
    const shared = yaml({
      repositories: [alpineCommunity],
      packages: ['bash=5.2.37-r2'],
      archs: ['arm64'],
    });
    const parentA = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    const parentB = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [alpineMain],
      packages: ['busybox=1.36.1-r0'],
      archs: ['amd64'],
    });
    const lock = lockJson([{ name: 'bash', version: '5.2.37-r2' }]);
    mockFiles({
      'images/a/apko.yaml': parentA,
      'images/b/apko.yaml': parentB,
      'shared/pkgs.yaml': shared,
      'images/a/apko.lock.json': lock,
      'images/b/apko.lock.json': lock,
      'shared/pkgs.lock.json': lock,
    });

    await expect(
      extractAllPackageFiles({}, [
        'images/a/apko.yaml',
        'shared/pkgs.yaml',
        'images/b/apko.yaml',
      ]),
    ).resolves.toEqual([
      extracted(
        'images/a/apko.yaml',
        [
          pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', [
            registryUrl(alpineCommunity, 'x86_64'),
            wolfiX86,
          ]),
        ],
        ['images/a/apko.lock.json'],
      ),
      extracted(
        'shared/pkgs.yaml',
        [
          {
            ...pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [
              registryUrl(alpineCommunity, 'x86_64'),
              wolfiX86,
              registryUrl(alpineCommunity, 'aarch64'),
              registryUrl(alpineMain, 'x86_64'),
            ]),
            lockedVersion: '5.2.37-r2',
          },
        ],
        [
          'images/a/apko.lock.json',
          'shared/pkgs.lock.json',
          'images/b/apko.lock.json',
        ],
      ),
      extracted(
        'images/b/apko.yaml',
        [
          pin('busybox=1.36.1-r0', 'busybox', '1.36.1-r0', [
            registryUrl(alpineCommunity, 'x86_64'),
            registryUrl(alpineMain, 'x86_64'),
          ]),
        ],
        ['images/b/apko.lock.json'],
      ),
    ]);
  });

  it('keeps a declared tag on an included package', async () => {
    const parent = yaml({
      include: 'pkgs/child.yaml',
      repositories: [wolfi, `@edge ${edgeMain}`],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    const child = yaml({
      packages: [
        'bash=5.2.37-r2',
        'nodejs@edge=22.13.1-r0',
        'busybox@missing=1.36.1-r0',
      ],
    });
    mockFiles({
      'app/apko.yaml': parent,
      'app/pkgs/child.yaml': child,
    });
    const edge = registryUrl(edgeMain, 'x86_64');

    await expect(
      extractAllPackageFiles({}, ['app/apko.yaml']),
    ).resolves.toEqual([
      extracted('app/apko.yaml', [
        pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', [wolfiX86]),
      ]),
      extracted('app/pkgs/child.yaml', [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86]),
        pin(
          'nodejs@edge=22.13.1-r0',
          'nodejs',
          '22.13.1-r0',
          [edge, wolfiX86],
          'nodejs@edge={{{newValue}}}',
        ),
        pin(
          'busybox@missing=1.36.1-r0',
          'busybox',
          '1.36.1-r0',
          [wolfiX86],
          'busybox@missing={{{newValue}}}',
        ),
      ]),
    ]);
  });

  it('follows an include when the root lists no packages', async () => {
    const parent = yaml({
      include: 'pkgs/child.yaml',
      repositories: [wolfi],
      packages: [],
      archs: ['amd64'],
    });
    const child = yaml({
      packages: ['bash=5.2.37-r2'],
    });
    mockFiles({
      'app/apko.yaml': parent,
      'app/pkgs/child.yaml': child,
    });

    await expect(
      extractAllPackageFiles({}, ['app/apko.yaml']),
    ).resolves.toEqual([
      extracted('app/pkgs/child.yaml', [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86]),
      ]),
    ]);
  });

  it('follows an include through a file whose specs are all dropped', async () => {
    const parent = yaml({
      include: 'pkgs/mid.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
    });
    const mid = yaml({
      include: 'base.yaml',
      repositories: [alpineMain],
      packages: ['!ignored', './bash.apk'],
      archs: ['arm64'],
    });
    const base = yaml({
      packages: ['bash=5.2.37-r2'],
    });
    mockFiles({
      'app/apko.yaml': parent,
      'app/pkgs/mid.yaml': mid,
      'app/base.yaml': base,
    });
    const registryUrls = [
      registryUrl(alpineMain, 'aarch64'),
      registryUrl(wolfi, 'aarch64'),
    ];

    await expect(
      extractAllPackageFiles({}, ['app/apko.yaml']),
    ).resolves.toEqual([
      extracted('app/apko.yaml', [
        pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', registryUrls),
      ]),
      extracted('app/base.yaml', [
        pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', registryUrls),
      ]),
    ]);
  });

  it('keeps the other lock when a later parent lock is absent', async () => {
    const shared = yaml({
      packages: ['bash=5.2.37-r2'],
    });
    const parentA = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    const parentB = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [wolfi],
      packages: ['busybox=1.36.1-r0'],
      archs: ['amd64'],
    });
    mockFiles({
      'images/a/apko.yaml': parentA,
      'images/b/apko.yaml': parentB,
      'shared/pkgs.yaml': shared,
      'images/a/apko.lock.json': lockJson([
        { name: 'bash', version: '5.2.37-r2' },
      ]),
      'images/b/apko.lock.json': '{',
    });

    await expect(
      extractAllPackageFiles({}, ['images/a/apko.yaml', 'images/b/apko.yaml']),
    ).resolves.toEqual([
      extracted(
        'images/a/apko.yaml',
        [pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', [wolfiX86])],
        ['images/a/apko.lock.json'],
      ),
      extracted(
        'shared/pkgs.yaml',
        [
          {
            ...pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [wolfiX86]),
            lockedVersion: '5.2.37-r2',
          },
        ],
        ['images/a/apko.lock.json'],
      ),
      extracted('images/b/apko.yaml', [
        pin('busybox=1.36.1-r0', 'busybox', '1.36.1-r0', [wolfiX86]),
      ]),
    ]);
  });

  it('keeps parent locks when the included file has no lock of its own', async () => {
    const shared = yaml({
      repositories: [alpineCommunity],
      packages: ['bash=5.2.37-r2'],
      archs: ['arm64'],
    });
    const parent = yaml({
      include: '../../shared/pkgs.yaml',
      repositories: [wolfi],
      packages: ['curl=8.12.1-r0'],
      archs: ['amd64'],
    });
    mockFiles({
      'images/a/apko.yaml': parent,
      'shared/pkgs.yaml': shared,
      'images/a/apko.lock.json': lockJson([
        { name: 'bash', version: '5.2.37-r2' },
      ]),
    });

    await expect(
      extractAllPackageFiles({}, ['images/a/apko.yaml', 'shared/pkgs.yaml']),
    ).resolves.toEqual([
      extracted(
        'images/a/apko.yaml',
        [
          pin('curl=8.12.1-r0', 'curl', '8.12.1-r0', [
            registryUrl(alpineCommunity, 'x86_64'),
            wolfiX86,
          ]),
        ],
        ['images/a/apko.lock.json'],
      ),
      extracted(
        'shared/pkgs.yaml',
        [
          {
            ...pin('bash=5.2.37-r2', 'bash', '5.2.37-r2', [
              registryUrl(alpineCommunity, 'x86_64'),
              wolfiX86,
              registryUrl(alpineCommunity, 'aarch64'),
            ]),
            lockedVersion: '5.2.37-r2',
          },
        ],
        ['images/a/apko.lock.json'],
      ),
    ]);
  });
});
