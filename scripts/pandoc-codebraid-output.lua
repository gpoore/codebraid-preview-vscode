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


local codebraidConfig = {}
local codebraidOutput = {}
local codebraidKeyCurrentIndex = {}
local codebraidKeyIsStale = {}

local classes = {
    ['classMissing'] = 'codebraid-output-missing',
    ['classOld'] = 'codebraid-output-old',
    ['classStale'] = 'codebraid-output-stale',
    ['classWaiting'] = 'codebraid-output-waiting',
}

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
    codebraidConfig['commonmark'] = metaConfig['commonmark']
    codebraidConfig['codebraid_running'] = metaConfig['codebraid_running']
    if codebraidConfig['codebraid_running'] then
        for className, classVal in pairs(classes) do
            classes[className] = classVal .. ' codebraid-running'
        end
    end
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
        if class:sub(1, 3) == 'cb-' or (not codebraidConfig['commonmark'] and class:sub(1, 3) == 'cb.') then
            local lang = ''
            if index > 1 then
                lang = classes[1]
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


function Code(elem)
    local cbLang, cbClass = getCodebraidLangAndCommandClass(elem.classes)
    if cbLang == nil or cbClass == nil then
        return
    end
    local cbCollectionType = getCodebraidCodeCollectionType(cbClass)
    local cbCollectionName = getCodebraidCodeCollectionName(cbCollectionType, elem.attributes)
    local key = cbCollectionType .. '.' .. cbLang .. '.' .. cbCollectionName

    local collectionData = codebraidOutput[key]
    if collectionData == nil then
        return pandoc.Span({}, {class=classes['classMissing']})
    end
    local nodeIndex = codebraidKeyCurrentIndex[key]
    if nodeIndex == nil then
        nodeIndex = 1
    end
    codebraidKeyCurrentIndex[key] = nodeIndex + 1
    nodeData = collectionData[nodeIndex]
    if nodeData == nil then
        return pandoc.Span(pandoc.Inlines{}, {class=classes['classMissing']})
    end
    if nodeData['placeholder'] then
        return pandoc.Span(pandoc.Inlines{}, {class=classes['classWaiting']})
    end
    local isStale = codebraidKeyIsStale[key]
    if isStale == nil then
        isStale = false
    end
    if not isStale then
        local attrHash = getCodebraidAttrHash(elem.id, elem.classes, elem.attributes)
        local codeHash = pandoc.sha1(elem.text)
        if attrHash ~= nodeData['attr_hash'] or codeHash ~= nodeData['code_hash'] or not nodeData['inline'] then
            isStale = true
        end
    end
    codebraidKeyIsStale[key] = isStale

    if nodeData['output'] ~= nil then
        if not nodeData['inline'] then
            return pandoc.Span(pandoc.Inlines{}, {class=classes['classWaiting']})
        elseif isStale then
            return pandoc.Span(nodeData['output'], {class=classes['classStale']})
        elseif nodeData['old'] then
            return pandoc.Span(nodeData['output'], {class=classes['classOld']})
        else
            return nodeData['output']
        end
    else
        if not nodeData['inline'] then
            return pandoc.Span(pandoc.Inlines{}, {class=classes['classWaiting']})
        elseif isStale then
            return pandoc.Span(pandoc.Inlines{}, {class=classes['classStale']})
        elseif nodeData['old'] then
            return pandoc.Span(pandoc.Inlines{}, {class=classes['classOld']})
        else
            return pandoc.Inlines{}
        end
    end
end


function CodeBlock(elem)
    local cbLang, cbClass = getCodebraidLangAndCommandClass(elem.classes)
    if cbLang == nil or cbClass == nil then
        return
    end
    local cbCollectionType = getCodebraidCodeCollectionType(cbClass)
    local cbCollectionName = getCodebraidCodeCollectionName(cbCollectionType, elem.attributes)
    local key = cbCollectionType .. '.' .. cbLang .. '.' .. cbCollectionName

    local collectionData = codebraidOutput[key]
    if collectionData == nil then
        return pandoc.Div(pandoc.Null(), {class=classes['classMissing']})
    end
    local nodeIndex = codebraidKeyCurrentIndex[key]
    if nodeIndex == nil then
        nodeIndex = 1
    end
    codebraidKeyCurrentIndex[key] = nodeIndex + 1
    nodeData = collectionData[nodeIndex]
    if nodeData == nil then
        return pandoc.Div(pandoc.Null(), {class=classes['classMissing']})
    end
    if nodeData['placeholder'] then
        return pandoc.Div(pandoc.Null(), {class=classes['classWaiting']})
    end
    local isStale = codebraidKeyIsStale[key]
    if isStale == nil then
        isStale = false
    end
    if not isStale then
        local attrHash = getCodebraidAttrHash(elem.id, elem.classes, elem.attributes)
        local codeHash = pandoc.sha1(elem.text)
        if attrHash ~= nodeData['attr_hash'] or codeHash ~= nodeData['code_hash'] or nodeData['inline'] then
            isStale = true
        end
    end
    codebraidKeyIsStale[key] = isStale

    if nodeData['output'] ~= nil then
        if nodeData['inline'] then
            return pandoc.Div(pandoc.Null(), {class=classes['classWaiting']})
        elseif isStale then
            return pandoc.Div(nodeData['output'], {class=classes['classStale']})
        elseif nodeData['old'] then
            return pandoc.Div(nodeData['output'], {class=classes['classOld']})
        else
            return nodeData['output']
        end
    else
        if nodeData['inline'] then
            return pandoc.Div(pandoc.Null(), {class=classes['classWaiting']})
        elseif isStale then
            return pandoc.Div(pandoc.Null(), {class=classes['classStale']})
        elseif nodeData['old'] then
            return pandoc.Div(pandoc.Null(), {class=classes['classOld']})
        else
            return pandoc.Null()
        end
    end
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
