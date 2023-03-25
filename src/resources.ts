// Copyright (c) 2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


export const resourceRoots: Array<string> = [
	'media',
	'scripts',
	'node_modules/katex/dist',
	'node_modules/@vscode/codicons/dist',
];


export const webviewResources: {[key: string]: string} = {
    katex: 'node_modules/katex/dist',
    vscodeCodicon: 'node_modules/@vscode/codicons/dist/codicon.css',
    vscodeCss: 'media/vscode-markdown.css',
    codebraidCss: 'media/codebraid-preview.css',
    codebraidPreviewJs: 'scripts/codebraid-preview.js',
};


export const pandocResources: {[key: string]: string} = {
    sourceposSyncFilter: 'pandoc/filters/sourcepos_sync.lua',
    showRawFilter: 'pandoc/filters/show_raw.lua',
    codebraidOutputFilter: 'pandoc/filters/codebraid_output.lua',
    readersRoot: 'pandoc/readers',
};
