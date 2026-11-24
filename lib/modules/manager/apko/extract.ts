import { isNonEmptyArray } from '@sindresorhus/is';
import upath from 'upath';
import { logger } from '../../../logger/index.ts';
import { coerceArray } from '../../../util/array.ts';
import { getSiblingFileName, readLocalFile } from '../../../util/fs/index.ts';
import { regEx } from '../../../util/regex.ts';
import { isHttpUrl } from '../../../util/url.ts';
import { ApkDatasource } from '../../datasource/apk/index.ts';
import { api as apkVersioning } from '../../versioning/apk/index.ts';
import type {
  ExtractConfig,
  PackageDependency,
  PackageFile,
  PackageFileContent,
} from '../types.ts';
import { ApkoConfig, ApkoLock, type ApkoLockPackage } from './schema.ts';

type SpecSkipReason =
  | 'unspecified-version'
  | 'contains-variable'
  | 'unsupported-version'
  | 'local-dependency';

interface DroppedSpec {
  kind: 'drop';
}

interface SkippedSpec {
  kind: 'skip';
  depName: string;
  skipReason: SpecSkipReason;
}

interface VersionedSpec {
  kind: 'versioned';
  depName: string;
  currentValue: string;
  replaceString: string;
  autoReplaceStringTemplate: string;
  tag: string | null;
}

type PackageSpec = DroppedSpec | SkippedSpec | VersionedSpec;

interface RepositoryIndex {
  untaggedHttp: string[];
  httpByTag: Map<string, string[]>;
  fileTags: Set<string>;
}

const packageSpecRegex = regEx(
  /^(?<name>[a-zA-Z0-9][\w.+-]*)(?:@(?<prefixTag>[\w.-]+))?(?:(?<operator>[<>=~]+)(?<version>[^@]+))?(?:@(?<suffixTag>[\w.-]+))?$/,
);

const taggedRepositoryRegex = regEx(/^@(?<tag>[\w.-]+)\s+(?<url>\S+)$/);

const yamlExtensionRegex = regEx(/\.ya?ml$/);

const allArchs = [
  '386',
  'amd64',
  'arm64',
  'arm/v6',
  'arm/v7',
  'loong64',
  'ppc64le',
  'riscv64',
  's390x',
];

const apkArchByApkoArch = new Map([
  ['386', 'x86'],
  ['amd64', 'x86_64'],
  ['arm64', 'aarch64'],
  ['arm/v6', 'armhf'],
  ['arm/v7', 'armv7'],
  ['loong64', 'loongarch64'],
]);

export function getLockFileName(packageFileName: string): string {
  const baseName = upath
    .basename(packageFileName)
    .replace(yamlExtensionRegex, '');
  return getSiblingFileName(packageFileName, `${baseName}.lock.json`);
}

function parsePackageSpec(
  spec: string,
  fileTags: ReadonlySet<string>,
): PackageSpec {
  const groups = packageSpecRegex.exec(spec)?.groups;
  if (!groups) {
    return { kind: 'drop' };
  }

  const { name: depName, operator, version } = groups;
  const tag = groups.prefixTag ?? groups.suffixTag ?? null;
  if (tag && fileTags.has(tag)) {
    return { kind: 'skip', depName, skipReason: 'local-dependency' };
  }
  if (!operator) {
    return { kind: 'skip', depName, skipReason: 'unspecified-version' };
  }
  if (version.includes('$')) {
    return { kind: 'skip', depName, skipReason: 'contains-variable' };
  }

  const constraint = `${operator}${version}`;
  if (!apkVersioning.isValid(constraint)) {
    return { kind: 'skip', depName, skipReason: 'unsupported-version' };
  }

  const currentValue = apkVersioning.isSingleVersion(constraint)
    ? version
    : constraint;
  const valueEnd = spec.indexOf(constraint) + constraint.length;
  const valuePrefix = spec.slice(0, valueEnd - currentValue.length);
  const tagSuffix = spec.slice(valueEnd);
  return {
    kind: 'versioned',
    depName,
    currentValue,
    replaceString: spec,
    autoReplaceStringTemplate: `${valuePrefix}{{{newValue}}}${tagSuffix}`,
    tag,
  };
}

