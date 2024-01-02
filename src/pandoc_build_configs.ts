// Copyright (c) 2023-2024, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


// Error handling:  `PandocBuildConfigCollections` is intended for external
// use.  All other classes and functions will throw errors on incorrect
// settings.  `PandocBuildConfigCollections` catches errors and displays an
// appropriate error message.
//
// Type checking and data validation:  All settings should be appropriately
// validated (to the extent that is possible) by `package.json: pandoc.build`.
// Only basic type checking is done here, plus more in-depth validation for
// any data that must be processed with regex.


import * as vscode from 'vscode';

import * as crypto from 'crypto';
import * as path from 'path';
import * as yaml from 'js-yaml';

import CodebraidPreviewError from './err';
import { isWindows, homedir } from './constants';
import { FileExtension } from './util';
import { PandocReader, PandocWriter, fallbackHtmlWriter } from './pandoc_util';
import { fallbackFileExtensionToReaderMap } from './pandoc_settings';




type ConfigPandocDefaults = {[key: string]: any};
type BuildSettings = {
    defaults: {[key: string]: any},
    options: Array<string>,
};
const getFallbackBuildSettings = function () : BuildSettings {
    return {defaults: {}, options: []};
};
type ConfigSettings = {
    reader: string,
    preview: {[key: string]: BuildSettings},
    export: {[key: string]: BuildSettings},
};


type PandocOptions = Array<string>;
// This is a copy of `package.json: codebraid.preview.pandoc.build` regex for
// options, with capture groups added.
const optionRegex = new RegExp("^((?!(?:-f|--from|-r|--read|-t|--to|-w|--write|-o|--output)(?:[ =]|$))(?:-[a-zA-Z]|--[a-z]+(?:-[a-z]+)*))(?:([ =])((?:(?<![\\\\^`])\"[^\"]+(?<![\\\\^`])\"(?!\")|(?<![\\\\^`])'[^']+(?<![\\\\^`])'(?!')|[^ \t\"';&|]+(?=[\"']|$))+))?$");
function normalizeOptions(options: Array<string>, writer: PandocWriter) : PandocOptions {
    const normalizedOptions: PandocOptions = [];
    for (const option of options) {
        const optionMatch = option.match(optionRegex);
        if (!optionMatch) {
            throw new CodebraidPreviewError(
                `Writer "${writer}" has invalid options; check for unsupported reader/writer/output settings, and check quoting/escaping for shell`
            );
        }
        if (isWindows && optionMatch[3] && (optionMatch[3].startsWith('~/') || optionMatch[3].startsWith('~\\'))) {
            const opt = optionMatch[1];
            const sep = optionMatch[2];
            const val = `"${homedir}"${optionMatch[3].slice(1)}`;
            normalizedOptions.push(`${opt}${sep}${val}`);
        } else {
            normalizedOptions.push(option);
        }
    }
    return normalizedOptions;
}


class PandocBuildConfig {
    inputFileExtension: string;
    reader: PandocReader;
    writer: PandocWriter;
    isPredefined: boolean | undefined;
    defaults: ConfigPandocDefaults;
    defaultsHashName: string | null;
    defaultsFileName: string | null;
    defaultsAsBytes: Buffer;
    defaultsFileScope: boolean | undefined;
    options: PandocOptions;
    optionsFileScope: boolean | undefined;

