// Copyright (c) 2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import type * as vscode from 'vscode';


export class NotebookTextEditorDocument {
	private notebook: vscode.NotebookDocument;

	constructor(notebook: vscode.NotebookDocument) {
		this.notebook = notebook;
	}

	get fileName() {
		return this.notebook.uri.fsPath;
	}

	get isUntitled() {
		return this.notebook.isUntitled;
	}

	get uri() {
		return this.notebook.uri;
	}

    get isDirty() {
        return this.notebook.isDirty;
    }
}

export class NotebookTextEditor {
	// Wrapper around `vscode.NotebookEditor` to make it more like
	// `vscode.TextEditor`
	readonly isNotebook = true;
	private notebookEditor: vscode.NotebookEditor;
	document: NotebookTextEditorDocument;
	isIpynb: boolean;

	constructor(notebookEditor: vscode.NotebookEditor) {
		this.notebookEditor = notebookEditor;
		this.document = new NotebookTextEditorDocument(notebookEditor.notebook);
		this.isIpynb = this.document.fileName.endsWith('.ipynb');
	}

	get viewColumn() {
		return this.notebookEditor.viewColumn;
	}
}
