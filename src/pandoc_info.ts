// Copyright (c) 2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { VersionArray, versionToString, versionIsAtLeast } from './util';


const minPandocVersionRecommended: VersionArray = [3, 1, 1];
const minPandocVersionCodebraidWrappers: VersionArray = [3, 1, 1];

export type PandocInfo = {
	executable: string,
	extraEnv: {[key: string]: string},
	defaultDataDir: string | undefined;
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

export async function getPandocInfo(config: vscode.WorkspaceConfiguration) : Promise<PandocInfo | null | undefined> {
	// Any quoting of executable is supplied by user in config
	const executable = config.pandoc.executable;
	const extraEnv = config.pandoc.extraEnv;
	const args = ['--version'];
	const maybeVersionAndDataDir = await new Promise<[VersionArray, string | undefined] | null | undefined>((resolve) => {
		child_process.execFile(executable, args, {shell: true, encoding: 'utf8'}, (error, stdout, stderr) => {
			if (error) {
				resolve(undefined);
			} else {
				let versionMatch = /(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?(?!\d)/.exec(stdout);
				if (!versionMatch) {
					resolve(null);
				} else {
					const major = Number(versionMatch[1]);
					const minor = Number(versionMatch[2]);
					const patch = Number(versionMatch[3]) || 0;
					const build = Number(versionMatch[4]) || 0;
					const version: VersionArray = [major, minor, patch];
					if (build > 0) {
						version.push(build);
					}
					let dataDirMatch = /User data directory:\s+(\S[^\r\n]*)\r?\n/.exec(stdout);
					if (!dataDirMatch) {
						resolve([version, undefined]);
					} else {
						let dataDir: string | undefined = dataDirMatch[1].replaceAll('\\', '/');
						if (dataDir.match(/[\\`^$%"']/)) {
							dataDir = undefined;
						}
						resolve([version, dataDir]);
					}
				}
			}
		});
	}).catch((reason: any) => {return undefined;});
	if (!maybeVersionAndDataDir) {
		return maybeVersionAndDataDir;
	}
	const version = maybeVersionAndDataDir[0];
	const defaultDataDir = maybeVersionAndDataDir[1];
	const pandocInfo = {
		executable: executable,
		extraEnv: extraEnv,
		defaultDataDir: defaultDataDir,
		version: version,
		versionString: versionToString(version),
		major: version[0],
		minor: version[1],
		patch: version[2],
		build: version.length < 4 ? undefined : version[3],
		minVersionRecommended: minPandocVersionRecommended,
		minVersionRecommendedString: versionToString(minPandocVersionRecommended),
		isMinVersionRecommended: versionIsAtLeast(version, minPandocVersionRecommended),
		supportsCodebraidWrappers: versionIsAtLeast(version, minPandocVersionCodebraidWrappers),
	};
	return pandocInfo;
}