    constructor(inputFileExtension: string, reader: PandocReader, writer: PandocWriter, settings: any, isPredefined?: boolean) {
        this.inputFileExtension = inputFileExtension;
        this.reader = reader;
        this.writer = writer;
        this.isPredefined = isPredefined;
        let maybeDefaults = settings.defaults;
        if (typeof(maybeDefaults) !== 'object' || maybeDefaults === null || Array.isArray(maybeDefaults)) {
            throw new CodebraidPreviewError(`Writer "${writer}" has missing or invalid value for "defaults"`);
        }
        this.defaults = maybeDefaults;
        let maybeFileScope = this.defaults['file-scope'];
        if (typeof(maybeFileScope) !== 'boolean' && maybeFileScope !== undefined) {
            throw new CodebraidPreviewError(`Writer "${writer}" has invalid value in "defaults" for "file-scope"`);
        }
        this.defaultsFileScope = maybeFileScope;
        if (Object.keys(this.defaults).length === 0) {
            this.defaultsHashName = null;
        } else {
            const readerHash = crypto.createHash('sha256');
            const hash = crypto.createHash('sha256');
            readerHash.update(reader.name);
            hash.update(reader.name);
            hash.update(readerHash.digest());
            hash.update(writer.name);
            this.defaultsHashName = hash.digest('base64url');
        }
        this.defaultsFileName = null;
        this.defaultsAsBytes = Buffer.from(`# Reader: ${reader}\n# Writer: ${writer}\n${yaml.dump(this.defaults)}`, 'utf8');
        let maybeOptions = settings.options;
        if (!Array.isArray(maybeOptions)) {
            throw new CodebraidPreviewError(`Writer "${writer}" has missing or invalid value for "options"`);
        }
        for (const opt of maybeOptions) {
            if (typeof(opt) !== 'string') {
                throw new CodebraidPreviewError(`Writer "${writer}" has invalid non-string value in "options"`);
            }
        }
        this.options = normalizeOptions(maybeOptions, this.writer);
        this.defaultsFileScope = this.options.indexOf('--file-scope') !== -1;
    }
};
export class PandocPreviewBuildConfig extends PandocBuildConfig {
}
export class PandocExportBuildConfig extends PandocBuildConfig {
}

const predefinedExportBuildConfigWriters: Map<string, string> = new Map([
    ['HTML', 'html'],
    ['Jupyter Notebook', 'ipynb'],
    ['LaTeX', 'latex'],
    ['LaTeX (beamer)', 'beamer'],
    ['Markdown (Pandoc)', 'markdown'],
    ['Markdown (commonmark)', 'commonmark'],
    ['Markdown (commonmark_x)', 'commonmark_x'],
    ['Org', 'org'],
    ['OpenDocument (odt)', 'odt'],
    ['PDF', 'pdf'],
    ['Plain text (txt)', 'plain'],
    ['PowerPoint', 'pptx'],
    ['reStructuredText', 'rst'],
    ['reveal.js', 'revealjs'],
    ['S5', 's5'],
    ['Slidy', 'slidy'],
    ['Word', 'docx'],
]);

export class PandocBuildConfigCollection {
    inputFileExtension: string;  // `.<ext>` or `.<output_format>.<ext>`
    reader: PandocReader;
    preview: Map<string, PandocPreviewBuildConfig>;
    export: Map<string, PandocExportBuildConfig>;

    constructor(inputFileExtension: string, settings: any, context: vscode.ExtensionContext) {
        this.inputFileExtension = inputFileExtension;
        let maybeReader = settings.reader;
        if (typeof(maybeReader) !== 'string') {
            throw new CodebraidPreviewError('Missing or invalid value for "reader"');
        }
        this.reader = new PandocReader(maybeReader, context);
        let maybePreview = settings.preview;
        if (typeof(maybePreview) !== 'object' || maybePreview === null || Array.isArray(maybePreview)) {
            throw new CodebraidPreviewError('Missing or invalid value for "preview"');
        }
        this.preview = new Map();
        for (const [key, value] of Object.entries(maybePreview)) {
            if (typeof(value) !== 'object' || value === null || Array.isArray(value)) {
                throw new CodebraidPreviewError(`Invalid value under "preview", "${key}"`);
            }
            let writer: PandocWriter;
            if ('writer' in value) {
                if (typeof(value.writer) !== 'string') {
                    throw new CodebraidPreviewError(`Invalid value under "preview", "${key}", "writer"`);
                }
                writer = new PandocWriter(value.writer, key);
            } else {
                writer = new PandocWriter(key);
            }
            const buildConfig = new PandocPreviewBuildConfig(inputFileExtension, this.reader, writer, value);
            this.preview.set(key, buildConfig);
        }
        // Ensure that default preview settings are defined
        if (!this.preview.has('html')) {
            const fallbackHtmlBuildConfig = new PandocPreviewBuildConfig(inputFileExtension, this.reader, fallbackHtmlWriter, getFallbackBuildSettings(), true);
            this.preview.set('html', fallbackHtmlBuildConfig);
        }
        let maybeExport = settings.export;
        if (typeof(maybeExport) !== 'object' || maybeExport === null || Array.isArray(maybeExport)) {
            throw new CodebraidPreviewError('Missing or invalid value for "export"');
        }
        this.export = new Map();
        for (const [key, value] of Object.entries(maybeExport)) {
            if (typeof(value) !== 'object' || value === null || Array.isArray(value)) {
                throw new CodebraidPreviewError(`Invalid value under "export", "${key}"`);
            }
            let writer: PandocWriter;
            if ('writer' in value) {
                if (typeof(value.writer) !== 'string') {
                    throw new CodebraidPreviewError(`Invalid value under "export", "${key}", "writer"`);
                }
                writer = new PandocWriter(value.writer, key);
            } else {
                writer = new PandocWriter(key);
            }
            const buildConfig = new PandocExportBuildConfig(inputFileExtension, this.reader, writer, value);
            this.export.set(key, buildConfig);
        }
        for (let [name, writerString] of predefinedExportBuildConfigWriters) {
            if (this.export.has(name)) {
                name = `${name} [predefined]`;
            }
            const writer = new PandocWriter(writerString, name);
            const buildConfig = new PandocPreviewBuildConfig(inputFileExtension, this.reader, writer, getFallbackBuildSettings(), true);
            this.export.set(name, buildConfig);
        }
    }
};


