// Copyright (c) 2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as child_process from 'child_process';
import { VersionArray, versionToString, versionIsAtLeast } from './util';


const minPandocVersionRecommended: VersionArray = [3, 1, 1];
const minPandocVersionCodebraidWrappers: VersionArray = [3, 1, 1];

export type PandocVersionInfo = {
	version: VersionArray,
	versionString: string,
	major: number,
	minor: number,
	patch: number,
	build: number | undefined,
	minVersionRecommended: VersionArray,
	minVersionRecommendedString: string,
	isMinVersionRecommended: boolean,
	supportsCodebraidWrappers: boolean,
} | null | undefined;

export async function getPandocVersionInfo() : Promise<PandocVersionInfo | null | undefined> {
	const executable = 'pandoc';
	const args = ['--version'];
	const maybeVersion: VersionArray | null | undefined = await new Promise<VersionArray | null | undefined>((resolve) => {
		child_process.execFile(executable, args, {shell: true, encoding: 'utf8'}, (error, stdout, stderr) => {
			if (error) {
				resolve(undefined);
			} else {
				let match = /(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?(?!\d)/.exec(stdout);
				if (!match) {
					resolve(null);
				} else {
					const major = Number(match[1]);
					const minor = Number(match[2]);
					const patch = Number(match[3]) || 0;
					const build = Number(match[4]) || 0;
					const version: VersionArray = [major, minor, patch];
					if (build > 0) {
						version.push(build);
					}
					resolve(version);
				}
			}
		});
	}).catch((reason: any) => {return undefined;});
	if (!maybeVersion) {
		return maybeVersion;
	}
	const pandocVersionInfo = {
		version: maybeVersion,
		versionString: versionToString(maybeVersion),
		major: maybeVersion[0],
		minor: maybeVersion[1],
		patch: maybeVersion[2],
		build: maybeVersion.length < 4 ? undefined : maybeVersion[3],
		minVersionRecommended: minPandocVersionRecommended,
		minVersionRecommendedString: versionToString(minPandocVersionRecommended),
		isMinVersionRecommended: versionIsAtLeast(maybeVersion, minPandocVersionRecommended),
		supportsCodebraidWrappers: versionIsAtLeast(maybeVersion, minPandocVersionCodebraidWrappers),
	};
	return pandocVersionInfo;
}
