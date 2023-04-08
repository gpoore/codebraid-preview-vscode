// Copyright (c) 2022-2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as vscode from 'vscode';

import type { ExtensionState } from './types';
import { isWindows, homedir } from './constants';
import { resourceRoots } from './resources';
import { FileExtension } from './util';
import { PandocVersionInfo, getPandocVersionInfo } from './pandoc_version_info';
import { PandocBuildConfigCollections } from './pandoc_build_configs';
import { NotebookTextEditor } from './notebook';
import PreviewPanel from './preview_panel';


let context: vscode.ExtensionContext;
let pandocVersionInfo: PandocVersionInfo;
const previews: Set<PreviewPanel> = new Set();
function updatePreviewConfigurations() {
	for (const preview of previews) {
		preview.updateConfiguration();
	}
}
let extensionState: ExtensionState;
const oldExtraLocalResourceRoots: Set<string> = new Set();
let checkPreviewVisibleInterval: NodeJS.Timeout | undefined;




export async function activate(extensionContext: vscode.ExtensionContext) {
	context = extensionContext;

	// Check Pandoc version here, since async, but don't give any
	// errors/warnings about compatibility until the extension is actually
	// used.  Simply loading the extension in the background won't result in
	// errors/warnings.
	pandocVersionInfo = await getPandocVersionInfo();

	const outputChannel = vscode.window.createOutputChannel('Codebraid Preview');
	context.subscriptions.push(outputChannel);
	const log = (message: string) => {
		const date = new Date();
		outputChannel.appendLine(`[${date.toLocaleString()}]`);
		if (message.endsWith('\n')) {
			outputChannel.append(message);
		} else {
			outputChannel.appendLine(message);
		}
	};
	log('Activating extension');

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'codebraidPreview.startPreview',
			startPreview
		),
		vscode.commands.registerCommand(
			'codebraidPreview.runCodebraid',
			runCodebraid
		),
		vscode.commands.registerCommand(
			'codebraidPreview.setScrollSyncMode',
			setScrollSyncMode
		),
		vscode.commands.registerCommand(
			'codebraidPreview.exportDocument',
			exportDocument
		),
	);

	let openPreviewStatusBarItem = vscode.window.createStatusBarItem(
		'codebraidPreview.startPreview',
		vscode.StatusBarAlignment.Right,
		14
	);
	let runCodebraidStatusBarItem = vscode.window.createStatusBarItem(
		'codebraidPreview.runCodebraid',
		vscode.StatusBarAlignment.Right,
		13
	);
	let scrollSyncModeStatusBarItem = vscode.window.createStatusBarItem(
		'codebraidPreview.setScrollSyncMode',
		vscode.StatusBarAlignment.Right,
		12
	);
	let exportDocumentStatusBarItem = vscode.window.createStatusBarItem(
		'codebraidPreview.exportDocument',
		vscode.StatusBarAlignment.Right,
		11
	);

	const config = vscode.workspace.getConfiguration('codebraid.preview');
	const pandocBuildConfigCollections = new PandocBuildConfigCollections(context);
	context.subscriptions.push(pandocBuildConfigCollections);
	await pandocBuildConfigCollections.update(config);
	extensionState = {
		isWindows: isWindows,
		context: context,
		config: config,
		pandocVersionInfo: pandocVersionInfo,
		pandocBuildConfigCollections: pandocBuildConfigCollections,
		normalizedExtraLocalResourceRoots: normalizeExtraLocalResourceRoots(config),
		resourceRootUris: resourceRoots.map((root) => vscode.Uri.file(context.asAbsolutePath(root))),
		log: log,
		statusBarItems: {
			openPreview: openPreviewStatusBarItem,
			runCodebraid: runCodebraidStatusBarItem,
			scrollSyncMode: scrollSyncModeStatusBarItem,
			exportDocument: exportDocumentStatusBarItem,
		},
		statusBarConfig: {
			scrollPreviewWithEditor: undefined,
			scrollEditorWithPreview: undefined,
			setCodebraidRunningExecute: () => {runCodebraidStatusBarItem.text = '$(sync~spin) Codebraid';},
			setCodebraidRunningNoExecute: () => {runCodebraidStatusBarItem.text = '$(loading~spin) Codebraid';},
			setCodebraidWaiting: () => {runCodebraidStatusBarItem.text = '$(run-all) Codebraid';},
			setDocumentExportRunning: () => {exportDocumentStatusBarItem.text = '$(sync~spin) Pandoc';},
			setDocumentExportWaiting: () => {exportDocumentStatusBarItem.text = '$(export) Pandoc';},
		},
	};

	openPreviewStatusBarItem.name = 'Codebraid Preview: open preview';
	openPreviewStatusBarItem.text = '$(open-preview) Codebraid Preview';
	openPreviewStatusBarItem.tooltip = 'Open Codebraid Preview window';
	openPreviewStatusBarItem.command = 'codebraidPreview.startPreview';
	openPreviewStatusBarItem.show();

	runCodebraidStatusBarItem.name = 'Codebraid Preview: run Codebraid';
	runCodebraidStatusBarItem.text = '$(run-all) Codebraid';
	runCodebraidStatusBarItem.tooltip = 'Run all Codebraid sessions';
	runCodebraidStatusBarItem.command = 'codebraidPreview.runCodebraid';
	runCodebraidStatusBarItem.hide();

	scrollSyncModeStatusBarItem.name = 'Codebraid Preview: set scroll sync mode';
	let scrollState: 0|1|2|3;
	if (config.scrollPreviewWithEditor && config.scrollEditorWithPreview) {
		scrollState = 0;
	} else if (config.scrollPreviewWithEditor) {
		scrollState = 1;
	} else if (config.scrollEditorWithPreview) {
		scrollState = 2;
	} else {
		scrollState = 3;
	}
	updateScrollSyncStatusBarItemText(scrollStateSymbols[scrollState]);
	scrollSyncModeStatusBarItem.text = `$(file) $(arrow-both) $(notebook-render-output) Scroll`;
	scrollSyncModeStatusBarItem.tooltip = 'Set Codebraid Preview scroll sync mode';
	scrollSyncModeStatusBarItem.command = 'codebraidPreview.setScrollSyncMode';
	scrollSyncModeStatusBarItem.hide();

	vscode.workspace.onDidChangeConfiguration(
		() => {
			extensionState.config = vscode.workspace.getConfiguration('codebraid.preview');
			extensionState.normalizedExtraLocalResourceRoots = normalizeExtraLocalResourceRoots(extensionState.config);
			extensionState.pandocBuildConfigCollections.update(extensionState.config, updatePreviewConfigurations);
		},
		null,
		context.subscriptions
	);
	vscode.workspace.onDidChangeWorkspaceFolders(
		() => {
			if (previews.size > 0) {
				vscode.window.showInformationMessage([
					'Workspace folder(s) have changed.',
					'This will not affect preview panels until they are closed and reopened.',
				].join(' '));
			}
		},
		null,
		context.subscriptions
	);
	vscode.window.onDidChangeActiveTextEditor(
		updateStatusBarItems,
		null,
		context.subscriptions
	);
	vscode.window.onDidChangeVisibleTextEditors(
		updateStatusBarItems,
		null,
		context.subscriptions
	);
	vscode.window.onDidChangeActiveNotebookEditor(
		updateStatusBarItems,
		null,
		context.subscriptions
	);
	vscode.window.onDidChangeVisibleNotebookEditors(
		updateStatusBarItems,
		null,
		context.subscriptions
	);
	// There currently isn't an event for the webview becoming visible
	checkPreviewVisibleInterval = setInterval(
		() => {updateWithPreviewStatusBarItems();},
		1000
	);

	exportDocumentStatusBarItem.name = 'Codebraid Preview: export with Pandoc';
	exportDocumentStatusBarItem.text = '$(export) Pandoc';
	exportDocumentStatusBarItem.tooltip = 'Export document with Pandoc';
	exportDocumentStatusBarItem.command = 'codebraidPreview.exportDocument';
	exportDocumentStatusBarItem.hide();
}


