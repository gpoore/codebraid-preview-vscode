// Copyright (c) 2022-2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as vscode from 'vscode';

import * as path from 'path';
import * as yaml from 'js-yaml';

import type PreviewPanel from './preview_panel';
import type { ExtensionState } from './types';
import CodebraidPreviewError from './err';
import { processedDefaultsRelativeFileName } from './pandoc_settings';
import { pandocBuiltinReaderWriterRegex, PandocReader, PandocWriter } from './pandoc_util';


type PandocDefaultsYamlData = {
	yaml: {[key: string]: any} | undefined;
	inputFiles: Array<string> | undefined;
	hasReader: boolean;
	extractedReader: PandocReader | undefined;
	embeddedReader: PandocReader | null | undefined;
	rawReaderString: string | undefined;
	fileScope: boolean | undefined;
	hasWriter: boolean;
	extractedWriter: PandocWriter | undefined;
	embeddedWriter: PandocWriter | null | undefined;
	rawWriterString: string | undefined;
	needsBuildConfig: boolean;
};


export class PandocDefaultsFile implements vscode.Disposable {
	private previewPanel: PreviewPanel;
	private extension: ExtensionState;
	private cwdUri: vscode.Uri;

	isRelevant: boolean;
	fileName: string | undefined;
	data: PandocDefaultsYamlData | undefined;
	private lastReadDefaultsBytes: Uint8Array | undefined;
	private lastWrittenDefaultsBytes: Uint8Array | undefined;
	processedFileName: string | undefined;

	private isDisposed: boolean;
	private isUpdating: boolean;
	private scheduledUpdateTimer: NodeJS.Timer | undefined;

	constructor(previewPanel: PreviewPanel) {
		this.previewPanel = previewPanel;
		this.extension = previewPanel.extension;
		this.cwdUri = vscode.Uri.file(previewPanel.cwd);

		this.isRelevant = false;

		this.isDisposed = false;
		this.isUpdating = false;
	}

	dispose() {
		if (this.scheduledUpdateTimer) {
			clearTimeout(this.scheduledUpdateTimer);
			this.scheduledUpdateTimer = undefined;
		}
		this.isDisposed = true;
	}

	private extractedKeys: Set<string> = new Set(['input-files', 'input-file', 'file-scope']);
	private readerKeys: Set<string> = new Set(['from', 'reader']);
	private writerKeys: Set<string> = new Set(['to', 'writer']);
	private prohibitedKeys: Set<string> = new Set(['output-file', 'standalone']);

