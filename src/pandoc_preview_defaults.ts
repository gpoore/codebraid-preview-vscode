// Copyright (c) 2022, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as vscode from 'vscode';

import * as path from 'path';
import * as yaml from 'js-yaml';

import type PreviewPanel from './preview_panel';
import type {ExtensionState} from './types';




export default class PandocPreviewDefaults {
	previewPanel: PreviewPanel;
	extension: ExtensionState;
	cwd: string;

	rawFileName: string | undefined;
	asString: string | undefined;

	isValid: boolean;
	isRelevant: boolean;
	errorMessage: string | undefined;
	yaml: {[key: string]: any} | undefined;
	inputFiles: Array<string> | undefined;
	from: string | undefined;
	fileScope: boolean | undefined;
	to: string | undefined;
	processedFileName: string | undefined;

	constructor(previewPanel: PreviewPanel) {
		this.previewPanel = previewPanel;
		this.extension = previewPanel.extension;
		this.cwd = previewPanel.cwd;
		this.isValid = false;
		this.isRelevant = false;
	}

	extractedKeys: Set<string> = new Set(['input-files', 'input-file', 'from', 'reader', 'to', 'writer', 'file-scope']);

	async update() {
		let currentPreviewDefaultsFile = this.extension.config.pandoc.previewDefaultsFile;
		let currentPreviewDefaultsPath = path.join(this.cwd, currentPreviewDefaultsFile);
		let currentPreviewDefaultsString: string | undefined;
		let currentPreviewDefaultsFileName: string | undefined;
		try {
			let currentPreviewDefaultsDocument = await vscode.workspace.openTextDocument(currentPreviewDefaultsPath);
			currentPreviewDefaultsFileName = currentPreviewDefaultsDocument.fileName;
			currentPreviewDefaultsString = currentPreviewDefaultsDocument.getText();
		} catch {
		}
		this.isValid = false;
		this.isRelevant = false;
		this.errorMessage = undefined;
		this.yaml = undefined;
		this.inputFiles = undefined;
		this.from = undefined;
		if (!currentPreviewDefaultsString || !currentPreviewDefaultsString.trim()) {
			this.isValid = true;
			this.previewPanel.fileNames = [this.previewPanel.currentFileName];
			this.previewPanel.previousFileName = undefined;
			this.previewPanel.fromFormat = this.extension.config.pandoc.fromFormat;
			return;
		}
		if (currentPreviewDefaultsString !== this.asString) {
			try {
				[this.yaml, this.inputFiles, this.from, this.fileScope, this.to] = this.loadYAML(currentPreviewDefaultsString);
			} catch (e) {
				if (!this.previewPanel.panel) {
					return;
				}
				this.errorMessage = `Failed to process config "${currentPreviewDefaultsPath}":\n${e}`;
				this.showErrorMessage();
				return;
			}
			const defaultsFileYaml: {[key: string]: any} = {...this.yaml};
			let keyCount: number = 0;
			Object.keys(defaultsFileYaml).forEach((key) => {
				if (this.extractedKeys.has(key)) {
					delete defaultsFileYaml[key];
				} else {
					keyCount += 1;
				}
			});
			if (keyCount > 0) {
				const processedDefaultsPath = path.join(this.cwd, '_codebraid', 'defaults', '_codebraid_preview.yaml');
				const processedDefaultsUri = vscode.Uri.file(processedDefaultsPath);
				const data = Buffer.from(yaml.dump(defaultsFileYaml), 'utf8');
				let oldData: Uint8Array | undefined = undefined;
				if (this.processedFileName === undefined) {
					try {
						oldData = await vscode.workspace.fs.readFile(processedDefaultsUri);
					} catch {
					}
				}
				if (oldData === undefined || data.compare(oldData) !== 0) {
					try {
						await new Promise<void>((resolve) => {
							resolve(vscode.workspace.fs.writeFile(processedDefaultsUri, data));
						});
					} catch (error) {
						this.errorMessage = `Saving defaults file failed:\n${error}`;
						this.showErrorMessage();
						return;
					}
				}
				this.processedFileName = processedDefaultsUri.fsPath;
			} else {
				this.processedFileName = undefined;
			}
			this.asString = currentPreviewDefaultsString;
		}
		this.rawFileName = currentPreviewDefaultsFileName;
		this.isValid = true;
		if (!this.inputFiles) {
			this.isRelevant = true;
			this.previewPanel.fileNames = [this.previewPanel.currentFileName];
			this.previewPanel.previousFileName = undefined;
		} else if (this.inputFiles.indexOf(this.previewPanel.currentFileName) !== -1) {
			this.isRelevant = true;
			this.previewPanel.fileNames = this.inputFiles;
			if (this.previewPanel.previousFileName) {
				if (this.previewPanel.fileNames.indexOf(this.previewPanel.previousFileName) === -1) {
					this.previewPanel.previousFileName = undefined;
				}
			}
		} else {
			this.previewPanel.fileNames = [this.previewPanel.currentFileName];
			this.previewPanel.previousFileName = undefined;
		}
		if (this.isRelevant && this.from) {
			this.previewPanel.fromFormat = this.from;
		} else {
			this.previewPanel.fromFormat = this.extension.config.pandoc.fromFormat;
		}
	}

	showErrorMessage() {
		if (this.errorMessage && this.previewPanel.panel) {
			vscode.window.showErrorMessage(this.errorMessage);
		}
	}

	loadYAML(dataString: string) : [{[key: string]: any}?, Array<string>?, string?, boolean?, string?] {
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
				inputFiles.push(vscode.Uri.file(path.join(this.cwd, inputFile)).fsPath);
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
		return [data, inputFiles, from, fileScope, to];
	}

};
