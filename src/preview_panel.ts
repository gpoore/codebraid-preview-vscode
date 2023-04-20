// Copyright (c) 2022-2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as vscode from 'vscode';

import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';

import type { ExtensionState } from './types';
import type { PandocInfo } from './pandoc_info';
import { PandocReader, PandocWriter, fallbackHtmlWriter } from './pandoc_util';
import type { PandocPreviewBuildConfig, PandocExportBuildConfig, PandocBuildConfigCollection } from './pandoc_build_configs';
import { PandocDefaultsFile } from './pandoc_defaults_file';
import { countNewlines, FileExtension } from './util';
import { webviewResources, pandocResources } from './resources';
import { checkCodebraidVersion, minCodebraidVersionString } from './check_codebraid';
import {
	readersWithWrapper,
	builtinToFileExtensionMap,
	defaultSaveDialogFilter,
	defaultSaveDialogFileExtensionToFilterKeyMap,
	extractedMediaDirectory,
} from './pandoc_settings';
import { NotebookTextEditor } from './notebook';


type Source = {
	index: number,
	fileName: string, fileText: string, fileTextLines: number,
	endPaddingText: string, totalTextLines: number,
};
type Sources = Array<Source>;

type PandocPreviewOptions = {
	reader: PandocReader | undefined;
	writer: PandocWriter | undefined;
	fileScope: boolean | undefined;
	embedResources: boolean | undefined;
};

type ScrollSyncData = {
	offset: number;
	map: Map<string, [number, number]>;
};

