import pathlib


formats = [
    'commonmark', 'commonmark_x', 'gfm',
    'markdown', 'markdown_mmd', 'markdown_phpextra', 'markdown_strict',
    'latex',
    'org',
    'rst',
    'textile'
]

template = '''\
-- Copyright (c) 2023, Geoffrey M. Poore
-- All rights reserved.
--
-- Licensed under the BSD 3-Clause License:
-- http://opensource.org/licenses/BSD-3-Clause
--

local format = '<format>'
local readerlib = dofile(pandoc.path.join{pandoc.path.directory(PANDOC_SCRIPT_FILE), '../lib/readerlib.lua'})

Extensions = readerlib.getExtensions(format)

function Reader(sources, opts)
    return readerlib.read(sources, format, opts)
end
'''

for format in formats:
    file_path = pathlib.Path(f'../readers/{format}.lua')
    file_path.write_text(template.replace('<format>', format), encoding='utf8')
