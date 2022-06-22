-- Copyright (c) 2022, Geoffrey M. Poore
-- All rights reserved.
--
-- Licensed under the BSD 3-Clause License:
-- http://opensource.org/licenses/BSD-3-Clause
--

-- Pandoc Lua filter that takes Codebraid output stored in document metadata
-- and inserts the output into the document, overwriting the code nodes that
-- generated it.
--


local fromFormatIsCommonmark = false
local codebraidIsRunning = false
-- Chunk output obtained from metadata.  {code_collection_key: [{chunk_attr: value}]}
local codebraidOutput = {}
-- Current location in output for each code collection.  {code_collection_key: int}
local codebraidKeyCurrentIndex = {}
-- Whether each code collection has stale output.  {code_collection_key: bool}
local codebraidKeyIsStale = {}
-- Whether code collection is currently being processed/executed.  nil | {code_collection_key: bool}
local codebraidKeyIsProcessing
-- Map placehold langs to actual langs for cases where lang is inherited.  {key: value}
local codebraidPlaceholderLangs = {}
-- Counter for assigning placeholder langs for cases where lang is inherited.
local placeholderLangNum = 0


--[[
Classes attached to output based on its status.
  * `missing`:  No output data exists.  This applies to a new code chunk that
    has never been processed by Codebraid.
  * `placeholder`:  This is only possible while Codebraid is running (or if
    Codebraid fails to complete).  Output data has not been received but is
    expected.  There is no old cached output, so a placeholder is displayed.
    This applies to a code chunk in a session/source currently being processed
    by Codebraid, when the chunk itself has not yet been processed.
  * `old`:  This is only possible while Codebraid is running (or if Codebraid
    fails to complete).  It is the same as `placeholder`, except old cached
    output data exists so it can be displayed instead of a placeholder.
  * `modified`:  Output data exists but it may be outdated because the code
    chunk attributes or code has been modified.  When both `old` and
    `modified` apply to a chunk, `modified` is used.
  * `stale`:  Output data exists and can be displayed, but a prior code chunk
    has been modified so the output may be outdated.  When both `old` and
    `stale` apply to a chunk, `stale` is used.

The `invalid-display` class applies in cases where output exists but there is
an inline-block mismatch that makes the output impossible to display.  The
`output-none` class applies when there is outdated data and it contains no
output.
--]]
local classCategories = {'missing', 'placeholder', 'old', 'modified', 'stale'}
local classes = {
    ['output'] = 'codebraid-output',
    ['outputNoOutput'] = 'codebraid-output codebraid-output-none',
}
for _, k in pairs(classCategories) do
    classes[k] = 'codebraid-output codebraid-output-' .. k
    if k ~= 'missing' and k ~= 'placeholder' then
        classes[k .. 'InvalidDisplay'] = classes[k] .. ' codebraid-output-invalid-display'
        classes[k .. 'NoOutput'] = classes[k] .. ' codebraid-output-none'
    end
end
local preppingClass = ' codebraid-output-prepping'
local processingClass = ' codebraid-output-processing'


-- Dict of Codebraid classes that cause code execution.  {key: bool}
local codebraidExecuteClasses = {
    ['cb-expr'] = true,
    ['cb-nb'] = true,
    ['cb-run'] = true,
    ['cb-repl'] = true
}
for k, v in pairs(codebraidExecuteClasses) do
    local altKey, _ = k:gsub('%-', '.')
    codebraidExecuteClasses[altKey] = v
end