export class PandocBuildConfigCollections implements vscode.Disposable {
    private context: vscode.ExtensionContext;
    private buildConfigCollections: Map<string, PandocBuildConfigCollection>;
    private fallbackBuildConfigCollections: Map<string, PandocBuildConfigCollection>;
    private isUpdating: boolean;
    private scheduledUpdateTimer: NodeJS.Timeout | undefined;
    private isDisposed: boolean;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.buildConfigCollections = new Map();
        this.fallbackBuildConfigCollections = new Map();
        for (const [ext, reader] of fallbackFileExtensionToReaderMap) {
            const fallbackConfigSettings = this.getFallbackConfigSettings(reader);
            const configCollection = new PandocBuildConfigCollection(ext, fallbackConfigSettings, context);
            this.fallbackBuildConfigCollections.set(ext, configCollection);
        }

        this.isDisposed = false;
        this.isUpdating = false;
    }

    dispose() {
        if (this.scheduledUpdateTimer) {
            clearTimeout(this.scheduledUpdateTimer);
        }
        this.isDisposed = true;
    }

    getFallbackConfigSettings(reader: string) : ConfigSettings {
        return {
            reader: reader,
            preview: {html: getFallbackBuildSettings()},
            export: {},
        };
    }

    async update(config: vscode.WorkspaceConfiguration, callback?: () => void) {
        if (this.isDisposed) {
            return;
        }
        if (this.isUpdating) {
            if (this.scheduledUpdateTimer) {
                clearTimeout(this.scheduledUpdateTimer);
            }
            this.scheduledUpdateTimer = setTimeout(
                () => {
                    this.scheduledUpdateTimer = undefined;
                    this.update(config, callback);
                },
                100,
            );
            return;
        }

        this.isUpdating = true;

        // Remove settings for file extensions that are no longer defined.
        // For those that are defined, update the settings if they are valid
        // and otherwise continue with the last valid state.
        const oldKeys = new Set(this.buildConfigCollections.keys());
        const errorMessages: Array<string> = [];
        for (const [key, value] of Object.entries(config.pandoc.build)) {
            const inputFileExtension = key.slice(1);  // trim `*` from `*.<ext>`
            oldKeys.delete(inputFileExtension);
            let buildConfigCollection: PandocBuildConfigCollection;
            try {
                buildConfigCollection = new PandocBuildConfigCollection(inputFileExtension, value, this.context);
            } catch (error) {
                if (error instanceof CodebraidPreviewError) {
                    errorMessages.push(`Failed to process settings for ${key}:  ${error.message}.`);
                    continue;
                } else {
                    throw error;
                }
            }
            this.buildConfigCollections.set(inputFileExtension, buildConfigCollection);
        }
        for (const oldKey of oldKeys) {
            this.buildConfigCollections.delete(oldKey);
        }
        if (errorMessages.length > 0) {
            vscode.window.showErrorMessage(`Invalid settings under "codebraid.preview.pandoc.build":  ${errorMessages.join('  ')}`);
        }

        for (const [ext, configCollection] of this.buildConfigCollections) {
            for (const [configType, writerBuildConfigMap] of Object.entries({preview: configCollection.preview, export: configCollection.export})) {
                for (const [writerName, buildConfig] of writerBuildConfigMap) {
                    if (buildConfig.defaultsHashName !== null && !this.isDisposed) {
                        try {
                            await this.updateDefaultsFile(buildConfig);
                        } catch (error) {
                            writerBuildConfigMap.delete(writerName);
                            vscode.window.showErrorMessage([
                                `Failed to update "codebraid.preview.pandoc.build" settings for *${ext}, "${configType}", "${writerName}", "defaults".`,
                                `This build configuration will be unavailable until the issue is resolved.`,
                                `${error}`,
                            ].join('  '));
                        }
                    }
                }
            }
        }

        // Carry over deprecated settings if possible
        if (typeof(config.pandoc.fromFormat) === 'string' && config.pandoc.fromFormat !== '' && config.pandoc.fromFormat !== 'commonmark_x') {
            let mdBuildConfigCollection = this.buildConfigCollections.get('.md');
            if (!mdBuildConfigCollection) {
                // `try...catch` here and later guard against `PandocReader()`
                // being incompatible with `config.pandoc.fromFormat`
                try {
                    const fallbackConfigSettings = this.getFallbackConfigSettings(config.pandoc.fromFormat);
                    mdBuildConfigCollection = new PandocBuildConfigCollection('.md', fallbackConfigSettings, this.context);
                    this.buildConfigCollections.set('.md', mdBuildConfigCollection);
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Invalid deprecated setting "codebraid.preview.pandoc.fromFormat" is ignored: ${error}.`
                    );
                }
            }
            if (!mdBuildConfigCollection) {
                // Already resulted in error message due to failed fallback
            } else if (mdBuildConfigCollection.reader.asPandocString === 'commonmark_x') {
                try {
                    const replacementReader = new PandocReader(config.pandoc.fromFormat, this.context);
                    mdBuildConfigCollection.reader = replacementReader;
                    for (const buildConfig of mdBuildConfigCollection.preview.values()) {
                        buildConfig.reader = replacementReader;
                    }
                    for (const buildConfig of mdBuildConfigCollection.export.values()) {
                        buildConfig.reader = replacementReader;
                    }
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Invalid deprecated setting "codebraid.preview.pandoc.fromFormat" is ignored: ${error}.`
                    );
                }
            } else {
                vscode.window.showWarningMessage(
                    'Deprecated setting "codebraid.preview.pandoc.fromFormat" is ignored'
                );
            }
        }
        if (Array.isArray(config.pandoc.options) && config.pandoc.options.length > 0) {
            let mdBuildConfigCollection = this.buildConfigCollections.get('.md');
            if (!mdBuildConfigCollection) {
                const fallbackConfigSettings = this.getFallbackConfigSettings('commonmark_x');
                mdBuildConfigCollection = new PandocBuildConfigCollection('.md', fallbackConfigSettings, this.context);
                this.buildConfigCollections.set('.md', mdBuildConfigCollection);
            }
            let useOptions: boolean = true;
            const buildConfigs = [...mdBuildConfigCollection.preview.values(), ...mdBuildConfigCollection.export.values()];
            for (const buildConfig of buildConfigs) {
                if (buildConfig.options.length !== 0) {
                    useOptions = false;
                    break;
                }
            }
            if (useOptions) {
                for (const buildConfig of buildConfigs) {
                    buildConfig.options.push(...config.pandoc.options);
                }
            } else {
                vscode.window.showWarningMessage(
                    'Deprecated setting "codebraid.preview.pandoc.options" is ignored'
                );
            }
        }

        this.isUpdating = false;

        if (callback) {
            return callback();
        }
    }

    private async updateDefaultsFile(buildConfig: PandocBuildConfig) {
        if (buildConfig.defaultsHashName === null) {
            return;
        }

        const defaultsFileUri = vscode.Uri.file(path.join(this.context.asAbsolutePath('pandoc/defaults'), `${buildConfig.defaultsHashName}.yaml`));
        let defaultsBytes: Uint8Array | undefined;
		try {
			defaultsBytes = await vscode.workspace.fs.readFile(defaultsFileUri);
		} catch {
		}
        if (this.isDisposed) {
            return;
        }
        if (!defaultsBytes || buildConfig.defaultsAsBytes.compare(defaultsBytes) !== 0) {
            await Promise.resolve(vscode.workspace.fs.writeFile(defaultsFileUri, buildConfig.defaultsAsBytes));
        }
        buildConfig.defaultsFileName = defaultsFileUri.fsPath;
    }

    inputFileExtensions() : IterableIterator<string> {
        return this.buildConfigCollections.keys();
    }
    fallbackInputFileExtensions() : IterableIterator<string> {
        return this.fallbackBuildConfigCollections.keys();
    }
    allInputFileExtensions() : IterableIterator<string> {
        return new Set([...this.buildConfigCollections.keys(), ...this.fallbackBuildConfigCollections.keys()]).keys();
    }

    getConfigCollection(inputFileExtension: FileExtension | string) : PandocBuildConfigCollection | undefined {
        if (typeof(inputFileExtension) === 'string') {
            return this.buildConfigCollections.get(inputFileExtension);
        }
        let configCollection = this.buildConfigCollections.get(inputFileExtension.fullExtension);
        if (!configCollection && inputFileExtension.isDoubleExtension) {
            configCollection = this.buildConfigCollections.get(inputFileExtension.outerExtension);
        }
        return configCollection;
    }
    hasConfigCollection(inputFileExtension: FileExtension | string) : boolean {
        return this.getConfigCollection(inputFileExtension) !== undefined;
    }
    getFallbackConfigCollection(inputFileExtension: FileExtension | string) : PandocBuildConfigCollection | undefined {
        if (typeof(inputFileExtension) === 'string') {
            return this.fallbackBuildConfigCollections.get(inputFileExtension);
        }
        let configCollection = this.fallbackBuildConfigCollections.get(inputFileExtension.fullExtension);
        if (!configCollection && inputFileExtension.isDoubleExtension) {
            configCollection = this.fallbackBuildConfigCollections.get(inputFileExtension.outerExtension);
        }
        return configCollection;
    }
    hasFallbackConfigCollection(inputFileExtension: FileExtension | string) : boolean {
        return this.getFallbackConfigCollection(inputFileExtension) !== undefined;
    }
    hasAnyConfigCollection(inputFileExtension: FileExtension | string) : boolean {
        return this.getConfigCollection(inputFileExtension) !== undefined || this.getFallbackConfigCollection(inputFileExtension) !== undefined;
    }

    getPreviewConfig(inputFileExtension: FileExtension | string, writer: PandocWriter | string) : PandocBuildConfig | undefined {
        const configCollection = this.getConfigCollection(inputFileExtension);
        if (typeof(writer) === 'string') {
            return configCollection?.preview.get(writer);
        }
        return configCollection?.preview.get(writer.name);
    }
    hasPreviewConfig(inputFileExtension: FileExtension | string, writer: PandocWriter | string) : boolean {
        return this.getPreviewConfig(inputFileExtension, writer) !== undefined;
    }

    getExportConfig(inputFileExtension: FileExtension | string, writer: PandocWriter | string) : PandocBuildConfig | undefined {
        const configCollection = this.getConfigCollection(inputFileExtension);
        if (typeof(writer) === 'string') {
            return configCollection?.export.get(writer);
        }
        return configCollection?.export.get(writer.name);
    }
    hasExportConfig(inputFileExtension: FileExtension | string, writer: PandocWriter | string) : boolean {
        return this.getExportConfig(inputFileExtension, writer) !== undefined;
    }
}
