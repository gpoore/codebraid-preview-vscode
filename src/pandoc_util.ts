// Copyright (c) 2023, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


import * as vscode from 'vscode';

import { homedir, isWindows } from './constants';
import CodebraidPreviewError from './err';
import { pandocReaderWrapperPath, readersWithWrapper, readersWithCodebraid, markdownReaders, commonmarkReaders } from './pandoc_settings';




export const pandocBuiltinReaderWriterRegex = /^([0-9a-z_]+)((?:[+-][0-9a-z_]+)*)$/;
const customLuaRegex = /^(.+?\.lua)((?:[+-][0-9a-z_]+)*)$/;

class PandocIOProcessor {
    name: string;
    asPandocString: string;
    isBuiltin: boolean;
    base: string;
    builtinBase: string | undefined;
    protected customExpanded: string | undefined;
    protected extensions: string;
    protected isLua: boolean;

    constructor(format: string, name?: string) {
        let processedFormat: string;
        const formatWithoutQuotes = format.replaceAll(`'`, ``).replaceAll(`"`, ``);
        const builtinMatch = formatWithoutQuotes.match(pandocBuiltinReaderWriterRegex);
        if (builtinMatch) {
            this.isBuiltin = true;
            processedFormat = formatWithoutQuotes;
            this.base = builtinMatch[1];
            this.builtinBase = this.base;
            this.extensions = builtinMatch[2];
            this.isLua = false;
        } else {
            this.isBuiltin = false;
            processedFormat = format;
            const customLuaMatch = formatWithoutQuotes.match(customLuaRegex);
            if (!customLuaMatch) {
                if (name) {
                    throw new CodebraidPreviewError(
                        `Unrecognized builtin reader/writer name, or invalid Lua reader/writer name: "${format}"`
                    );
                } else {
                    throw new CodebraidPreviewError([
                        `Unrecognized builtin reader/writer name, or invalid Lua reader/writer name: "${format}"`,
                        `(for settings, this can be caused by creating a preview/export with a descriptive name and forgetting to define a "writer" field)`,
                    ].join(' '));
                }
            }
            this.base = customLuaMatch[1];
            this.extensions = customLuaMatch[2];
            this.isLua = true;
            if (isWindows && (format.startsWith('~/') || format.startsWith('~\\'))) {
                this.customExpanded = `"${homedir}"${format.slice(1)}`;
            }
        }
        this.asPandocString = processedFormat;
        this.name = name ? name : processedFormat;
    }

    toString() : string {
        return this.name;
    }
};

export class PandocReader extends PandocIOProcessor {
    isMarkdown: boolean;
    isCommonmark: boolean;
    canSourcepos: boolean;
    canFileScope: boolean;
    canCodebraid: boolean;
    hasExtensionsSourcepos: boolean;
    hasExtensionsFileScope: boolean;
    asArg: string;
    asArgNoWrapper: string;
    asCodebraidArg: string;
    hasWrapper: boolean;

    constructor(format: string, context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration) {
        super(format);

        this.hasExtensionsSourcepos = this.extensions.indexOf('+sourcepos') > this.extensions.indexOf('-sourcepos');
        this.hasExtensionsFileScope = this.extensions.indexOf('+file_scope') > this.extensions.indexOf('-file_scope');
        this.isMarkdown = this.builtinBase !== undefined && markdownReaders.has(this.builtinBase);
        this.isCommonmark = this.builtinBase !== undefined && commonmarkReaders.has(this.builtinBase);
        this.canSourcepos = (this.builtinBase !== undefined && readersWithWrapper.has(this.builtinBase)) || this.hasExtensionsSourcepos;
        this.canFileScope = (this.builtinBase !== undefined && readersWithWrapper.has(this.builtinBase)) || this.hasExtensionsFileScope;
        this.canCodebraid = this.builtinBase !== undefined && readersWithCodebraid.has(this.builtinBase);
        this.hasWrapper = this.builtinBase !== undefined && readersWithWrapper.has(this.builtinBase);

        if (this.hasExtensionsSourcepos) {
            if (!this.isCommonmark) {
                throw new CodebraidPreviewError(
                    `Pandoc reader "${this.base}" is not based on CommonMark and does not support the "sourcepos" extension`
                );
            } else if (!config.pandoc.preferPandocSourcepos) {
                throw new CodebraidPreviewError(
                    `Pandoc reader "${this.base}" uses the "sourcepos" extension, but setting "codebraid.preview.pandoc.preferPandocSourcepos" is "false"`
                );
            }
        }

        if (this.hasWrapper) {
            let readerWithWrapperAndExtensions = `${this.builtinBase}.lua${this.extensions}`;
            if (this.canSourcepos) {
                if (!this.hasExtensionsSourcepos) {
                    readerWithWrapperAndExtensions += '+sourcepos';
                }
                if (!config.pandoc.preferPandocSourcepos) {
                    readerWithWrapperAndExtensions += '-prefer_pandoc_sourcepos';
                }
            }
            const asArg = context.asAbsolutePath(`${pandocReaderWrapperPath}/${readerWithWrapperAndExtensions}`);
            // Built-in readers will be unquoted
            this.asArg = `"${asArg}"`;
            this.asArgNoWrapper = this.asPandocString;
            this.asCodebraidArg = this.asArgNoWrapper;
        } else {
            // A built-in reader without a wrapper needs no quoting.  A custom
            // reader is from settings "pandoc.build.<format>.reader", which
            // is required to have any quoting already included.  A reader set
            // in the Codebraid Preview defaults file is only extracted if it
            // is a built-in reader.  Thus, there is never a case where a
            // user-supplied reader is not required to be quoted by the user.
            this.asArg = this.customExpanded ? this.customExpanded : this.asPandocString;
            this.asArgNoWrapper = this.asArg;
            this.asCodebraidArg = this.asArgNoWrapper;
        }
    }
}

export class PandocWriter extends PandocIOProcessor {
    asArg: string;
    asCodebraidArg: string;

    constructor(format: string, alias?: string) {
        super(format, alias);

        this.asArg = this.customExpanded ? this.customExpanded : this.asPandocString;
        this.asCodebraidArg = this.asArg;
    }
}

export const fallbackHtmlWriter = new PandocWriter('html');
