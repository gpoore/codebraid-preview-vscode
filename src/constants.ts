// Copyright (c) 2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as os from 'os';
import * as process from 'process';


export const homedir = os.homedir();
export const isWindows = process.platform === 'win32';