export function deactivate() {
	if (checkPreviewVisibleInterval) {
		clearInterval(checkPreviewVisibleInterval);
	}
}


function normalizeExtraLocalResourceRoots(config: vscode.WorkspaceConfiguration): Array<string> {
	if (previews.size > 0) {
		let didChangeExtraRoots: boolean = false;
		if (oldExtraLocalResourceRoots.size !== config.security.extraLocalResourceRoots.length) {
			didChangeExtraRoots = true;
		} else {
			for (const root of config.security.extraLocalResourceRoots) {
				if (!oldExtraLocalResourceRoots.has(root)) {
					didChangeExtraRoots = true;
					break;
				}
			}
		}
		if (didChangeExtraRoots) {
			vscode.window.showInformationMessage([
				'Extension setting "security.extraLocalResourceRoots" has changed.',
				'This will not affect preview panels until they are closed and reopened.',
			].join(' '));
		}
	}
	oldExtraLocalResourceRoots.clear();
	const extraRoots: Array<string> = [];
	for (const root of config.security.extraLocalResourceRoots) {
		oldExtraLocalResourceRoots.add(root);
		if (root.startsWith('~/') || root.startsWith('~\\')) {
			extraRoots.push(`${homedir}${root.slice(1)}`);
		} else {
			extraRoots.push(root);
		}
	}
	return extraRoots;
}


