'use strict';

/* eslint no-await-in-loop: off */

import {
  readdir as fsReaddir,
  rename as fsRename,
  existsSync,
  statSync,
  lstatSync
} from 'fs';
import Promise from 'bluebird';
import junk from 'junk';
import rimraf from 'rimraf';
import mkdirp from 'mkdirp';
import path from 'path';
import moment from 'moment';
import { exec } from 'child_process';
import findLodash from 'lodash/find';
import { log } from '../../utils/log';
import { mtp as _mtpCli } from '../../utils/binaries';

import { DEVICES_TYPE_CONST } from '../../constants';
import { baseName } from '../../utils/paths';
import {
  clearFileTransfer,
  fetchDirList,
  processMtpOutput,
  setFileTransferProgress
} from '../../containers/HomePage/actions';
import {
  niceBytes,
  percentage,
  splitIntoLines,
  isArray,
  undefinedOrNull
} from '../../utils/funcs';
import { msToTime, unixTimestampNow } from '../../utils/date';
import MTP_KERNEL from '../../../mtp-kernel';
import { MTP_ERROR_FLAGS } from '../../../mtp-kernel/mtp-error-flags';

const readdir = Promise.promisify(fsReaddir);
const execPromise = Promise.promisify(exec);

const mtpObj = new MTP_KERNEL();
let mountedMtpDevice = null;

/**
 * This hack is to support flex quotes parser for mtp cli.
 */