function indexRepositories(entries: string[]): RepositoryIndex {
  const index: RepositoryIndex = {
    untaggedHttp: [],
    httpByTag: new Map(),
    fileTags: new Set(),
  };
  for (const entry of entries) {
    const tagged = taggedRepositoryRegex.exec(entry)?.groups;
    const tag = tagged?.tag ?? null;
    const url = tagged?.url ?? entry;
    if (url.includes('?')) {
      continue;
    }
    if (!isHttpUrl(url)) {
      if (tag) {
        index.fileTags.add(tag);
      }
      continue;
    }

    if (tag) {
      index.httpByTag.set(tag, [...coerceArray(index.httpByTag.get(tag)), url]);
      continue;
    }
    index.untaggedHttp.push(url);
  }
  return index;
}

function requestedArchs(archs: string[] | undefined): string[] {
  if (archs === undefined) {
    return allArchs;
  }
  if (archs.length === 1 && archs[0] === 'all') {
    return allArchs;
  }
  return archs;
}

function registryUrlsFor(
  tag: string | null,
  repositories: RepositoryIndex,
  apkArchs: string[],
): string[] {
  const tagged = tag === null ? undefined : repositories.httpByTag.get(tag);
  const urls = tagged
    ? [...tagged, ...repositories.untaggedHttp]
    : repositories.untaggedHttp;
  return urls.flatMap((url) => apkArchs.map((arch) => `${url}?arch=${arch}`));
}

function lockedVersionOf(
  depName: string,
  lockPackages: ApkoLockPackage[],
): string | undefined {
  const versions = new Set(
    lockPackages
      .filter((lockPackage) => lockPackage.name === depName)
      .map((lockPackage) => lockPackage.version),
  );
  if (versions.size !== 1) {
    return undefined;
  }
  const [version] = versions;
  return version;
}

function toDependency(
  spec: SkippedSpec | VersionedSpec,
  repositories: RepositoryIndex,
  apkArchs: string[],
  lockPackages: ApkoLockPackage[],
): PackageDependency {
  if (spec.kind === 'skip') {
    return {
      datasource: ApkDatasource.id,
      depName: spec.depName,
      skipReason: spec.skipReason,
    };
  }

  const dep: PackageDependency = {
    datasource: ApkDatasource.id,
    depName: spec.depName,
    currentValue: spec.currentValue,
    replaceString: spec.replaceString,
    autoReplaceStringTemplate: spec.autoReplaceStringTemplate,
  };
  const registryUrls = registryUrlsFor(spec.tag, repositories, apkArchs);
  if (isNonEmptyArray(registryUrls)) {
    dep.registryUrls = registryUrls;
  }
  const lockedVersion = lockedVersionOf(spec.depName, lockPackages);
  if (lockedVersion) {
    dep.lockedVersion = lockedVersion;
  }
  return dep;
}

async function readLockPackages(
  lockFileName: string,
  packageFile: string,
): Promise<ApkoLockPackage[] | null> {
  const content = await readLocalFile(lockFileName, 'utf8');
  if (!content) {
    return null;
  }

  const lock = ApkoLock.safeParse(content);
  if (!lock.success) {
    logger.debug(
      { err: lock.error, packageFile },
      'Failed to parse apko lock file',
    );
    return null;
  }
  return lock.data.contents.packages;
}

interface ApkoFile {
  include?: string;
  repositories: string[];
  buildRepositories: string[];
  archs?: string[];
  specs: (SkippedSpec | VersionedSpec)[];
}

interface MergedSources {
  repositories: string[];
  buildRepositories: string[];
  archs?: string[];
}

interface LockRecord {
  lockFileName: string;
  packages: ApkoLockPackage[];
}

interface IncludedEntry {
  packageFile: string;
  file: ApkoFile;
  deps: PackageDependency[];
  registryUrls: string[];
  lockFiles: string[];
  lockPackages: ApkoLockPackage[];
}

