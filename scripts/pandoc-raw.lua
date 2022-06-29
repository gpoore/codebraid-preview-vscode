-- Copyright (c) 2022, Geoffrey M. Poore
-- All rights reserved.
--
-- Licensed under the BSD 3-Clause License:
-- http://opensource.org/licenses/BSD-3-Clause
--

-- Pandoc Lua filter that converts non-HTML raw nodes into a form that can
-- be displayed in an HTML preview.
--


function RawNode(elem, isInline)
    if elem.format:lower() == 'html' then
        return
    end
    local attr = pandoc.Attr("", {'pandoc-raw'}, {{'pandoc-raw-attr', '{=' .. elem.format .. '}'}})
    if isInline then
        return pandoc.Span(pandoc.Code(elem.text), attr)
    else
        return pandoc.Div(pandoc.CodeBlock(elem.text), attr)
    end
end

function RawInline(elem)
    return RawNode(elem, true)
end

function RawBlock(elem)
    return RawNode(elem, false)
end


return {
    {
        RawInline = RawInline,
        RawBlock = RawBlock,
    },
}