type UpdatingStatus = null | 'waiting' | 'running' | 'finished';
const yamlMetadataRegex = /^---[ \t]*\r?\n.+?\n(?:---|\.\.\.)[ \t]*\r?\n/us;


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
	private onDisposeExtensionCallback?: () => void;

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
	uriCache: Map<string, vscode.Uri>;
	// Track visible editor that is relevant.  For notebooks, this is
	// currently set to the initial editor and never updated later regardless
	// of visibility.  Notebooks do not currently support features like scroll
	// sync that rely on the current visible editor, and having constant
	// access to the editor is convenient for checking whether the notebook
	// has unsaved changes.  If notebook support is expanded in the future,
	// `visibleEditor` should be updated, and something should be added like
	// `editors: Array<vscode.TextEditor | vscode.NotebookEditor>`.
	visibleEditor: vscode.TextEditor | NotebookTextEditor | undefined;
	// Track recent visible files to determine which visible editor to sync
	// with.  It may be worth tracking `viewColumn` as well eventually.
	currentFileName: string;
	previousFileName: string | undefined;

	// Pandoc
	// ------
	fileExtension: FileExtension;
	pandocInfo: PandocInfo;
	pandocPreviewOptions: PandocPreviewOptions | undefined;
	lastPandocPreviewOptions: PandocPreviewOptions | undefined;
	pandocPreviewBuildConfig: PandocPreviewBuildConfig | undefined;
	lastPandocPreviewBuildConfig: PandocPreviewBuildConfig | undefined;
	documentPandocDefaultsFile: PandocDefaultsFile;
	pandocPreviewWriterQuickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;
	pandocExportWriterQuickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;
	pandocExportBuildConfigs: Map<string, PandocExportBuildConfig> | undefined;
	lastExportFileNameNoExt: string | undefined;
	lastExportFileExtension: string | undefined;
	lastExportWriterName: string | undefined;
	cacheKey: string;
	isNotebook: boolean;

	// Display
	// -------
	panel: vscode.WebviewPanel | undefined;
	extensionResourceWebviewRoots: Array<string>;
	webviewResourceUris: Record<string, vscode.Uri>;
	webviewResourceUrisEmbed: Record<string, string>;
	pandocResourcePaths: Record<string, string>;
	baseTag: string;
	contentSecurityNonce: string;
	usingContentSecurityNonce: boolean;
	contentSecurityTag: string;
	mdPreviewExtHtmlStyleAttr: string;
	codebraidPreviewJsTag: string;
	hasScrollSync: boolean;
	isScrollingEditorWithPreview: boolean;
	isScrollingEditorWithPreviewTimer: NodeJS.Timer | undefined;
	sourceOffset: number;
	sourceMap: Map<string, [number, number]>;
	isShowingUpdatingMessage: boolean;
	isShowingErrorMessage: boolean;
	updateTimer: NodeJS.Timer | undefined;
	moveCursorTextDecoration: vscode.TextEditorDecorationType;
	moveCursorTextDecorationTimer: NodeJS.Timer | undefined;
	updateConfigurationTimer: NodeJS.Timer | undefined;

	// Subprocess
	// ----------
	pandocPreviewArgs: Array<string>;
	pandocPreviewArgsEmbed: Array<string>;
	pandocCssArgs: Array<string>;
	pandocCssArgsEmbed: Array<string>;
	pandocShowRawArgs: Array<string>;
	pandocWithCodebraidOutputArgs: Array<string>;
	pandocExportArgs: Array<string>;
	waitedForPythonExtensionActivation: boolean | undefined;
	codebraidCommand: Array<string> | null | undefined;
	codebraidArgs: Array<string>;
	pythonPathToCodebraidCommandCache: Map<string, Array<string>>;
	buildProcessOptions: child_process.ExecFileOptions;
	codebraidProcessOptions: child_process.SpawnOptions;
	lastBuildTime: number;
	needsBuild: boolean;
	isBuildInProgress: boolean;
	usingCodebraid: boolean;
	isCodebraidInProgress: boolean;
	hasCodebraidMessageErrors: boolean;
	didCheckInitialCodebraidCache: boolean;
	oldCodebraidOutput: Map<string, Array<string>>;
	currentCodebraidOutput: Map<string, Array<string>>;
	codebraidProcessingStatus: Map<string, boolean>;
	codebraidPlaceholderLangs: Map<string, string>;
	isExporting: boolean;

	constructor(editor: vscode.TextEditor | NotebookTextEditor, extension: ExtensionState, fileExtension: FileExtension) {
		this.disposables = [];

		this.extension = extension;
		this.fileExtension = fileExtension;

		this.cwd = path.dirname(editor.document.uri.fsPath);
		this.fileNames = [editor.document.fileName];
		this.uriCache = new Map();
		this.visibleEditor = editor;
		this.currentFileName = editor.document.fileName;
		const hash = crypto.createHash('sha1');
		hash.update(editor.document.fileName);
		this.cacheKey = hash.digest('base64url');
		this.isNotebook = 'isNotebook' in editor;

		// Wait to create defaults until the attributes needed are set
		this.documentPandocDefaultsFile = new PandocDefaultsFile(this);
		this.disposables.push(this.documentPandocDefaultsFile);

		const localResourceRootUris: Array<vscode.Uri> = [
			vscode.Uri.file(this.cwd),
			...extension.resourceRootUris,
		];
		if (vscode.workspace.workspaceFolders) {
			for (const folder of vscode.workspace.workspaceFolders) {
				localResourceRootUris.push(folder.uri);
			}
		}
		for (const root of extension.normalizedExtraLocalResourceRoots) {
			if (path.isAbsolute(root)) {
				localResourceRootUris.push(vscode.Uri.file(root));
			} else {
				localResourceRootUris.push(vscode.Uri.file(path.join(this.cwd, root)));
			}
		}
		this.panel = vscode.window.createWebviewPanel(
			'codebraidPreview', // Type
			'Codebraid Preview', // Panel title
			vscode.ViewColumn.Beside, // Editor column
			{   // Options
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: localResourceRootUris,
			}
		);
		// Cleanup may be triggered by the webview panel being closed.  Since
		// `retainContextWhenHidden` is true, the panel won't be disposed when
		// it isn't visible.
		this.panel.onDidDispose(
			() => {
				if (this.panel) {
					// Don't call `this.dispose()` when that initiated
					// disposal
					this.panel = undefined;
					this.dispose();
				}
			},
			this,
			this.disposables
		);
		this.extensionResourceWebviewRoots = [];
		for (const uri of extension.resourceRootUris) {
			this.extensionResourceWebviewRoots.push(
				// .asWebviewUri() gives URI for file handling, which needs to
				// be generalized for use as a root in content security policy
				`${this.panel.webview.asWebviewUri(uri)}/`.replace(/^https:\/\/[^\/]+\.([^.\/]+\.[^.\/]+)/, 'https://*.$1')
			);
		}
		this.webviewResourceUris = {};
		this.webviewResourceUrisEmbed = {};
		for (const [key, resource] of Object.entries(webviewResources)) {
			this.webviewResourceUris[key] = this.panel.webview.asWebviewUri(
				vscode.Uri.file(this.extension.context.asAbsolutePath(resource))
			);
			this.webviewResourceUrisEmbed[key] = url.pathToFileURL(this.extension.context.asAbsolutePath(resource)).toString();
		}
		this.pandocResourcePaths = {};
		for (const [key, value] of Object.entries(pandocResources)) {
			this.pandocResourcePaths[key] = this.extension.context.asAbsolutePath(value);
		}
		if (this.extension.pandocInfo?.defaultDataDir) {
			const dataDir = this.extension.pandocInfo.defaultDataDir;
			const pandocDefaultDataDir = this.convertStringToLiteralHtml(dataDir);
			const pandocDefaultDataDirAsFileUri = this.convertStringToLiteralHtml(url.pathToFileURL(dataDir).toString());
			const pandocDefaultDataDirAsWebviewUri = this.convertStringToLiteralHtml(this.panel.webview.asWebviewUri(vscode.Uri.file(dataDir)).toString());
			this.baseTag = [
				`<base`,
				`href="${this.panel.webview.asWebviewUri(vscode.Uri.file(this.cwd))}/"`,
				`data-pandocdefaultdatadir="${pandocDefaultDataDir}"`,
				`data-pandocdefaultdatadirasfileuri="${pandocDefaultDataDirAsFileUri}"`,
				`data-pandocdefaultdatadiraswebviewuri="${pandocDefaultDataDirAsWebviewUri}"`,
				`>`,
			].join(' ');
		} else {
			this.baseTag = `<base href="${this.panel.webview.asWebviewUri(vscode.Uri.file(this.cwd))}/">`;
		}
		this.contentSecurityNonce = this.getContentSecurityNonce();
		this.usingContentSecurityNonce = false;
		this.contentSecurityTag = this.getContentSecurityTag();
		this.mdPreviewExtHtmlStyleAttr = this.getMdPreviewExtHtmlStyleAttr();
		this.codebraidPreviewJsTag = `<script type="module" src="${this.webviewResourceUris.codebraidPreviewJs}"></script>`;
		this.hasScrollSync = false;
		this.isScrollingEditorWithPreview = false;
		this.sourceOffset = 0;
		this.sourceMap = new Map();
		this.isShowingUpdatingMessage = true;
		this.isShowingErrorMessage = false;
		this.moveCursorTextDecoration = vscode.window.createTextEditorDecorationType({backgroundColor: 'cornflowerblue', isWholeLine: true});
		this.disposables.push(this.moveCursorTextDecoration);
		this.showUpdatingMessage(null, null);

		this.pandocPreviewArgs = [
			`--standalone`,
			`--lua-filter="${this.pandocResourcePaths.sourceposSyncFilter}"`,
			`--katex=${this.webviewResourceUris.katex}/`,
		];
		this.pandocPreviewArgsEmbed = [
			...this.pandocPreviewArgs.filter(elem => !elem.startsWith('--katex')),
			`--katex=${this.webviewResourceUrisEmbed.katex}/`,
		];
		if (this.isNotebook) {
			this.pandocPreviewArgs.push(`--extract-media="${extractedMediaDirectory}/${this.cacheKey}"`);
			// Not needed for embed
		}
		this.pandocCssArgs = [];
		this.pandocCssArgsEmbed = [];
		for (const key of Object.keys(this.webviewResourceUris)) {
			if (key.endsWith('Css')) {
				this.pandocCssArgs.push(`--css=${this.webviewResourceUris[key]}`);
				this.pandocCssArgsEmbed.push(`--css=${this.webviewResourceUrisEmbed[key]}`);
			}
		}
		this.pandocShowRawArgs = [
			`--lua-filter="${this.pandocResourcePaths.showRawFilter}"`,
		];
		this.pandocWithCodebraidOutputArgs = [
			`--lua-filter="${this.pandocResourcePaths.codebraidOutputFilter}"`,
		];
		this.pandocExportArgs = [
			'--standalone',
		];
		this.codebraidArgs = [
			'pandoc',
			'--only-code-output', 'codebraid_preview',
			'--stdin-json-header',
		];
		this.pythonPathToCodebraidCommandCache = new Map();
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
		this.codebraidProcessingStatus = new Map();
		this.codebraidPlaceholderLangs = new Map();
		this.lastBuildTime = 0;
		this.needsBuild = true;
		this.isBuildInProgress = false;
		this.isCodebraidInProgress = false;
		this.hasCodebraidMessageErrors = false;
		this.usingCodebraid = false;
		this.isExporting = false;

		if (editor instanceof NotebookTextEditor) {
			vscode.workspace.onDidSaveNotebookDocument(
				this.onDidSaveNotebookDocument,
				this,
				this.disposables
			);
		} else {
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
			vscode.workspace.onDidChangeTextDocument(
				this.onDidChangeTextDocument,
				this,
				this.disposables
			);
			vscode.workspace.onDidSaveTextDocument(
				this.onDidSaveTextDocument,
				this,
				this.disposables
			);
		}

		this.updateConfiguration();
	}

	registerOnDisposeCallback(callback: () => void) {
		this.onDisposeExtensionCallback = callback;
	}

	dispose() {
		if (this.panel) {
			const panel = this.panel;
			this.panel = undefined;
			panel.dispose();
		}
		for (const timer of [this.updateTimer, this.moveCursorTextDecorationTimer, this.updateConfigurationTimer]) {
			if (timer) {
				clearTimeout(timer);
			}
		}
		for (const quickPick of [this.pandocPreviewWriterQuickPick, this.pandocExportWriterQuickPick]) {
			if (quickPick) {
				quickPick.dispose();
			}
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
		if (this.onDisposeExtensionCallback) {
			this.onDisposeExtensionCallback();
			this.onDisposeExtensionCallback = undefined;
		}
		if (this.isNotebook) {
			fs.promises.rm(
				path.join(this.cwd, extractedMediaDirectory, this.cacheKey),
				{force: true, recursive: true}
			);
		}
	}

	async updateConfiguration() {
		if (this.isBuildInProgress || this.isCodebraidInProgress || this.isExporting) {
			if (this.updateConfigurationTimer) {
				clearTimeout(this.updateConfigurationTimer);
			}
			this.updateConfigurationTimer = setTimeout(
				() => {
					this.updateConfigurationTimer = undefined;
					if (!this.panel) {
						return;
					}
					this.updateConfiguration();
				},
				50
			);
			return;
		}
		this.resetContentSecurity();
		this.mdPreviewExtHtmlStyleAttr = this.getMdPreviewExtHtmlStyleAttr();

		this.pandocInfo = undefined;
		this.lastPandocPreviewOptions = this.pandocPreviewOptions;
		this.pandocPreviewOptions = undefined;
		this.lastPandocPreviewBuildConfig = this.pandocPreviewBuildConfig;
		this.pandocPreviewBuildConfig = undefined;
		this.pandocExportBuildConfigs = undefined;
		for (const quickPick of [this.pandocPreviewWriterQuickPick, this.pandocExportWriterQuickPick]) {
			if (quickPick) {
				quickPick.dispose();
			}
		}
		this.documentPandocDefaultsFile.update(() => {
			this.updateFileNames();
			this.updatePandocConfigs();
		});
	}

	private updateFileNames() {
		if (this.documentPandocDefaultsFile.isRelevant && this.documentPandocDefaultsFile.data?.inputFiles) {
			this.fileNames = this.documentPandocDefaultsFile.data?.inputFiles;
			if (this.previousFileName && this.fileNames.indexOf(this.previousFileName) === -1) {
				this.previousFileName = undefined;
			}
		} else {
			this.fileNames = [this.currentFileName];
			this.previousFileName = undefined;
		}
	}

	private updatePandocConfigs() {
		let buildConfigCollection: PandocBuildConfigCollection | undefined;
		buildConfigCollection = this.extension.pandocBuildConfigCollections.getConfigCollection(this.fileExtension);
		if (!buildConfigCollection && (!this.documentPandocDefaultsFile.isRelevant || !this.documentPandocDefaultsFile.data?.hasReader)) {
			buildConfigCollection = this.extension.pandocBuildConfigCollections.getFallbackConfigCollection(this.fileExtension);
			if (buildConfigCollection) {
				vscode.window.showWarningMessage([
					`"pandoc.build" settings for ${this.fileExtension} are missing or invalid;`,
					`default fallback preview settings will be used until this is fixed`,
				].join(' '));
			} else {
				vscode.window.showErrorMessage([
					`"pandoc.build" settings for ${this.fileExtension} are missing or invalid;`,
					`preview update will be disabled until this is fixed`,
				].join(' '));
				return;
			}
		}
		this.pandocExportBuildConfigs = buildConfigCollection?.export;

		let previewBuildConfig: PandocPreviewBuildConfig | undefined;
		if (!buildConfigCollection) {
			this.updatePandocPreviewBuildConfigAndSettings(previewBuildConfig);
			return;
		}
		if (this.documentPandocDefaultsFile.isRelevant && this.documentPandocDefaultsFile.data?.rawWriterString) {
			const rawWriterString = this.documentPandocDefaultsFile.data.rawWriterString;
			if (this.lastPandocPreviewOptions?.writer?.asPandocString === rawWriterString) {
				previewBuildConfig = buildConfigCollection.preview.get(this.lastPandocPreviewOptions.writer.name);
			}
			if (previewBuildConfig) {
				this.updatePandocPreviewBuildConfigAndSettings(previewBuildConfig);
				return;
			}
			let possibleConfigCount: number = 0;
			for (const buildConfig of buildConfigCollection.preview.values()) {
				if (buildConfig.writer.asPandocString === rawWriterString) {
					possibleConfigCount += 1;
					previewBuildConfig = buildConfig;
				}
			}
			if (possibleConfigCount <= 1) {
				this.updatePandocPreviewBuildConfigAndSettings(previewBuildConfig);
			} else {
				this.updatePandocPreviewBuildConfigAndSettingsQuickPick(buildConfigCollection);
			}
			return;
		}
		// There is always at least one config, a fallback for HTML
		if (buildConfigCollection.preview.size === 1) {
			previewBuildConfig = buildConfigCollection.preview.values().next().value;
		} else if (this.lastPandocPreviewOptions?.writer) {
			previewBuildConfig = buildConfigCollection.preview.get(this.lastPandocPreviewOptions.writer.name);
		}
		if (previewBuildConfig) {
			this.updatePandocPreviewBuildConfigAndSettings(previewBuildConfig);
		} else {
			this.updatePandocPreviewBuildConfigAndSettingsQuickPick(buildConfigCollection);
		}
	}

	private updatePandocPreviewBuildConfigAndSettings(previewBuildConfig: PandocPreviewBuildConfig | undefined) {
		// `updatePandocConfigs()` guarantees that there is either a build
		// config or a defaults reader.  It does not guarantee a writer when
		// there is no build config, so an HTML fallback is used in that case.
		// When `documentPandocDefaultsFile.data?.has<Reader|Writer>`,
		// `documentPandocDefaultsFile.data.extracted<Reader|Writer>` will be
		// either a string or `undefined`.  If `undefined`, then the
		// reader/writer is in the defaults file and will be set there during
		// build.
		this.pandocPreviewBuildConfig = previewBuildConfig;

		let reader: PandocReader | undefined;
		let writer: PandocWriter | undefined;
		let fileScope: boolean | undefined;
		let embedResources: boolean | undefined;

		if (this.documentPandocDefaultsFile.isRelevant && this.documentPandocDefaultsFile.data?.hasReader) {
			reader = this.documentPandocDefaultsFile.data.extractedReader;
		} else {
			reader = previewBuildConfig?.reader;
		}

		if (this.documentPandocDefaultsFile.isRelevant && this.documentPandocDefaultsFile.data?.hasWriter) {
			writer = this.documentPandocDefaultsFile.data.extractedWriter;
		} else if (previewBuildConfig) {
			writer = previewBuildConfig.writer;
		} else {
			writer = fallbackHtmlWriter;
		}

		// Document defaults have precedence over settings defaults.  Options
		// override everything.
		if (previewBuildConfig && previewBuildConfig.defaultsFileScope !== undefined) {
			fileScope = previewBuildConfig.defaultsFileScope;
		}
		if (this.documentPandocDefaultsFile.isRelevant && this.documentPandocDefaultsFile.data?.fileScope !== undefined) {
			fileScope = this.documentPandocDefaultsFile.data.fileScope;
		}
		if (previewBuildConfig && previewBuildConfig.optionsFileScope !== undefined) {
			fileScope = previewBuildConfig.optionsFileScope;
		}
		// `--embed-resources` option currently exists, but `embed-resources`
		// default does not.  Support the default in case Pandoc adds it in
		// the future.  Pandoc will raise an error for unknown defaults.
		// Support deprecated `self-contained` as well.  Only handle the case
		// `self-contained` set to `true`, after handling `embed-resources`,
		// so that resources are embedded if either is set `true` at a given
		// precedence level.
		if (previewBuildConfig && typeof(previewBuildConfig.defaults['embed-resources']) === 'boolean') {
			embedResources = previewBuildConfig.defaults['embed-resources'];
		}
		if (previewBuildConfig && previewBuildConfig.defaults['self-contained'] === true) {
			embedResources = true;
		}
		if (this.documentPandocDefaultsFile.isRelevant && this.documentPandocDefaultsFile.data?.yaml) {
			if (typeof(this.documentPandocDefaultsFile.data.yaml['embed-resources']) === 'boolean') {
				embedResources = this.documentPandocDefaultsFile.data.yaml['embed-resources'];
			}
			if (this.documentPandocDefaultsFile.data.yaml['self-contained'] === true) {
				embedResources = true;
			}
		}
		if (previewBuildConfig && previewBuildConfig.options.indexOf('--embed-resources') !== -1) {
			embedResources = true;
		}
		if (previewBuildConfig && previewBuildConfig.options.indexOf('--self-contained') !== -1) {
			embedResources = true;
		}

		if (fileScope && !reader?.canFileScope) {
			const message = [];
			if (reader) {
				message.push(`The setting "file-scope" is not supported for the current input format "${reader.asPandocString}", so it will be ignored.`);
			} else if (this.documentPandocDefaultsFile.isRelevant && this.documentPandocDefaultsFile.data?.hasReader) {
				message.push(`The setting "file-scope" is not supported for the current input format "${this.documentPandocDefaultsFile.data?.rawReaderString}", so it will be ignored.`);
			} else {
				message.push(`The setting "file-scope" is not supported for the current input format, so it will be ignored.`);
			}
			message.push(
				`This setting is only currently supported for built-in Pandoc formats ${Array.from(readersWithWrapper).join(', ')}.`,
				`It is also supported for custom readers that have a "+file_scope" extension and are explicitly set to use that extension ("<reader>+file_scope").`
			);
			vscode.window.showErrorMessage(message.join(' '));
			fileScope = false;
		}

		this.pandocInfo = this.extension.pandocInfo;
		this.pandocPreviewOptions = {
			reader: reader,
			writer: writer,
			fileScope: fileScope,
			embedResources: embedResources,
		};
		this.update();
	}

	private updatePandocPreviewBuildConfigAndSettingsQuickPick(buildConfigCollection: PandocBuildConfigCollection) {
		if (this.pandocPreviewWriterQuickPick) {
			this.pandocPreviewWriterQuickPick.dispose();
		}
		const quickPick = vscode.window.createQuickPick();
		this.pandocPreviewWriterQuickPick = quickPick;
		quickPick.title = 'Select preview format';
		quickPick.ignoreFocusOut = true;
		const pickItems: Array<{'label': string}> = [];
		if (this.documentPandocDefaultsFile.isRelevant && this.documentPandocDefaultsFile.data?.rawWriterString) {
			const rawWriterString = this.documentPandocDefaultsFile.data.rawWriterString;
			for (const [name, buildConfig] of buildConfigCollection.preview) {
				if (name === rawWriterString || buildConfig.writer.asPandocString === rawWriterString) {
					pickItems.push({label: name});
				}
			}
		} else {
			for (const name of buildConfigCollection.preview.keys()) {
				pickItems.push({label: name});
			}
		}
		quickPick.items = pickItems;
		quickPick.onDidHide(() => {
			if (this.pandocPreviewWriterQuickPick) {
				const picked = pickItems[0].label;
				this.pandocPreviewWriterQuickPick.dispose();
				this.pandocPreviewWriterQuickPick = undefined;
				const previewBuildConfig: PandocPreviewBuildConfig | undefined = buildConfigCollection?.preview.get(picked);
				this.updatePandocPreviewBuildConfigAndSettings(previewBuildConfig);
			}
		});
		quickPick.onDidAccept(() => {
			if (this.pandocPreviewWriterQuickPick) {
				const picked = this.pandocPreviewWriterQuickPick.activeItems[0].label;
				this.pandocPreviewWriterQuickPick.dispose();
				this.pandocPreviewWriterQuickPick = undefined;
				const previewBuildConfig: PandocPreviewBuildConfig | undefined = buildConfigCollection?.preview.get(picked);
				this.updatePandocPreviewBuildConfigAndSettings(previewBuildConfig);
			}
		});
		quickPick.show();
	}

	getMdPreviewExtHtmlStyleAttr() : string {
		// Create a style attribute for use in the preview <html> tag to set
		// font-related properties.  This allows font settings to be
		// inherited from the built-in Markdown preview.  Reference:
		// https://github.com/microsoft/vscode/blob/b7415cacddd44db3543b74eb9296cadc358762a7/extensions/markdown-language-features/src/preview/documentRenderer.ts#L88
		const mdPreviewExtConfig = vscode.workspace.getConfiguration('markdown.preview');
		const styleAttr = [
			mdPreviewExtConfig.fontFamily ? `--markdown-font-family: ${mdPreviewExtConfig.fontFamily};` : '',
			isNaN(mdPreviewExtConfig.fontSize) ? '' : `--markdown-font-size: ${mdPreviewExtConfig.fontSize}px;`,
			isNaN(mdPreviewExtConfig.lineHeight) ? '' : `--markdown-line-height: ${mdPreviewExtConfig.lineHeight};`,
		].join(' ').replace(/"/g, '&quot;');
		return styleAttr;
	}

	getContentSecurityNonce() : string {
		return crypto.randomBytes(16).toString('base64');
	}

	getContentSecurityTag() : string {
		if (!this.panel) {
			return '';
		}

		const security = this.extension.config.security;
		const contentSecurityOptions: Map<string, Array<string>> = new Map();
		// Each source is configured within its own block to scope variables
		// font-src
		{
			const fontSrc: Array<string> = [];
			contentSecurityOptions.set('font-src', fontSrc);
			if (security.allowLocalFonts) {
				fontSrc.push(this.panel.webview.cspSource);
			} else {
				fontSrc.push(...this.extensionResourceWebviewRoots);
			}
			if (security.allowRemoteFonts) {
				fontSrc.push('https:');
			}
			if (security.allowEmbeddedFonts) {
				fontSrc.push('data:');
			}
		}
		// img-src
		{
			const imgSrc: Array<string> = [];
			contentSecurityOptions.set('img-src', imgSrc);
			if (security.allowLocalImages) {
				imgSrc.push(this.panel.webview.cspSource);
			} else {
				imgSrc.push(...this.extensionResourceWebviewRoots);
			}
			if (security.allowRemoteImages) {
				imgSrc.push('https:');
			}
			if (security.allowEmbeddedImages) {
				imgSrc.push('data:');
			}
		}
		// media-src
		{
			const mediaSrc: Array<string> = [];
			contentSecurityOptions.set('media-src', mediaSrc);
			if (security.allowLocalMedia) {
				mediaSrc.push(this.panel.webview.cspSource);
			} else {
				mediaSrc.push(...this.extensionResourceWebviewRoots);
			}
			if (security.allowRemoteMedia) {
				mediaSrc.push('https:');
			}
			if (security.allowEmbeddedMedia) {
				mediaSrc.push('data:');
			}
		}
		// style-src
		{
			const styleSrc: Array<string> = [`'unsafe-inline'`];
			contentSecurityOptions.set('style-src', styleSrc);
			if (security.allowLocalStyles) {
				styleSrc.push(this.panel.webview.cspSource);
			} else {
				styleSrc.push(...this.extensionResourceWebviewRoots);
			}
			if (security.allowRemoteStyles) {
				styleSrc.push('https:');
			}
			if (security.allowEmbeddedStyles) {
				styleSrc.push('data:');
			}
		}
		// script-src
		{
			// sha256 hash is for Pandoc KaTeX script
			const scriptSrc: Array<string> = [`'sha256-67kRF6ir7uYcntligDJr9ckJ39fnGm98n5gLaDW7_a8='`];
			if (this.usingContentSecurityNonce) {
				scriptSrc.push(`'nonce-${this.contentSecurityNonce}'`);
			}
			contentSecurityOptions.set('script-src', scriptSrc);
			if (security.allowInlineScripts) {
				scriptSrc.push(`'unsafe-inline'`);
			}
			if (security.allowLocalScripts) {
				scriptSrc.push(this.panel.webview.cspSource);
			} else {
				scriptSrc.push(...this.extensionResourceWebviewRoots);
			}
			if (security.allowRemoteScripts) {
				scriptSrc.push('https:');
			}
			if (security.allowEmbeddedScripts) {
				scriptSrc.push('data:');
			}
		}

		const contentSecurityElems: Array<string> = [];
		for (const [src, opt] of contentSecurityOptions) {
			contentSecurityElems.push(`${src} ${opt.join(' ')};`);
		}
		const contentSecurityTag = [
			`<meta http-equiv="Content-Security-Policy"`,
			`content="default-src 'none'; `,
			contentSecurityElems.join(' '),
			`">`
		].join(' ');
		return contentSecurityTag;
	}

	resetContentSecurity() {
		if (this.usingContentSecurityNonce) {
			this.contentSecurityNonce = this.getContentSecurityNonce();
		}
		this.contentSecurityTag = this.getContentSecurityTag();
	}

	formatMessage(title: string, message: string) {
		let htmlStyle: string;
		if (this.extension.config.css.useMarkdownPreviewFontSettings) {
			htmlStyle = `style="${this.mdPreviewExtHtmlStyleAttr}"`;
		} else {
			htmlStyle = '';
		}
		return `<!DOCTYPE html>
<html lang="en" ${htmlStyle}>
<head>
	<meta charset="UTF-8">
	${this.baseTag}
	${this.contentSecurityTag}
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${this.webviewResourceUris.vscodeCss}">
	<link rel="stylesheet" href="${this.webviewResourceUris.vscodeCodiconCss}">
	<link rel="stylesheet" href="${this.webviewResourceUris.codebraidCss}">
	${this.codebraidPreviewJsTag}
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

	updatingMessageClassMap = new Map([
		['waiting',  'codebraid-updating codebraid-updating-waiting'],
		['running',  'codebraid-updating codebraid-updating-running'],
		['finished', 'codebraid-updating codebraid-updating-finished'],
	]);

	showUpdatingMessage(codebraidStatus: UpdatingStatus, pandocStatus: UpdatingStatus) {
		if (!this.panel) {
			return;
		}
		let messageList: Array<string> = [];
		if (codebraidStatus === null && pandocStatus === null) {
			messageList.push('<h1>Updating Codebraid Preview<span class="codebraid-updating-anim">...</span></h1>');
		} else {
			messageList.push('<h1>Updating Codebraid Preview...</h1>');
		}
		if (codebraidStatus !== null) {
			messageList.push(`<p class="${this.updatingMessageClassMap.get(codebraidStatus)}">Codebraid: load cache</p>`);
		}
		if (pandocStatus !== null) {
			messageList.push(`<p class="${this.updatingMessageClassMap.get(pandocStatus)}">Pandoc: convert</p>`);
		}
		this.panel.webview.html = this.formatMessage(
			'Updating Codebraid Preview...',
			messageList.join('\n')
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
			}
		}
	}

	onDidSaveTextDocument(document: vscode.TextDocument) {
		if (!this.panel) {
			return;
		}
		if (document.fileName === this.documentPandocDefaultsFile.fileName) {
			this.updateConfiguration();
		}
	}

	onDidSaveNotebookDocument(notebookDocument: vscode.NotebookDocument) {
		if (!this.panel) {
			return;
		}
		if (this.fileNames.indexOf(notebookDocument.uri.fsPath) !== -1) {
			// Notebooks need a delay.  Updating immediately can read the old
			// document before the new document is written.
			setTimeout(() => this.update(), 100);
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
			if (!this.hasScrollSync) {
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
			const fileStartEndLines = this.sourceMap.get(document.fileName);
			if (fileStartEndLines) {
				startLine += fileStartEndLines[0] - 1;
			} else {
				return;
			}
			startLine += this.sourceOffset;
			this.panel.webview.postMessage({
				command: 'codebraidPreview.scrollPreview',
				startLine: startLine,
			});
		}
	}

	onDidChangePreviewEditor(editor: vscode.TextEditor | NotebookTextEditor) {
		if (!this.panel) {
			return;
		}
		if (editor instanceof NotebookTextEditor) {
			return;
		}
		// Scroll preview when switching to a new editor for the first time.
		if (this.isScrollingEditorWithPreview) {
			return;
		}
		if (!this.hasScrollSync) {
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
		const fileStartEndLines = this.sourceMap.get(editor.document.fileName);
		if (fileStartEndLines) {
			startLine += fileStartEndLines[0] - 1;
		} else {
			return;
		}
		startLine += this.sourceOffset;
		this.panel.webview.postMessage({
			command: 'codebraidPreview.scrollPreview',
			startLine: startLine,
		});
	}

	async onDidReceiveMessage(message: any) {
		if (!this.panel) {
			return;
		}
		switch (message.command) {
			case 'codebraidPreview.scrollEditor': {
				if (!this.visibleEditor || !this.hasScrollSync) {
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
				// Preview line numbers are one-indexed
				let scrollStartLine: number = message.startLine - this.sourceOffset - 1;
				let scrollFileName: string | undefined = undefined;
				for (const [fileName, [fileStartLine, fileEndLine]] of this.sourceMap) {
					if (fileStartLine <= scrollStartLine && scrollStartLine <= fileEndLine) {
						scrollFileName = fileName;
						scrollStartLine -= fileStartLine - 1;
						break;
					}
				}
				if (!scrollFileName) {
					return;
				}
				const viewColumn = this.visibleEditor.viewColumn;
				const document = await vscode.workspace.openTextDocument(scrollFileName);
				const editor = await vscode.window.showTextDocument(document, viewColumn, true);
				this.visibleEditor = editor;
				if (!this.panel) {
					return;
				}
				if (scrollStartLine < 0) {
					return;
				}
				const range = new vscode.Range(scrollStartLine, 0, scrollStartLine, 0);
				editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
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
				let cursorFileName: string | undefined;
				// Preview line numbers are one-indexed
				let cursorStartLine: number = message.startLine - this.sourceOffset - 1;
				// Don't adjust column index from one-indexed, so that after
				// rather than before character
				const cursorColumn: number = message.startColumn ? message.startColumn : 0;
				for (const [fileName, [fileStartLine, fileEndLine]] of this.sourceMap) {
					if (fileStartLine <= cursorStartLine && cursorStartLine <= fileEndLine) {
						cursorFileName = fileName;
						cursorStartLine -= fileStartLine - 1;
						break;
					}
				}
				if (!cursorFileName) {
					return;
				}
				const viewColumn = this.visibleEditor.viewColumn;
				const document = await vscode.workspace.openTextDocument(cursorFileName);
				if (!this.panel) {
					return;
				}
				const editor = await vscode.window.showTextDocument(document, viewColumn);
				this.visibleEditor = editor;
				if (!this.panel) {
					return;
				}
				const position = new vscode.Position(cursorStartLine, cursorColumn);
        		const selection = new vscode.Selection(position, position);
        		editor.selection = selection;
				const range = new vscode.Range(cursorStartLine, 0, cursorStartLine, 0);
				editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
				editor.setDecorations(this.moveCursorTextDecoration, [range]);
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
				if (this.moveCursorTextDecorationTimer) {
					// Clear the timer, but no need to clear the decorations
					// because that happens automatically when the new
					// decorations are set
					clearTimeout(this.moveCursorTextDecorationTimer);
				}
				this.moveCursorTextDecorationTimer = setTimeout(
					() => {
						editor.setDecorations(this.moveCursorTextDecoration, []);
						this.moveCursorTextDecorationTimer = undefined;
					},
					500);
				return;
			}
		}
	}

	switchEditor(editor: vscode.TextEditor | NotebookTextEditor) {
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


	showPreviewError(executable: string, error: child_process.ExecFileException) {
		if (!this.panel) {
			return;
		}
		this.isShowingUpdatingMessage = false;
		this.isShowingErrorMessage = true;
		this.panel.webview.html = this.formatMessage(
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
	}

	showPreviewEmpty() {
		if (!this.panel) {
			return;
		}
		this.isShowingUpdatingMessage = false;
		this.isShowingErrorMessage = true;
		this.panel.webview.html = this.formatMessage('', '');
	}

	showPreviewHtml(html: string) {
		if (!this.panel) {
			return;
		}
		this.isShowingUpdatingMessage = false;
		this.isShowingErrorMessage = false;
		let match = /<head>[ \t\r\n]*<meta charset="[a-zA-Z0-9_-]+" +\/>[ \t\r]*\n/.exec(html);
		if (html.indexOf(`<head>`) === match?.index) {
			let htmlStart = html.slice(0, match.index);
			if (this.extension.config.css.useMarkdownPreviewFontSettings) {
				htmlStart = htmlStart.replace('<html', `<html style="${this.mdPreviewExtHtmlStyleAttr}"`);
			}
			const newHeadCharsetPreviewTags = [
				match[0].trimEnd(),
				this.baseTag,
				this.contentSecurityTag,
				this.codebraidPreviewJsTag,
				// Timestamp ensures that preview updates when HTML is
				// otherwise unmodified.  This may occur when changes are
				// quickly undone.  The preview must still update to clear any
				// DOM modifications such as temp alerts.
				`<!-- Build time: ${this.lastBuildTime} -->\n`,
			].join('\n  ');
			const htmlEnd = html.slice(match.index + match[0].length);
			const patchedHtml = [
				htmlStart,
				newHeadCharsetPreviewTags,
				htmlEnd,
			].join('');
			this.panel.webview.html = patchedHtml;
		} else {
			this.isShowingErrorMessage = true;
			this.panel.webview.html = this.formatMessage(
				'Codebraid Preview',
				[
					'<h1 style="color:red;">Codebraid Preview Error</h1>',
					'<h2>Pandoc returned unexpected, potentially invalid HTML:</h2>',
					'<pre style="white-space: pre-wrap;">',
					this.convertStringToLiteralHtml(html),
					'</pre>',
					''
				].join('\n')
			);
		}
	}


	async getSources(fileNames: Array<string>, reader?: PandocReader) : Promise<Sources | undefined> {
		let sources: Sources = [];
		for (let fileName of fileNames) {
			let fileText: string;
			try {
				let fileDocument = await vscode.workspace.openTextDocument(fileName);
				fileText = fileDocument.getText();
			} catch {
				if (!this.panel) {
					return undefined;
				}
				vscode.window.showErrorMessage(`Missing input file "${fileName}"`);
				return undefined;
			}
			const fileTextLines = countNewlines(fileText);
			let endPaddingText: string = '';
			let totalTextLines: number = fileTextLines;
			if (fileText.slice(0, -2) !== '\n\n') {
				if (fileText.slice(0, -1) === '\n') {
					endPaddingText = '\n';
					totalTextLines += 1;
				} else {
					endPaddingText = '\n\n';
					totalTextLines += 2;
				}
			}
			sources.push({
				index: sources.length,
				fileName: fileName, fileText: fileText, fileTextLines: fileTextLines,
				endPaddingText: endPaddingText, totalTextLines: totalTextLines,
			});
			if (!this.usingCodebraid && reader?.canCodebraid) {
				if (reader.isCommonmark) {
					if (fileText.indexOf('.cb-') !== -1) {
						this.usingCodebraid = true;
					}
				} else if (fileText.indexOf('.cb-') !== -1 || fileText.indexOf('.cb.') !== -1) {
					this.usingCodebraid = true;
				}
			}
		}
		return sources;
	}


	async getPythonExecCommand(): Promise<Array<string> | undefined> {
		// Get Python command currently set in Python extension
		const pythonExtension = vscode.extensions.getExtension('ms-python.python');
		if (!pythonExtension) {
			return undefined;
		}
		if (!pythonExtension.isActive) {
			await pythonExtension.activate();
			if (!this.panel) {
				return undefined;
			}
		}
		let currentUri: vscode.Uri | undefined = this.uriCache.get(this.currentFileName);
		if (!currentUri) {
			currentUri = vscode.Uri.file(this.currentFileName);
			this.uriCache.set(this.currentFileName, currentUri);
		}
		// To get execCommand from microsoft/vscode-python extension:
		// interface IExtensionApi
		// https://github.com/microsoft/vscode-python/issues/12596
		// https://github.com/microsoft/vscode-python/blob/3698950c97982f31bb9dbfc19c4cd8308acda284/src/client/api.ts
		// Work around https://github.com/microsoft/vscode-python/issues/15467
		// following the approach used in the mypy extension:
		// https://github.com/matangover/mypy-vscode/blob/48162f345c7f14b96f29976660100ae1dd49cc0a/src/extension.ts#L694
		let pythonExecCommand: Array<string> | undefined = pythonExtension.exports.settings.getExecutionDetails(currentUri).execCommand;
		if (!pythonExecCommand) {
			// Setting scoped to the first workspace folder, or global fallback
			pythonExecCommand = pythonExtension.exports.settings.getExecutionDetails(undefined).execCommand;
		}
		if (!this.waitedForPythonExtensionActivation) {
			if (pythonExecCommand && pythonExecCommand.length === 1 && pythonExecCommand[0] === 'python') {
				let seconds = 0;
				while (seconds < 5 && this.panel) {
					await new Promise((resolve) => setTimeout(resolve, 1000));
					seconds += 1;
					pythonExecCommand = pythonExtension.exports.settings.getExecutionDetails(currentUri).execCommand;
					if (!pythonExecCommand) {
						pythonExecCommand = pythonExtension.exports.settings.getExecutionDetails(undefined).execCommand;
					}
					if (!pythonExecCommand || pythonExecCommand.length !== 1 || pythonExecCommand[0] !== 'python') {
						break;
					}
				}
			}
			this.waitedForPythonExtensionActivation = true;
			this.extension.log(
				`Retrieving initial Python exec command from Python extension:\n    ${pythonExecCommand?.join(' ')}`
			);
		}
		return pythonExecCommand;
	}


	async setCodebraidCommand() {
		let codebraidCommand: Array<string> = [];
		let isCodebraidCompatible: boolean | null | undefined;
		let pythonPath: string | undefined;
		const pythonExecCommand = await this.getPythonExecCommand();
		if (pythonExecCommand) {
			if (pythonExecCommand.length === 1) {
				pythonPath = pythonExecCommand[0];
			} else {
				for (const elem of pythonExecCommand) {
					if (elem.includes('python')) {
						pythonPath = elem;
						break;
					}
				}
			}
		}
		if (!pythonPath) {
			pythonPath = vscode.workspace.getConfiguration('python').defaultInterpreterPath;
		}
		if (pythonPath && this.pythonPathToCodebraidCommandCache.has(pythonPath)) {
			this.codebraidCommand = this.pythonPathToCodebraidCommandCache.get(pythonPath);
			return;
		}
		if (pythonPath) {
			const pythonPathElems: Array<string> = pythonPath.replaceAll('\\', '/').split('/');
			if (pythonPathElems.length > 1 && pythonPathElems.at(-1)?.includes('python')) {
				pythonPathElems.pop();  // Remove python executable
				let binaryDir: string | undefined;
				if (pythonPathElems.at(-1) === 'bin' || pythonPathElems.at(-1) === 'Scripts') {
					binaryDir = pythonPathElems.at(-1);
					pythonPathElems.pop();
				}
				const pythonRootPath: string = pythonPathElems.join('/');
				const pythonRootPathQuoted: string = `"${pythonPathElems.join('/')}"`;
				try {
					await fs.promises.access(`${pythonRootPath}/conda-meta`, fs.constants.X_OK).then(() => {
						// Using full paths to avoid https://github.com/conda/conda/issues/11174
						codebraidCommand.push(...['conda', 'run', '--prefix', pythonRootPathQuoted, '--no-capture-output']);
					});
				} catch {
				}
				codebraidCommand.push(`${pythonRootPathQuoted}/${binaryDir ? binaryDir : 'Scripts'}/codebraid`);
				isCodebraidCompatible = await checkCodebraidVersion(codebraidCommand);
			}
		}
		if (isCodebraidCompatible === undefined) {
			codebraidCommand = ['codebraid'];
			isCodebraidCompatible = await checkCodebraidVersion(codebraidCommand);
			if (isCodebraidCompatible && pythonPath) {
				if (this.codebraidCommand === undefined || (Array.isArray(this.codebraidCommand) &&
						(this.codebraidCommand.length !== 1 || this.codebraidCommand[0] !== 'codebraid'))) {
					vscode.window.showWarningMessage([
						`The Python interpreter selected in VS Code does not have codebraid installed or it could not be found.`,
						`Falling back to codebraid on PATH.`
					].join(' '));
					this.extension.log([
						`Could not find codebraid installation as part of Python interpreter selected in VS code:`,
						`    ${pythonPath}`,
						`Falling back to codebraid on PATH.`
					].join('\n'));
				}
			}
		}
		if (isCodebraidCompatible === undefined) {
			this.codebraidCommand = undefined;
			vscode.window.showErrorMessage([
				`Could not find codebraid executable.`,
				`Code execution is disabled.`,
				`Install from https://pypi.org/project/codebraid/, ${minCodebraidVersionString}+.`,
			].join(' '));
		} else if (isCodebraidCompatible === null) {
			this.codebraidCommand = null;
			vscode.window.showErrorMessage([
				`Codebraid executable failed to return version information.`,
				`Code execution is disabled.`,
				`Consider reinstalling from https://pypi.org/project/codebraid/, ${minCodebraidVersionString}+.`,
			].join(' '));
		} else if (isCodebraidCompatible === false) {
			this.codebraidCommand = null;
			vscode.window.showErrorMessage([
				`Codebraid executable is outdated and unsupported.`,
				`Code execution is disabled.`,
				`Upgrade to ${minCodebraidVersionString}+ at https://pypi.org/project/codebraid/.`,
			].join(' '));
		} else {
			if (this.codebraidCommand === undefined) {
				this.extension.log(`Setting initial Codebraid command:\n    ${codebraidCommand.join(' ')}`);
			}
			this.codebraidCommand = codebraidCommand;
			if (pythonPath && (codebraidCommand.length !== 1 || codebraidCommand[0] !== 'codebraid')) {
				this.pythonPathToCodebraidCommandCache.set(pythonPath, codebraidCommand);
			}
		}
	}


	sourcesToJsonHeader(sources: Sources) : string {
		const pandocSources: Array<{name: string, lines: number}> = [];
		for (const source of sources) {
			pandocSources.push({name: source.fileName, lines: source.totalTextLines});
		}
		return JSON.stringify({sources: pandocSources}) + '\n';
	}

	async update() {
		if (!this.panel) {
			this.needsBuild = false;
			return;
		} else {
			this.needsBuild = true;
		}

		if (this.updateTimer || this.isBuildInProgress || !this.pandocPreviewOptions || !this.pandocInfo) {
			return;
		}

		if (!this.panel.visible) {
			// There currently isn't an event for the webview becoming visible
			this.updateTimer = setTimeout(
				() => {
					this.updateTimer = undefined;
					this.update();
				},
				this.extension.config.minBuildInterval
			);
			return;
		}

		let timeNow = Date.now();
		if (this.lastBuildTime + this.extension.config.minBuildInterval > timeNow) {
			this.updateTimer = setTimeout(
				() => {
					this.updateTimer = undefined;
					this.update();
				},
				this.lastBuildTime + this.extension.config.minBuildInterval - timeNow
			);
			return;
		}

		this.isBuildInProgress = true;
		this.needsBuild = false;
		this.lastBuildTime = timeNow;

		const maybeSources: Sources | undefined = await this.getSources(this.fileNames, this.pandocPreviewOptions.reader);
		if (!this.panel || !maybeSources) {
			this.isBuildInProgress = false;
			return;
		}
		const sources: Sources = maybeSources;

		if (this.usingCodebraid && !this.didCheckInitialCodebraidCache && !this.isCodebraidInProgress) {
			this.didCheckInitialCodebraidCache = true;
			if (this.isShowingUpdatingMessage) {
				this.showUpdatingMessage('running', 'waiting');
			}
			await this.runCodebraidNoExecute();
			if (!this.panel) {
				this.isBuildInProgress = false;
				return;
			}
			if (this.isShowingUpdatingMessage) {
				this.showUpdatingMessage('finished', 'running');
			}
		} else if (this.isShowingUpdatingMessage) {
			this.showUpdatingMessage(null, 'running');
		}

		const executable: string = this.pandocInfo.executable;
		const args: Array<string> = [];
		if (this.extension.config.css.useDefault && this.extension.config.css.overrideDefault) {
			if (this.pandocPreviewOptions.embedResources) {
				args.push(...this.pandocCssArgsEmbed);
			} else {
				args.push(...this.pandocCssArgs);
			}
		}
		if (this.pandocPreviewBuildConfig?.defaultsFileName) {
			// This needs quoting, since it involves an absolute path
			args.push('--defaults', `"${this.pandocPreviewBuildConfig.defaultsFileName}"`);
		}
		if (this.pandocPreviewBuildConfig?.options) {
			args.push(...this.pandocPreviewBuildConfig.options);
		}
		if (this.documentPandocDefaultsFile.processedFileName) {
			// This needs quoting, since it involves an absolute path
			args.push('--defaults', `"${this.documentPandocDefaultsFile.processedFileName}"`);
		}
		if (this.extension.config.css.useDefault && !this.extension.config.css.overrideDefault) {
			if (this.pandocPreviewOptions.embedResources) {
				args.push(...this.pandocCssArgsEmbed);
			} else {
				args.push(...this.pandocCssArgs);
			}
		}
		if (this.pandocPreviewOptions.embedResources) {
			args.push(...this.pandocPreviewArgsEmbed);
		} else {
			args.push(...this.pandocPreviewArgs);
		}
		if (this.extension.config.pandoc.showRaw) {
			args.push(...this.pandocShowRawArgs);
		}
		if (this.usingCodebraid) {
			args.push(...this.pandocWithCodebraidOutputArgs);
		}
		// Reader and writer don't need quoting, since they are either builtin
		// (`^[0-9a-z_+-]+$`) or are custom from `settings.json` (and thus
		// require any quoting by the user).  Readers/writers in preview
		// defaults file are only extracted and used here if they are builtin.
		if (this.pandocPreviewOptions.reader) {
			if (this.pandocInfo.supportsCodebraidWrappers) {
				if (this.pandocPreviewOptions.fileScope && this.pandocPreviewOptions.reader.canFileScope && !this.pandocPreviewOptions.reader.hasExtensionsFileScope) {
					// Any incompatibilities have already resulted in error
					// messages during configuration update
					args.push('--from', `${this.pandocPreviewOptions.reader.asArg}+file_scope`);
				} else {
					args.push('--from', this.pandocPreviewOptions.reader.asArg);
				}
			} else {
				args.push('--from', this.pandocPreviewOptions.reader.asArgNoWrapper);
			}
		}
		if (this.pandocPreviewOptions.writer) {
			args.push('--to', this.pandocPreviewOptions.writer.asArg);
		}

		// Store current scroll sync data in object, then swap out for new
		// data once document is written to pandoc stdin and new data is
		// calculated, and finally update preview panel once pandoc completes
		const scrollSyncData: ScrollSyncData = {
			offset: this.sourceOffset,
			map: this.sourceMap,
		};

		let buildProcess = child_process.execFile(
			executable,
			args,
			{...this.buildProcessOptions, env: {...process.env, ...this.pandocInfo.extraEnv}},
			(error, stdout, stderr) => {
				this.isBuildInProgress = false;
				if (!this.panel) {
					return;
				}
				if (this.usingContentSecurityNonce) {
					this.resetContentSecurity();
				}
				this.sourceOffset = scrollSyncData.offset;
				this.sourceMap = scrollSyncData.map;
				if (error) {
					let regex: RegExp;
					if (this.pandocPreviewOptions?.reader?.hasWrapper) {
						regex = /(?<=Error running Lua:\r?\n)Error at.+?(line.+?)(\d+)(.+?column.+?)(\d+).+?unexpected.+?(?=stack traceback:)/s;
					} else {
						regex = /Error at.+?(line.+?)(\d+)(.+?column.+?)(\d+).+?unexpected.+$/s;
					}
					let messageMatch = stderr.match(regex);
					if (messageMatch) {
						if (this.isShowingUpdatingMessage) {
							this.showPreviewEmpty();
						}
						let message: string;
						const errorLine = Number(messageMatch[2]);
						const errorColumn = Number(messageMatch[4]);
						let errorFileName: string | undefined;
						let errorFileLine: number | undefined;
						for (const [fileName, [fileStartLine, fileEndLine]] of this.sourceMap) {
							if (fileStartLine <= errorLine && errorLine <= fileEndLine) {
								errorFileName = fileName;
								errorFileLine = errorLine - fileStartLine + 1 - this.sourceOffset;
								break;
							}
						}
						if (errorFileName && errorFileLine) {
							const linked = [
								`<a href="#" class="codebraid-temp-alert-pos" data-codebraid-temp-alert-pos="${errorFileLine}:${errorColumn}">`,
								this.convertStringToLiteralHtml(messageMatch[1]),
								errorFileLine.toString(),
								this.convertStringToLiteralHtml(messageMatch[3]),
								errorColumn.toString(),
								`</a>`
							].join('');
							const [messageBefore, messageAfter] = messageMatch[0].split(messageMatch.slice(1).join(''), 2);
							message = [
								this.sourceMap.size > 1 ? this.convertStringToLiteralHtml(`In "${path.basename(errorFileName)}":\n`) : '',
								this.convertStringToLiteralHtml(messageBefore),
								linked,
								this.convertStringToLiteralHtml(messageAfter),
							].join('');
						} else {
							message = this.convertStringToLiteralHtml(messageMatch[0]);
						}
						this.panel.webview.postMessage({
							command: 'codebraidPreview.tempAlert',
							tempAlert: `<pre data-codebraid-title="Parse error">${message}</pre>\n`,
							alertType: 'parseError',
						});
					} else {
						this.hasScrollSync = false;
						this.showPreviewError(executable, error);
					}
				} else {
					// Order matters here because `showPreviewHtml()` changes
					// `isShowing*` status
					const switchingToPreview: boolean = this.isShowingUpdatingMessage || this.isShowingErrorMessage;
					this.hasScrollSync = this.pandocPreviewOptions?.reader?.canSourcepos || false;
					this.showPreviewHtml(stdout);
					if (stderr && this.extension.config.pandoc.showStderr !== 'never') {
						// Strip out standard warning message for HTML without
						// a title.  If this is relevant for the user's target
						// output format, a warning will be raised during
						// export.
						stderr = stderr.replace(/(?:^|(?<=\n))\[WARNING\] This document format requires a nonempty <title> element\.\s*?\r?\n\s+?\S.*?\r?\n\s+?\S.*?(?:\r?\n|$)/, '');
						const isWarning: boolean = stderr.toLowerCase().indexOf('warning') !== -1;
						if (this.extension.config.pandoc.showStderr === 'warning' && !isWarning) {
							stderr = '';
						}
						if (stderr) {
							this.panel.webview.postMessage({
								command: 'codebraidPreview.tempAlert',
								tempAlert: `<pre data-codebraid-title="stderr">${this.convertStringToLiteralHtml(stderr)}</pre>\n`,
								alertType: 'stderr',
								isWarning: isWarning,
							});
						}
					}
					if (switchingToPreview && this.visibleEditor) {
						this.onDidChangePreviewEditor(this.visibleEditor);
					}
				}
				if (this.needsBuild) {
					// This timer isn't tracked for disposal since it runs
					// within the next event loop cycle and thus will quickly
					// detect `dispose()`.
					setTimeout(() => {this.update();}, 0);
				}
			}
		);

		if (this.pandocInfo.supportsCodebraidWrappers && this.pandocPreviewOptions.reader?.hasWrapper) {
			buildProcess.stdin?.write(this.sourcesToJsonHeader(sources));
		}
		let nextSourceOffset: number = 0;
		let includingCodebraidOutput: boolean;
		if (this.usingCodebraid && (this.currentCodebraidOutput.size > 0 || this.oldCodebraidOutput.size > 0)) {
			includingCodebraidOutput = true;
		} else {
			includingCodebraidOutput = false;
		}
		if (includingCodebraidOutput) {
			let metadataStartList: Array<string> = [
				`---`,
				`codebraid_meta:`,
				`  commonmark: ${this.pandocPreviewOptions.reader?.isCommonmark || false}`,
				`  running: ${this.isCodebraidInProgress}`,
			];
			if (this.isCodebraidInProgress && this.codebraidProcessingStatus.size > 0) {
				metadataStartList.push(`  collection_processing:`);
				for (const [k, v] of this.codebraidProcessingStatus) {
					metadataStartList.push(`    "${k}": ${v}`);
				}
			}
			if (this.codebraidPlaceholderLangs.size > 0) {
				metadataStartList.push(`  placeholder_langs:`);
				for (const [k, v] of this.codebraidPlaceholderLangs) {
					metadataStartList.push(`    "${k}": "\`${v}\`"`);
				}
			}
			metadataStartList.push('codebraid_output:\n');
			let metadataStart = metadataStartList.join('\n');
			buildProcess.stdin?.write(metadataStart);
			// Offset ignores `---` for now, since document could start with
			// that sequence
			nextSourceOffset += countNewlines(metadataStart) - 1;
			let keySet = new Set();
			if (this.currentCodebraidOutput.size > 0) {
				for (const [key, yamlArray] of this.currentCodebraidOutput) {
					buildProcess.stdin?.write(`  "${key}":\n`);
					nextSourceOffset += 1;
					for (const yaml of yamlArray) {
						buildProcess.stdin?.write(yaml);
						nextSourceOffset += countNewlines(yaml);
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
					nextSourceOffset += 1;
					for (const yaml of yamlArray) {
						buildProcess.stdin?.write(yaml);
						nextSourceOffset += countNewlines(yaml);
					}
				}
			}
		}
		// Line numbers in webview are one-indexed
		let startLine: number = 0;
		let endLine: number = 0;
		const nextSourceMap: Map<string, [number, number]> = new Map();
		for (const source of sources) {
			if (source.index === 0 && includingCodebraidOutput) {
				if (yamlMetadataRegex.test(source.fileText)) {
					buildProcess.stdin?.write(source.fileText.slice(source.fileText.indexOf('\n') + 1));
				} else {
					buildProcess.stdin?.write('---\n\n');
					// Offset start+end delim lines, and trailing blank
					nextSourceOffset += 3;
					buildProcess.stdin?.write(source.fileText);
				}
			} else {
				buildProcess.stdin?.write(source.fileText);
			}
			if (source.endPaddingText) {
				buildProcess.stdin?.write(source.endPaddingText);
			}
			startLine = endLine + 1;
			endLine = startLine + source.totalTextLines - 1;
			if (!nextSourceMap.has(source.fileName)) {
				// For files included multiple times, use the first
				// occurrence.  Possible future feature:  Track the
				// location in the preview and try to use that information
				// to determine which occurrence to use.
				nextSourceMap.set(source.fileName, [startLine, endLine]);
			}
		}
		buildProcess.stdin?.end();
		scrollSyncData.offset = nextSourceOffset;
		scrollSyncData.map = nextSourceMap;
	}


	receiveCodebraidMessage(dataString: string) {
		let dataStringTrimmed = dataString.trim();
		if (dataStringTrimmed === '') {
			return;
		}
		let data: any;
		try {
			data = JSON.parse(dataStringTrimmed);
		} catch {
			this.extension.log(`Failed to process Codebraid output:\n${dataString}`);
			this.hasCodebraidMessageErrors = true;
			return;
		}
		if (data.message_type === 'index') {
			this.receiveCodebraidIndex(data);
		} else if (data.message_type === 'output') {
			this.receiveCodebraidOutput(data);
		} else {
			this.extension.log(`Received unexpected, unsupported Codebraid output:\n${dataString}`);
			this.hasCodebraidMessageErrors = true;
		}
	}

	receiveCodebraidIndex(data: any) {
		this.codebraidProcessingStatus = new Map();
		for (const codeCollection of data.code_collections) {
			let key: string = `${codeCollection.type}.${codeCollection.lang}.${codeCollection.name}`;
			this.codebraidProcessingStatus.set(key, true);
			let length: number = codeCollection.length;
			let yamlArray: Array<string>;
			let oldYamlArray = this.oldCodebraidOutput.get(key);
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
		this.codebraidPlaceholderLangs = new Map(Object.entries(data.placeholder_langs));
		this.update();
	}

	receiveCodebraidOutput(data: any) {
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
		if (yamlArray === undefined) {
			this.extension.log(`Unexpected Codebraid output for uninitialized "${key}"`);
			this.hasCodebraidMessageErrors = true;
			return;
		}
		// index is 1-based
		yamlArray[index-1] = yaml;
		if (index === length) {
			this.codebraidProcessingStatus.set(key, false);
		}
		this.update();
	}

	async runCodebraidExecute() {
		return this.runCodebraid(false);
	}

	async runCodebraidNoExecute() {
		return this.runCodebraid(true);
	}

	private async runCodebraid(noExecute: boolean) {
		if (!this.panel || this.isCodebraidInProgress) {
			return;
		}
		if (!this.pandocPreviewOptions || !this.pandocInfo) {
			vscode.window.showErrorMessage(
				'Cannot run Codebraid while configuration is updating or is invalid'
			);
			return;
		}
		if (!this.pandocPreviewOptions?.reader?.canCodebraid) {
			let message: string;
			if (this.pandocPreviewOptions.reader) {
				message = `Codebraid is not compatible with current input format "${this.pandocPreviewOptions.reader.asPandocString}"`;
			} else if (this.documentPandocDefaultsFile.data?.rawReaderString) {
				message = `Codebraid is not compatible with current input format "${this.documentPandocDefaultsFile.data.rawReaderString}"`;
			} else {
				message = `Codebraid is not compatible with current input format`;
			}
			vscode.window.showErrorMessage(message);
			return;
		}
		if (this.isExporting) {
			vscode.window.showErrorMessage(
				'Cannot run Codebraid while document is exporting; try again when export completes'
			);
			return;
		}

		// Typically, this will already be detected and set automatically
		// during file reading by searching for `.cb-` and `.cb.`
		this.usingCodebraid = true;
		this.isCodebraidInProgress = true;
		this.hasCodebraidMessageErrors = false;
		if (noExecute) {
			this.extension.statusBarConfig.setCodebraidRunningNoExecute();
		} else {
			this.extension.statusBarConfig.setCodebraidRunningExecute();
		}

		await this.setCodebraidCommand();
		if (!this.codebraidCommand || !this.panel) {
			this.extension.statusBarConfig.setCodebraidWaiting();
			this.isCodebraidInProgress = false;
			return;
		}

		// Update preview to start any progress indicators, etc.
		this.panel.webview.postMessage({
			command: 'codebraidPreview.startingCodebraid',
		});

		const maybeSources: Sources | undefined = await this.getSources(this.fileNames, this.pandocPreviewOptions.reader);
		if (!this.panel || !maybeSources) {
			this.extension.statusBarConfig.setCodebraidWaiting();
			this.isCodebraidInProgress = false;
			return;
		}
		const sources: Sources = maybeSources;
		const stdinOrigins: Array<{path: string, lines: number}> = [];
		for (const source of sources) {
			stdinOrigins.push({path: source.fileName, lines: source.totalTextLines});
		}

		const executable: string = this.codebraidCommand[0];
		const args: Array<string> = this.codebraidCommand.slice(1);
		args.push(...this.codebraidArgs);
		if (noExecute) {
			args.push('--no-execute');
		}
		if (this.extension.config.css.useDefault && this.extension.config.css.overrideDefault) {
			if (this.pandocPreviewOptions.embedResources) {
				args.push(...this.pandocCssArgsEmbed);
			} else {
				args.push(...this.pandocCssArgs);
			}
		}
		if (this.pandocPreviewBuildConfig?.defaultsFileName) {
			// This needs quoting, since it involves an absolute path
			args.push('--defaults', `"${this.pandocPreviewBuildConfig.defaultsFileName}"`);
		}
		if (this.pandocPreviewBuildConfig?.options) {
			args.push(...this.pandocPreviewBuildConfig.options);
		}
		if (this.documentPandocDefaultsFile.processedFileName) {
			// This needs quoting, since it involves an absolute path
			args.push('--defaults', `"${this.documentPandocDefaultsFile.processedFileName}"`);
		}
		if (this.extension.config.css.useDefault && !this.extension.config.css.overrideDefault) {
			if (this.pandocPreviewOptions.embedResources) {
				args.push(...this.pandocCssArgsEmbed);
			} else {
				args.push(...this.pandocCssArgs);
			}
		}
		// If Codebraid adds a --pre-filter or similar option, that would need
		// to be handled here.
		if (this.pandocPreviewOptions.embedResources) {
			args.push(...this.pandocPreviewArgsEmbed);
		} else {
			args.push(...this.pandocPreviewArgs);
		}
		if (this.pandocPreviewOptions.reader) {
			args.push('--from', this.pandocPreviewOptions.reader.asCodebraidArg);
		}
		if (this.pandocPreviewOptions.fileScope) {
			// Codebraid is not currently operating with the new Lua wrappers
			args.push('--file-scope');
		}
		if (this.pandocPreviewOptions.writer) {
			args.push('--to', this.pandocPreviewOptions.writer.asCodebraidArg);
		}

		this.oldCodebraidOutput = this.currentCodebraidOutput;
		this.currentCodebraidOutput = new Map();

		const stderrBuffer: Array<string> = [];
		const stdoutBuffer: Array<string> = [];
		let codebraidProcessExitStatus: number | string = await new Promise<number | string>((resolve) => {
			const codebraidProcess = child_process.spawn(
				executable,
				args,
				{...this.codebraidProcessOptions, env: {...process.env, ...this.pandocInfo?.extraEnv}}
			);
			codebraidProcess.stdin?.setDefaultEncoding('utf8');
			codebraidProcess.stdout?.setEncoding('utf8');
			codebraidProcess.stderr?.setEncoding('utf8');

			codebraidProcess.on('close', (exitCode: number) => {
				resolve(exitCode);
			});
			codebraidProcess.on('error', (error: any) => {
				resolve(`${error}`);
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
						this.receiveCodebraidMessage(jsonData);
					}
					stdoutBuffer.length = 0;
					stdoutBuffer.push(data.slice(index+1));
				}
			});
			codebraidProcess.stdin?.write(JSON.stringify({origins: stdinOrigins}));
			codebraidProcess.stdin?.write('\n');
			for (const source of sources) {
				codebraidProcess.stdin?.write(source.fileText);
				if (source.endPaddingText) {
					codebraidProcess.stdin?.write(source.endPaddingText);
				}
			}
			codebraidProcess.stdin?.end();
		});

		if (typeof(codebraidProcessExitStatus) === 'string') {
			const message = `Codebraid process failed: ${codebraidProcessExitStatus}`;
			vscode.window.showErrorMessage(message);
			this.extension.log(message);
			this.currentCodebraidOutput = this.oldCodebraidOutput;
		} else if (codebraidProcessExitStatus > 0 && codebraidProcessExitStatus < 4) {
			let message: string;
			if (stderrBuffer.length === 0) {
				message = `Codebraid process failed with exit code ${codebraidProcessExitStatus}. No stderr or other information is available.`;
				this.extension.log(message);
			} else {
				message = `Codebraid process failed with exit code ${codebraidProcessExitStatus}. See Output log for details.`;
				this.extension.log(`Codebraid process failed with exit code ${codebraidProcessExitStatus}:\n${stderrBuffer.join('')}`);
			}
			vscode.window.showErrorMessage(message);
			this.currentCodebraidOutput = this.oldCodebraidOutput;
		} else {
			for (const jsonData of stdoutBuffer.join('').split('\n')) {
				this.receiveCodebraidMessage(jsonData);
			}
		}
		this.extension.statusBarConfig.setCodebraidWaiting();
		this.codebraidProcessingStatus.clear();
		this.isCodebraidInProgress = false;
		if (this.hasCodebraidMessageErrors) {
			vscode.window.showErrorMessage('Received unexpected or invalid output from Codebraid. See Output log for details.');
		}
		this.update();
	}


	async export() {
		if (!this.pandocPreviewOptions || !this.pandocInfo) {
			vscode.window.showErrorMessage(
				'Cannot export while configuration is updating or is invalid'
			);
			return;
		}
		if (this.isNotebook && this.visibleEditor?.document.isDirty) {
			vscode.window.showErrorMessage(
				'Cannot export while notebook contains unsaved changes'
			);
			return;
		}
		if (this.isCodebraidInProgress) {
			vscode.window.showWarningMessage(
				'Exporting while Codebraid is running can result in incomplete output in the exported document.'
			);
		}

		this.isExporting = true;

		const maybeSources: Sources | undefined = await this.getSources(this.fileNames);
		if (!this.panel || !maybeSources) {
			this.isExporting = false;
			return;
		}
		const sources: Sources = maybeSources;

		if (!this.pandocExportBuildConfigs || this.pandocExportBuildConfigs.size === 0) {
			this.exportGetFileName(sources, undefined);
			return;
		}

		if (this.pandocExportWriterQuickPick) {
			this.pandocExportWriterQuickPick.dispose();
		}
		const quickPick = vscode.window.createQuickPick();
		this.pandocExportWriterQuickPick = quickPick;
		quickPick.title = 'Select Pandoc export format';
		const pickItems: Array<{label: string, description?: string, kind?: vscode.QuickPickItemKind.Separator}> = [];
		if (this.lastExportWriterName && this.pandocExportBuildConfigs.has(this.lastExportWriterName)) {
			pickItems.push({label: 'most recent', kind: vscode.QuickPickItemKind.Separator});
			pickItems.push({label: this.lastExportWriterName});
		}
		// If the "From file extension" label is selected, then
		// `pandocExportBuildConfigs.get(<label>)` returns `undefined`.  So a
		// writer is not defined and must be inferred by Pandoc.
		pickItems.push({label: '', kind: vscode.QuickPickItemKind.Separator});
		pickItems.push({label: 'From file extension', description: 'Pandoc determines export format from file extension'});
		pickItems.push({label: 'user defined', kind: vscode.QuickPickItemKind.Separator});
		for (const [key, buildConfig] of this.pandocExportBuildConfigs) {
			if (buildConfig.isPredefined) {
				continue;
			}
			pickItems.push({label: key});
		}
		if (pickItems.at(-1)?.kind) {
			pickItems.pop();
		}
		pickItems.push({label: 'predefined', kind: vscode.QuickPickItemKind.Separator});
		for (const [key, buildConfig] of this.pandocExportBuildConfigs) {
			if (!buildConfig.isPredefined) {
				continue;
			}
			pickItems.push({label: key});
		}
		if (pickItems.at(-1)?.kind) {
			pickItems.pop();
		}
		quickPick.items = pickItems;
		quickPick.onDidHide(() => {
			if (this.pandocExportWriterQuickPick) {
				this.pandocExportWriterQuickPick.dispose();
				this.pandocExportWriterQuickPick = undefined;
			}
			this.isExporting = false;
		});
		quickPick.onDidAccept(() => {
			if (this.pandocExportWriterQuickPick) {
				const picked = this.pandocExportWriterQuickPick.activeItems[0].label;
				this.pandocExportWriterQuickPick.dispose();
				this.pandocExportWriterQuickPick = undefined;
				const exportBuildConfig: PandocExportBuildConfig | undefined = this.pandocExportBuildConfigs?.get(picked);
				this.exportGetFileName(sources, exportBuildConfig);
			}
		});
		quickPick.show();
	}

	private async exportGetFileName(sources: Sources, pandocExportBuildConfig: PandocExportBuildConfig | undefined) {
		let defaultExportFileNameNoExt: string | undefined;
		if (this.lastExportFileNameNoExt) {
			defaultExportFileNameNoExt = this.lastExportFileNameNoExt;
		} else if (sources.length === 1) {
			const fileName = sources[0].fileName;
			if (fileName.endsWith(this.fileExtension.fullExtension)) {
				defaultExportFileNameNoExt = fileName.slice(0, -this.fileExtension.fullExtension.length);
			} else if (path.basename(fileName).lastIndexOf('.') !== -1) {
				defaultExportFileNameNoExt = fileName.slice(0, fileName.lastIndexOf('.'));
			}
		}
		let defaultExportUri: vscode.Uri | undefined;
		if (defaultExportFileNameNoExt) {
			defaultExportUri = vscode.Uri.file(defaultExportFileNameNoExt);
		}
		let defaultExportFileExtension: string | undefined;
		if (pandocExportBuildConfig?.writer.builtinBase) {
			defaultExportFileExtension = builtinToFileExtensionMap.get(pandocExportBuildConfig.writer.builtinBase);
		}
		if (!defaultExportFileExtension) {
			defaultExportFileExtension = this.lastExportFileExtension;
		}

		let saveDialogFilter: {[key: string]: Array<string>};
		let defaultFilterKey: string | undefined;
		if (defaultExportFileExtension) {
			defaultFilterKey = defaultSaveDialogFileExtensionToFilterKeyMap.get(defaultExportFileExtension);
		}
		if (!defaultFilterKey) {
			saveDialogFilter = defaultSaveDialogFilter;
		} else {
			// Attempt to select the correct file extension by default, and
			// put it at the top of the file-extension dropdown menu.
			// `defaultSaveDialogFilter` and
			// `defaultSaveDialogFileExtensionToFilterKeyMap` are created at
			// the same time from the same data, so there is no mismatch
			// between their contents.
			saveDialogFilter = {};
			saveDialogFilter[defaultFilterKey] = defaultSaveDialogFilter[defaultFilterKey];
			for (const [key, value] of Object.entries(defaultSaveDialogFilter)) {
				if (key !== defaultFilterKey) {
					saveDialogFilter[key] = value;
				}
			}
		}

		let saveLabel: string;
		if (pandocExportBuildConfig) {
			saveLabel = `Pandoc export (format "${pandocExportBuildConfig.writer.name}")`;
		} else {
			saveLabel = 'Pandoc export (format from file extension)';
		}
		const exportUri: vscode.Uri | undefined = await vscode.window.showSaveDialog({
			title: 'Pandoc export',
			saveLabel: saveLabel,
			defaultUri: defaultExportUri,
			filters: saveDialogFilter,
		});
		if (!this.panel || !exportUri) {
			this.isExporting = false;
			return;
		}
		const exportFileName = exportUri.fsPath;
		for (const source of sources) {
			if (source.fileName === exportFileName) {
				vscode.window.showErrorMessage(`Export cannot overwrite source file "${path.basename(source.fileName)}"`);
				this.isExporting = false;
				return;
			}
		}
		if (/[\u0000-\u001F\u007F\u0080—\u009F*?"<>|$!%`^]|(?<!^[a-zA-z]):|:(?![\\/])|\\"/.test(exportFileName)) {
			// Don't allow command characters, characters invalid in Windows
			// file names, Windows CMD/PowerShell escapes, interpolation, or
			// escaped double quotes.
			vscode.window.showErrorMessage(`Cannot export file; invalid or unsupported file name: "${exportFileName}"`);
			this.isExporting = false;
			return;
		}

		this.exportPandoc(sources, pandocExportBuildConfig, exportFileName);
	}

	private exportPandoc(sources: Sources, pandocExportBuildConfig: PandocExportBuildConfig | undefined, exportFileName: string) {
		const reader: PandocReader | undefined = this.pandocPreviewOptions?.reader;
		// Writer is either from chosen build config or from file extension;
		// any writer in document defaults file is ignored.
		const writer: PandocWriter | undefined = pandocExportBuildConfig?.writer;
		let fileScope: boolean = false;
		// Document defaults have precedence over settings defaults.  Options
		// override everything.
		if (pandocExportBuildConfig && pandocExportBuildConfig.defaultsFileScope !== undefined) {
			fileScope = pandocExportBuildConfig.defaultsFileScope;
		}
		if (this.documentPandocDefaultsFile.isRelevant && this.documentPandocDefaultsFile.data?.fileScope !== undefined) {
			fileScope = this.documentPandocDefaultsFile.data.fileScope;
		}
		if (pandocExportBuildConfig && pandocExportBuildConfig.optionsFileScope !== undefined) {
			fileScope = pandocExportBuildConfig.optionsFileScope;
		}

		// `this.pandocInfo` is checked in `export()`, and config is
		// locked during export, so the fallback value shouldn't ever be used
		const executable: string = this.pandocInfo?.executable || 'pandoc';
		const args: Array<string> = [];
		if (pandocExportBuildConfig?.defaultsFileName) {
			// This needs quoting, since it involves an absolute path
			args.push('--defaults', `"${pandocExportBuildConfig.defaultsFileName}"`);
		}
		if (pandocExportBuildConfig?.options) {
			args.push(...pandocExportBuildConfig.options);
		}
		if (this.documentPandocDefaultsFile.processedFileName) {
			// This needs quoting, since it involves an absolute path
			args.push('--defaults', `"${this.documentPandocDefaultsFile.processedFileName}"`);
		}
		args.push(...this.pandocExportArgs);
		if (this.usingCodebraid) {
			args.push(...this.pandocWithCodebraidOutputArgs);
		}
		// Reader and writer don't need quoting, since they are either builtin
		// (`^[0-9a-z_+-]+$`) or are custom from `settings.json` (and thus
		// require any quoting by the user).  Readers/writers in preview
		// defaults file are only extracted and used here if they are builtin.
		if (reader) {
			if (this.extension.pandocInfo?.supportsCodebraidWrappers) {
				if (fileScope && reader.canFileScope && !reader.hasExtensionsFileScope) {
					// Any incompatibilities have already resulted in error
					// messages during configuration update
					args.push('--from', `${reader.asArg}+file_scope`);
				} else {
					args.push('--from', reader.asArg);
				}
			} else {
				args.push('--from', reader.asArgNoWrapper);
			}
		}
		if (writer) {
			// If a writer isn't specified, Pandoc may still be able to
			// proceed based on file extension of output; otherwise, it will
			// give an error
			args.push('--to', writer.asArg);
		}
		args.push('--output', `"${exportFileName}"`);

		this.extension.statusBarConfig.setDocumentExportRunning();
		const buildProcess = child_process.execFile(
			executable,
			args,
			{...this.buildProcessOptions, env: {...process.env, ...this.pandocInfo?.extraEnv}},
			(error, stdout, stderr) => {
				this.extension.statusBarConfig.setDocumentExportWaiting();
				this.isExporting = false;
				if (!this.panel) {
					return;
				}
				if (error) {
					vscode.window.showErrorMessage(`Pandoc export failed: ${error}`);
					this.extension.log(`Pandoc export failed: ${error}`);
				} else if (stderr) {
					if (stderr.toLowerCase().indexOf('error') !== -1) {
						vscode.window.showErrorMessage(`Pandoc export stderr: ${stderr}`);
					} else if (stderr.toLowerCase().indexOf('warning') !== -1){
						vscode.window.showWarningMessage(`Pandoc export stderr: ${stderr}`);
					} else {
						vscode.window.showInformationMessage(`Pandoc export stderr: ${stderr}`);
					}
					this.extension.log(`Pandoc export stderr: ${stderr}`);
				}
				if (!error) {
					if (path.basename(exportFileName).lastIndexOf('.') !== -1) {
						const extIndex = exportFileName.lastIndexOf('.');
						this.lastExportFileNameNoExt = exportFileName.slice(0, extIndex);
						this.lastExportFileExtension = exportFileName.slice(extIndex);
						this.lastExportWriterName = writer?.name;
					} else {
						this.lastExportFileNameNoExt = exportFileName;
						this.lastExportFileExtension = undefined;
						this.lastExportWriterName = writer?.name;
					}
				}
			}
		);

		if (this.extension.pandocInfo?.supportsCodebraidWrappers && reader?.hasWrapper) {
			buildProcess.stdin?.write(this.sourcesToJsonHeader(sources));
		}
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
				`  commonmark: ${reader?.isCommonmark || false}`,
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
		for (const source of sources) {
			if (source.index === 0 && includingCodebraidOutput) {
				if (yamlMetadataRegex.test(source.fileText)) {
					buildProcess.stdin?.write(source.fileText.slice(source.fileText.indexOf('\n') + 1));
				} else {
					buildProcess.stdin?.write('---\n\n');
					buildProcess.stdin?.write(source.fileText);
				}
			} else {
				buildProcess.stdin?.write(source.fileText);
			}
			if (source.endPaddingText) {
				buildProcess.stdin?.write(source.endPaddingText);
			}
		}
		buildProcess.stdin?.end();
	}

}
