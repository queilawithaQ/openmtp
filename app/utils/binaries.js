'use strict';

import path from 'path';
import { init as nbindInit } from 'nbind';
import { remote } from 'electron';
import { getPlatform } from './getPlatform';
import { IS_PROD } from '../constants/env';
import { PATHS } from './paths';
import { isPackaged } from './isPackaged';

const { root } = PATHS;
const { getAppPath } = remote.app;

const binariesPath =
  IS_PROD && isPackaged
    ? path.join(path.dirname(getAppPath()), '..', './Resources', './bin')
    : path.join(root, './resources', getPlatform(), './bin');

export const mtp = path.resolve(path.join(binariesPath, './mtp-cli'));

const nativeModulePath =
  IS_PROD && isPackaged
    ? path.join(path.dirname(getAppPath()), '..', 'Resources', 'bin')
    : path.join(root, 'resources', getPlatform(), 'native-addons', 'mtp');

export const mtpNativeModule = nbindInit(nativeModulePath).lib;
