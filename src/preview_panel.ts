// Copyright (c) 2022, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as vscode from 'vscode';

import * as child_process from 'child_process';
import * as path from 'path';

import type { ExtensionState } from './types';
import PandocPreviewDefaults from './pandoc_preview_defaults';
import {countNewlines} from './util';




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
	fromFormat: string;
	pandocPreviewDefaults: PandocPreviewDefaults;
	// Track visible editor that is relevant.
	visibleEditor: vscode.TextEditor | undefined;
	// Track recent visible files to determine which visible editor to sync
	// with.  It may be worth tracking `viewColumn` as well eventually.
	currentFileName: string;
	previousFileName: string | undefined;

	// Display
	// -------
	panel: vscode.WebviewPanel | undefined;
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
	pandocPreviewArgs: Array<string>;
	pandocWithCodebraidOutputArgs: Array<string>;
	pandocExportArgs: Array<string>;
	codebraidArgs: Array<string>;
	buildProcessOptions: child_process.ExecFileOptions;
	codebraidProcessOptions: child_process.SpawnOptions;
	lastBuildTime: number;
	needsBuild: boolean;
	buildIsScheduled: boolean;
	buildIsInProgress: boolean;
	usingCodebraid: boolean;
	codebraidIsInProgress: boolean;
	didCheckInitialCodebraidCache: boolean;
	oldCodebraidOutput: Map<string, Array<string>>;
	currentCodebraidOutput: Map<string, Array<string>>;

	constructor(editor: vscode.TextEditor, extension: ExtensionState) {
		this.disposables = [];

		this.extension = extension;

		this.cwd = path.dirname(editor.document.uri.fsPath);
		this.fileNames = [];
		this.fileNames.push(editor.document.fileName);
		this.fromFormat = extension.config.pandoc.fromFormat;
		this.pandocPreviewDefaults = new PandocPreviewDefaults(this);
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
					vscode.Uri.file(this.extension.context.asAbsolutePath('media')),
					vscode.Uri.file(this.extension.context.asAbsolutePath('scripts')),
					vscode.Uri.file(this.extension.context.asAbsolutePath('node_modules/katex/dist')),
					vscode.Uri.file(this.extension.context.asAbsolutePath('node_modules/@vscode/codicons/dist')),
				],
			}
		);
		this.disposables.push(this.panel);
		// Cleanup may be triggered by the webview panel being closed.  Since
		// `retainContextWhenHidden` is true, the panel won't be disposed when
		// it isn't visible.
		this.panel.onDidDispose(
			() => {
				this.panel = undefined;
				this.dispose();
			},
			this,
			this.disposables
		);
		this.resourceWebviewUris = {
			katex: this.panel.webview.asWebviewUri(
				vscode.Uri.file(this.extension.context.asAbsolutePath('node_modules/katex/dist'))
			),
			vscodeCodicon: this.panel.webview.asWebviewUri(
				vscode.Uri.file(this.extension.context.asAbsolutePath('node_modules/@vscode/codicons/dist/codicon.css'))
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
			pandocCodebraidOutputLuaFilter: this.extension.context.asAbsolutePath('scripts/pandoc-codebraid-output.lua'),
		};
		this.baseTag = `<base href="${this.panel.webview.asWebviewUri(vscode.Uri.file(this.cwd))}/">`;
		this.contentSecurityOptions = {
			'style-src': [`${this.panel.webview.cspSource}`, `'unsafe-inline'`,],
			'font-src': [`${this.panel.webview.cspSource}`],
			'img-src': [`${this.panel.webview.cspSource}`],
			'script-src': [`${this.panel.webview.cspSource}`, `'unsafe-inline'`],
		};
		let contentSecurityContent: Array<string> = [];
		for (const src in this.contentSecurityOptions) {
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

		this.pandocPreviewArgs = [
			`--standalone`,
			`--lua-filter="${this.resourcePaths.pandocSourcePosLuaFilter}"`,
			`--css=${this.resourceWebviewUris.vscodeCss}`,
			`--css=${this.resourceWebviewUris.vscodeCodicon}`,
			`--css=${this.resourceWebviewUris.codebraidCss}`,
			`--katex=${this.resourceWebviewUris.katex}/`,
			`--to=html`,
		];
		this.pandocWithCodebraidOutputArgs = [
			`--lua-filter="${this.resourcePaths.pandocCodebraidOutputLuaFilter}"`,
		];
		this.pandocExportArgs = [
			`--standalone`,
		];
		this.codebraidArgs = ['pandoc', '--only-code-output', 'codebraid_preview'];
		this.buildProcessOptions = {
			maxBuffer: 1024*1024*16, // = <default>*16 = 16_777_216 bytes
			cwd: this.cwd,
			shell: true // not ideal, but consistently 2-5x faster
		};
		this.codebraidProcessOptions = {
			cwd: this.cwd,
			shell: true,
		};
		this.didCheckInitialCodebraidCache = false;
		this.oldCodebraidOutput = new Map();
		this.currentCodebraidOutput = new Map();
		this.lastBuildTime = 0;
		this.needsBuild = true;
		this.buildIsScheduled = false;
		this.buildIsInProgress = false;
		this.codebraidIsInProgress = false;
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

		// Need to wait until any preview defaults file is read and processed
		// before creating initial preview.
		this.pandocPreviewDefaults.update().then(() => {
			this.update().then(() => {
				this.onDidChangePreviewEditor(editor);
			});
		});
	}

	registerOnDisposeCallback(callback: () => void) {
		this._onDisposeExtensionCallback = callback;
	}

	dispose() {
		this.panel = undefined;
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
		if (this._onDisposeExtensionCallback) {
			this._onDisposeExtensionCallback();
			this._onDisposeExtensionCallback = undefined;
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
		if (!this.panel) {
			return;
		}
		this.panel.webview.html = this.formatMessage(
			'Updating Codebraid Preview...',
			'<h1>Updating Codebraid Preview...</h1>'
		);
	}

	convertStringToLiteralHtml(s: string) {
		return s.replaceAll('&', '&amp;')
				.replaceAll('<', '&lt;')
				.replaceAll('>', '&gt;')
				.replaceAll('"', '&quot;')
				.replaceAll("'", '&apos;');
	}

	onDidChangeActiveTextEditor(editor: vscode.TextEditor | undefined) {
		if (!this.panel) {
			return;
		}
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
		if (!this.panel) {
			return;
		}
		this.visibleEditor = undefined;
		for (const editor of editors) {
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
			for (const editor of editors) {
				if (editor.document.uri.scheme === 'file' && editor.document.fileName === this.previousFileName) {
					this.visibleEditor = editor;
					this.currentFileName = this.previousFileName;
					this.previousFileName = undefined;
					this.onDidChangePreviewEditor(editor);
					return;
				}
			}
		}
		for (const editor of editors) {
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
		if (!this.panel) {
			return;
		}
		if (event.contentChanges.length !== 0 && event.document.uri.scheme === 'file') {
			if (this.fileNames.indexOf(event.document.fileName) !== -1) {
				this.update();
			} else if (event.document.fileName === this.pandocPreviewDefaults.fileName) {
				this.pandocPreviewDefaults.update().then(() => {
					this.update();
				});
			}
		}
	}

	onDidChangeTextEditorVisibleRanges(event: vscode.TextEditorVisibleRangesChangeEvent) {
		if (!this.panel) {
			return;
		}
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
		if (!this.panel) {
			return;
		}
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
		if (!this.panel) {
			return;
		}
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
				if (!this.panel) {
					return;
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

	switchEditor(editor: vscode.TextEditor) {
		// This is called by `startPreview()`, which checks the editor for
		// validity first.
		if (!this.panel) {
			return;
		}
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


	setWebviewHTML(html: string) {
		if (!this.panel) {
			return;
		}
		this.panel.webview.html = html.replace(
			`<head>`,
			`<head>\n  ${this.baseTag}\n  ${this.contentSecurityTag}\n  ${this.codebraidPreviewJsTag}`
		);
	}


	async getFileTexts(fileNames: Array<string>, fromFormatIsCommonmark: boolean | undefined) : Promise<Array<string> | undefined> {
		let fileTexts: Array<string> = [];
		for (let fileName of fileNames) {
			let fileText: string;
			try {
				let fileDocument = await vscode.workspace.openTextDocument(fileName);
				fileText = fileDocument.getText();
			} catch {
				if (!this.panel) {
					return;
				}
				vscode.window.showErrorMessage(`Missing input file "${fileName}"`);
				return undefined;
			}
			fileTexts.push(fileText);
			if (!this.usingCodebraid && fromFormatIsCommonmark !== undefined) {
				if (fromFormatIsCommonmark) {
					if (fileText.indexOf('.cb-') !== -1) {
						this.usingCodebraid = true;
					}
				} else if (fileText.indexOf('.cb-') !== -1 || fileText.indexOf('.cb.') !== -1) {
					this.usingCodebraid = true;
				}
			}
		}
		return fileTexts;
	}


	isFromFormatCommonMark(format: string) : boolean {
		return /^(?:commonmark_x|commonmark|gfm)(?:$|[+-])/.test(format);
	}


	async update() {
		if (!this.panel) {
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

		if (!this.pandocPreviewDefaults.isValid) {
			this.pandocPreviewDefaults.showErrorMessage();
			return;
		}
		this.buildIsInProgress = true;
		this.needsBuild = false;
		this.lastBuildTime = timeNow;

		// Collect all data that depends on config and preview defaults so
		// that everything from here onward isn't affected by config or
		// preview changes during await's.
		let fileNames = this.fileNames;
		let fromFormat = this.fromFormat;
		let filters = this.pandocPreviewDefaults.filters;
		let normalizedConfigPandocOptions = this.extension.normalizedConfigPandocOptions;

		let fromFormatIsCommonmark: boolean = this.isFromFormatCommonMark(fromFormat);
		this.sourceSupportsScrollSync = fromFormatIsCommonmark;
		if (fromFormatIsCommonmark) {
			fromFormat += '+sourcepos';
		}

		let maybeFileTexts: Array<string> | undefined = await this.getFileTexts(fileNames, fromFormatIsCommonmark);
		if (!maybeFileTexts) {
			this.buildIsInProgress = false;
			this.sourceSupportsScrollSync = false;
			return;
		}
		const fileTexts: Array<string> = maybeFileTexts;


		if (this.usingCodebraid && !this.didCheckInitialCodebraidCache && !this.codebraidIsInProgress) {
			this.didCheckInitialCodebraidCache = true;
			await this.runCodebraidNoExecute();
		}

		const executable: string = 'pandoc';
		const args: Array<string> = [];
		args.push(...normalizedConfigPandocOptions);
		if (filters) {
			for (const filter of filters) {
				if (filter.endsWith('.lua')) {
					args.push(...['--lua-filter', filter]);
				} else {
					args.push(...['--filter', filter]);
				}
			}
		}
		args.push(...this.pandocPreviewArgs);
		if (this.usingCodebraid) {
			args.push(...this.pandocWithCodebraidOutputArgs);
		}
		args.push(`--from=${fromFormat}`);

		let buildProcess = child_process.execFile(
			executable,
			args,
			this.buildProcessOptions,
			(error, stdout, stderr) => {
				if (!this.panel) {
					return;
				}
				let output: string;
				if (error) {
					output = this.formatMessage(
						'Codebraid Preview',
						[
							'<h1 style="color:red;">Codebraid Preview Error</h1>',
							`<h2><code>${executable}</code> failed:</h2>`,
							'<pre style="white-space: pre-wrap;">',
							this.convertStringToLiteralHtml(String(error)),
							'</pre>',
							''
						].join('\n')
					);
					this.scrollSyncOffset = 0;
					this.sourceSupportsScrollSync = false;
				} else {
					output = stdout;
				}
				this.setWebviewHTML(output);
				this.buildIsInProgress = false;
				if (this.needsBuild) {
					setTimeout(() => {this.update();}, 0);
				}
			}
		);

		this.scrollSyncOffset = 0;
		let includingCodebraidOutput: boolean;
		if (this.usingCodebraid && (this.currentCodebraidOutput.size > 0 || this.oldCodebraidOutput.size > 0)) {
			includingCodebraidOutput = true;
		} else {
			includingCodebraidOutput = false;
		}
		if (includingCodebraidOutput) {
			buildProcess.stdin?.write([
				`---`,
				`codebraid_meta:`,
				`  commonmark: ${fromFormatIsCommonmark}`,
				`  codebraid_running: ${this.codebraidIsInProgress}`,
				`codebraid_output:\n`,
			].join('\n'));
			// Offset ignores `---` for now, since document could start with
			// that sequence
			this.scrollSyncOffset += 3;
			let keySet = new Set();
			if (this.currentCodebraidOutput.size > 0) {
				for (const [key, yamlArray] of this.currentCodebraidOutput) {
					buildProcess.stdin?.write(`  "${key}":\n`);
					this.scrollSyncOffset += 1;
					for (const yaml of yamlArray) {
						buildProcess.stdin?.write(yaml);
						this.scrollSyncOffset += countNewlines(yaml);
					}
					keySet.add(key);
				}
			}
			if (this.oldCodebraidOutput.size > 0) {
				for (const [key, yamlArray] of this.oldCodebraidOutput) {
					if (keySet.has(key)) {
						continue;
					}
					buildProcess.stdin?.write(`  "${key}":\n`);
					this.scrollSyncOffset += 1;
					for (const yaml of yamlArray) {
						buildProcess.stdin?.write(yaml);
						this.scrollSyncOffset += countNewlines(yaml);
					}
				}
			}
		}
		if (!this.sourceSupportsScrollSync || fileTexts.length === 1) {
			this.scrollSyncMap = undefined;
			for (const [fileIndex, fileText] of fileTexts.entries()) {
				if (fileIndex === 0 && includingCodebraidOutput) {
					if (/^---[ \t]*\n.+?\n(?:---|\.\.\.)[ \t]*\n/.test(fileText)) {
						buildProcess.stdin?.write(fileText.slice(fileText.indexOf('\n')+1));
					} else {
						buildProcess.stdin?.write('---\n\n');
						// Offset start+end delim lines, and trailing blank
						this.scrollSyncOffset += 3;
						buildProcess.stdin?.write(fileText);
					}
				} else {
					buildProcess.stdin?.write(fileText);
				}
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
			for (const [fileIndex, fileText] of fileTexts.entries()) {
				const fileName = fileNames[fileIndex];
				if (fileIndex === 0 && includingCodebraidOutput) {
					if (/^---[ \t]*\n.+?\n(?:---|\.\.\.)[ \t]*\n/.test(fileText)) {
						buildProcess.stdin?.write(fileText.slice(fileText.indexOf('\n')+1));
					} else {
						buildProcess.stdin?.write('---\n\n');
						// Offset start+end delim lines, and trailing blank
						this.scrollSyncOffset += 3;
						buildProcess.stdin?.write(fileText);
					}
				} else {
					buildProcess.stdin?.write(fileText);
				}
				startLine = endLine + 1;
				fileTextLines = countNewlines(fileText);
				endLine = startLine + fileTextLines - 1;
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


	processCodebraidOutput(dataString: string) {
		let dataStringTrimmed = dataString.trim();
		if (dataStringTrimmed === '') {
			return;
		}
		let data: any;
		try {
			data = JSON.parse(dataStringTrimmed);
		} catch {
			// May need to add logging/debugging/alert
			return;
		}
		let key = `${data.code_collection.type}.${data.code_collection.lang}.${data.code_collection.name}`;
		// index is 1-based
		let [index, length] = data.number.split('/').map((numString: string) => Number(numString));
		if (index === undefined || length === undefined) {
			return;
		}
		let yamlLines = [
			`  - inline: ${data.inline}\n`,
			`    attr_hash: "\`${data.attr_hash}\`"\n`,
			`    code_hash: "\`${data.code_hash}\`"\n`,
		];
		if (data.output.length > 0) {
			yamlLines.push(`    output:\n`);
			for (const md of data.output) {
				yamlLines.push(
					`    - |\n`,
					`      `, md.replaceAll('\n', '\n      '), `\n`,
				);
			}
		}
		let yaml = yamlLines.join('');
		let yamlArray = this.currentCodebraidOutput.get(key);
		let oldYamlArray = this.oldCodebraidOutput.get(key);
		if (yamlArray === undefined) {
			if (oldYamlArray === undefined) {
				yamlArray = Array(length).fill(`  - placeholder: true\n`);
			} else {
				yamlArray = [];
				for (const [oldIndex, oldYaml] of oldYamlArray.entries()) {
					if (oldIndex === length) {
						break;
					}
					yamlArray.push(oldYaml + `    old: true\n`);
				}
				while (yamlArray.length < length) {
					yamlArray.push(`  - placeholder: true\n`);
				}
			}
			this.currentCodebraidOutput.set(key, yamlArray);
		}
		// index is 1-based
		yamlArray[index-1] = yaml;
		this.update();
	}

	async runCodebraidExecute() {
		return this.runCodebraid(false);
	}

	async runCodebraidNoExecute() {
		return this.runCodebraid(true);
	}

	private async runCodebraid(noExecute: boolean) {
		if (!this.panel) {
			return;
		}
		if (!this.extension.hasCompatibleCodebraid) {
			vscode.window.showErrorMessage([
				`Codebraid is not installed or is out of date (need ${this.extension.minCodebraidVersion}+).`,
				`Install or upgrade (https://pypi.org/project/codebraid/), then reload the extension.`,
				`Code execution and loading output from cache is disabled.`,
			].join(' '));
			return;
		}
		if (this.codebraidIsInProgress) {
			return;
		}

		// Typically, this will already be detected and set automatically
		// during file reading by searching for `.cb{.-}`
		this.usingCodebraid = true;

		if (!this.pandocPreviewDefaults.isValid) {
			this.pandocPreviewDefaults.showErrorMessage();
			return;
		}

		this.codebraidIsInProgress = true;
		// Update preview to start any progress indicators, etc.
		this.update();

		// Collect all data that depends on config and preview defaults so
		// that everything from here onward isn't affected by config or
		// preview changes during await's.
		let fileNames = this.fileNames;
		let fromFormat = this.fromFormat;
		let normalizedConfigPandocOptions = this.extension.normalizedConfigPandocOptions;

		let fromFormatIsCommonmark: boolean = this.isFromFormatCommonMark(fromFormat);
		if (fromFormatIsCommonmark) {
			fromFormat += '+sourcepos';
		}

		let maybeFileTexts: Array<string> | undefined = await this.getFileTexts(fileNames, fromFormatIsCommonmark);
		if (!maybeFileTexts) {
			this.codebraidIsInProgress = false;
			return;
		}
		const fileTexts: Array<string> = maybeFileTexts;

		const executable: string = 'codebraid';
		const args: Array<string> = [];
		args.push(...this.codebraidArgs);
		if (noExecute) {
			args.push('--no-execute');
		}
		args.push(...normalizedConfigPandocOptions);
		// Filters from 'pandocPreviewDefaults.filters' are skipped, because
		// they are only applied to the document after Codebraid processing.
		// If Codebraid adds a --pre-filter or similar option, that would need
		// to be handled here.
		args.push(...this.pandocPreviewArgs);
		args.push(`--from=${fromFormat}`);

		this.oldCodebraidOutput = this.currentCodebraidOutput;
		this.currentCodebraidOutput = new Map();

		if (noExecute) {
			this.extension.statusBarConfig.setCodebraidRunningNoExecute();
		} else {
			this.extension.statusBarConfig.setCodebraidRunningExecute();
		}

		const stderrBuffer: Array<string> = [];
		const stdoutBuffer: Array<string> = [];
		const codebraidProcessExitPromise = new Promise<number>((resolve, reject) => {
			const codebraidProcess = child_process.spawn(
				executable,
				args,
				this.codebraidProcessOptions
			);
			codebraidProcess.stdin?.setDefaultEncoding('utf8');
			codebraidProcess.stdout?.setEncoding('utf8');
			codebraidProcess.stderr?.setEncoding('utf8');

			codebraidProcess.on('close', (exitCode: number) => {
				resolve(exitCode);
			});
			codebraidProcess.on('error', (error: any) => {
				reject(error);
			});
			codebraidProcess.stderr?.on('data', (data: string) => {
				stderrBuffer.push(data);
			});
			codebraidProcess.stdout?.on('data', (data: string) => {
				const index = data.lastIndexOf('\n');
				if (index === -1) {
					stdoutBuffer.push(data);
				} else {
					stdoutBuffer.push(data.slice(0, index));
					for (const jsonData of stdoutBuffer.join('').split('\n')) {
						this.processCodebraidOutput(jsonData);
					}
					stdoutBuffer.length = 0;
					stdoutBuffer.push(data.slice(index+1));
				}
			});
			for (const fileText of fileTexts) {
				codebraidProcess.stdin?.write(fileText);
				if (fileText.slice(0, -2) !== '\n\n') {
					codebraidProcess.stdin?.write('\n\n');
				}
			}
			codebraidProcess.stdin?.end();
		}).catch((error) => {
			if (!this.panel) {
				return undefined;
			}
			vscode.window.showErrorMessage(`${error}`);
			return undefined;});

		let codebraidProcessExitCode: number | undefined = await codebraidProcessExitPromise;
		if (codebraidProcessExitCode === 0 || (codebraidProcessExitCode && codebraidProcessExitCode >= 4)) {
			for (const jsonData of stdoutBuffer.join('').split('\n')) {
				this.processCodebraidOutput(jsonData);
			}
		} else {
			this.currentCodebraidOutput = this.oldCodebraidOutput;
			if (codebraidProcessExitCode === undefined) {
				vscode.window.showErrorMessage('Codebraid process failed to start or lost communication.');
			} else if (stderrBuffer.length === 0) {
				vscode.window.showErrorMessage(`Codebraid process failed with exit code ${codebraidProcessExitCode}.`);
		 	} else {
				vscode.window.showErrorMessage(
					`Codebraid process failed with exit code ${codebraidProcessExitCode}: ${stderrBuffer.join('')}`
				);
			}
		}
		this.extension.statusBarConfig.setCodebraidWaiting();
		this.codebraidIsInProgress = false;
	}


	async exportDocument(exportPath: string) {
		// Collect all data that depends on config and preview defaults so
		// that everything from here onward isn't affected by config or
		// preview changes during await's.
		let fileNames = this.fileNames;
		let fromFormat = this.fromFormat;
		let filters = this.pandocPreviewDefaults.filters;
		let normalizedConfigPandocOptions = this.extension.normalizedConfigPandocOptions;

		let maybeFileTexts: Array<string> | undefined = await this.getFileTexts(fileNames, undefined);
		if (!maybeFileTexts) {
			return;
		}
		const fileTexts: Array<string> = maybeFileTexts;

		const executable: string = 'pandoc';
		const args: Array<string> = [];
		args.push(...normalizedConfigPandocOptions);
		if (filters) {
			for (const filter of filters) {
				if (filter.endsWith('.lua')) {
					args.push(...['--lua-filter', filter]);
				} else {
					args.push(...['--filter', filter]);
				}
			}
		}
		args.push(...this.pandocExportArgs);
		if (this.usingCodebraid) {
			args.push(...this.pandocWithCodebraidOutputArgs);
		}
		args.push(`--from=${fromFormat}`);
		// Save dialog requires confirmation of overwrite
		args.push(...['--output', `"${exportPath}"`]);

		this.extension.statusBarConfig.setDocumentExportRunning();
		let buildProcess = child_process.execFile(
			executable,
			args,
			this.buildProcessOptions,
			(error, stdout, stderr) => {
				if (!this.panel) {
					return;
				}
				this.extension.statusBarConfig.setDocumentExportWaiting();
				if (error) {
					vscode.window.showErrorMessage(`Pandoc export failed: ${error}`);
				} else if (stderr) {
					vscode.window.showErrorMessage(`Pandoc export stderr: ${stderr}`);
				}
			}
		);

		let fromFormatIsCommonmark: boolean = this.isFromFormatCommonMark(fromFormat);
		let includingCodebraidOutput: boolean;
		if (this.usingCodebraid && (this.currentCodebraidOutput.size > 0 || this.oldCodebraidOutput.size > 0)) {
			includingCodebraidOutput = true;
		} else {
			includingCodebraidOutput = false;
		}
		if (includingCodebraidOutput) {
			buildProcess.stdin?.write([
				`---`,
				`codebraid_meta:`,
				`  commonmark: ${fromFormatIsCommonmark}`,
				`codebraid_output:\n`,
			].join('\n'));
			let keySet = new Set();
			if (this.currentCodebraidOutput.size > 0) {
				for (const [key, yamlArray] of this.currentCodebraidOutput) {
					buildProcess.stdin?.write(`  "${key}":\n`);
					for (const yaml of yamlArray) {
						buildProcess.stdin?.write(yaml);
					}
					keySet.add(key);
				}
			}
			if (this.oldCodebraidOutput.size > 0) {
				for (const [key, yamlArray] of this.oldCodebraidOutput) {
					if (keySet.has(key)) {
						continue;
					}
					buildProcess.stdin?.write(`  "${key}":\n`);
					for (const yaml of yamlArray) {
						buildProcess.stdin?.write(yaml);
					}
				}
			}
		}
		for (const [fileIndex, fileText] of fileTexts.entries()) {
			if (fileIndex === 0 && includingCodebraidOutput) {
				if (/^---[ \t]*\n.+?\n(?:---|\.\.\.)[ \t]*\n/.test(fileText)) {
					buildProcess.stdin?.write(fileText.slice(fileText.indexOf('\n')+1));
				} else {
					buildProcess.stdin?.write('---\n\n');
					buildProcess.stdin?.write(fileText);
				}
			} else {
				buildProcess.stdin?.write(fileText);
			}
			if (fileText.slice(0, -2) !== '\n\n') {
				buildProcess.stdin?.write('\n\n');
			}
		}
		buildProcess.stdin?.end();
	}

}
