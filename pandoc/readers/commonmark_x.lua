-- Copyright (c) 2023, Geoffrey M. Poore
-- All rights reserved.
--
-- Licensed under the BSD 3-Clause License:
-- http://opensource.org/licenses/BSD-3-Clause
--

local format = 'commonmark_x'
local readerlib = dofile(pandoc.path.join{pandoc.path.directory(PANDOC_SCRIPT_FILE), '../lib/readerlib.lua'})

Extensions = readerlib.getExtensions(format)

function Reader(sources, opts)
    return readerlib.read(sources, format, opts)
end
