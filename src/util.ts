// Copyright (c) 2022-2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


export function countNewlines(text: string) {
	let newlines: number = 0;
	for (const c of text) {
		if (c === '\n') {
			newlines += 1;
		}
	}
	return newlines;
}


export class FileExtension {
	fullExtension: string;
	outerExtension: string;
	innerExtension: string;
	isDoubleExtension: boolean;

	constructor(fileName: string) {
		const match = fileName.match(this.fileNameExtensionRegex) || ['', '', '', ''];
		this.fullExtension = match[0];
		this.outerExtension = match[2];
		this.innerExtension = match[1];
		this.isDoubleExtension = Boolean(match[1]);
	}

	private fileNameExtensionRegex = /(\.[0-9a-z_]+(?:[+-][0-9a-z_]+)*)?(\.[0-9a-z_]+)$/;

	toString() : string {
		return `*${this.fullExtension}`;
	}
}


export type VersionArray = [number, number, number] | [number, number, number, number];

export function versionToString(version: VersionArray) : string {
	const major: number = version[0];
	const minor: number = version[1];
	const patch: number = version[2];
	let build: number | undefined;
	if (version.length === 4) {
		build = version[3];
	}
	let versionString: string = `${major}.${minor}.${patch}`;
	if (build) {
		versionString += `.${build}`;
	}
	return versionString;
}

export function versionIsAtLeast(version: VersionArray, minVersion: VersionArray) : boolean {
	let normalizedVersion: VersionArray;
	let normalizedMinVersion: VersionArray;
	if (version.length === minVersion.length) {
		normalizedVersion = version;
		normalizedMinVersion = minVersion;
	} else {
		normalizedVersion = [...version];
		while (normalizedVersion.length < 4) {
			normalizedVersion.push(0);
		}
		normalizedMinVersion = [...minVersion];
		while (normalizedMinVersion.length < 4) {
			normalizedMinVersion.push(0);
		}
	}
	for (let n = 0; n < normalizedVersion.length; n++) {
		if (normalizedVersion[n] < normalizedMinVersion[n]) {
			return false;
		}
		if (normalizedVersion[n] > normalizedMinVersion[n] || n === normalizedMinVersion.length - 1) {
			return true;
		}
	}
	return false;
}