function showPandocMissingError() {
	getPandocVersionInfo().then((result) => {
		pandocVersionInfo = result;
		extensionState.pandocVersionInfo = result;
	});
	let message: string;
	if (pandocVersionInfo === undefined) {
		message = [
			'Could not find pandoc.',
			'Make sure that it is installed and on PATH.',
			'If you have just installed pandoc, wait a moment and try again.',
			'Or manually reload the extension: restart, or CTRL+SHIFT+P and then run "Reload Window".',
		].join(' ');
	} else {
		message = [
			'Failed to identify pandoc version; possibly invalid or corrupted executable.',
			'Make sure that it is installed and on PATH.',
			'If you have just installed pandoc, wait a moment and try again.',
			'Or manually reload the extension: restart, or CTRL+SHIFT+P and then run "Reload Window".',
		].join(' ');
	}
	vscode.window.showErrorMessage(message);
}

let didShowPandocVersionMessage: boolean = false;
function showPandocVersionMessage() {
	if (didShowPandocVersionMessage) {
		return;
	}
	didShowPandocVersionMessage = true;
	const oldVersionString = pandocVersionInfo?.versionString;
	getPandocVersionInfo().then((result) => {
		if (result?.versionString !== oldVersionString) {
			didShowPandocVersionMessage = false;
		}
		pandocVersionInfo = result;
		extensionState.pandocVersionInfo = result;
	});
	let messageArray: Array<string> = [];
	if (!pandocVersionInfo?.isMinVersionRecommended) {
		messageArray.push(
			`Pandoc ${pandocVersionInfo?.versionString} is installed, but ${pandocVersionInfo?.minVersionRecommendedString}+ is recommended.`,
		);
		if (!pandocVersionInfo?.supportsCodebraidWrappers) {
			messageArray.push(
				`Scroll sync will only work for formats commonmark, commonmark_x, and gfm.`,
				`It will not work for other Markdown variants, or for other formats like Org, LaTeX, and reStructuredText.`,
				`The file scope option (command-line "--file-scope", or defaults "file-scope") is not supported.`,
			);
		}
		vscode.window.showWarningMessage(messageArray.join(' '));
	}
}