function Meta(metaTable)
    local metaConfig = metaTable['codebraid_meta']
    local metaOutput = metaTable['codebraid_output']
    if metaConfig == nil or metaOutput == nil then
        return
    end
    fromFormatIsCommonmark = metaConfig['commonmark']
    codebraidIsRunning = metaConfig['running']
    if metaConfig['placeholder_langs'] ~= nil then
        for key, elem in pairs(metaConfig['placeholder_langs']) do
            codebraidPlaceholderLangs[key] = elem[1].text
        end
    end
    codebraidKeyIsProcessing = metaConfig['collection_processing']
    for key, rawOutputList in pairs(metaOutput) do
        local processedOutputList = {}
        codebraidOutput[key] = processedOutputList
        for _, rawOutput in pairs(rawOutputList) do
            if rawOutput['placeholder'] ~= nil then
                table.insert(processedOutputList, {['placeholder']=true})
            else
                local nodeOutput = {
                    ['placeholder'] = false,
                    ['inline'] = rawOutput['inline'],
                    ['attr_hash'] = rawOutput['attr_hash'][1].text,
                    ['code_hash'] = rawOutput['code_hash'][1].text,
                }
                if rawOutput['old'] == nil then
                    nodeOutput['old'] = false
                else
                    nodeOutput['old'] = true
                end
                if rawOutput['output'] ~= nil then
                    if nodeOutput['inline'] then
                        local inlineOutputElems = pandoc.Inlines{}
                        for _, output in pairs(rawOutput['output']) do
                            for _, blockElem in pairs(output) do
                                for inlineIndex, inlineElem in pairs(blockElem.content) do
                                    -- The first element is a placeholder span
                                    -- to prevent text from being parsed as if
                                    -- present at the start of a new line
                                    if inlineIndex > 1 then
                                        inlineOutputElems:insert(inlineElem)
                                    end
                                end
                            end
                        end
                        nodeOutput['output'] = inlineOutputElems
                    else
                        local blockOutputElems = pandoc.Blocks{}
                        for _, output in pairs(rawOutput['output']) do
                            for _, blockElem in pairs(output) do
                                blockOutputElems:insert(blockElem)
                            end
                        end
                        nodeOutput['output'] = blockOutputElems
                    end
                end
                table.insert(processedOutputList, nodeOutput)
            end
        end
    end
    metaTable['codebraid_meta'] = nil
    metaTable['codebraid_output'] = nil
    return metaTable
end




function getCodebraidLangAndCommandClass(classes)
    for index, class in pairs(classes) do
        if class:sub(1, 3) == 'cb-' or (not fromFormatIsCommonmark and class:sub(1, 3) == 'cb.') then
            local lang = ''
            if index > 1 then
                lang = classes[1]
            end
            if lang:match('^%d+$') then
                actualLang = codebraidPlaceholderLangs[tostring(placeholderLangNum)]
                if actualLang ~= nil then
                    lang = actualLang
                    placeholderLangNum = placeholderLangNum + 1
                end
            end
            return lang, class
        end
    end
    return nil, nil
end

function getCodebraidCodeCollectionType(cbClass)
    if codebraidExecuteClasses[cbClass] == nil then
        return 'source'
    end
    return 'session'
end

function getCodebraidCodeCollectionName(cbCollectionType, attributes)
    for k, v in pairs(attributes) do
        if k == cbCollectionType then
            return v
        end
    end
    return ''
end

local codebraidSourceposPrefix = 'codebraid-sourcepos'
local codebraidSourceposPrefixLen = codebraidSourceposPrefix:len()
function isCodebraidSourcepos(s)
    if s == nil or s:len() < codebraidSourceposPrefixLen then
        return false
    end
    if s:sub(1, codebraidSourceposPrefixLen) == codebraidSourceposPrefix then
        return true
    end
    return false
end

function getCodebraidAttrHash(id, classes, attributes)
    local attrList = {}
    table.insert(attrList, '{')
    if not isCodebraidSourcepos(id) and id ~= nil and id ~= '' then
        table.insert(attrList, '#' .. id)
    end
    for _, class in pairs(classes) do
        if not isCodebraidSourcepos(class) then
            table.insert(attrList, '.' .. class)
        end
    end
    for k, v in pairs(attributes) do
        if not isCodebraidSourcepos(k) then
            local vEsc, _ = v:gsub('\\', '\\\\')
            vEsc, _  = vEsc:gsub('"', '\\"')
            table.insert(attrList, k .. '=' .. '"' .. vEsc .. '"')
        end
    end
    table.insert(attrList, '}')
    attrString = table.concat(attrList, ' ')
    return pandoc.sha1(attrString)
