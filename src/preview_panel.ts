// Copyright (c) 2022, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as vscode from 'vscode';

import * as child_process from 'child_process';
import * as path from 'path';
import * as yaml from 'js-yaml';

import type { ExtensionState } from './types';




export default class PreviewPanel implements vscode.Disposable {
	// `PreviewPanel` interacts extensively with `vscode.TextEditor` and
	// `vscode.TextDocument`.  It is important to realize that editor and
	// document states do not necessarily correspond to typical user
	// descriptions.  For example, `document.isClosed` describes an internal
	// state that can be triggered by switching tabs so that a document is not
	// visible.  It does not describe whether a tab that displays a document
	// exists anywhere in the current VS Code window.  Relevant links:
	//   * https://code.visualstudio.com/api/references/vscode-api
	//   * https://github.com/microsoft/vscode/issues/15178
	//   * https://github.com/microsoft/vscode/issues/15723
	//   * https://github.com/microsoft/vscode/issues/21617
	//   * https://github.com/microsoft/vscode/issues/33728
	//

	// Class
	// -----
	disposables: vscode.Disposable[];

	// Extension
	// ---------
	extension: ExtensionState;
	_onDisposeExtensionCallback?: () => void;

	// Files
	// -----
	cwd: string;
	// All file paths associated with the document that contain document text,
	// typically paths for Markdown files.  That is, all paths excluding
	// config, data, media, and so forth.  For a single-file document, this is
	// just obtained from `editor.document.fileName` at preview launch.  For
	// multi-file documents, file names are obtained using
	// `codebraid.preview.pandoc.previewDefaultsFile` in extension config,
	// which defaults to `_codebraid_preview.yaml`.  If this file exists in
	// the directory of the document that launches preview, it is read and
	// checked for the key `input-files`.  If this key exists and the list of
	// `input-files` includes the document that launched the preview, then the
	// list is used to define the file paths for the document.  Note that file
	// names are stored in an `Array` rather than a `Set` to allow for a
	// single file to be included multiple times.
	fileNames: Array<string>;
	// Track visible editor that is relevant.
	visibleEditor: vscode.TextEditor | undefined;
	// Track recent visible files to determine which visible editor to sync
	// with.  It may be worth tracking `viewColumn` as well eventually.
	currentFileName: string | undefined;
	previousFileName: string | undefined;
	// Pandoc defaults type: <exists_valid> | <exists_invalid> | <none>
	pandocpreviewDefaults: {[key: string]: any} | null | undefined;
	// In addition to the most the recent Pandoc defaults, keep the file name
	// and the raw string from the defaults file to detect changes and avoid
	// unnecessary YAML loading.
	pandocpreviewDefaultsFileName: string | undefined;
	pandocpreviewDefaultsString: string | undefined;

	// Display
	// -------
	panel: vscode.WebviewPanel;
	resourceWebviewUris: Record<string, vscode.Uri>;
	resourcePaths: Record<string, string>;
	baseTag: string;
	contentSecurityOptions: Record<string, Array<string>>;
	contentSecurityTag: string;
	codebraidPreviewJsTag: string;
	sourceSupportsScrollSync: boolean;
	isScrollingEditorWithPreview: boolean;
	isScrollingEditorWithPreviewTimer: NodeJS.Timer | undefined;
	scrollSyncOffset: number;
	scrollSyncMap: Map<string, [number, number]> | undefined;
	scrollSyncMapMaxLine: number;

	// Subprocess
	// ----------
	pandocArgs: Array<string>;
	codebraidArgs: Array<string>;
	buildProcessOptions: child_process.ExecFileOptions;
	lastBuildTime: number;
	needsBuild: boolean;
	buildIsScheduled: boolean;
	buildIsInProgress: boolean;
	codebraidProcess: child_process.ChildProcess | undefined;
	usingCodebraid: boolean;

