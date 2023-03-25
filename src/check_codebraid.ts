// Copyright (c) 2022, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as child_process from 'child_process';

import { VersionArray, versionIsAtLeast, versionToString } from './util';


const minCodebraidVersion: VersionArray = [0, 10, 3];
export const minCodebraidVersionString = versionToString(minCodebraidVersion);

const compatibleCodebraidPaths: Set<string> = new Set();




export async function checkCodebraidVersion(codebraidCommand: Array<string>) : Promise<boolean | null | undefined> {
	const codebraidPath = codebraidCommand.join(' ');
	if (compatibleCodebraidPaths.has(codebraidPath)) {
		return true;
	}
	const executable = codebraidCommand[0];
	const args = codebraidCommand.slice(1);
	args.push('--version');
	const status = await new Promise<boolean | null | undefined>((resolve) => {
		child_process.execFile(executable, args, {shell: true, encoding: 'utf8'}, (error, stdout, stderr) => {
			if (error) {
				resolve(undefined);
			} else {
				let match = /(?<!\d)(\d+)\.(\d+)\.(\d+)(?!\d)/.exec(stdout);
				if (!match) {
					resolve(null);
				} else {
					const major = Number(match[1]);
					const minor = Number(match[2]);
					const patch = Number(match[3]);
					const version: VersionArray = [major, minor, patch];
					resolve(versionIsAtLeast(version, minCodebraidVersion));
				}
			}
		});
	}).catch((reason: any) => {return undefined;});
	if (status) {
		compatibleCodebraidPaths.add(codebraidPath);
	}
	return status;
}