	async update(callback?: () => void) {
		if (this.isDisposed) {
			return;
		}
		if (this.isUpdating) {
			if (this.scheduledUpdateTimer) {
				clearTimeout(this.scheduledUpdateTimer);
			}
			this.scheduledUpdateTimer = setTimeout(
				() => {
					this.scheduledUpdateTimer = undefined;
					this.update(callback);
				},
				100,
			);
		}

		this.isUpdating = true;

		let defaultsBaseName: string;
		// Deal with deprecated setting
		const deprecatedDefaultsFile = this.extension.config.pandoc.previewDefaultsFile;
		const defaultsFile = this.extension.config.pandoc.defaultsFile;
		if (defaultsFile === '_codebraid_preview.yaml' && typeof(deprecatedDefaultsFile) === 'string' && deprecatedDefaultsFile && deprecatedDefaultsFile !== defaultsFile) {
			defaultsBaseName = deprecatedDefaultsFile;
		} else {
			defaultsBaseName = defaultsFile;
		}
		const defaultsUri = vscode.Uri.joinPath(this.cwdUri, defaultsBaseName);
		this.fileName = defaultsUri.fsPath;

		let defaultsBytes: Uint8Array | undefined;
		try {
			defaultsBytes = await vscode.workspace.fs.readFile(defaultsUri);
		} catch {
		}
		if (this.isDisposed) {
			this.reset();
			this.isUpdating = false;
			return;
		}
		if (!defaultsBytes) {
			this.reset();
			this.isUpdating = false;
			if (callback) {
				callback();
			}
			return;
		}
		if (defaultsBytes === this.lastReadDefaultsBytes) {
			this.isUpdating = false;
			if (callback) {
				callback();
			}
			return;
		}

		let defaultsString: string | undefined;
		try {
			defaultsString = Buffer.from(defaultsBytes).toString('utf8');
		} catch (error) {
			vscode.window.showErrorMessage(
				`Defaults file "${path.basename(this.fileName)}" could not be decoded so it will be ignored:\n${error}`
			);
			this.reset();
			this.isUpdating = false;
			if (callback) {
				callback();
			}
			return;
		}

		let yamlData: PandocDefaultsYamlData;
		try {
			yamlData = this.loadPandocDefaultsYamlData(defaultsString);
		} catch (error) {
			vscode.window.showErrorMessage(
				`Defaults file "${path.basename(this.fileName)}" is invalid so it will be ignored:\n${error}`
			);
			this.reset();
			this.isUpdating = false;
			if (callback) {
				callback();
			}
			return;
		}

		if (yamlData.embeddedWriter !== undefined) {
			// Custom writers will need a separate temp file for export that
			// omits the writer, and possibly other modifications.
			vscode.window.showErrorMessage([
				`Defaults file "${path.basename(this.fileName)}" has custom writer "${yamlData.rawWriterString}".`,
				`Custom writers are not yet supported, so this will be ignored.`,
			].join(' '));
			yamlData.hasWriter = false;
			yamlData.embeddedWriter = undefined;
			yamlData.rawWriterString = undefined;
		}

		const processedYamlData: {[key: string]: any} = {...yamlData.yaml};
		let keyCount: number = 0;
		Object.keys(processedYamlData).forEach((key) => {
			if (this.extractedKeys.has(key)) {
				delete processedYamlData[key];
			} else if (this.readerKeys.has(key) && yamlData.extractedReader) {
				delete processedYamlData[key];
			} else if (this.writerKeys.has(key) && yamlData.extractedWriter) {
				delete processedYamlData[key];
			} else {
				keyCount += 1;
			}
		});
		let processedFileName: string | undefined;
		if (keyCount > 0) {
			const processedDefaultsUri = vscode.Uri.joinPath(this.cwdUri, processedDefaultsRelativeFileName);
			processedFileName = processedDefaultsUri.fsPath;
			const dataBytes = Buffer.from(yaml.dump(processedYamlData), 'utf8');
			let oldDataBytes: Uint8Array | undefined;
			if (this.lastWrittenDefaultsBytes === undefined) {
				try {
					oldDataBytes = await vscode.workspace.fs.readFile(processedDefaultsUri);
				} catch {
				}
				if (this.isDisposed) {
					this.reset();
					this.isUpdating = false;
					return;
				}
			} else {
				oldDataBytes = this.lastWrittenDefaultsBytes;
			}
			if (oldDataBytes === undefined || dataBytes.compare(oldDataBytes) !== 0) {
				try {
					await vscode.workspace.fs.writeFile(processedDefaultsUri, dataBytes);
				} catch (error) {
					vscode.window.showErrorMessage(
						`Defaults file "${path.basename(this.fileName)}" could not be converted into a temp file so it will be ignored:\n${error}`
					);
					this.reset();
					this.isUpdating = false;
					if (callback) {
						callback();
					}
					return;
				}
				if (this.isDisposed) {
					this.reset();
					this.isUpdating = false;
					return;
				}
			}
			this.lastWrittenDefaultsBytes = dataBytes;
		}
		this.processedFileName = processedFileName;
		this.data = yamlData;

		if (!yamlData.inputFiles) {
			this.isRelevant = true;
		} else if (yamlData.inputFiles.indexOf(this.previewPanel.currentFileName) !== -1) {
			this.isRelevant = true;
		}

		this.isUpdating = false;
		if (callback) {
			callback();
		}
	}

	private reset() {
		this.isRelevant = false;
		this.fileName = undefined;
		this.data = undefined;
		this.lastReadDefaultsBytes = undefined;
		this.lastWrittenDefaultsBytes = undefined;
		this.processedFileName = undefined;
	}