	constructor(editor: vscode.TextEditor, extension: ExtensionState) {
		this.disposables = [];

		this.extension = extension;

		this.cwd = path.dirname(editor.document.uri.fsPath);
		this.fileNames = [];
		this.fileNames.push(editor.document.fileName);
		this.visibleEditor = editor;
		this.currentFileName = editor.document.fileName;
		vscode.window.onDidChangeActiveTextEditor(
			this.onDidChangeActiveTextEditor,
			this,
			this.disposables
		);
		vscode.window.onDidChangeVisibleTextEditors(
			this.onDidChangeVisibleTextEditors,
			this,
			this.disposables
		);

		this.panel = vscode.window.createWebviewPanel(
			'codebraidPreview', // Type
			'Codebraid Preview', // Panel title
			vscode.ViewColumn.Beside, // Editor column
			{   // Options
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.file(this.cwd),
					vscode.Uri.file(this.extension.context.asAbsolutePath('node_modules/katex/dist')),
					vscode.Uri.file(this.extension.context.asAbsolutePath('media')),
					vscode.Uri.file(this.extension.context.asAbsolutePath('scripts')),
				],
			}
		);
		this.disposables.push(this.panel);
		// Cleanup may be triggered by the webview panel being closed.  Since
		// `retainContextWhenHidden` is true, the panel won't be disposed when
		// it isn't visible.
		this.panel.onDidDispose(
			() => {this.dispose();},
			this,
			this.disposables
		);
		this.resourceWebviewUris = {
			katex: this.panel.webview.asWebviewUri(
				vscode.Uri.file(this.extension.context.asAbsolutePath('node_modules/katex/dist'))
			),
			vscodeCss: this.panel.webview.asWebviewUri(
				vscode.Uri.file(this.extension.context.asAbsolutePath('media/vscode-markdown.css'))
			),
			codebraidCss: this.panel.webview.asWebviewUri(
				vscode.Uri.file(this.extension.context.asAbsolutePath('media/codebraid-preview.css'))
			),
			codebraidPreviewJs: this.panel.webview.asWebviewUri(
				vscode.Uri.file(this.extension.context.asAbsolutePath('scripts/codebraid-preview.js'))
			),
		};
		this.resourcePaths = {
			pandocSourcePosLuaFilter: this.extension.context.asAbsolutePath('scripts/pandoc-sourcepos-sync.lua'),
		};
		this.baseTag = `<base href="${this.panel.webview.asWebviewUri(vscode.Uri.file(this.cwd))}/">`;
		this.contentSecurityOptions = {
			'style-src': [`${this.panel.webview.cspSource}`, `'unsafe-inline'`,],
			'font-src': [`${this.panel.webview.cspSource}`],
			'img-src': [`${this.panel.webview.cspSource}`],
			'script-src': [`${this.panel.webview.cspSource}`, `'unsafe-inline'`],
		};
		let contentSecurityContent: Array<string> = [];
		for (let src in this.contentSecurityOptions) {
			contentSecurityContent.push(`${src} ${this.contentSecurityOptions[src].join(' ')};`);
		}
		this.contentSecurityTag = [
			`<meta http-equiv="Content-Security-Policy"`,
			`content="default-src 'none';`,
			contentSecurityContent.join(' '),
			`">`
		].join(' ');
		this.codebraidPreviewJsTag = `<script type="module" src="${this.resourceWebviewUris.codebraidPreviewJs}"></script>`;
		this.sourceSupportsScrollSync = false;
		this.isScrollingEditorWithPreview = false;
		this.scrollSyncOffset = 0;
		this.scrollSyncMapMaxLine = 0;
		this.showUpdatingMessage();

		this.pandocArgs = [
			`--standalone`,
			`--lua-filter="${this.resourcePaths.pandocSourcePosLuaFilter}"`,
			`--css=${this.resourceWebviewUris.vscodeCss}`,
			`--css=${this.resourceWebviewUris.codebraidCss}`,
			`--katex=${this.resourceWebviewUris.katex}/`,
			`--to=html`,
		];
		this.codebraidArgs = ['pandoc'];
		this.buildProcessOptions = {
			maxBuffer: 1024*1024*16, // = <default>*16 = 16_777_216 bytes
			cwd: this.cwd,
			shell: true // not ideal, but consistently 2-5x faster
		};
		this.lastBuildTime = 0;
		this.needsBuild = true;
		this.buildIsScheduled = false;
		this.buildIsInProgress = false;
		this.codebraidProcess = undefined;
		this.usingCodebraid = false;

		vscode.workspace.onDidChangeTextDocument(
			this.onDidChangeTextDocument,
			this,
			this.disposables
		);

		vscode.window.onDidChangeTextEditorVisibleRanges(
			this.onDidChangeTextEditorVisibleRanges,
			this,
			this.disposables
		);

		this.panel.webview.onDidReceiveMessage(
			this.onDidReceiveMessage,
			this,
			this.disposables
		);

