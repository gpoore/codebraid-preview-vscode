// Copyright (c) 2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//




// Relative to extension directory
export const pandocReaderWrapperPath = 'pandoc/readers';
// Relative to document directory (cwd)
export const processedDefaultsRelativeFileName = '_codebraid/temp_defaults/_codebraid_preview.yaml';
export const extractedMediaDirectory = '_codebraid/extracted_media';


export const fallbackFileExtensionToReaderMap: Map<string, string> = new Map([
    ['.cbmd', 'commonmark_x'],
    ['.markdown','commonmark_x'],
    ['.md', 'commonmark_x'],
    ['.org', 'org'],
    ['.rst', 'rst'],
    ['.tex', 'latex'],
    ['.textile', 'textile'],
]);


export const builtinToFileExtensionMap: Map<string, string> = new Map([
    ['beamer', '.tex'],
    ['commonmark', '.md'],
    ['commonmark_x', '.md'],
    ['context', '.tex'],
    ['docbook', '.dbk'],
    ['docbook4', '.dbk'],
    ['docbook5', '.dbk'],
    ['docx', '.docx'],
    ['epub', '.epub'],
    ['epub2', '.epub'],
    ['epub3', '.epub'],
    ['gfm', '.md'],
    ['html', '.html'],
    ['html4', '.html'],
    ['html5', '.html'],
    ['ipynb', '.ipynb'],
    ['json', '.json'],
    ['latex', '.tex'],
    ['markdown_mmd', '.md'],
    ['markdown_phpextra', '.md'],
    ['markdown_strict', '.md'],
    ['odt', '.odt'],
    ['org', '.org'],
    ['pdf', '.pdf'],
    ['plain', '.txt'],
    ['pptx', '.pptx'],
    ['revealjs', '.html'],
    ['rst', '.rst'],
    ['rtf', '.rtf'],
    ['s5', '.html'],
    ['slideous', '.html'],
    ['slidy', '.html'],
    ['textile', '.textile'],
]);


const exportFileExtensions: Array<string> = Array.from(new Set(builtinToFileExtensionMap.values())).sort();
export const defaultSaveDialogFilter: {[key: string]: [] | [string]} = {};
export const defaultSaveDialogFileExtensionToFilterKeyMap: Map<string, string> = new Map();
defaultSaveDialogFilter['*.*'] = [];
for (const ext of exportFileExtensions) {
    const key = `*${ext}`;
    const value = ext.slice(1);
    defaultSaveDialogFilter[key] = [value];
    defaultSaveDialogFileExtensionToFilterKeyMap.set(ext, key);
}


export const commonmarkReaders: Set<string> = new Set([
    'commonmark',
    'commonmark_x',
    'gfm',
]);

export const markdownReaders: Set<string> = new Set([
    ...commonmarkReaders,
    'markdown', 'markdown_mmd', 'markdown_phpextra', 'markdown_strict',
]);

export const readersWithCodebraid = markdownReaders;

export const readersWithWrapper: Set<string> = new Set([
    ...markdownReaders,
    'latex',
    'org',
    'rst',
    'textile'
]);

export const readersWithPandocSourcepos: Set<string> = new Set([
    ...commonmarkReaders
]);
export const readersWithWrapperSourcepos: Set<string> = readersWithWrapper;
export const readersWithSourcepos: Set<string> = new Set([
    ...readersWithPandocSourcepos,
    ...readersWithWrapperSourcepos,
]);
