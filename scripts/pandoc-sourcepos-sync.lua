-- Copyright (c) 2022, Geoffrey M. Poore
-- All rights reserved.
--
-- Licensed under the BSD 3-Clause License:
-- http://opensource.org/licenses/BSD-3-Clause
--

-- Pandoc Lua filter for Codebraid Preview scroll sync.
--
-- Take AST from commonmark_x+sourcepos, and remove all "data-pos" divs and
-- spans except for the first one that occurs on a given input line.  For the
-- first div/span that occurs on a given input line, modify its attrs as
-- needed for Codebraid Preview.  Insert empty divs at the end of the document
-- with attrs that contain additional information.
--


local minLineNum = 0
local maxLineNum = 0
local trackedLines = {}
local referenceLinesToIds = {}
local nodesWithTrackerSpans = {
    Str=true,
    Code=true,
}
local nodesWithAttributes = {
    CodeBlock=true,
    Div=true,
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
local sourceIsStdin = nil
if PANDOC_STATE.input_files[1] == '-' then
    sourceIsStdin = true
else
    sourceIsStdin = false
end


function parseStartEndLineNum(elem, dataPos)
    -- Extract start and end line from 'data-pos' attribute value
    local startLineStr = nil
    local endLineStr = nil
    if sourceIsStdin then
        if string.find(dataPos, ';', nil, true) == nil then
            startLineStr, endLineStr = dataPos:match('^(%d+):%d+%-(%d+):%d+$')
        else
            startLineStr, endLineStr = dataPos:match('^(%d+):.+;%d+:%d+%-(%d+):%d+$')
        end
    else
        if string.find(dataPos, ';', nil, true) == nil then
            startLineStr, endLineStr = dataPos:match('^.*@(%d+):%d+%-(%d+):%d+$')
        else
            startLineStr, endLineStr = dataPos:match('^.*@(%d+):.+;%d+:%d+%-(%d+):%d+$')
        end
    end
    if startLineStr == nil or endLineStr == nil then
        error('Failed to parse sourcepos data.  Received "data-pos" = "' .. dataPos .. '"\n')
    end
    if elem.t ~= 'CodeBlock' then
        return tonumber(startLineStr), tonumber(endLineStr)
    end
    return tonumber(startLineStr), tonumber(endLineStr) - 1
end

function setCodebraidAttr(elem, startLineNum, endLineNum)
    elem.attributes['data-pos'] = nil
    if elem.identifier ~= '' then
        referenceLinesToIds[startLineNum] = elem.identifier
    else
        elem.identifier = 'codebraid-sourcepos-' .. tostring(startLineNum)
    end
    elem.classes:insert('codebraid-sourcepos')
    elem.attributes['codebraid-sourcepos-start'] = startLineNum
    if minLineNum == 0 or startLineNum < minLineNum then
        minLineNum = startLineNum
    end
    if elem.t == 'CodeBlock' then
        if trackedLines[endLineNum] ~= nil then
            -- Ending sourcepos may refer to the start of the line following
            -- a closing code block fence
            endLineNum = endLineNum - 1
        end
        -- math.floor() -> int
        elem.attributes['codebraid-sourcepos-lines'] = math.floor(endLineNum - startLineNum + 1)
    end
    trackedLines[startLineNum] = true
end


function Code(elem)
    local dataPos = elem.attributes['data-pos']
    if dataPos == nil then
        return nil
    end
    local startLineNum, endLineNum = parseStartEndLineNum(elem, dataPos)
    if trackedLines[startLineNum] ~= nil then
        elem.attributes['data-pos'] = nil
        return elem
    end
    setCodebraidAttr(elem, startLineNum, endLineNum)
    return elem
end


Image = Code


function Span(elem)
    local dataPos = elem.attributes['data-pos']
    if dataPos == nil then
        return nil
    end
    if #(elem.content) ~= 1 or nodesWithTrackerSpans[elem.content[1].t] == nil then
        if elem.identifier == '' and #(elem.classes) == 0 and #(elem.attributes) == 1 then
            return elem.content
        end
        elem.attributes['data-pos'] = nil
        return elem
    end
    local startLineNum, endLineNum = parseStartEndLineNum(elem, dataPos)
    if trackedLines[startLineNum] ~= nil then
        if elem.identifier == '' and #(elem.classes) == 0 and #(elem.attributes) == 1 then
            return elem.content
        end
        elem.attributes['data-pos'] = nil
        return elem
    end
    setCodebraidAttr(elem, startLineNum, endLineNum)
    return elem
end


function Inlines(elem)
    for _, subElem in pairs(elem) do
        if nodesWithAttributes[subElem.t] ~= nil then
            local dataPos = subElem.attributes['data-pos']
            if dataPos ~= nil then
                subElem.attributes['data-pos'] = nil
            end
        end
    end
    return elem
end


function CodeBlock(elem)
    local dataPos = elem.attributes['data-pos']
    if dataPos == nil then
        return nil
    end
    local startLineNum, endLineNum = parseStartEndLineNum(elem, dataPos)
    if endLineNum > maxLineNum then
        maxLineNum = endLineNum
    end
    if trackedLines[startLineNum] ~= nil then
        elem.attributes['data-pos'] = nil
        return elem
    end
    setCodebraidAttr(elem, startLineNum, endLineNum)
    return elem
end


Header = CodeBlock


function Div(elem)
    local dataPos = elem.attributes['data-pos']
    if dataPos == nil then
        return nil
    end
    local _, endLineNum = parseStartEndLineNum(elem, dataPos)
    if endLineNum > maxLineNum then
        maxLineNum = endLineNum
    end
    if elem.identifier == '' and #(elem.classes) == 0 and #(elem.attributes) == 1 then
        return elem.content
    else
        elem.attributes['data-pos'] = nil
        return elem
    end
end


function Blocks(elem)
    for _, subElem in pairs(elem) do
        if nodesWithAttributes[subElem.t] ~= nil then
            local dataPos = subElem.attributes['data-pos']
            if dataPos ~= nil then
                subElem.attributes['data-pos'] = nil
                local _, endLineNum = parseStartEndLineNum(subElem, dataPos)
                if endLineNum > maxLineNum then
                    maxLineNum = endLineNum
                end
            end
        end
    end
    return elem
end


function Pandoc(doc)
    -- `trackedLines` is not a sequence, so `#trackedLines == 0` isn't valid
    if maxLineNum == 0 then
        return nil
    end
    for lineNumber, identifier in pairs(referenceLinesToIds) do
        doc.blocks:insert(
            pandoc.Div(pandoc.Null(), {
                id='codebraid-sourcepos-' .. tostring(lineNumber),
                class='codebraid-sourcepos-ref',
                ['codebraid-sourcepos-ref']=identifier
            })
        )
    end
    doc.blocks:insert(
        pandoc.Div(pandoc.Null(), {
            id='codebraid-sourcepos-meta',
            class='codebraid-sourcepos-meta',
            ['codebraid-sourcepos-min']=minLineNum,
            ['codebraid-sourcepos-max']=maxLineNum,
        })
    )
    return doc
end


-- Some elements need processing first.  For example, if there is both an
-- image and text on a line, the image should be used for sync.
return {
    {
        Image = Image,
        Header = Header
    },
    {
        Code = Code,
        Span = Span,
        Inlines = Inlines,
        CodeBlock = CodeBlock,
        Div = Div,
        Blocks = Blocks,
        Pandoc = Pandoc
    }
}