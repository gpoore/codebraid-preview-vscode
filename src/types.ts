// Copyright (c) 2022, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import type * as vscode from 'vscode';


export type ExtensionState = {
	'isWindows': boolean,
	'context': vscode.ExtensionContext,
	'config': vscode.WorkspaceConfiguration,
	'normalizedConfigPandocOptions': Array<string>,
	'statusBarItems': {
		'openPreview': vscode.StatusBarItem
		'runCodebraid': vscode.StatusBarItem,
		'scrollSyncMode': vscode.StatusBarItem,
		'exportDocument': vscode.StatusBarItem,
	},
	'statusBarConfig': {
		scrollPreviewWithEditor: boolean | undefined,
		scrollEditorWithPreview: boolean | undefined,
		setCodebraidRunningExecute: () => void,
		setCodebraidRunningNoExecute: () => void,
		setCodebraidWaiting: () => void,
		setDocumentExportRunning: () => void,
		setDocumentExportWaiting: () => void,
	}
};
