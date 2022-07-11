// Copyright (c) 2022, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as vscode from 'vscode';

import * as yaml from 'js-yaml';

import type PreviewPanel from './preview_panel';
import type {ExtensionState} from './types';


type PandocDefaultsYaml = {
	yaml: {[key: string]: any} | undefined;
	inputFiles: Array<string> | undefined;
	from: string | undefined;
	fileScope: boolean | undefined;
	to: string | undefined;
};


export default class PandocPreviewDefaults {
	previewPanel: PreviewPanel;
	extension: ExtensionState;
	cwdUri: vscode.Uri;

	fileName: string | undefined;
	asString: string | undefined;

	isValid: boolean;
	errorMessage: string | undefined;
	lastWrittenDefaultsBytes: Uint8Array | undefined;

	isUpdating: boolean;

	constructor(previewPanel: PreviewPanel) {
		this.previewPanel = previewPanel;
		this.extension = previewPanel.extension;
		this.cwdUri = vscode.Uri.file(previewPanel.cwd);
		this.isValid = false;
		this.isUpdating = false;
	}

	extractedKeys: Set<string> = new Set(['input-files', 'input-file', 'from', 'reader', 'to', 'writer', 'file-scope']);

	async update() {
		while (this.isUpdating) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			if (!this.previewPanel.panel) {
				return;
			}
		}
		this.isUpdating = true;

		let pandocDefaultsYaml: PandocDefaultsYaml | undefined;
		const defaultsUri = vscode.Uri.joinPath(this.cwdUri, this.extension.config.pandoc.previewDefaultsFile);
		this.fileName = defaultsUri.fsPath;
		let defaultsBytes: Uint8Array | undefined;
		let defaultsString: string | undefined;

		try {
			defaultsBytes = await vscode.workspace.fs.readFile(defaultsUri);
		} catch {
		}
		if (!this.previewPanel.panel) {
			this.isUpdating = false;
			return;
		}
		if (!defaultsBytes) {
			this.isValid = true;
			this.errorMessage = undefined;
			this.asString = undefined;
			this.previewPanel.onPandocPreviewDefaultsInvalidNotRelevant();
			this.isUpdating = false;
			return;
		}

		try {
			defaultsString = Buffer.from(defaultsBytes).toString('utf8');
		} catch (error) {
			this.isValid = false;
			this.errorMessage = `Failed to decode defaults file "${this.extension.config.pandoc.previewDefaultsFile}":\n${error}`;
			this.showErrorMessage();
			this.asString = undefined;
			this.previewPanel.onPandocPreviewDefaultsInvalidNotRelevant();
			this.isUpdating = false;
			return;
		}
		if (defaultsString === this.asString) {
			this.isUpdating = false;
			return;
		}

