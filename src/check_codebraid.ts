// Copyright (c) 2022, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as child_process from 'child_process';


const minVersion: [number, number, number] = [0, 7, 0];
const minMajor = minVersion[0];
const minMinor = minVersion[1];
const minPatch = minVersion[2];
export const minCodebraidVersion: string = `v${minMajor}.${minMinor}.${minPatch}`;

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
					let major = Number(match[1]);
					let minor = Number(match[2]);
					let patch = Number(match[3]);
					if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
						resolve(null);
					} else if (major > minMajor) {
						resolve(true);
					} else if (major === minMajor && minor > minMinor) {
						resolve(true);
					} else if (major === minMajor && minor === minMinor && patch >= minPatch) {
						resolve(true);
					} else {
						resolve(false);
					}
				}
			}
		});
	}).catch((reason: any) => {return undefined;});
	if (status) {
		compatibleCodebraidPaths.add(codebraidPath);
	}
	return status;
}
