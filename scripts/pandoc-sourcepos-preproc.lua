-- Copyright (c) 2022, Geoffrey M. Poore
-- All rights reserved.
--
-- Licensed under the BSD 3-Clause License:
-- http://opensource.org/licenses/BSD-3-Clause
--

-- Pandoc Lua filter for preprocessing AST from commonmark_x+sourcepos.
-- Intended to run before all other filters.  Merges adjacent Str nodes that
-- are wrapped in sourcepos spans, so that the final Str nodes have the same
-- content as would be generated without sourcepos.  With sourcepos, some
-- adjacent non-whitespace characters are split into multiple Str nodes, and
-- then each of these is wrapped in a sourcepos span.
--


function Inlines(elems)
    local didModify = false
    local preprocElems = pandoc.Inlines{}
    local lastStrElem = nil
    for _, elem in pairs(elems) do
        if elem.t == 'Span' and elem.attributes['data-pos'] ~= nil and #elem.c == 1 and elem.c[1].t == 'Str' then
            if lastStrElem ~= nil then
                -- There is no attempt to merge the `data-pos` attributes
                -- here, because only the line numbers are used for scroll
                -- sync.  Adjacent string nodes are always on the same line,
                -- and inaccurate column numbers are irrelevant.
                lastStrElem.text = lastStrElem.text .. elem.c[1].text
                didModify = true
            else
                lastStrElem = elem.c[1]
                preprocElems:insert(elem)
            end
        else
            lastStrElem = nil
            preprocElems:insert(elem)
        end
    end
    if didModify then
        return preprocElems
    else
        return
    end
end