	private loadPandocDefaultsYamlData(dataString: string) : PandocDefaultsYamlData {
		if (dataString.charCodeAt(0) === 0xFEFF) {
			// Drop BOM
			dataString = dataString.slice(1);
		}
		let maybeData: any;
		try {
			maybeData = yaml.load(dataString);
		} catch (error) {
			// yaml.YAMLException
			throw new CodebraidPreviewError(`Failed to load YAML:\n${error}`);
		}
		if (typeof(maybeData) !== 'object' || maybeData === null || Array.isArray(maybeData)) {
			throw new CodebraidPreviewError('Top level of YAML must be an associative array (that is, a map/dict/hash)');
		}
		Object.keys(maybeData).forEach((key) => {
			if (typeof(key) !== 'string') {
				throw new CodebraidPreviewError('Top level of YAML must have string keys');
			}
			if (this.prohibitedKeys.has(key)) {
				throw new CodebraidPreviewError(`Key "${key}" is not supported`);
			}
		});
		const data: {[key: string]: any} = maybeData;
		let maybeInputFiles: any = undefined;
		for (const key of ['input-files', 'input-file']) {
			if (data.hasOwnProperty(key)) {
				if (maybeInputFiles !== undefined) {
					throw new CodebraidPreviewError('Cannot have both keys "input-files" and "input-file"');
				}
				if (key === 'input-files') {
					maybeInputFiles = data[key];
					if (!Array.isArray(maybeInputFiles) || maybeInputFiles.length === 0) {
						throw new CodebraidPreviewError('Key "input-files" must map to a list of strings');
					}
				} else {
					maybeInputFiles = [data[key]];
				}
				for (const x of maybeInputFiles) {
					if (typeof(x) !== 'string') {
						if (key === 'input-files') {
							throw new CodebraidPreviewError('Key "input-files" must map to a list of strings');
						} else {
							throw new CodebraidPreviewError('Key "input-file" must map to a string');
						}
					}
					if (!/^[^\\/]+$/.test(x)) {
						if (key === 'input-files') {
							throw new CodebraidPreviewError('Key "input-files" must map to a list of file names in the document directory');
						} else {
							throw new CodebraidPreviewError('Key "input-file" must map to a file name in the document directory');
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
		let maybeReader: any = undefined;
		for (const key of this.readerKeys) {
			if (data.hasOwnProperty(key)) {
				if (maybeReader !== undefined) {
					throw new CodebraidPreviewError(
						`Cannot define more than one of ${Array.from(this.readerKeys).map(k => `"${k}"`).join(', ')}`
					);
				}
				maybeReader = data[key];
				if (typeof(maybeReader) !== 'string' || maybeReader === '') {
					throw new CodebraidPreviewError(`Key "${key}" must map to a non-empty string`);
				}
			}
		}
		const hasReader: boolean = maybeReader !== undefined;
		let extractedReader: PandocReader | undefined;
		let embeddedReader: PandocReader | null | undefined;
		if (hasReader) {
			if (pandocBuiltinReaderWriterRegex.test(maybeReader)) {
				extractedReader = new PandocReader(maybeReader, this.extension.context);
			} else {
				// Custom definitions may not fit expected patterns
				try {
					embeddedReader = new PandocReader(maybeReader, this.extension.context);
				} catch {
					embeddedReader = null;
				}
			}
		}
		let maybeFileScope: any = undefined;
		if (data.hasOwnProperty('file-scope')) {
			maybeFileScope = data['file-scope'];
			if (typeof(maybeFileScope) !== 'boolean') {
				throw new CodebraidPreviewError('Key "file-scope" must map to a boolean');
			}
		}
		const fileScope: boolean | undefined = maybeFileScope;
		let maybeWriter: any = undefined;
		for (const key of this.writerKeys) {
			if (data.hasOwnProperty(key)) {
				if (maybeWriter !== undefined) {
					throw new CodebraidPreviewError(
						`Cannot define more than one of ${Array.from(this.writerKeys).map(k => `"${k}"`).join(', ')}`
					);
				}
				maybeWriter = data[key];
				if (typeof(maybeWriter) !== 'string' || maybeWriter === '') {
					throw new CodebraidPreviewError(`Key "${key}" must map to a string`);
				}
			}
		}
		const hasWriter: boolean = maybeWriter !== undefined;
		let extractedWriter: PandocWriter | undefined;
		let embeddedWriter: PandocWriter | null | undefined;
		if (hasWriter) {
			if (pandocBuiltinReaderWriterRegex.test(maybeWriter)) {
				extractedWriter = new PandocWriter(maybeWriter);
			} else {
				// Custom definitions may not fit expected patterns
				try {
					embeddedWriter = new PandocWriter(maybeWriter);
				} catch {
					embeddedWriter = null;
				}
			}
		}
		return {
			yaml: data,
			inputFiles: inputFiles,
			hasReader: hasReader,
			extractedReader: extractedReader,
			embeddedReader: embeddedReader,
			rawReaderString: maybeReader,
			fileScope: fileScope,
			hasWriter: hasWriter,
			extractedWriter: extractedWriter,
			embeddedWriter: embeddedWriter,
			rawWriterString: maybeWriter,
			needsBuildConfig: !(hasReader && hasWriter),
		};
	}

};
