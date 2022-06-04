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

	fileName: string | undefined;
	asString: string | undefined;

	isValid: boolean;
	isRelevant: boolean;
	errorMessage: string | undefined;
	yaml: {any: any} | undefined;
	inputFiles: Array<string> | undefined;
	from: string | undefined;
	filters: Array<string> | undefined;

	constructor(previewPanel: PreviewPanel) {
		this.previewPanel = previewPanel;
		this.extension = previewPanel.extension;
		this.cwd = previewPanel.cwd;
		this.isValid = false;
		this.isRelevant = false;
	}

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
		this.filters = undefined;
		if (!currentPreviewDefaultsString || !currentPreviewDefaultsString.trim()) {
			this.isValid = true;
			this.previewPanel.fileNames = [this.previewPanel.currentFileName];
			this.previewPanel.previousFileName = undefined;
			this.previewPanel.fromFormat = this.extension.config.pandoc.fromFormat;
			return;
		}
		if (currentPreviewDefaultsString !== this.asString) {
			try {
				[this.yaml, this.inputFiles, this.from, this.filters] = this.loadYAML(currentPreviewDefaultsString);
			} catch (e) {
				if (!this.previewPanel.panel) {
					return;
				}
				this.errorMessage = `Failed to process config "${currentPreviewDefaultsPath}":\n${e}`;
				this.showErrorMessage();
				return;
			}
			this.asString = currentPreviewDefaultsString;
		}
		this.fileName = currentPreviewDefaultsFileName;
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

	loadYAML(dataString: string) : [{any: any} | undefined,	Array<string> | undefined, string | undefined, Array<string> | undefined] {
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
		let maybeInputFiles: any = undefined;
		if (maybeData.hasOwnProperty('input-files')) {
			maybeInputFiles = maybeData['input-files'];
			if (!Array.isArray(maybeInputFiles) || maybeInputFiles.length === 0) {
				throw new Error('Key "input-files" must map to a list of strings');
			}
			for (const x of maybeInputFiles) {
				if (typeof(x) !== 'string') {
					throw new Error('Key "input-files" must map to a list of strings');
				}
				if (!/^[^\\\\/]+$/.test(x)) {
					throw new Error('Key "input-files" must map to a list of file names in the document directory');
				}
			}
		}
		let maybeInputFile: any = undefined;
		if (maybeData.hasOwnProperty('input-file')) {
			maybeInputFile = maybeData['input-file'];
			if (typeof(maybeInputFile) !== 'string') {
				throw new Error('Key "input-file" must map to a string');
			}
		}
		if (maybeInputFile && maybeInputFiles) {
			throw new Error('Cannot have both keys "input-files" and "input-file"');
		}
		let inputFiles: Array<string> | undefined;
		if (maybeInputFiles) {
			inputFiles = [];
			for (const inputFile of maybeInputFiles) {
				inputFiles.push(vscode.Uri.file(path.join(this.cwd, inputFile)).fsPath);
			}
		} else if (maybeInputFile) {
			inputFiles = [vscode.Uri.file(path.join(this.cwd, maybeInputFile)).fsPath];
		}
		let maybeFrom: any = undefined;
		if (maybeData.hasOwnProperty('from')) {
			maybeFrom = maybeData['from'];
			if (typeof(maybeFrom) !== 'string') {
				throw new Error('Key "from" must map to a string');
			}
			if (!/^[a-z_]+(?:[+-][a-z_]+)*$/.test(maybeFrom)) {
				throw new Error('Key "from" has incorrect value');
			}
		}
		let from: string | undefined = maybeFrom;
		let maybeFilters: any = undefined;
		if (maybeData.hasOwnProperty('filters')) {
			maybeFilters = maybeData['filters'];
			if (!Array.isArray(maybeFilters) || maybeFilters.length === 0) {
				throw new Error('Key "filters" must map to an array of strings');
			}
			for (const x of maybeFilters) {
				if (typeof(x) !== 'string' || !x) {
					throw new Error('Key "filters" must map to an array of strings');
				}
				if (/[ "';&|~$]/.test(x)) {
					throw new Error(`Unsupported character in filter name: "${x}"`);
				}
			}
		}
		return [maybeData, inputFiles, from, maybeFilters];
	}

};