		try {
			pandocDefaultsYaml = this.loadPandocDefaultsYaml(defaultsString);
		} catch (error) {
			this.isValid = false;
			this.errorMessage = `Failed to load defaults file "${this.fileName}":\n${error}`;
			this.showErrorMessage();
			this.asString = undefined;
			this.previewPanel.onPandocPreviewDefaultsInvalidNotRelevant();
			this.isUpdating = false;
			return;
		}
		const processedDefaultsData: {[key: string]: any} = {...pandocDefaultsYaml.yaml};
		let keyCount: number = 0;
		Object.keys(processedDefaultsData).forEach((key) => {
			if (this.extractedKeys.has(key)) {
				delete processedDefaultsData[key];
			} else {
				keyCount += 1;
			}
		});
		let processedDefaultsFileName: string | undefined;
		if (keyCount > 0) {
			const processedDefaultsUri = vscode.Uri.joinPath(this.cwdUri, '_codebraid', 'defaults', '_codebraid_preview.yaml');
			processedDefaultsFileName = processedDefaultsUri.fsPath;
			const dataBytes = Buffer.from(yaml.dump(processedDefaultsData), 'utf8');
			let oldDataBytes: Uint8Array | undefined;
			if (this.lastWrittenDefaultsBytes === undefined) {
				try {
					oldDataBytes = await vscode.workspace.fs.readFile(processedDefaultsUri);
				} catch {
				}
				if (!this.previewPanel.panel) {
					this.isUpdating = false;
					return;
				}
			} else {
				oldDataBytes = this.lastWrittenDefaultsBytes;
			}
			if (oldDataBytes === undefined || dataBytes.compare(oldDataBytes) !== 0) {
				try {
					await Promise.resolve(vscode.workspace.fs.writeFile(processedDefaultsUri, dataBytes));
				} catch (error) {
					this.isValid = false;
					this.errorMessage = `Saving temp defaults file failed:\n${error}`;
					this.showErrorMessage();
					this.asString = undefined;
					this.previewPanel.onPandocPreviewDefaultsInvalidNotRelevant();
					this.isUpdating = false;
					return;
				}
				if (!this.previewPanel.panel) {
					this.isUpdating = false;
					return;
				}
			}
			this.lastWrittenDefaultsBytes = dataBytes;
		}
		this.isValid = true;
		this.errorMessage = undefined;
		this.asString = defaultsString;
		let isRelevant: boolean = false;
		if (!pandocDefaultsYaml.inputFiles) {
			isRelevant = true;
			this.previewPanel.fileNames = [this.previewPanel.currentFileName];
			this.previewPanel.previousFileName = undefined;
		} else if (pandocDefaultsYaml.inputFiles.indexOf(this.previewPanel.currentFileName) !== -1) {
			isRelevant = true;
			this.previewPanel.fileNames = pandocDefaultsYaml.inputFiles;
			if (this.previewPanel.previousFileName) {
				if (this.previewPanel.fileNames.indexOf(this.previewPanel.previousFileName) === -1) {
					this.previewPanel.previousFileName = undefined;
				}
			}
		}
		if (isRelevant) {
			this.previewPanel.defaultsFileName = processedDefaultsFileName;
			if (pandocDefaultsYaml.from !== undefined) {
				this.previewPanel.fromFormat = pandocDefaultsYaml.from;
			}
			if (pandocDefaultsYaml.fileScope !== undefined) {
				this.previewPanel.fileScope = pandocDefaultsYaml.fileScope;
			}
			if (pandocDefaultsYaml.to !== undefined) {
				this.previewPanel.toFormat = pandocDefaultsYaml.to;
			}
		} else {
			this.previewPanel.onPandocPreviewDefaultsInvalidNotRelevant();
		}
		this.isUpdating = false;
	}

	showErrorMessage() {
		if (this.errorMessage && this.previewPanel.panel) {
			vscode.window.showErrorMessage(this.errorMessage);
		}
	}

	loadPandocDefaultsYaml(dataString: string) : PandocDefaultsYaml {
		if (dataString.charCodeAt(0) === 0xFEFF) {
			// Drop BOM
			dataString = dataString.slice(1);
		}
		let maybeData: any;
		try {
			maybeData = yaml.load(dataString);
		} catch (e) {
			// yaml.YAMLException
			throw new Error(`Failed to load YAML:\n${e}`);
		}
		if (typeof(maybeData) !== 'object' || maybeData === null || Array.isArray(maybeData)) {
			throw new Error('Top level of YAML must be an associative array (that is, a map/dict/hash)');
		}
		Object.keys(maybeData).forEach((key) => {
			if (typeof(key) !== 'string') {
				throw new Error('Top level of YAML must have string keys');
			}
		});
		const data: {[key: string]: any} = maybeData;
		let maybeInputFiles: any = undefined;
		for (const key of ['input-files', 'input-file']) {
			if (data.hasOwnProperty(key)) {
				if (maybeInputFiles !== undefined) {
					throw new Error('Cannot have both keys "input-files" and "input-file"');
				}
				if (key === 'input-files') {
					maybeInputFiles = data[key];
					if (!Array.isArray(maybeInputFiles) || maybeInputFiles.length === 0) {
						throw new Error('Key "input-files" must map to a list of strings');
					}
				} else {
					maybeInputFiles = [data[key]];
				}
				for (const x of maybeInputFiles) {
					if (typeof(x) !== 'string') {
						if (key === 'input-files') {
							throw new Error('Key "input-files" must map to a list of strings');
						} else {
							throw new Error('Key "input-file" must map to a string');
						}
					}
					if (!/^[^\\/]+$/.test(x)) {
						if (key === 'input-files') {
							throw new Error('Key "input-files" must map to a list of file names in the document directory');
						} else {
							throw new Error('Key "input-file" must map to a file name in the document directory');
						}
					}
				}
			}
		}
		let inputFiles: Array<string> | undefined;
		if (maybeInputFiles) {
			inputFiles = [];
			for (const inputFile of maybeInputFiles) {
				inputFiles.push(vscode.Uri.joinPath(this.cwdUri, inputFile).fsPath);
			}
		}
		let maybeFrom: any = undefined;
		for (const key of ['from', 'reader']) {
			if (data.hasOwnProperty(key)) {
				if (maybeFrom !== undefined) {
					throw new Error('Cannot define both keys "from" and "reader"');
				}
				maybeFrom = data[key];
				if (typeof(maybeFrom) !== 'string') {
					throw new Error(`Key "${key}" must map to a string`);
				}
				if (!/^[a-z_]+(?:[+-][a-z_]+)*$/.test(maybeFrom)) {
					throw new Error(`Key "${key}" has incorrect value (expect <format><extensions>)`);
				}
			}
		}
		const from: string | undefined = maybeFrom;
		let maybeFileScope: any = undefined;
		if (data.hasOwnProperty('file-scope')) {
			maybeFileScope = data['file-scope'];
			if (typeof(maybeFileScope) !== 'boolean') {
				throw new Error('Key "file-scope" must map to a boolean');
			}
		}
		const fileScope: boolean | undefined = maybeFileScope;
		let maybeTo: any = undefined;
		for (const key of ['to', 'writer']) {
			if (data.hasOwnProperty(key)) {
				if (maybeTo !== undefined) {
					throw new Error('Cannot define both keys "to" and "writer"');
				}
				maybeTo = data[key];
				if (typeof(maybeTo) !== 'string') {
					throw new Error(`Key "${key}" must map to a string`);
				}
				if (!/^[a-z_]+(?:[+-][a-z_]+)*$/.test(maybeTo)) {
					throw new Error(`Key "${key}" has incorrect value (expect <format><extensions>)`);
				}
			}
		}
		const to: string | undefined = maybeTo;
		return {
			yaml: data,
			inputFiles: inputFiles,
			from: from,
			fileScope: fileScope,
			to: to
		};
	}

};