function parseApkoFile(content: string, packageFile: string): ApkoFile | null {
  const parsed = ApkoConfig.safeParse(content);
  if (!parsed.success) {
    logger.debug(
      { err: parsed.error, packageFile },
      'Failed to parse apko file',
    );
    return null;
  }

  const { contents, archs, include } = parsed.data;
  const repositories = coerceArray(contents.repositories);
  const buildRepositories = coerceArray(contents.build_repositories);
  const fileTags = indexRepositories([
    ...repositories,
    ...buildRepositories,
  ]).fileTags;
  const specs = contents.packages
    .map((spec) => parsePackageSpec(spec, fileTags))
    .filter((spec) => spec.kind !== 'drop');
  if (!specs.length) {
    logger.debug(`No apk packages found in ${packageFile}`);
    return null;
  }

  return { include, repositories, buildRepositories, archs, specs };
}

function apkArchsFor(archs: string[] | undefined): string[] {
  return requestedArchs(archs).map(
    (arch) => apkArchByApkoArch.get(arch) ?? arch,
  );
}

function repositoryIndex(
  repositories: string[],
  buildRepositories: string[],
): RepositoryIndex {
  return indexRepositories([...repositories, ...buildRepositories]);
}

function includedPath(
  rootDir: string,
  includePath: string | undefined,
): string | null {
  if (!includePath || upath.isAbsolute(includePath)) {
    return null;
  }
  const resolved = upath.normalize(upath.join(rootDir, includePath));
  if (resolved.startsWith('..')) {
    return null;
  }
  return resolved;
}

function unionUrls(target: string[], extra: string[]): void {
  for (const url of extra) {
    if (!target.includes(url)) {
      target.push(url);
    }
  }
}

function applyRegistryUrls(entry: IncludedEntry): void {
  const registryUrls = [...entry.registryUrls];
  for (const dep of entry.deps) {
    dep.registryUrls = registryUrls;
  }
}

function refreshLockedVersions(entry: IncludedEntry): void {
  for (const dep of entry.deps) {
    const lockedVersion = lockedVersionOf(dep.depName!, entry.lockPackages);
    if (lockedVersion) {
      dep.lockedVersion = lockedVersion;
    } else {
      delete dep.lockedVersion;
    }
  }
}

function addLock(entry: IncludedEntry, lock: LockRecord): void {
  entry.lockFiles.push(lock.lockFileName);
  entry.lockPackages.push(...lock.packages);
  refreshLockedVersions(entry);
}

async function readApkoFile(
  packageFile: string,
  cache: Map<string, ApkoFile>,
): Promise<ApkoFile | null> {
  const cached = cache.get(packageFile);
  if (cached) {
    return cached;
  }
  const content = await readLocalFile(packageFile, 'utf8');
  const file = content ? parseApkoFile(content, packageFile) : null;
  if (!file) {
    return null;
  }
  cache.set(packageFile, file);
  return file;
}

async function readLock(packageFile: string): Promise<LockRecord | null> {
  const lockFileName = getLockFileName(packageFile);
  const packages = await readLockPackages(lockFileName, packageFile);
  if (!packages) {
    return null;
  }
  return { lockFileName, packages };
}

async function mergedSources(
  packageFile: string,
  rootDir: string,
  stack: Set<string>,
  cache: Map<string, ApkoFile>,
): Promise<MergedSources> {
  if (stack.has(packageFile)) {
    return { repositories: [], buildRepositories: [] };
  }
  const file = await readApkoFile(packageFile, cache);
  if (!file) {
    return { repositories: [], buildRepositories: [] };
  }

  stack.add(packageFile);
  const merged: MergedSources = {
    repositories: [],
    buildRepositories: [],
  };
  const child = includedPath(rootDir, file.include);
  if (child) {
    const included = await mergedSources(child, rootDir, stack, cache);
    merged.repositories.push(...included.repositories);
    merged.buildRepositories.push(...included.buildRepositories);
    merged.archs = included.archs;
  }
  merged.repositories.push(...file.repositories);
  merged.buildRepositories.push(...file.buildRepositories);
  if (file.archs) {
    merged.archs = file.archs;
  }
  stack.delete(packageFile);
  return merged;
}

