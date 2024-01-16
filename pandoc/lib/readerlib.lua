-- Copyright (c) 2023, Geoffrey M. Poore
-- All rights reserved.
--
-- Licensed under the BSD 3-Clause License:
-- http://opensource.org/licenses/BSD-3-Clause
--


-- Pandoc Lua reader library for [Codebraid](https://codebraid.org/) and
-- related software.
--
--   * Only reads from stdin, not the filesystem.  The first line of input
--     must be file metadata in JSON format, including filename(s) and
--     length(s).  This allows multiple (concatenated) sources to be read from
--     stdin, while still processing them as if they were separate files read
--     from the filesystem.  That includes `--file-scope` emulation via a
--     `+file_scope` extension.
--
--   * For formats with Pandoc's `sourcepos` extension, modifies the
--     `sourcepos` data.  Source names are omitted.  All line numbers refer to
--     line numbers in the concatenated sources, rather than line numbers
--     within individual sources.  (This is regardless of `+file_scope`.) This
--     provides a simple, unambiguous way to handle sources that are included
--     multiple times.
--
--   * For formats without Pandoc's `sourcepos` extension, defines a
--     `+sourcepos` extension that generates `sourcepos`-style data.  Source
--     names are omitted.  All line numbers refer to line numbers in the
--     concatenated sources, rather than line numbers within individual
--     sources.  (This is regardless of `+file_scope`.)
--
--
-- # Usage
--
-- Create a reader Lua script, for example, `markdown.lua`.  The example below
-- assumes that `markdown.lua` and `readerlib.lua` are in the same directory.
-- The loading process for `readerlib.lua` should be adjusted if it is
-- elsewhere.  `readerlib.lua` itself requires at least one external library,
-- `sourceposlib.lua'.  If this is not in the same directory as
-- `readerlib.lua`, then redefine `readerlib.libPath` accordingly.
--
--     local format = 'markdown'
--     local scriptDir = pandoc.path.directory(PANDOC_SCRIPT_FILE)
--     local readerlib = dofile(pandoc.path.join{scriptDir, 'readerlib.lua'})
--
--     Extensions = readerlib.getExtensions(format)
--
--     function Reader(sources, opts)
--         return readerlib.read(sources, format, opts)
--     end
--
-- Then use the custom reader:
--
--     pandoc -f markdown.lua -t <format> ...
--
-- Instead of `-f markdown.lua`, the path to `markdown.lua` may need to be
-- specified, depending on where it is located and system configuration.
-- Pandoc looks for readers relative to the working directory, and then checks
-- in the `custom` subdirectory of the user data directory (see Pandoc's
-- `--data-dir`).
--
-- Instead of using `--file-scope`, use `-f markdown.lua+file_scope`.
--
-- The `+sourcepos` extension can be used with all text-based formats.  (But
-- see the notes below about the `sourcepos` data.)
--
--
-- # Input format
--
-- The first line of input must be file metadata in JSON format, including
-- filename(s) and length(s):
--
--     {"sources": [{"name": <path_string>, "lines": <number_of_lines>}, ...]}
--
-- This is then followed by the concatenated contents of all sources.  The
-- text for each source must have newlines appended until it ends with the
-- sequence `\n\n`.
--
--
-- # `sourcepos` support for formats without Pandoc's `sourcepos` extension
--
-- The reader generates an AST, like normal.  Then it walks through the AST,
-- and for each Str/Code/CodeBlock/RawInline/RawBlock node it searches the
-- document sources for the corresponding text.  Each search picks up where
-- the last successful search ended.  Each successful search results in the
-- current search node being wrapped in a Span/Div node containing source data
-- in the `sourcepos` format:  `data-pos` attribute with source info.  The
-- `sourcepos` data differs from that provided by Pandoc in a few ways.
--
--   * Source names are omitted.  All line numbers refer to line numbers in
--     the concatenated sources, rather than line numbers within individual
--     sources.  This provides a simple, unambiguous way to handle sources
--     that are included multiple times.  It does mean that external
--     applications using the `sourcepos` data must maintain a mapping between
--     line numbers in the concatenated sources and line numbers in individual
--     sources.
--
--   * Only line numbers are calculated.  Column numbers are always set to 0
--     (zero).  Column numbers cannot be determined accurately unless they are
--     tracked during document parsing.  Line numbers themselves will not
--     always be correct, since they are reconstructed after parsing.
--


local VERSION = {0, 2, 0}
local VERSION_DATE = '20240116'
local VERSION_STRING = table.concat(VERSION, '.')
local AUTHOR_NOTE = table.concat({
    'Pandoc Lua reader library for [Codebraid](https://codebraid.org/) and related software.',
    'Version ' .. VERSION_STRING .. ' from ' .. VERSION_DATE .. '.',
    'Copyright (c) 2023-2024, Geoffrey M. Poore.',
    'All rights reserved.',
    'Licensed under the BSD 3-Clause License: http://opensource.org/licenses/BSD-3-Clause.',
}, '\n')
local readerlib = {
    VERSION        = VERSION,
    VERSION_DATE   = VERSION_DATE,
    VERSION_STRING = VERSION_STRING,
    AUTHOR_NOTE    = AUTHOR_NOTE,
}

-- There is no way for a custom reader to access command-line `--file-scope`
-- status, so a corresponding extension is defined.  The `sourcepos` extension
-- defined here is primarily for Pandoc formats that do not already have
-- `sourcepos` support.  The `prefer_pandoc_sourcepos` extension determines
-- whether the `sourcepos` extension uses Pandoc's `sourcepos` (when
-- available) or uses `sourceposlib` instead.  The `sourceposlib`
-- implementation is usually less accurate, but also inserts fewer block-level
-- nodes into the AST and thus can be more convenient for working with
-- filters.
readerlib.customExtensions = {
    file_scope = false,
    sourcepos = false,
    prefer_pandoc_sourcepos = true,
}


local function throwFatalError(message)
    io.stderr:write('The Codebraid custom Lua reader for Pandoc failed:\n')
    if message:sub(-1) == '\n' then
        io.stderr:write(message)
    else
        io.stderr:write(message .. '\n')
    end
    os.exit(1)
end


-- By default, assume all libraries are in the same directory as this file.
-- Libraries are only loaded when needed, so that `readerlib.libPath` can be
-- redefined if necessary before load time.
readerlib.libPath = pandoc.path.directory(debug.getinfo(1, 'S').source:sub(2))
local didLoadLibs = false
local sourceposlib
local loadLibs = function ()
    sourceposlib = dofile(pandoc.path.join{readerlib.libPath, 'sourceposlib.lua'})
    didLoadLibs = true
end


local nodesWithAttributes = {
    CodeBlock=true,
    Div=true,
    Figure=true,
    Header=true,
    Table=true,
    Code=true,
    Image=true,
    Link=true,
    Span=true,
    Cell=true,
    TableFoot=true,
    TableHead=true,
}

local formatHasPandocSourceposMap = {}
readerlib.formatHasPandocSourcepos = function (format)
    if formatHasPandocSourceposMap[format] == nil then
        readerlib.getExtensions(format)
    end
    return formatHasPandocSourceposMap[format]
end

readerlib.getExtensions = function (format)
    local extensions = pandoc.format.extensions(format)
    formatHasPandocSourceposMap[format] = extensions['sourcepos'] ~= nil
    for k, v in pairs(readerlib.customExtensions) do
        if extensions[k] == nil then
            extensions[k] = v
        end
    end
    -- Format-specific patches
    if format == 'textile' then
        extensions['raw_html'] = nil
    end
    return extensions
end


local function parseConcatSources(concatSources)
    local sources = {}
    local concatSourcesWithJsonHeaderText = concatSources[1].text
    local concatSourcesFirstNewlineIndex, _ = concatSourcesWithJsonHeaderText:find('\n', 1, true)
    if concatSourcesFirstNewlineIndex == nil then
        throwFatalError('Missing JSON header containing source metadata')
    end
    local rawJsonHeader = concatSourcesWithJsonHeaderText:sub(1, concatSourcesFirstNewlineIndex-1)
    local concatSourcesText = concatSourcesWithJsonHeaderText:sub(concatSourcesFirstNewlineIndex+1)
    local jsonHeader = pandoc.json.decode(rawJsonHeader, false)
    if type(jsonHeader) ~= 'table' or type(jsonHeader.sources) ~= 'table' then
        throwFatalError('Incomplete or invalid JSON header for source metadata')
    end
    for k, v in pairs(jsonHeader.sources) do
        if type(k) ~= 'number' or type(v) ~= 'table' then
            throwFatalError('Incomplete or invalid JSON header for source metadata')
        end
        if type(v.name) ~= 'string' or type(v.lines) ~= 'number' then
            throwFatalError('Incomplete or invalid JSON header for source metadata')
        end
    end
    if #jsonHeader.sources == 1 then
        local newSource = {
            name = jsonHeader.sources[1].name,
            lines = jsonHeader.sources[1].lines,
            text = concatSourcesText
        }
        table.insert(sources, newSource)
    else
        local concatSourcesIndex = 1
        local stringbyte = string.byte
        local newlineAsByte = stringbyte('\n')
        for _, src in pairs(jsonHeader.sources) do
            local newSource = {
                name = src.name,
                lines = src.lines
            }
            local lines = src.lines
            if concatSourcesIndex > concatSourcesText:len() then
                throwFatalError('Did not receive text for source "' .. src.name .. '"')
            end
            for index = concatSourcesIndex, concatSourcesText:len() do
                if stringbyte(concatSourcesText, index) == newlineAsByte then
                    lines = lines - 1
                    if lines == 0 then
                        newSource.text = concatSourcesText:sub(concatSourcesIndex, index)
                        if newSource.text:sub(-2) ~= '\n\n' then
                            throwFatalError('Source "' .. src.name .. '" does not end with an empty line (\\n\\n)')
                        end
                        concatSourcesIndex = index + 1
                        break
                    end
                end
            end
            if lines ~= 0 or newSource.text == nil then
                throwFatalError('Did not receive all text for source "' .. src.name .. '"')
            end
            table.insert(sources, newSource)
        end
    end
    local offset = 0
    for _, source in pairs(sources) do
        source.sanitizedName = source.name:gsub(':?%.?[\\/]', '__'):gsub(' ', '-'):gsub('%.', '')
        source.offset = offset
        offset = offset + source.lines
    end
    return sources, concatSourcesText
end

local function parseExtensions(format, extensions)
    local pandocExtensions = {}
    local customExtensions = {}
    for _, ext in pairs(extensions) do
        if readerlib.customExtensions[ext] == nil then
            pandocExtensions[ext] = true
        elseif ext == 'sourcepos' and readerlib.formatHasPandocSourcepos(format) then
            if extensions:includes('prefer_pandoc_sourcepos') then
                pandocExtensions[ext] = true
            else
                customExtensions[ext] = true
            end
        else
            customExtensions[ext] = true
        end
    end
    return pandocExtensions, customExtensions
end

-- read(
--   concatSources: <JSON file metadata header line, then concatenated text>,
--   format: <format name, without extensions (without `+-extension`)>,
--   opts: <opts from `Reader()`, ReaderOptions, or compatible table>,
-- )
readerlib.read = function (concatSources, format, opts)
    if not didLoadLibs then
        loadLibs()
    end
    if not (concatSources and format and opts) then
        throwFatalError('Missing arguments: sources, format, and opts are required')
    end
    if #concatSources ~= 1 or concatSources[1].name ~= '' then
        throwFatalError('Only a single input read from stdin is supported')
    end
    if not format:match('^[a-z_]+$') then
        throwFatalError('Invalid format name (any extensions should be passed via opts.extensions)')
    end
    -- When reading, always use `pandoc.read(<text>, ...)` rather than
    -- `pandoc.read(<sources>, ...)`.  The `sources` returned by
    -- `parseConcatSources()` have the same attributes as those generated by
    -- Pandoc itself, but they are not the Pandoc Haskell Sources type and
    -- thus are not accepted by `pandoc.read()`.
    local sources, concatSourcesText = parseConcatSources(concatSources)
    local pandocExtensions, customExtensions = parseExtensions(format, opts.extensions)
    local doc
    if not customExtensions['file_scope'] or #sources == 1 then
        doc = pandoc.read(concatSourcesText, {format=format, extensions=pandocExtensions}, opts)
        if pandocExtensions['sourcepos'] then
            doc = doc:walk(sourceposlib.strMergeFilter)
        elseif customExtensions['sourcepos'] then
            doc = sourceposlib.addSourcepos(doc, concatSourcesText, format, pandocExtensions, customExtensions, 0)
        end
    else
        -- Emulate `--file-scope` using the `+file_scope` extension:
        --   * Read each source individually.
        --   * Merge metadata, with later metadata overwriting earlier.  Note
        --     that Pandoc automatically updates the document returned by a
        --     `Reader()` with any metadata from `--metadata`, so `--metadata`
        --     doesn't need to be handled explicitly here.
        --   * Change all ids and internal links to include a prefix based on
        --     source name.
        --   * Wrap each source's blocks in a Div with an id based on source
        --     name.  Then join the Divs to create the final document.
        doc = pandoc.Pandoc({})
        for sourceNum, source in pairs(sources) do
            local subDoc = pandoc.read(source.text, {format=format, extensions=pandocExtensions}, opts)
            for k, v in pairs(subDoc.meta) do
                doc.meta[k] = v
            end
            local subFilter = {}
            local updateIdSourcepos
            local addDataPosOffset
            if pandocExtensions['sourcepos'] and sourceNum > 1 then
                addDataPosOffset = function (dataPos)
                    local startLine, firstIgnored, endLine, secondIgnored
                    if dataPos:find(';', nil, true) == nil then
                        startLine, firstIgnored, endLine, secondIgnored = dataPos:match('^(%d+)(:%d+%-)(%d+)(:%d+)$')
                    else
                        startLine, firstIgnored, endLine, secondIgnored = dataPos:match('^(%d+)(:.+;%d+:%d+%-)(%d+)(:%d+)$')
                    end
                    startLine = tostring(tonumber(startLine) + source.offset)
                    endLine = tostring(tonumber(endLine) + source.offset)
                    return startLine .. firstIgnored .. endLine .. secondIgnored
                end
                updateIdSourcepos = function (node)
                    local didModify = false
                    if node.identifier ~= '' then
                        node.identifier = source.sanitizedName .. '__' .. node.identifier
                        didModify = true
                    end
                    if node.attributes['data-pos'] then
                        node.attributes['data-pos'] = addDataPosOffset(node.attributes['data-pos'])
                        didModify = true
                    end
                    if didModify then
                        return node
                    end
                    return nil
                end
            else
                updateIdSourcepos = function (node)
                    if node.identifier == '' then
                        return nil
                    end
                    node.identifier = source.sanitizedName .. '__' .. node.identifier
                    return node
                end
            end
            for k, _ in pairs(nodesWithAttributes) do
                if k ~= 'Link' then
                    subFilter[k] = updateIdSourcepos
                end
            end
            subFilter.Link = function (node)
                local didModify = false
                local maybeNode = updateIdSourcepos(node)
                if maybeNode ~= nil then
                    node = maybeNode
                    didModify = true
                end
                if node.target:sub(1, 1) == '#' then
                    node.target = '#' .. source.sanitizedName .. '__' .. node.target:sub(2)
                    didModify = true
                end
                if didModify then
                    return node
                end
                return nil
            end
            if pandocExtensions['sourcepos'] then
                for k, v in pairs(sourceposlib.strMergeFilter) do
                    if subFilter[k] ~= nil then
                        throwFatalError('Lua filter clash in processing custom extension +file_scope')
                    end
                    subFilter[k] = v
                end
            end
            subDoc = subDoc:walk(subFilter)
            if customExtensions['sourcepos'] then
                subDoc = sourceposlib.addSourcepos(subDoc, source.text, format, pandocExtensions, customExtensions, source.offset)
            end
            doc.blocks:insert(pandoc.Div(subDoc.blocks, {id=source.sanitizedName}))
        end
    end
    return doc
end


return readerlib