		this.update(() => this.onDidChangePreviewEditor(editor));
	}

	registerOnDisposeCallback(callback: () => void) {
		this._onDisposeExtensionCallback = callback;
	}

	dispose() {
		while (true) {
			let disposable = this.disposables.pop();
			if (disposable) {
				disposable.dispose();
			} else {
				break;
			}
		}
		if (this._onDisposeExtensionCallback) {
			this._onDisposeExtensionCallback();
		}
	}

	formatMessage(title: string, message: string) {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	${this.baseTag}
	${this.contentSecurityTag}
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${this.resourceWebviewUris.vscodeCss}">
	<link rel="stylesheet" href="${this.resourceWebviewUris.codebraidCss}">
	<style>
	body {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: space-around;
	}
	</style>
	<title>${title}</title>
</head>
<body>
<div>
${message}
</div>
</body>
</html>`;
	}

	showUpdatingMessage() {
		this.panel.webview.html = this.formatMessage(
			'Updating Codebraid Preview...',
			'<h1>Updating Codebraid Preview...</h1>'
		);
	}

	convertStringToLiteralHtml(s: string) {
		return s.replace('&', '&amp;')
				.replace('<', '&lt;')
				.replace('>', '&gt;')
				.replace('"', '&quot;')
				.replace("'", '&apos;');
	}

	onDidChangeActiveTextEditor(editor: vscode.TextEditor | undefined) {
		if (!editor) {
			this.onDidChangeVisibleTextEditors(vscode.window.visibleTextEditors);
			return;
		}
		if (editor.document.uri.scheme !== 'file' || this.fileNames.indexOf(editor.document.fileName) === -1) {
			this.onDidChangeVisibleTextEditors(vscode.window.visibleTextEditors);
			return;
		}
		this.visibleEditor = editor;
		if (editor.document.fileName !== this.currentFileName) {
			this.previousFileName = this.currentFileName;
			this.currentFileName = editor.document.fileName;
		}
		this.onDidChangePreviewEditor(editor);
	}

	onDidChangeVisibleTextEditors(editors: readonly vscode.TextEditor[]) {
		this.visibleEditor = undefined;
		for (let editor of editors) {
			if (editor.document.uri.scheme === 'file' && editor.document.fileName === this.currentFileName) {
				this.visibleEditor = editor;
				this.onDidChangePreviewEditor(editor);
				return;
			}
		}
		if (this.fileNames.length === 1) {
			return;
		}
		if (this.previousFileName) {
			for (let editor of editors) {
				if (editor.document.uri.scheme === 'file' && editor.document.fileName === this.previousFileName) {
					this.visibleEditor = editor;
					this.currentFileName = this.previousFileName;
					this.previousFileName = undefined;
					this.onDidChangePreviewEditor(editor);
					return;
				}
			}
		}
		for (let editor of editors) {
			if (editor.document.uri.scheme === 'file' && this.fileNames.indexOf(editor.document.fileName) !== -1) {
				this.visibleEditor = editor;
				this.previousFileName = this.currentFileName;
				this.currentFileName = editor.document.fileName;
				this.onDidChangePreviewEditor(editor);
				return;
			}
		}
	}

	onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent) {
		if (event.contentChanges.length !== 0 && event.document.uri.scheme === 'file') {
			if (this.fileNames.indexOf(event.document.fileName) !== -1) {
				this.update();
			} else if (event.document.fileName === this.pandocpreviewDefaultsFileName) {
				this.update();
			}
		}
	}

	onDidChangeTextEditorVisibleRanges(event: vscode.TextEditorVisibleRangesChangeEvent) {
		if (event.visibleRanges.length === 0 || this.isScrollingEditorWithPreview) {
			return;
		}
		let document = event.textEditor.document;
		if (document.uri.scheme === 'file' && document.fileName === this.currentFileName) {
			if (!this.sourceSupportsScrollSync) {
				return;
			}
			if (this.extension.statusBarConfig.scrollPreviewWithEditor !== undefined) {
				if (!this.extension.statusBarConfig.scrollPreviewWithEditor) {
					return;
				}
			} else if (!this.extension.config.scrollPreviewWithEditor) {
				return;
			}
			let startLine = event.visibleRanges[0].start.line + 1;  // Webview is one-indexed
			if (this.scrollSyncMap) {
				let fileStartEndLine = this.scrollSyncMap.get(document.fileName);
				if (fileStartEndLine) {
					startLine += fileStartEndLine[0] - 1;
				} else {
					return;
				}
			}
			startLine += this.scrollSyncOffset;
			this.panel.webview.postMessage(
				{
					command: 'codebraidPreview.scrollPreview',
					start: startLine,
				}
			);
		}
	}

	onDidChangePreviewEditor(editor: vscode.TextEditor) {
		// Scroll preview when switching to a new editor for the first time.
		if (this.isScrollingEditorWithPreview) {
			return;
		}
		if (!this.sourceSupportsScrollSync) {
			return;
		}
		if (this.extension.statusBarConfig.scrollPreviewWithEditor !== undefined) {
			if (!this.extension.statusBarConfig.scrollPreviewWithEditor) {
				return;
			}
		} else if (!this.extension.config.scrollPreviewWithEditor) {
			return;
		}
		let startLine = editor.visibleRanges[0].start.line + 1;  // Webview is one-indexed
		if (this.scrollSyncMap) {
			let fileStartEndLine = this.scrollSyncMap.get(editor.document.fileName);
			if (fileStartEndLine) {
				startLine += fileStartEndLine[0] - 1;
			} else {
				return;
			}
		}
		startLine += this.scrollSyncOffset;
		this.panel.webview.postMessage(
			{
				command: 'codebraidPreview.scrollPreview',
				start: startLine,
			}
		);
	}

	async onDidReceiveMessage(message: any) {
		switch (message.command) {
			case 'codebraidPreview.scrollEditor': {
				if (!this.visibleEditor || !this.sourceSupportsScrollSync) {
					return;
				}
				if (this.extension.statusBarConfig.scrollEditorWithPreview !== undefined) {
					if (!this.extension.statusBarConfig.scrollEditorWithPreview) {
						return;
					}
				} else if (!this.extension.config.scrollEditorWithPreview) {
					return;
				}
				this.isScrollingEditorWithPreview = true;
				let scrollStartLine: number = message.start - this.scrollSyncOffset;
				if (this.scrollSyncMap) {
					let scrollFileName = undefined;
					for (const [fileName, [fileStartLine, fileEndLine]] of this.scrollSyncMap) {
						if (fileStartLine <= scrollStartLine && scrollStartLine <= fileEndLine) {
							scrollFileName = fileName;
							scrollStartLine -= fileStartLine - 1;
							break;
						}
					}
					if (scrollFileName) {
						let column = this.visibleEditor.viewColumn;
						let document = await vscode.workspace.openTextDocument(scrollFileName);
						let editor = await vscode.window.showTextDocument(document, column);
						this.visibleEditor = editor;
					}
				}
				scrollStartLine -= 1; // Webview is one-indexed
				if (scrollStartLine < 0) {
					return;
				}
				let range = new vscode.Range(scrollStartLine, 0, scrollStartLine, 0);
				this.visibleEditor.revealRange(range, vscode.TextEditorRevealType.AtTop);
				if (this.isScrollingEditorWithPreviewTimer !== undefined) {
					clearTimeout(this.isScrollingEditorWithPreviewTimer);
				}
				this.isScrollingEditorWithPreviewTimer = setTimeout(
					() => {
						this.isScrollingEditorWithPreview = false;
						this.isScrollingEditorWithPreviewTimer = undefined;
					},
					50
				);
				return;
			}
			case 'codebraidPreview.moveCursor': {
				if (!this.visibleEditor) {
					return;
				}
				this.isScrollingEditorWithPreview = true;
				const cursorLine: number = message.start - 1;
				const position = new vscode.Position(cursorLine, 0);
        		const selection = new vscode.Selection(position, position);
        		this.visibleEditor.selection = selection;
				const range = new vscode.Range(cursorLine, 0, cursorLine, 0);
				this.visibleEditor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
				vscode.window.showTextDocument(this.visibleEditor.document, this.visibleEditor.viewColumn, false);
				if (this.isScrollingEditorWithPreviewTimer !== undefined) {
					clearTimeout(this.isScrollingEditorWithPreviewTimer);
				}
				this.isScrollingEditorWithPreviewTimer = setTimeout(
					() => {
						this.isScrollingEditorWithPreview = false;
						this.isScrollingEditorWithPreviewTimer = undefined;
					},
					50
				);
				return;
			}
		}
	}

	loadStringPandocpreviewDefaults(stringDefaults: string) : {[key: string]: any} {
		// Given a Pandoc defaults file in string form, load it and check
		// the validity of the keys that may be used for preview.  Any errors
		// are handled by the code calling this method.
		if (stringDefaults.charCodeAt(0) === 0xFEFF) {
			// Drop BOM
			stringDefaults = stringDefaults.slice(1);
		}
		let maybePandocpreviewDefaults: any = yaml.load(stringDefaults);
		if (typeof(maybePandocpreviewDefaults) !== 'object' || maybePandocpreviewDefaults === null) {
			throw new Error('Top level of YAML must be an associative array (that is, a map or dict or hash)');
		}
		if (Array.isArray(maybePandocpreviewDefaults)) {
			throw new Error('Top level of YAML must be an associative array (that is, a map or dict or hash)');
		}
		let maybeInputFiles: any = undefined;
		if (maybePandocpreviewDefaults.hasOwnProperty('input-files')) {
			maybeInputFiles = maybePandocpreviewDefaults['input-files'];
			if (!Array.isArray(maybeInputFiles)) {
				throw new Error('Key "input-files" must map to a list of strings');
			}
			if (maybeInputFiles.length === 0) {
				throw new Error('Key "input-files" must map to a non-empty list of strings');
			}
			for (let x of maybeInputFiles) {
				if (typeof(x) !== 'string') {
					throw new Error('Key "input-files" must map to a list of strings');
				}
				if (!x.match('^[^\\\\/]+$')) {
					throw new Error('Key "input-files" must map to a list of file names in the document directory');
				}
			}
		}
		let maybeInputFile: any = undefined;
		if (maybePandocpreviewDefaults.hasOwnProperty('input-file')) {
			maybeInputFile = maybePandocpreviewDefaults['input-file'];
			if (typeof(maybeInputFile) !== 'string') {
				throw new Error('Key "input-file" must be a string');
			}
		}
		if (maybeInputFile && maybeInputFiles) {
			throw new Error('Cannot have both keys "input-files" and "input-file"');
		}
		if (maybePandocpreviewDefaults.hasOwnProperty('from')) {
			let maybeFrom = maybePandocpreviewDefaults['from'];
			if (typeof(maybeFrom) !== 'string') {
				throw new Error('Key "from" must be a string');
			}
			if (!maybeFrom.match('^[a-z_]+(?:[+-][a-z_]+)*$')) {
				throw new Error('Key "from" has incorrect value');
			}
		}
		return maybePandocpreviewDefaults;
	}

	switchEditor(editor: vscode.TextEditor) {
		// This is called by `startPreview()`, which checks the editor for
		// validity first.
		this.visibleEditor = editor;
		if (!this.panel.visible) {
			this.panel.reveal(vscode.ViewColumn.Beside);
		}
		if (editor.document.fileName !== this.currentFileName) {
			this.previousFileName = this.currentFileName;
			this.currentFileName = editor.document.fileName;
		}
		this.onDidChangePreviewEditor(editor);
	}

	async update(callback?: () => void) {
		if (this.usingCodebraid) {
			return;
		}
		if (this.disposables.length === 0) {
			this.needsBuild = false;
			return;
		} else {
			this.needsBuild = true;
		}

		if (this.buildIsScheduled || this.buildIsInProgress) {
			return;
		}

		if (!this.panel.visible) {
			this.buildIsScheduled = true;
			// There currently isn't an event for the webview becoming visible
			setTimeout(
				() => {
					this.buildIsScheduled = false;
					this.update();
				},
				this.extension.config.minBuildInterval
			);
			return;
		}

		let timeNow = Date.now();
		if (this.lastBuildTime + this.extension.config.minBuildInterval > timeNow) {
			this.buildIsScheduled = true;
			setTimeout(
				() => {
					this.buildIsScheduled = false;
					this.update();
				},
				this.lastBuildTime + this.extension.config.minBuildInterval - timeNow
			);
			return;
		}

		this.buildIsInProgress = true;
		this.needsBuild = false;
		this.lastBuildTime = timeNow;

		let currentPandocpreviewDefaultsFile = this.extension.config.pandoc.previewDefaultsFile;
		let currentPandocpreviewDefaultsString: string | undefined;
		let currentPandocpreviewDefaultsFileName: string | undefined;
		try {
			let pandocpreviewDefaultsDocument = await vscode.workspace.openTextDocument(
				path.join(this.cwd, currentPandocpreviewDefaultsFile)
			);
			currentPandocpreviewDefaultsFileName = pandocpreviewDefaultsDocument.fileName;
			currentPandocpreviewDefaultsString = pandocpreviewDefaultsDocument.getText();
		} catch {
		}
		if (!currentPandocpreviewDefaultsFileName || !currentPandocpreviewDefaultsString) {
			this.pandocpreviewDefaults = undefined;
			this.pandocpreviewDefaultsFileName = undefined;
			this.pandocpreviewDefaultsString = undefined;
		} else if (currentPandocpreviewDefaultsString === this.pandocpreviewDefaultsString) {
			this.pandocpreviewDefaultsFileName = currentPandocpreviewDefaultsFileName;
			if (this.pandocpreviewDefaults === null) {
				// Invalid defaults.  Webview will already show error from
				// previous build attempt.
				this.buildIsInProgress = false;
				return;
			}
		} else {
			let currentPandocpreviewDefaults: {[key: string]: any};
			try {
				currentPandocpreviewDefaults = this.loadStringPandocpreviewDefaults(currentPandocpreviewDefaultsString);
			} catch (e) {
				this.pandocpreviewDefaults = null;
				this.pandocpreviewDefaultsFileName = currentPandocpreviewDefaultsFileName;
				this.pandocpreviewDefaultsString = currentPandocpreviewDefaultsString;
				this.panel.webview.html = this.formatMessage(
					'Codebraid Preview',
					[
						'<h1 style="color:red;">Codebraid Preview Error</h1>',
						'<h2>Invalid Pandoc defaults file</h2>',
						'<p>For file <code>',
						this.convertStringToLiteralHtml(currentPandocpreviewDefaultsFileName),
						'</code>:</p>',
						'<pre style="white-space: pre-wrap;">',
						this.convertStringToLiteralHtml(String(e)),
						'</pre>',
						''
					].join('\n')
				);
				this.buildIsInProgress = false;
				this.sourceSupportsScrollSync = false;
				return;
			}
			let inputFiles: Array<string> | undefined = undefined;
			if (currentPandocpreviewDefaults.hasOwnProperty('input-files')) {
				inputFiles = currentPandocpreviewDefaults['input-files'];
			} else if (currentPandocpreviewDefaults.hasOwnProperty('input-file')) {
				inputFiles = [currentPandocpreviewDefaults['input-file']];
			}
			let defaultsApply: boolean = false;
			let currentFileNames: Array<string> = [];
			if (inputFiles) {
				for (let inputFile of inputFiles) {
					let inputFileName = vscode.Uri.file(path.join(this.cwd, inputFile)).fsPath;
					currentFileNames.push(inputFileName);
					if (this.fileNames.indexOf(inputFileName) !== -1) {
						defaultsApply = true;
					}
				}
			}
			if (defaultsApply) {
				this.fileNames = currentFileNames;
				this.pandocpreviewDefaults = currentPandocpreviewDefaults;
				this.pandocpreviewDefaultsFileName = currentPandocpreviewDefaultsFileName;
				this.pandocpreviewDefaultsString = currentPandocpreviewDefaultsString;
			} else {
				this.pandocpreviewDefaults = undefined;
				this.pandocpreviewDefaultsFileName = undefined;
				this.pandocpreviewDefaultsString = undefined;
			}
		}

		let fromFormat: string;
		if (!this.pandocpreviewDefaults || !this.pandocpreviewDefaults.hasOwnProperty('from')) {
			fromFormat = this.extension.config.pandoc.fromFormat;
		} else {
			fromFormat = this.pandocpreviewDefaults['from'];
		}
		let fromFormatIsCommonmarkX: boolean;
		if (/^commonmark_x(?:$|[+-])/.test(fromFormat)) {
			fromFormat += '+sourcepos';
			fromFormatIsCommonmarkX = true;
			this.sourceSupportsScrollSync = true;
		} else {
			fromFormatIsCommonmarkX = false;
			this.sourceSupportsScrollSync = false;
		}

		let fileTexts: Array<string> = [];
		let useCodebraid: boolean = false;
		for (let fileName of this.fileNames) {
			let fileDocument: vscode.TextDocument;
			let fileText: string;
			try {
				fileDocument = await vscode.workspace.openTextDocument(fileName);
				fileText = fileDocument.getText();
			} catch {
				this.panel.webview.html = this.formatMessage(
					'Codebraid Preview',
					[
						'<h1 style="color:red;">Codebraid Preview Error</h1>',
						`<h2>Missing input file: <code>${fileName}</code></h2>`,
						''
					].join('\n')
				);
				this.buildIsInProgress = false;
				this.sourceSupportsScrollSync = false;
				return;
			}
			fileTexts.push(fileText);
			if (!useCodebraid) {
				if (fromFormatIsCommonmarkX) {
					if (fileText.indexOf('.cb-') !== -1) {
						useCodebraid = true;
					}
				} else if (fileText.indexOf('.cb-') !== -1 || fileText.indexOf('.cb.') !== -1) {
					useCodebraid = true;
				}
			}
		}
		let executable: string;
		let args: Array<string> = [];
		executable = 'pandoc';
		args.push(...this.extension.normalizedConfigPandocOptions);
		args.push(...this.pandocArgs);
		args.push(`--from=${fromFormat}`);
		let buildProcess = child_process.execFile(
			executable,
			args,
			this.buildProcessOptions,
			(err, stdout, stderr) => {
				if (this.disposables.length === 0) {
					return;
				}
				let output: string;
				if (err) {
					output = this.formatMessage(
						'Codebraid Preview',
						[
							'<h1 style="color:red;">Codebraid Preview Error</h1>',
							`<h2><code>${executable}</code> failed:</h2>`,
							'<pre style="white-space: pre-wrap;">',
							this.convertStringToLiteralHtml(String(err)),
							'</pre>',
							''
						].join('\n')
					);
					this.sourceSupportsScrollSync = false;
				} else {
					output = stdout;
				}
				this.panel.webview.html = output.replace(
					`<head>`,
					`<head>\n  ${this.baseTag}\n  ${this.contentSecurityTag}\n  ${this.codebraidPreviewJsTag}`
				);
				this.buildIsInProgress = false;
				if (callback) {
					callback();
				}
				if (this.needsBuild) {
					setTimeout(() => {this.update();}, 0);
				}
			}
		);
		this.scrollSyncOffset = 0;
		if (!this.sourceSupportsScrollSync || fileTexts.length === 1) {
			this.scrollSyncMap = undefined;
			for (const fileText of fileTexts) {
				buildProcess.stdin?.write(fileText);
				if (fileText.slice(0, -2) !== '\n\n') {
					buildProcess.stdin?.write('\n\n');
				}
			}
		} else {
			// Line numbers in webview are one-indexed
			let startLine: number = 0;
			let endLine: number = 0;
			let fileTextLines: number = 0;
			this.scrollSyncMap = new Map();
			this.scrollSyncMapMaxLine = 0;
			for (let index = 0; index < this.fileNames.length; index++) {
				const fileName = this.fileNames[index];
				const fileText = fileTexts[index];
				startLine = endLine + 1;
				fileTextLines = 0;
				for (const c of fileText) {
					if (c === '\n') {
						fileTextLines += 1;
					}
				}
				endLine = startLine + fileTextLines - 1;
				buildProcess.stdin?.write(fileText);
				if (fileText.slice(0, -2) !== '\n\n') {
					fileTextLines += 2;
					endLine += 2;
					buildProcess.stdin?.write('\n\n');
				}
				if (!this.scrollSyncMap.has(fileName)) {
					// For files included multiple times, use the first
					// occurrence.  Possible future feature:  Track the
					// location in the preview and try to use that information
					// to determine which occurrence to use.
					this.scrollSyncMap.set(fileName, [startLine, endLine]);
				}
				this.scrollSyncMapMaxLine = endLine;
			}
		}
		buildProcess.stdin?.end();
	}


	async runCodebraid() {
		if (this.codebraidProcess) {
			return;
		}
		this.usingCodebraid = true;

		let currentPandocpreviewDefaultsFile = this.extension.config.pandoc.previewDefaultsFile;
		let currentPandocpreviewDefaultsString: string | undefined;
		let currentPandocpreviewDefaultsFileName: string | undefined;
		try {
			let pandocpreviewDefaultsDocument = await vscode.workspace.openTextDocument(
				path.join(this.cwd, currentPandocpreviewDefaultsFile)
			);
			currentPandocpreviewDefaultsFileName = pandocpreviewDefaultsDocument.fileName;
			currentPandocpreviewDefaultsString = pandocpreviewDefaultsDocument.getText();
		} catch {
		}
		if (!currentPandocpreviewDefaultsFileName || !currentPandocpreviewDefaultsString) {
			this.pandocpreviewDefaults = undefined;
			this.pandocpreviewDefaultsFileName = undefined;
			this.pandocpreviewDefaultsString = undefined;
		} else if (currentPandocpreviewDefaultsString === this.pandocpreviewDefaultsString) {
			this.pandocpreviewDefaultsFileName = currentPandocpreviewDefaultsFileName;
			if (this.pandocpreviewDefaults === null) {
				// Invalid defaults.  Webview will already show error from
				// previous build attempt.
				return;
			}
		} else {
			let currentPandocpreviewDefaults: {[key: string]: any};
			try {
				currentPandocpreviewDefaults = this.loadStringPandocpreviewDefaults(currentPandocpreviewDefaultsString);
			} catch (e) {
				this.pandocpreviewDefaults = null;
				this.pandocpreviewDefaultsFileName = currentPandocpreviewDefaultsFileName;
				this.pandocpreviewDefaultsString = currentPandocpreviewDefaultsString;
				this.panel.webview.html = this.formatMessage(
					'Codebraid Preview',
					[
						'<h1 style="color:red;">Codebraid Preview Error</h1>',
						'<h2>Invalid Pandoc defaults file</h2>',
						'<p>For file <code>',
						this.convertStringToLiteralHtml(currentPandocpreviewDefaultsFileName),
						'</code>:</p>',
						'<pre style="white-space: pre-wrap;">',
						this.convertStringToLiteralHtml(String(e)),
						'</pre>',
						''
					].join('\n')
				);
				this.sourceSupportsScrollSync = false;
				return;
			}
			let inputFiles: Array<string> | undefined = undefined;
			if (currentPandocpreviewDefaults.hasOwnProperty('input-files')) {
				inputFiles = currentPandocpreviewDefaults['input-files'];
			} else if (currentPandocpreviewDefaults.hasOwnProperty('input-file')) {
				inputFiles = [currentPandocpreviewDefaults['input-file']];
			}
			let defaultsApply: boolean = false;
			let currentFileNames: Array<string> = [];
			if (inputFiles) {
				for (let inputFile of inputFiles) {
					let inputFileName = vscode.Uri.file(path.join(this.cwd, inputFile)).fsPath;
					currentFileNames.push(inputFileName);
					if (this.fileNames.indexOf(inputFileName) !== -1) {
						defaultsApply = true;
					}
				}
			}
			if (defaultsApply) {
				this.fileNames = currentFileNames;
				this.pandocpreviewDefaults = currentPandocpreviewDefaults;
				this.pandocpreviewDefaultsFileName = currentPandocpreviewDefaultsFileName;
				this.pandocpreviewDefaultsString = currentPandocpreviewDefaultsString;
			} else {
				this.pandocpreviewDefaults = undefined;
				this.pandocpreviewDefaultsFileName = undefined;
				this.pandocpreviewDefaultsString = undefined;
			}
		}

		let fromFormat: string;
		if (!this.pandocpreviewDefaults || !this.pandocpreviewDefaults.hasOwnProperty('from')) {
			fromFormat = this.extension.config.pandoc.fromFormat;
		} else {
			fromFormat = this.pandocpreviewDefaults['from'];
		}
		if (/^commonmark_x(?:$|[+-])/.test(fromFormat)) {
			fromFormat += '+sourcepos';
			this.sourceSupportsScrollSync = true;
		} else {
			this.sourceSupportsScrollSync = false;
		}

		let fileTexts: Array<string> = [];
		for (let fileName of this.fileNames) {
			let fileDocument: vscode.TextDocument;
			let fileText: string;
			try {
				fileDocument = await vscode.workspace.openTextDocument(fileName);
				fileText = fileDocument.getText();
			} catch {
				this.panel.webview.html = this.formatMessage(
					'Codebraid Preview',
					[
						'<h1 style="color:red;">Codebraid Preview Error</h1>',
						`<h2>Missing input file: <code>${fileName}</code></h2>`,
						''
					].join('\n')
				);
				this.sourceSupportsScrollSync = false;
				return;
			}
			fileTexts.push(fileText);
		}
		let executable: string;
		let args: Array<string> = [];
		executable = 'codebraid';
		args.push(...this.codebraidArgs);
		args.push(...this.extension.normalizedConfigPandocOptions);
		args.push(...this.pandocArgs);
		args.push(`--from=${fromFormat}`);
		this.extension.statusBarConfig.setCodebraidRunning();
		this.codebraidProcess = child_process.execFile(
			executable,
			args,
			this.buildProcessOptions,
			(err, stdout, stderr) => {
				this.extension.statusBarConfig.setCodebraidWaiting();
				if (this.disposables.length === 0) {
					return;
				}
				let output: string;
				if (err && (typeof(err.code) !== 'number' || err.code < 4)) {
					output = this.formatMessage(
						'Codebraid Preview',
						[
							'<h1 style="color:red;">Codebraid Preview Error</h1>',
							`<h2><code>${executable}</code> failed:</h2>`,
							'<pre style="white-space: pre-wrap;">',
							this.convertStringToLiteralHtml(String(err)),
							'</pre>',
							''
						].join('\n')
					);
					this.sourceSupportsScrollSync = false;
				} else {
					output = stdout;
				}
				this.panel.webview.html = output.replace(
					`<head>`,
					`<head>\n  ${this.baseTag}\n  ${this.contentSecurityTag}\n  ${this.codebraidPreviewJsTag}`
				);
				this.codebraidProcess = undefined;
			}
		);
		let buildProcess = this.codebraidProcess;
		this.scrollSyncOffset = 0;
		if (!this.sourceSupportsScrollSync || fileTexts.length === 1) {
			this.scrollSyncMap = undefined;
			for (const fileText of fileTexts) {
				buildProcess.stdin?.write(fileText);
				if (fileText.slice(0, -2) !== '\n\n') {
					buildProcess.stdin?.write('\n\n');
				}
			}
		} else {
			// Line numbers in webview are one-indexed
			let startLine: number = 0;
			let endLine: number = 0;
			let fileTextLines: number = 0;
			this.scrollSyncMap = new Map();
			this.scrollSyncMapMaxLine = 0;
			for (let index = 0; index < this.fileNames.length; index++) {
				const fileName = this.fileNames[index];
				const fileText = fileTexts[index];
				startLine = endLine + 1;
				fileTextLines = 0;
				for (const c of fileText) {
					if (c === '\n') {
						fileTextLines += 1;
					}
				}
				endLine = startLine + fileTextLines - 1;
				buildProcess.stdin?.write(fileText);
				if (fileText.slice(0, -2) !== '\n\n') {
					fileTextLines += 2;
					endLine += 2;
					buildProcess.stdin?.write('\n\n');
				}
				if (!this.scrollSyncMap.has(fileName)) {
					// For files included multiple times, use the first
					// occurrence.  Possible future feature:  Track the
					// location in the preview and try to use that information
					// to determine which occurrence to use.
					this.scrollSyncMap.set(fileName, [startLine, endLine]);
				}
				this.scrollSyncMapMaxLine = endLine;
			}
		}
		buildProcess.stdin?.end();
	}


	async exportDocument(exportPath: string) {
		let currentPandocpreviewDefaultsFile = this.extension.config.pandoc.previewDefaultsFile;
		let currentPandocpreviewDefaultsString: string | undefined;
		let currentPandocpreviewDefaultsFileName: string | undefined;
		try {
			let pandocpreviewDefaultsDocument = await vscode.workspace.openTextDocument(
				path.join(this.cwd, currentPandocpreviewDefaultsFile)
			);
			currentPandocpreviewDefaultsFileName = pandocpreviewDefaultsDocument.fileName;
			currentPandocpreviewDefaultsString = pandocpreviewDefaultsDocument.getText();
		} catch {
		}
		if (!currentPandocpreviewDefaultsFileName || !currentPandocpreviewDefaultsString) {
			this.pandocpreviewDefaults = undefined;
			this.pandocpreviewDefaultsFileName = undefined;
			this.pandocpreviewDefaultsString = undefined;
		} else if (currentPandocpreviewDefaultsString === this.pandocpreviewDefaultsString) {
			this.pandocpreviewDefaultsFileName = currentPandocpreviewDefaultsFileName;
			if (this.pandocpreviewDefaults === null) {
				vscode.window.showErrorMessage('Invalid Pandoc defaults file');
				return;
			}
		} else {
			let currentPandocpreviewDefaults: {[key: string]: any};
			try {
				currentPandocpreviewDefaults = this.loadStringPandocpreviewDefaults(currentPandocpreviewDefaultsString);
			} catch (e) {
				this.pandocpreviewDefaults = null;
				this.pandocpreviewDefaultsFileName = currentPandocpreviewDefaultsFileName;
				this.pandocpreviewDefaultsString = currentPandocpreviewDefaultsString;
				vscode.window.showErrorMessage('Invalid Pandoc defaults file');
				return;
			}
			let inputFiles: Array<string> | undefined = undefined;
			if (currentPandocpreviewDefaults.hasOwnProperty('input-files')) {
				inputFiles = currentPandocpreviewDefaults['input-files'];
			} else if (currentPandocpreviewDefaults.hasOwnProperty('input-file')) {
				inputFiles = [currentPandocpreviewDefaults['input-file']];
			}
			let defaultsApply: boolean = false;
			let currentFileNames: Array<string> = [];
			if (inputFiles) {
				for (let inputFile of inputFiles) {
					let inputFileName = vscode.Uri.file(path.join(this.cwd, inputFile)).fsPath;
					currentFileNames.push(inputFileName);
					if (this.fileNames.indexOf(inputFileName) !== -1) {
						defaultsApply = true;
					}
				}
			}
			if (defaultsApply) {
				this.fileNames = currentFileNames;
				this.pandocpreviewDefaults = currentPandocpreviewDefaults;
				this.pandocpreviewDefaultsFileName = currentPandocpreviewDefaultsFileName;
				this.pandocpreviewDefaultsString = currentPandocpreviewDefaultsString;
			} else {
				this.pandocpreviewDefaults = undefined;
				this.pandocpreviewDefaultsFileName = undefined;
				this.pandocpreviewDefaultsString = undefined;
			}
		}

		let fromFormat: string;
		if (!this.pandocpreviewDefaults || !this.pandocpreviewDefaults.hasOwnProperty('from')) {
			fromFormat = this.extension.config.pandoc.fromFormat;
		} else {
			fromFormat = this.pandocpreviewDefaults['from'];
		}

		let fileTexts: Array<string> = [];
		for (let fileName of this.fileNames) {
			let fileDocument: vscode.TextDocument;
			let fileText: string;
			try {
				fileDocument = await vscode.workspace.openTextDocument(fileName);
				fileText = fileDocument.getText();
			} catch {
				vscode.window.showErrorMessage('Failed to read all files');
				return;
			}
			fileTexts.push(fileText);
		}
		let executable: string;
		let args: Array<string> = [];
		if (this.usingCodebraid) {
			executable = 'codebraid';
			args.push('pandoc');
			// Save dialog already requires confirmation of overwrite
			args.push('--overwrite');
		} else {
			executable = 'pandoc';
		}
		args.push(...this.extension.normalizedConfigPandocOptions);
		args.push(`--from=${fromFormat}`);
		args.push('--standalone');
		args.push(...['--output', `"${exportPath}"`]);

		this.extension.statusBarConfig.setDocumentExportRunning();
		let buildProcess = child_process.execFile(
			executable,
			args,
			this.buildProcessOptions,
			(err, stdout, stderr) => {
				this.extension.statusBarConfig.setDocumentExportWaiting();
				if (err) {
					vscode.window.showErrorMessage(`Pandoc export failed: ${err}`);
				} else if (stderr && !this.usingCodebraid) {
					// Add Codebraid stderr once exit code options are finalized
					vscode.window.showErrorMessage(`Pandoc export stderr: ${stderr}`);
				}
			}
		);
		for (const fileText of fileTexts) {
			buildProcess.stdin?.write(fileText);
			if (fileText.slice(0, -2) !== '\n\n') {
				buildProcess.stdin?.write('\n\n');
			}
		}
		buildProcess.stdin?.end();
	}

}
