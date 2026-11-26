import { isNonEmptyArray } from '@sindresorhus/is';
import { quote } from 'shlex';
import upath from 'upath';
import { TEMPORARY_ERROR } from '../../../constants/error-messages.ts';
import { logger } from '../../../logger/index.ts';
import { exec } from '../../../util/exec/index.ts';
import type { ExecOptions } from '../../../util/exec/types.ts';
import { readLocalFile } from '../../../util/fs/index.ts';
import { regEx } from '../../../util/regex.ts';
import type { UpdateArtifact, UpdateArtifactsResult } from '../types.ts';
import {
  artifactErrorResult,
  resolveToolConstraint,
  updateLockFile,
} from '../util.ts';
import { getLockFileName } from './extract.ts';

const lockSuffix = regEx(/\.lock\.json$/);

async function siblingConfigName(
  lockFileName: string,
  packageFileName: string,
): Promise<string | null> {
  const directory = upath.dirname(lockFileName);
  const baseName = upath.basename(lockFileName).replace(lockSuffix, '');
  const yamlName = upath.join(directory, `${baseName}.yaml`);
  const ymlName = upath.join(directory, `${baseName}.yml`);
  const yaml = await readLocalFile(yamlName, 'utf8');
  const yml = await readLocalFile(ymlName, 'utf8');
  if (packageFileName === ymlName && yml) {
    return ymlName;
  }
  if (yaml) {
    return yamlName;
  }
  if (yml) {
    return ymlName;
  }
  return null;
}

async function regenerateLock(
  lockFileName: string,
  configFileName: string,
  packageFileName: string,
  newPackageFileContent: string,
  constraint: string | undefined,
): Promise<UpdateArtifactsResult[] | null> {
  const existingLockFileContent = await readLocalFile(lockFileName, 'utf8');
  if (!existingLockFileContent) {
    logger.debug(`No ${lockFileName} found`);
    return null;
  }

  const execOptions: ExecOptions = {
    cwdFile: configFileName,
    docker: {},
    toolConstraints: [{ toolName: 'apko', constraint }],
  };
  try {
    return await updateLockFile({
      lockFileName,
      existingLockFileContent,
      packageFile: { path: packageFileName, contents: newPackageFileContent },
      run: () =>
        exec(`apko lock ${quote(upath.basename(configFileName))}`, execOptions),
    });
  } catch (err) {
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }
    logger.debug({ err, packageFile: packageFileName }, 'apko lock failed');
    return artifactErrorResult(lockFileName, err);
  }
}

export async function updateArtifacts({
  packageFileName,
  updatedDeps,
  newPackageFileContent,
  config,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  if (!isNonEmptyArray(updatedDeps) && !config.isLockFileMaintenance) {
    return null;
  }

  const constraint = await resolveToolConstraint(config, 'apko');
  if (config.lockFiles?.length) {
    const results: UpdateArtifactsResult[] = [];
    for (const lockFileName of config.lockFiles) {
      const configFileName = await siblingConfigName(
        lockFileName,
        packageFileName,
      );
      if (!configFileName) {
        continue;
      }
      const updated = await regenerateLock(
        lockFileName,
        configFileName,
        packageFileName,
        newPackageFileContent,
        constraint,
      );
      if (updated) {
        results.push(...updated);
      }
    }
    return results.length ? results : null;
  }

  return regenerateLock(
    getLockFileName(packageFileName),
    packageFileName,
    packageFileName,
    newPackageFileContent,
    constraint,
  );
}