function startPreview() {
	if (!pandocVersionInfo) {
		showPandocMissingError();
		return;
	}
	if (!pandocVersionInfo.isMinVersionRecommended) {
		showPandocVersionMessage();
	}

	let editor: vscode.TextEditor | NotebookTextEditor | undefined = undefined;
	let activeOrVisibleEditors: Array<vscode.TextEditor | NotebookTextEditor> = [];
	if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
		activeOrVisibleEditors.push(vscode.window.activeTextEditor);
	} else {
		activeOrVisibleEditors.push(...vscode.window.visibleTextEditors);
		// `vscode.TextEditor` gets priority, but check for notebooks when
		// they are supported
		if (extensionState.pandocBuildConfigCollections.hasAnyConfigCollection('.ipynb')) {
			let pushedNotebookEditor: boolean = false;
			if (vscode.window.activeNotebookEditor) {
				const notebookTextEditor = new NotebookTextEditor(vscode.window.activeNotebookEditor);
				if (notebookTextEditor.isIpynb) {
					activeOrVisibleEditors.push(notebookTextEditor);
					pushedNotebookEditor = true;
				}
			}
			if (!pushedNotebookEditor) {
				for (const notebookEditor of vscode.window.visibleNotebookEditors) {
					const notebookTextEditor = new NotebookTextEditor(notebookEditor);
					if (notebookTextEditor.isIpynb) {
						activeOrVisibleEditors.push(notebookTextEditor);
					}
				}
			}
		}
	}
	if (activeOrVisibleEditors.length === 0) {
		return;
	}
	for (const possibleEditor of activeOrVisibleEditors) {
		if (possibleEditor.document.isUntitled) {
			if (activeOrVisibleEditors.length === 1) {
				vscode.window.showErrorMessage('Cannot preview unsaved files');
				return;
			}
			continue;
		}
		if (possibleEditor.document.uri.scheme !== 'file') {
			if (activeOrVisibleEditors.length === 1) {
				vscode.window.showErrorMessage([
					`Unsupported URI scheme "${possibleEditor.document.uri.scheme}":`,
					`Codebraid Preview only supports file URIs`,
				].join(' '));
				return;
			}
			continue;
		}
		const fileExt = new FileExtension(possibleEditor.document.fileName);
		if (!extensionState.pandocBuildConfigCollections.hasAnyConfigCollection(fileExt)) {
			if (activeOrVisibleEditors.length === 1) {
				const fileExtensions = Array.from(extensionState.pandocBuildConfigCollections.allInputFileExtensions()).join(', ');
				vscode.window.showErrorMessage(
					`Preview currently only supports file extensions ${fileExtensions}.  Modify "pandoc.build" in settings to add more.`
				);
				return;
			}
			continue;
		}
		if (editor) {
			vscode.window.showErrorMessage(
				'Multiple visible editors support preview. Select an editor, then start preview.'
			);
			return;
		}
		editor = possibleEditor;
	}
	if (!editor) {
		vscode.window.showErrorMessage('No open and visible files support preview');
		return;
	}
	let existingPreview: PreviewPanel | undefined;
	for (let p of previews) {
		if (p.panel && p.fileNames.indexOf(editor.document.fileName) !== -1) {
			existingPreview = p;
			break;
		}
	}
	if (existingPreview) {
		existingPreview.switchEditor(editor);
	} else {
		if (previews.size === extensionState.config.maxPreviews) {
			vscode.window.showErrorMessage(
				'Too many previews are already open; close one or change "maxPreviews" in settings'
			);
			return;
		}
		const fileExt = new FileExtension(editor.document.fileName);
		let configCollection = extensionState.pandocBuildConfigCollections.getConfigCollection(fileExt);
		if (!configCollection) {
			configCollection = extensionState.pandocBuildConfigCollections.getFallbackConfigCollection(fileExt);
			if (configCollection) {
				vscode.window.showErrorMessage(
					`"pandoc.build" settings for ${fileExt} are missing or invalid; default fallback preview settings will be used`,
				);
			} else {
				const fileExtensions = Array.from(extensionState.pandocBuildConfigCollections.allInputFileExtensions()).join(', ');
				vscode.window.showErrorMessage(
					`Preview currently only supports file extensions ${fileExtensions}.  Modify "pandoc.build" in settings to add more.`
				);
				return;
			}
		}
		let preview = new PreviewPanel(editor, extensionState, fileExt);
		context.subscriptions.push(preview);
		previews.add(preview);
		preview.registerOnDisposeCallback(
			() => {
				previews.delete(preview);
				updateStatusBarItems();
			}
		);
	}
	extensionState.statusBarItems.openPreview.hide();
	extensionState.statusBarItems.runCodebraid.show();
	extensionState.statusBarItems.scrollSyncMode.show();
}


function runCodebraid() {
	if (!pandocVersionInfo) {
		showPandocMissingError();
		return;
	}
	if (!pandocVersionInfo.isMinVersionRecommended) {
		showPandocVersionMessage();
	}

	if (previews.size === 0) {
		startPreview();
	}
	let preview: PreviewPanel | undefined;
	for (let p of previews) {
		if (p.panel && p.panel.visible) {
			if (preview) {
				vscode.window.showErrorMessage(
					'Cannot run Codebraid with two previews visible.  Close one and try again.'
				);
			}
		}
		preview = p;
	}
	preview?.runCodebraidExecute();
}


