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


export function hasCompatibleCodebraid() : boolean | undefined {
	let stdout: string;
	try {
		stdout = child_process.execFileSync('codebraid', ['--version'], {shell: true, encoding: 'utf8'});
	} catch {
		return undefined;
	}
	let match = /(?<!\d)(\d+)\.(\d+)\.(\d+)(?!\d)/.exec(stdout);
	if (!match) {
		return false;
	} else {
		let major = Number(match[1]);
		let minor = Number(match[2]);
		let patch = Number(match[3]);
		if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
			return false;
		} else if (major > minMajor) {
			return true;
		} else if (major === minMajor && minor > minMinor) {
			return true;
		} else if (major === minMajor && minor === minMinor && patch >= minPatch) {
			return true;
		} else {
			return false;
		}
	}
}
