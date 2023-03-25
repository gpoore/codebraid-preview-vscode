// Copyright (c) 2022-2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import type * as vscode from 'vscode';
import type { PandocBuildConfigCollections } from './pandoc_build_configs';
import type { PandocVersionInfo } from './pandoc_version_info';

export type ExtensionState = {
	'isWindows': boolean,
	'context': vscode.ExtensionContext,
	'config': vscode.WorkspaceConfiguration,
	'pandocVersionInfo': PandocVersionInfo,
	'pandocBuildConfigCollections': PandocBuildConfigCollections,
	'normalizedExtraLocalResourceRoots': Array<string>,
	'resourceRootUris': Array<vscode.Uri>,
	'log': (message: string) => void,
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