function exportDocument() {
	if (!pandocVersionInfo) {
		showPandocMissingError();
		return;
	}
	if (!pandocVersionInfo.isMinVersionRecommended) {
		showPandocVersionMessage();
	}

	if (previews.size === 0) {
		startPreview();
	}
	let preview: PreviewPanel | undefined;
	for (let p of previews) {
		if (p.panel && p.panel.visible) {
			if (preview) {
				vscode.window.showErrorMessage(
					'Cannot export document with two previews visible.  Close one and try again.'
				);
			}
		}
		preview = p;
	}
	if (!preview) {
		return;
	}
	preview.export();
}


let scrollState: 0|1|2|3 = 0;
let scrollStateSymbols: Array<string> = [
	'arrow-both',
	'arrow-right',
	'arrow-left',
	'remove-close',
];
function setScrollSyncMode() {
	if (scrollState === 3) {
		scrollState = 0;
	} else {
		scrollState += 1;
	}
	updateScrollSyncStatusBarItemText(scrollStateSymbols[scrollState]);
	switch (scrollState) {
		case 0: {
			extensionState.statusBarConfig.scrollPreviewWithEditor = true;
			extensionState.statusBarConfig.scrollEditorWithPreview = true;
			break;
		}
		case 1: {
			extensionState.statusBarConfig.scrollPreviewWithEditor = true;
			extensionState.statusBarConfig.scrollEditorWithPreview = false;
			break;
		}
		case 2: {
			extensionState.statusBarConfig.scrollPreviewWithEditor = false;
			extensionState.statusBarConfig.scrollEditorWithPreview = true;
			break;
		}
		case 3: {
			extensionState.statusBarConfig.scrollPreviewWithEditor = false;
			extensionState.statusBarConfig.scrollEditorWithPreview = false;
			break;
		}
		default:
			throw new Error('Invalid scroll sync mode');
	}
}
function updateScrollSyncStatusBarItemText(symbol: string) {
	extensionState.statusBarItems.scrollSyncMode.text = `$(file) $(${symbol}) $(notebook-render-output) Scroll`;
}


function updateStatusBarItems() {
	let showOpenPreviewStatusBarItem = true;
	if (vscode.window.visibleTextEditors.length === 0 && vscode.window.visibleNotebookEditors.length === 0) {
		showOpenPreviewStatusBarItem = false;
	} else {
		let visibleEditorsCount = 0;
		let previewEditorsCount = 0;
		const visibleEditors = [...vscode.window.visibleTextEditors, ...vscode.window.visibleNotebookEditors.map(ed => new NotebookTextEditor(ed))];
		for (const visibleEditor of visibleEditors) {
			const document = visibleEditor.document;
			if (document.uri.scheme === 'file' && extensionState.pandocBuildConfigCollections.hasAnyConfigCollection(new FileExtension(document.fileName))) {
				visibleEditorsCount += 1;
				for (const preview of previews) {
					if (preview.panel && preview.fileNames.indexOf(document.fileName) !== -1) {
						previewEditorsCount += 1;
						break;
					}
				}
			}
		}
		if (visibleEditorsCount === previewEditorsCount) {
			showOpenPreviewStatusBarItem = false;
		}
	}
	if (showOpenPreviewStatusBarItem) {
		extensionState.statusBarItems.openPreview.show();
	} else {
		extensionState.statusBarItems.openPreview.hide();
	}
	updateWithPreviewStatusBarItems();
}

let isShowingWithPreviewStatusBarItems = false;
function updateWithPreviewStatusBarItems() {
	let showWithPreviewStatusBarItems = false;
	for (const preview of previews) {
		if (preview.panel && preview.panel.visible) {
			showWithPreviewStatusBarItems = true;
			break;
		}
	}
	if (showWithPreviewStatusBarItems) {
		if (!isShowingWithPreviewStatusBarItems) {
			extensionState.statusBarItems.runCodebraid.show();
			extensionState.statusBarItems.scrollSyncMode.show();
			extensionState.statusBarItems.exportDocument.show();
		}
		isShowingWithPreviewStatusBarItems = true;
	} else {
		if (isShowingWithPreviewStatusBarItems) {
			extensionState.statusBarItems.runCodebraid.hide();
			extensionState.statusBarItems.scrollSyncMode.hide();
			extensionState.statusBarItems.exportDocument.hide();
		}
		isShowingWithPreviewStatusBarItems = false;
	}
}