export const escapeShellMtp = cmd => {
  if (cmd.indexOf(`\\"`) !== -1 && cmd.indexOf(`"\\`) !== -1) {
    return cmd
      .replace(/`/g, '\\`')
      .replace(/\\/g, `\\\\\\\\`)
      .replace(/"/g, `\\\\\\"`);
  }
  if (cmd.indexOf(`"\\"`) !== -1) {
    return cmd
      .replace(/`/g, '\\`')
      .replace(/\\/g, `\\\\\\\\`)
      .replace(/"/g, `\\\\\\"`);
  }
  if (cmd.indexOf(`\\"`) !== -1) {
    return cmd
      .replace(/`/g, '\\`')
      .replace(/\\/g, `\\\\\\`)
      .replace(/"/g, `\\\\\\\\"`);
  }
  if (cmd.indexOf(`"\\`) !== -1) {
    return cmd
      .replace(/`/g, '\\`')
      .replace(/\\/g, `\\\\\\\\`)
      .replace(/"/g, `\\\\\\"`);
  }
  return cmd
    .replace(/`/g, '\\`')
    .replace(/\\/g, `\\\\\\`)
    .replace(/"/g, `\\\\\\"`);
};

const mtpCli = `${escapeShellMtp(_mtpCli)}`;

const filterJunkMtpErrors = string => {
  return (
    string === '\n' ||
    string === '\r\n' ||
    string === '' ||
    string.toLowerCase().indexOf(`device::find failed`) !== -1 ||
    string.toLowerCase().indexOf(`iocreateplugininterfaceforservice`) !== -1
  );
};

const cleanJunkMtpError = ({ error = null, stdout = null, stderr = null }) => {
  const splittedError = splitIntoLines(error);
  const filteredError = splittedError
    ? splittedError.filter(a => !filterJunkMtpErrors(a))
    : [];

  const splittedStderr = splitIntoLines(stderr);
  const filteredStderr = splittedStderr
    ? splittedStderr.filter(a => !filterJunkMtpErrors(a))
    : [];

  return {
    filteredError,
    filteredStderr,
    filteredStdout: stdout
  };
};

const promisifiedExec = command => {
  try {
    return new Promise(resolve => {
      execPromise(command, (error, stdout, stderr) => {
        const {
          filteredStderr,
          filteredError,
          filteredStdout
        } = cleanJunkMtpError({ error, stdout, stderr });

        if (
          (undefinedOrNull(filteredStderr) || filteredStderr.length < 1) &&
          (undefinedOrNull(filteredError) || filteredError.length < 1)
        ) {
          return resolve({
            data: filteredStdout,
            stderr: null,
            error: null
          });
        }

        return resolve({
          data: filteredStdout,
          stderr: filteredStderr.join('\n'),
          error: filteredError.join('\n')
        });
      });
    });
  } catch (e) {
    log.error(e);
  }
};

export const checkFileExists = async (filePath, deviceType) => {
  try {
    if (typeof filePath === 'undefined' || filePath === null) {
      return null;
    }

    let _isArray = false;
    if (isArray(filePath)) {
      _isArray = true;
    }

    let fullPath = null;
    switch (deviceType) {
      case DEVICES_TYPE_CONST.local:
        if (_isArray) {
          for (let i = 0; i < filePath.length; i += 1) {
            const item = filePath[i];
            fullPath = path.resolve(item);
            if (await existsSync(fullPath)) {
              return true;
            }
          }
          return null;
        }

        fullPath = path.resolve(filePath);
        return await existsSync(fullPath);

      case DEVICES_TYPE_CONST.mtp:
        if (_isArray) {
          for (let i = 0; i < filePath.length; i += 1) {
            const item = filePath[i];
            fullPath = path.resolve(item);
            const {
              error: checkMtpFileExistsError,
              data: checkMtpFileExistsData
            } = await checkMtpFileExists(fullPath);

            if (checkMtpFileExistsError) {
              return null;
            }

            if (checkMtpFileExistsData) {
              return true;
            }
          }
          return null;
          // eslint-disable-next-line no-else-return
        } else {
          fullPath = path.resolve(filePath);

          const {
            error: checkMtpFileExistsError,
            data: checkMtpFileExistsData
          } = await checkMtpFileExists(fullPath);

          if (checkMtpFileExistsError) {
            return null;
          }

          if (checkMtpFileExistsData) {
            return true;
          }
        }

        return null;

      default:
        break;
    }

    return true;
  } catch (e) {
    log.error(e);
  }
};

/**
  Local device ->
 */
export const asyncReadLocalDir = async ({ filePath, ignoreHiddenFiles }) => {
  try {
    const response = [];
    const { error, data } = await readdir(filePath, 'utf8')
      .then(res => {
        return {
          data: res,
          error: null
        };
      })
      .catch(e => {
        return {
          data: null,
          error: e
        };
      });

    if (error) {
      log.error(error, `asyncReadLocalDir`);
      return { error: true, data: null };
    }

    let files = data;

    files = data.filter(junk.not);
    if (ignoreHiddenFiles) {
      // eslint-disable-next-line no-useless-escape
      files = data.filter(item => !/(^|\/)\.[^\/\.]/g.test(item));
    }

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const fullPath = path.resolve(filePath, file);

      if (!existsSync(fullPath)) {
        continue; // eslint-disable-line no-continue
      }
      const stat = statSync(fullPath);
      const isFolder = lstatSync(fullPath).isDirectory();
      const extension = path.extname(fullPath);
      const { size, atime: dateTime } = stat;

      if (findLodash(response, { path: fullPath })) {
        continue; // eslint-disable-line no-continue
      }

      response.push({
        name: file,
        path: fullPath,
        extension,
        size,
        isFolder,
        dateAdded: moment(dateTime).format('YYYY-MM-DD HH:mm:ss')
      });
    }
    return { error, data: response };
  } catch (e) {
    log.error(e);
  }
};

export const promisifiedRimraf = item => {
  try {
    return new Promise(resolve => {
      rimraf(item, {}, error => {
        resolve({
          data: null,
          stderr: error,
          error
        });
      });
    });
  } catch (e) {
    log.error(e);
  }
};

export const delLocalFiles = async ({ fileList }) => {
  try {
    if (!fileList || fileList.length < 1) {
      return {
        error: MTP_ERROR_FLAGS.NO_FILES_SELECTED,
        stderr: null,
        data: null
      };
    }

    for (let i = 0; i < fileList.length; i += 1) {
      const item = fileList[i];
      const { error } = await promisifiedRimraf(item);
      if (error) {
        log.error(`${error}`, `delLocalFiles -> rm error`);
        return { error, stderr: null, data: false };
      }
    }

    return { error: null, stderr: null, data: true };
  } catch (e) {
    log.error(e);
  }
};

const promisifiedRename = ({ oldFilePath, newFilePath }) => {
  try {
    return new Promise(resolve => {
      fsRename(oldFilePath, newFilePath, error => {
        resolve({
          data: null,
          stderr: error,
          error
        });
      });
    });
  } catch (e) {
    log.error(e);
  }
};

export const renameLocalFiles = async ({ oldFilePath, newFilePath }) => {
  try {
    if (
      typeof oldFilePath === 'undefined' ||
      oldFilePath === null ||
      typeof newFilePath === 'undefined' ||
      newFilePath === null
    ) {
      return {
        error: MTP_ERROR_FLAGS.NO_FILES_SELECTED,
        stderr: null,
        data: null
      };
    }

    const { error } = await promisifiedRename({ oldFilePath, newFilePath });
    if (error) {
      log.error(`${error}`, `renameLocalFiles -> mv error`);
      return { error, stderr: null, data: false };
    }

    return { error: null, stderr: null, data: true };
  } catch (e) {
    log.error(e);
  }
};

const promisifiedMkdir = ({ newFolderPath }) => {
  try {
    return new Promise(resolve => {
      mkdirp(newFolderPath, error => {
        resolve({ data: null, stderr: error, error });
      });
    });
  } catch (e) {
    log.error(e);
  }
};

export const newLocalFolder = async ({ newFolderPath }) => {
  try {
    if (typeof newFolderPath === 'undefined' || newFolderPath === null) {
      return { error: `Invalid path.`, stderr: null, data: null };
    }

    const { error } = await promisifiedMkdir({ newFolderPath });
    if (error) {
      log.error(`${error}`, `newLocalFolder -> mkdir error`);
      return { error, stderr: null, data: false };
    }

    return { error: null, stderr: null, data: true };
  } catch (e) {
    log.error(e);
  }
};

/**
 MTP device ->
 */

/**
 *
 * Detect MTP
 */
export const mtpInit = async () => {
  mtpObj.init();

  const { error, data } = await mtpObj.detectMtp();

  if (error) {
    log.error(error, `mtpInit`, false);

    mountedMtpDevice = null;
    return { error, data: null };
  }

  mountedMtpDevice = data;

  return {
    error: null,
    data
  };
};

const verifyMountedMtpDevice = async () => {
  if (!mountedMtpDevice) {
    const { error: mtpInitError } = await mtpInit();

    if (mtpInitError) {
      log.error(mtpInitError, `mountedMtpDevice`, false);

      return { error: mtpInitError, data: null };
    }
  }

  return { error: null, data: null };
};

export const fetchMtpStorageOptions = async ({ ...args }) => {
  try {
    const {
      error: verifyMountedMtpDeviceError
    } = await verifyMountedMtpDevice();

    if (verifyMountedMtpDeviceError) {
      return { error: verifyMountedMtpDeviceError, data: null };
    }

    const {
      error: setStorageDevicesError,
      data
    } = await mtpObj.setStorageDevices({ ...args });

    if (setStorageDevicesError) {
      log.error(setStorageDevicesError, `fetchMtpStorageOptions`, false);

      return { error: setStorageDevicesError, data: null };
    }

    if (typeof data === 'undefined') {
      mountedMtpDevice = null;

      return { error: MTP_ERROR_FLAGS.NO_MTP, data: null };
    }

    return { error: null, data };
  } catch (e) {
    log.error(e);
  }
};

const checkMtpFileExists = async filePath => {
  try {
    const {
      error: verifyMountedMtpDeviceError
    } = await verifyMountedMtpDevice();
    if (verifyMountedMtpDeviceError) {
      return { error: verifyMountedMtpDeviceError, data: null };
    }

    if (undefinedOrNull(filePath)) {
      return {
        error: MTP_ERROR_FLAGS.INVALID_PATH,
        data: null
      };
    }

    const { error, data } = await mtpObj.fileExists({
      filePath
    });

    if (error) {
      if (error === MTP_ERROR_FLAGS.INVALID_NOT_FOUND) {
        return { error: null, data: false };
      }

      log.error(error, `checkMtpFileExists -> error`);
      return { error, data: false };
    }

    if (typeof data === 'undefined') {
      mountedMtpDevice = null;

      return { error: MTP_ERROR_FLAGS.NO_MTP, data: false };
    }

    return { error: null, data: true };
  } catch (e) {
    log.error(e);
  }
};

export const asyncReadMtpDir = async ({
  ignoreHiddenFiles,
  filePath = '/'
}) => {
  try {
    const {
      error: verifyMountedMtpDeviceError
    } = await verifyMountedMtpDevice();
    if (verifyMountedMtpDeviceError) {
      return { error: verifyMountedMtpDeviceError, data: null };
    }

    const {
      error: listMtpFileTreeError,
      data: listMtpFileTreeData
    } = await mtpObj.listMtpFileTree({
      folderPath: filePath,
      recursive: false,
      ignoreHiddenFiles
    });
    if (listMtpFileTreeError) {
      log.error(listMtpFileTreeError, `asyncReadMtpDir`, false);

      return { error: listMtpFileTreeError, data: null };
    }

    if (typeof listMtpFileTreeData === 'undefined') {
      mountedMtpDevice = null;

      return { error: MTP_ERROR_FLAGS.NO_MTP, data: null };
    }

    return { error: null, data: listMtpFileTreeData };
  } catch (e) {
    log.error(e);
  }
};

export const renameMtpFiles = async ({ oldFilePath, newFilePath }) => {
  try {
    const {
      error: verifyMountedMtpDeviceError
    } = await verifyMountedMtpDevice();
    if (verifyMountedMtpDeviceError) {
      return { error: verifyMountedMtpDeviceError, data: null };
    }

    if (undefinedOrNull(oldFilePath) || undefinedOrNull(newFilePath)) {
      return {
        error: MTP_ERROR_FLAGS.NO_FILES_SELECTED,
        data: null
      };
    }

    const { error, data } = await mtpObj.renameFile({
      filePath: oldFilePath,
      newfileName: baseName(newFilePath)
    });

    if (error) {
      log.error(error, `renameMtpFiles -> error`);
      return { error, data: false };
    }

    if (typeof data === 'undefined') {
      mountedMtpDevice = null;

      return { error: MTP_ERROR_FLAGS.NO_MTP, data: false };
    }

    return { error: null, data: true };
  } catch (e) {
    log.error(e);
  }
};

export const delMtpFiles = async ({ fileList }) => {
  try {
    const {
      error: verifyMountedMtpDeviceError
    } = await verifyMountedMtpDevice();
    if (verifyMountedMtpDeviceError) {
      return { error: verifyMountedMtpDeviceError, data: null };
    }

    if (!fileList || fileList.length < 1) {
      return { error: MTP_ERROR_FLAGS.NO_FILES_SELECTED, data: null };
    }

    for (let i = 0; i < fileList.length; i += 1) {
      const { error, data } = await mtpObj.deleteFile({
        filePath: fileList[i]
      });

      if (error) {
        log.error(error, `delMtpDir -> error`);
        return { error, data: false };
      }

      if (typeof data === 'undefined') {
        mountedMtpDevice = null;

        return { error: MTP_ERROR_FLAGS.NO_MTP, data: false };
      }
    }

    return { error: null, data: true };
  } catch (e) {
    log.error(e);
  }
};

export const newMtpFolder = async ({ newFolderPath }) => {
  try {
    const {
      error: verifyMountedMtpDeviceError
    } = await verifyMountedMtpDevice();
    if (verifyMountedMtpDeviceError) {
      return { error: verifyMountedMtpDeviceError, data: null };
    }

    if (undefinedOrNull(newFolderPath)) {
      return { error: MTP_ERROR_FLAGS.INVALID_PATH, data: null };
    }

    const { error, data } = await mtpObj.createFolder({
      newFolderPath
    });

    if (error) {
      log.error(error, `newMtpFolder -> error`);
      return { error, data: false };
    }

    if (typeof data === 'undefined') {
      mountedMtpDevice = null;

      return { error: MTP_ERROR_FLAGS.NO_MTP, data: false };
    }

    return { error: null, data: true };
  } catch (e) {
    log.error(e);
  }
};

export const pasteFiles = async (
  { ...pasteArgs },
  { ...fetchDirListArgs },
  direction,
  deviceType,
  dispatch,
  getState,
  getCurrentWindow
) => {
  try {
    const { destinationFolder, fileTransferClipboard } = pasteArgs;

    if (undefinedOrNull(destinationFolder)) {
      dispatch(
        processMtpOutput({
          deviceType,
          error: MTP_ERROR_FLAGS.INVALID_PATH,
          data: null,
          callback: () => {
            dispatch(
              fetchDirList({ ...fetchDirListArgs }, deviceType, getState)
            );
          }
        })
      );
    }

    const { queue } = fileTransferClipboard;

    if (undefinedOrNull(queue) || queue.length < 1) {
      dispatch(
        processMtpOutput({
          deviceType,
          error: MTP_ERROR_FLAGS.NO_FILES_SELECTED,
          stderr: null,
          data: null,
          callback: () => {
            dispatch(
              fetchDirList({ ...fetchDirListArgs }, deviceType, getState)
            );
          }
        })
      );
    }

    let listMtpFileTree = {};

    switch (direction) {
      case 'localtoMtp':
        // eslint-disable-next-line no-case-declarations
        listMtpFileTree = await pasteLocalToMtp(
          { ...pasteArgs },
          deviceType,
          dispatch,
          getState,
          getCurrentWindow
        );
        break;
      case 'mtpToLocal':
        // eslint-disable-next-line no-case-declarations
        listMtpFileTree = await pasteMtpToLocal(
          { ...pasteArgs },
          deviceType,
          dispatch,
          getState,
          getCurrentWindow
        );
        break;
      default:
        break;
    }

    dispatch(
      processMtpOutput({
        deviceType,
        error: listMtpFileTree.error,
        data: null,
        callback: () => {
          dispatch(fetchDirList({ ...fetchDirListArgs }, deviceType, getState));
        }
      })
    );
  } catch (e) {
    log.error(e);
  }
};

const pasteMtpToLocal = async (
  { ...pasteArgs },
  deviceType,
  dispatch,
  getState,
  getCurrentWindow
) => {
  const { destinationFolder, fileTransferClipboard } = pasteArgs;
  const { queue } = fileTransferClipboard;

  let prevCopiedBlockSize = 0;
  let currentCopiedBlockSize = 0;
  let prevCopiedTime = 0;
  let currentCopiedTime = 0;

  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    const {
      error: listMtpFileTreeError,
      data: listMtpFileTreeData
    } = await mtpObj.listMtpFileTree({
      folderPath: item,
      recursive: true
    });

    if (listMtpFileTreeError) {
      log.error(listMtpFileTreeError, `pasteFiles -> listMtpFileTreeError`);
      return { error: listMtpFileTreeError, data: false };
    }

    dispatch(
      setFileTransferProgress({
        toggle: true,
        bodyText1: `Current file: ${path.basename(item)}`,
        bodyText2: '',
        percentage: percentage(i, queue[i].length - 1)
      })
    );

    const {
      error: downloadFileTreeError,
      data: downloadFileTreeData
    } = await mtpObj.downloadFileTree({
      rootNode: true,
      nodes: listMtpFileTreeData,
      destinationFilePath: path.join(destinationFolder, path.basename(item)),
      // eslint-disable-next-line no-loop-func
      callback: ({ sent: currentProgressSize, total: totalFileSize }) => {
        const startTime = 0;
        const perc = percentage(currentProgressSize, totalFileSize);
        currentCopiedBlockSize = totalFileSize - currentProgressSize;
        currentCopiedTime = unixTimestampNow();

        const copiedTimeDiff = currentCopiedTime - prevCopiedTime;

        if (copiedTimeDiff >= 1000) {
          const speed =
            prevCopiedBlockSize &&
            prevCopiedBlockSize - currentCopiedBlockSize > 0
              ? (prevCopiedBlockSize - currentCopiedBlockSize) *
                (1000 / copiedTimeDiff)
              : 0;
          // eslint-disable-next-line no-unused-vars
          const _speed = speed ? `${niceBytes(speed)}` : `--`;
          // eslint-disable-next-line no-unused-vars
          const elapsedTime = msToTime(currentCopiedTime - startTime);
          prevCopiedTime = currentCopiedTime;
          prevCopiedBlockSize = currentCopiedBlockSize;

          getCurrentWindow().setProgressBar(perc / 100);
        }
      }
    });

    if (downloadFileTreeError) {
      log.error(downloadFileTreeError, `pasteFiles -> downloadFileTreeError`);
      closeFileTransferProgressWindow(
        deviceType,
        dispatch,
        getState,
        getCurrentWindow
      );
      return { error: downloadFileTreeError, data: false };
    }

    if (!downloadFileTreeData) {
      log.error(downloadFileTreeError, `pasteFiles -> downloadFileTreeData`);
      closeFileTransferProgressWindow(
        deviceType,
        dispatch,
        getState,
        getCurrentWindow
      );

      return { error: MTP_ERROR_FLAGS.DOWNLOAD_FILE_FAILED, data: false };
    }
  }
  closeFileTransferProgressWindow(
    deviceType,
    dispatch,
    getState,
    getCurrentWindow
  );

  return { error: null, data: true };
};

const pasteLocalToMtp = async (
  { ...pasteArgs },
  deviceType,
  dispatch,
  getState,
  getCurrentWindow
) => {
  const { destinationFolder, fileTransferClipboard } = pasteArgs;
  const { queue } = fileTransferClipboard;

  let prevCopiedBlockSize = 0;
  let currentCopiedBlockSize = 0;
  let prevCopiedTime = 0;
  let currentCopiedTime = 0;

  dispatch(
    setFileTransferProgress({
      toggle: true,
      bodyText1: `Please wait...`,
      bodyText2: `Sit back and relax... This might take some time`,
      percentage: 0
    })
  );

  return new Promise(resolve => {
    setTimeout(async _ => {
      for (let i = 0; i < queue.length; i += 1) {
        const item = queue[i];
        const {
          error: listLocalFileTreeError,
          data: listLocalFileTreeData
        } = await mtpObj.listLocalFileTree({
          filePath: item,
          recursive: true
        });

        if (listLocalFileTreeError) {
          log.error(
            listLocalFileTreeError,
            `pasteFiles -> listMtpFileTreeError`
          );
          return resolve({
            error: listLocalFileTreeError,
            data: false
          });
        }

        const {
          error: uploadFileTreeError,
          data: uploadFileTreeData
        } = await mtpObj.uploadFileTree({
          rootNode: true,
          nodes: listLocalFileTreeData,
          destinationFilePath: path.join(
            destinationFolder,
            path.basename(item)
          ),
          // eslint-disable-next-line no-loop-func
          callback: ({ sent: currentProgressSize, total: totalFileSize }) => {
            const startTime = 0;
            const perc = percentage(currentProgressSize, totalFileSize);
            currentCopiedBlockSize = totalFileSize - currentProgressSize;
            currentCopiedTime = unixTimestampNow();

            const copiedTimeDiff = currentCopiedTime - prevCopiedTime;

            if (copiedTimeDiff >= 1000) {
              const speed =
                prevCopiedBlockSize &&
                prevCopiedBlockSize - currentCopiedBlockSize > 0
                  ? (prevCopiedBlockSize - currentCopiedBlockSize) *
                    (1000 / copiedTimeDiff)
                  : 0;
              // eslint-disable-next-line no-unused-vars
              const _speed = speed ? `${niceBytes(speed)}` : `--`;
              // eslint-disable-next-line no-unused-vars
              const elapsedTime = msToTime(currentCopiedTime - startTime);
              prevCopiedTime = currentCopiedTime;
              prevCopiedBlockSize = currentCopiedBlockSize;

              getCurrentWindow().setProgressBar(perc / 100);
            }
          }
        });

        if (uploadFileTreeError) {
          log.error(uploadFileTreeError, `pasteFiles -> uploadFileTreeError`);
          closeFileTransferProgressWindow(
            deviceType,
            dispatch,
            getState,
            getCurrentWindow
          );
          return resolve({ error: uploadFileTreeError, data: false });
        }

        if (!uploadFileTreeData) {
          log.error(uploadFileTreeError, `pasteFiles -> uploadFileTreeData`);
          closeFileTransferProgressWindow(
            deviceType,
            dispatch,
            getState,
            getCurrentWindow
          );

          return resolve({
            error: MTP_ERROR_FLAGS.DOWNLOAD_FILE_FAILED,
            data: false
          });
        }
      }
      closeFileTransferProgressWindow(
        deviceType,
        dispatch,
        getState,
        getCurrentWindow
      );

      return resolve({ error: null, data: true });
    }, 1000);
  });
};

const closeFileTransferProgressWindow = (
  deviceType,
  dispatch,
  getState,
  getCurrentWindow
) => {
  getCurrentWindow().setProgressBar(-1);
  dispatch(clearFileTransfer());
};

export const mtpVerboseReport = async () => {
  try {
    const { data, error, stderr } = await promisifiedExec(`${mtpCli} "pwd" -v`);

    if (error) {
      log.doLog(`${error}`);
      return { error, stderr, data: null };
    }
    if (stderr) {
      log.doLog(`${stderr}`);
      return { error, stderr, data: null };
    }

    return { error: null, stderr: null, data };
  } catch (e) {
    log.error(e);
  }
};