end


function codeChunk(elem, isInline)
    local cbLang, cbClass = getCodebraidLangAndCommandClass(elem.classes)
    if cbClass == nil then
        return
    end
    local cbCollectionType = getCodebraidCodeCollectionType(cbClass)
    local cbCollectionName = getCodebraidCodeCollectionName(cbCollectionType, elem.attributes)
    local key = cbCollectionType .. '.' .. cbLang .. '.' .. cbCollectionName

    local chunkStageClass = ''
    if codebraidIsRunning and codebraidKeyIsProcessing == nil then
        chunkStageClass = preppingClass
    end

    local collectionData = codebraidOutput[key]
    if collectionData == nil then
        if isInline then
            return pandoc.Span(pandoc.Span(pandoc.Inlines{}), {class=classes['missing'] .. chunkStageClass})
        else
            return pandoc.Div(pandoc.Null(), {class=classes['missing'] .. chunkStageClass})
        end
    end
    local nodeIndex = codebraidKeyCurrentIndex[key]
    if nodeIndex == nil then
        nodeIndex = 1
    end
    codebraidKeyCurrentIndex[key] = nodeIndex + 1
    local nodeData = collectionData[nodeIndex]
    if nodeData == nil then
        if isInline then
            return pandoc.Span(pandoc.Span(pandoc.Inlines{}), {class=classes['missing'] .. chunkStageClass})
        else
            return pandoc.Div(pandoc.Null(), {class=classes['missing'] .. chunkStageClass})
        end
    end
    if codebraidIsRunning and codebraidKeyIsProcessing ~= nil and codebraidKeyIsProcessing[key] then
        if nodeData['placeholder'] or nodeData['old'] then
            chunkStageClass = processingClass
        end
    end
    if nodeData['placeholder'] then
        if isInline then
            return pandoc.Span(pandoc.Span(pandoc.Inlines{}), {class=classes['placeholder'] .. chunkStageClass})
        else
            return pandoc.Div(pandoc.Null(), {class=classes['placeholder'] .. chunkStageClass})
        end
    end
    local isModified = false
    local isStale = codebraidKeyIsStale[key]
    if isStale == nil then
        isStale = false
    end
    local attrHash = getCodebraidAttrHash(elem.id, elem.classes, elem.attributes)
    local codeHash = pandoc.sha1(elem.text)
    if attrHash ~= nodeData['attr_hash'] or codeHash ~= nodeData['code_hash'] or isInline ~= nodeData['inline'] then
        isModified = true
        isStale = true
    end
    codebraidKeyIsStale[key] = isStale

    local output
    if nodeData['output'] ~= nil and isInline == nodeData['inline'] then
        if isInline then
            output = pandoc.Span(nodeData['output'])
        else
            output = nodeData['output']
        end
    else
        if isInline then
            output = pandoc.Span(pandoc.Inlines{})
        else
            output = pandoc.Null()
        end
    end
    local baseClass
    if isModified then
        baseClass = 'modified'
    elseif isStale then
        baseClass = 'stale'
    elseif nodeData['old'] then
        baseClass = 'old'
    else
        baseClass = 'output'
    end
    local displayClass
    if nodeData['output'] ~= nil then
        if isInline == nodeData['inline'] then
            displayClass = ''
        else
            displayClass = 'InvalidDisplay'
        end
    else
        displayClass = 'NoOutput'
    end
    if isInline then
        return pandoc.Span(output, {class=classes[baseClass .. displayClass] .. chunkStageClass})
    else
        return pandoc.Div(output, {class=classes[baseClass .. displayClass] .. chunkStageClass})
    end
end

function Code(elem)
    return codeChunk(elem, true)
end

function CodeBlock(elem)
    return codeChunk(elem, false)
end




return {
    {
        Meta = Meta,
    },
    {
        Pandoc = function (doc)
            return doc:walk {
                traverse = 'topdown',
                Code = Code,
                CodeBlock = CodeBlock,
            }
        end
    },
}