function expandedUrls(
  repositories: string[],
  buildRepositories: string[],
  archs: string[] | undefined,
): string[] {
  return registryUrlsFor(
    null,
    repositoryIndex(repositories, buildRepositories),
    apkArchsFor(archs),
  );
}

function depsFor(
  file: ApkoFile,
  repositories: RepositoryIndex,
  archs: string[],
  lockPackages: ApkoLockPackage[],
): PackageDependency[] {
  return file.specs.map((spec) =>
    toDependency(spec, repositories, archs, lockPackages),
  );
}

export async function extractPackageFile(
  content: string,
  packageFile: string,
): Promise<PackageFileContent | null> {
  const file = parseApkoFile(content, packageFile);
  if (!file) {
    return null;
  }

  const repositories = repositoryIndex(
    file.repositories,
    file.buildRepositories,
  );
  const apkArchs = apkArchsFor(file.archs);
  const lockFileName = getLockFileName(packageFile);
  const lockPackages = await readLockPackages(lockFileName, packageFile);
  const deps = depsFor(file, repositories, apkArchs, coerceArray(lockPackages));
  if (!lockPackages) {
    return { deps };
  }
  return { deps, lockFiles: [lockFileName] };
}

function toPackageFile(entry: IncludedEntry): PackageFile {
  const result: PackageFile = {
    packageFile: entry.packageFile,
    deps: entry.deps,
  };
  if (entry.lockFiles.length) {
    result.lockFiles = entry.lockFiles;
  }
  return result;
}

export async function extractAllPackageFiles(
  _config: ExtractConfig,
  packageFiles: string[],
): Promise<PackageFile[] | null> {
  const cache = new Map<string, ApkoFile>();
  const entries = new Map<string, IncludedEntry>();
  const order: IncludedEntry[] = [];

  async function appendStandalone(entry: IncludedEntry): Promise<void> {
    unionUrls(
      entry.registryUrls,
      expandedUrls(
        entry.file.repositories,
        entry.file.buildRepositories,
        entry.file.archs,
      ),
    );
    applyRegistryUrls(entry);
    addLock(entry, (await readLock(entry.packageFile))!);
  }

  async function visit(
    packageFile: string,
    rootDir: string,
    repositories: RepositoryIndex,
    archs: string[],
    registryUrls: string[],
    rootLock: LockRecord | null,
    stack: Set<string>,
  ): Promise<void> {
    if (stack.has(packageFile)) {
      return;
    }
    const file = await readApkoFile(packageFile, cache);
    if (!file) {
      return;
    }
    stack.add(packageFile);

    const existing = entries.get(packageFile);
    if (existing) {
      unionUrls(existing.registryUrls, registryUrls);
      applyRegistryUrls(existing);
      addLock(existing, rootLock!);
    } else {
      const entry: IncludedEntry = {
        packageFile,
        file,
        deps: depsFor(file, repositories, archs, []),
        registryUrls,
        lockFiles: [],
        lockPackages: [],
      };
      applyRegistryUrls(entry);
      if (rootLock) {
        addLock(entry, rootLock);
      }
      entries.set(packageFile, entry);
      order.push(entry);
    }

    const child = includedPath(rootDir, file.include);
    if (child) {
      await visit(
        child,
        rootDir,
        repositories,
        archs,
        registryUrls,
        rootLock,
        stack,
      );
    }
    stack.delete(packageFile);
  }

  for (const packageFile of packageFiles) {
    const existing = entries.get(packageFile);
    if (existing) {
      await appendStandalone(existing);
      continue;
    }

    const rootDir = upath.dirname(packageFile);
    const merged = await mergedSources(packageFile, rootDir, new Set(), cache);
    const repositories = repositoryIndex(
      merged.repositories,
      merged.buildRepositories,
    );
    const archs = apkArchsFor(merged.archs);
    await visit(
      packageFile,
      rootDir,
      repositories,
      archs,
      expandedUrls(merged.repositories, merged.buildRepositories, merged.archs),
      await readLock(packageFile),
      new Set(),
    );
  }

  if (!order.length) {
    return null;
  }
  return order.map(toPackageFile);
}
