// Copyright (c) 2022, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as vscode from 'vscode';

import PreviewPanel from './preview_panel';
import type { ExtensionState } from './types';


let context: vscode.ExtensionContext;
const previews: Set<PreviewPanel> = new Set();
let extensionState: ExtensionState;

const supportedFileExtensions = ['.md', '.markdown', '.cbmd'];
let checkPreviewVisibleInterval: NodeJS.Timeout | undefined;


export function activate(extensionContext: vscode.ExtensionContext) {
	context = extensionContext;
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

	let config = vscode.workspace.getConfiguration('codebraid.preview');
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
	extensionState = {
		context: context,
		config: config,
		statusBarItems: {
			openPreview: openPreviewStatusBarItem,
			runCodebraid: runCodebraidStatusBarItem,
			scrollSyncMode: scrollSyncModeStatusBarItem,
			exportDocument: exportDocumentStatusBarItem,
		},
		statusBarConfig: {
			scrollPreviewWithEditor: undefined,
			scrollEditorWithPreview: undefined,
			setCodebraidRunning: () => {runCodebraidStatusBarItem.text = '$(sync~spin) Codebraid';},
			setCodebraidWaiting: () => {runCodebraidStatusBarItem.text = '$(run-all) Codebraid';},
			setDocumentExportRunning: () => {exportDocumentStatusBarItem.text = '$(sync~spin) Pandoc';},
			setDocumentExportWaiting: () => {exportDocumentStatusBarItem.text = '$(export) Pandoc';},
		}
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
		() => {extensionState.config = vscode.workspace.getConfiguration('codebraid.preview');},
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


function fileExtensionIsSupported(fileName: string): boolean {
	for (const ext of supportedFileExtensions) {
		if (fileName.endsWith(ext)) {
			return true;
		}
	}
	return false;
}


function startPreview() {
	let editor = undefined;
	let activeOrVisibleEditors = [];
	if (vscode.window.activeTextEditor) {
		activeOrVisibleEditors.push(vscode.window.activeTextEditor);
	} else {
		activeOrVisibleEditors.push(...vscode.window.visibleTextEditors);
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
					`Codebraid Preview only supports file URIs)`,
				].join(' '));
				return;
			}
			continue;
		}
		if (!fileExtensionIsSupported(possibleEditor.document.fileName)) {
			if (activeOrVisibleEditors.length === 1) {
				vscode.window.showErrorMessage(
					`Preview currently only supports file extensions ${supportedFileExtensions.join(', ')}`
				);
				return;
			}
			continue;
		}
		editor = possibleEditor;
		break;
	}
	if (!editor) {
		vscode.window.showErrorMessage('No open and visible files support preview');
		return;
	}
	let existingPreview: PreviewPanel | undefined;
	for (let p of previews) {
		if (p.fileNames.indexOf(editor.document.fileName) !== -1) {
			existingPreview = p;
			break;
		}
	}
	if (existingPreview) {
		existingPreview.switchEditor(editor);
	} else {
		if (previews.size === extensionState.config.maxPreviews) {
			vscode.window.showErrorMessage(
				'Too many previews are already open; close one or change "maxPreviews" in configuration'
			);
			return;
		}
		let preview = new PreviewPanel(editor, extensionState);
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
	if (previews.size === 0) {
		startPreview();
	}
	let preview: PreviewPanel | undefined;
	for (let p of previews) {
		if (p.panel.visible) {
			if (preview) {
				vscode.window.showErrorMessage(
					'Cannot run Codebraid with two previews visible.  Close one and try again.'
				);
			}
		}
		preview = p;
	}
	preview?.runCodebraid();
}


function exportDocument() {
	if (previews.size === 0) {
		startPreview();
	}
	let preview: PreviewPanel | undefined;
	for (let p of previews) {
		if (p.panel.visible) {
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
	vscode.window.showSaveDialog({title: 'Pandoc export', saveLabel: 'Pandoc export'}).then((saveUri) => {
		if (!preview || !saveUri) {
			return;
		}
		let savePath = saveUri.fsPath;
		preview.exportDocument(savePath);
	});
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
	if (vscode.window.visibleTextEditors.length === 0) {
		showOpenPreviewStatusBarItem = false;
	} else {
		let visibleEditorsCount = vscode.window.visibleTextEditors.length;
		let previewEditorsCount = 0;
		for (const visibleEditor of vscode.window.visibleTextEditors) {
			const document = visibleEditor.document;
			if (document.uri.scheme === 'file' && fileExtensionIsSupported(document.fileName)) {
				for (const preview of previews) {
					if (preview.fileNames.indexOf(document.fileName) !== -1) {
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
		if (preview.panel.visible) {
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
