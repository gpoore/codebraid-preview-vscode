# Codebraid Preview

Codebraid Preview provides a Markdown preview for
[Pandoc](https://pandoc.org/) documents within [VS
Code](https://code.visualstudio.com/).  Most Markdown previews don't support
all of Pandoc's extensions to Markdown syntax.  Codebraid Preview supports
100% of Pandoc features—because the preview is generated by Pandoc itself!
There is also full bidirectional scroll sync and document export.

Codebraid Preview provides optional support for executing code blocks and
inline code to embed their output in the preview and in exported documents.
Code execution is performed by
[Codebraid](https://github.com/gpoore/codebraid/) using Jupyter kernels or its
own built-in code execution system.  When code is running, the preview still
updates whenever the document is modified, displaying all code output that is
currently available.  The preview always remains live.

![VS Code editor with Codebraid Preview](https://raw.githubusercontent.com/gpoore/codebraid-preview-vscode/master/readme_media/editor_with_preview.png)


## Features

* **HTML preview of Pandoc documents.**  Open the preview by running the "Open
  Codebraid Preview" command (`Ctrl+Shift+P`, then type command).  Or, for
  Markdown documents, just click on the "Codebraid Preview" button in the
  status bar (bottom right).  When changes are detected, the preview
  automatically refreshes.

* **Full bidirectional scroll sync.**  This requires processing the document
  as `commonmark_x`, which is [CommonMark](https://commonmark.org/) plus
  [Pandoc extensions](https://github.com/jgm/pandoc/wiki/Roadmap).
  `commonmark_x` has most of the features in Pandoc's Markdown and continues
  to gain new features.

* **Math support with [KaTeX](https://katex.org/).**  Surround LaTeX math with
  single dollar signs `$` for inline math or double dollar signs `$$` for
  block math, following standard Pandoc conventions.

* **Adjustable scroll sync directions.**  Once a preview window is open, click
  on the "Scroll" button in the status bar (bottom right) to toggle scroll
  mode.

* **Double-click to jump to source.**  Double-click in the preview, and jump
  to the start of the corresponding line in the document.

* **Export documents with Pandoc (including Codebraid output).**  Simply click
  the "Pandoc" button in the status bar (bottom right), or use the "Export
  document with Pandoc" command (`Ctrl+Shift+P`, then type command).

* **Scroll-sync support for multi-file documents.** Pandoc allows you to
  divide a document into multiple files that are combined into a single output
  document at build time.  Codebraid Preview can display such documents as
  long as all document files are in the same directory (folder).  For
  multi-file documents, create a YAML file that lists the document files to be
  combined.  For example, suppose your document is divided into `chapter_1.md`
  and `chapter_2.md`, both in the same directory.  Simply create a file named
  `_codebraid_preview.yaml` with this contents:

  ```
  input-files:
  - chapter_1.md
  - chapter_2.md
  ```

  Now, when you launch a preview in either `chapter_1.md` or `chapter_2.md`,
  both files will be combined in the preview.  When you scroll the preview,
  the editor will automatically switch between `chapter_1.md` and
  `chapter_2.md` depending on which part of the document you are viewing.
  That is, scroll sync works across multiple input files!

* **Execute code.** [Codebraid](https://github.com/gpoore/codebraid/) allows
  code blocks or inline code in Pandoc Markdown documents to be executed, with
  output embedded in the document.  Simply add Codebraid attributes to your
  code, then click the "Codebraid" button in the status bar (bottom right) or
  use the "Run code with Codebraid" command (`Ctrl+Shift+P`, then type
  command).

  For example, to execute a Python fenced code block, simply add the
  attributes `{.python .cb-run}` immediately after the opening fence ` ``` `,
  so that the code block begins with ` ```{.python .cb-run}`.  Then click the
  Codebraid button.  To use a Jupyter kernel for code execution, with a notebook-style display of output, use
  ` ```{.python .cb-nb jupyter_kernel=python3}` in the first code block to be
  executed and ` ```{.python .cb-nb}` in subsequent code blocks.

  When you first load a document that uses Codebraid, any cached code output
  will automatically be loaded and displayed in the document.  The preview
  will automatically refresh when you make changes to the document outside of
  executed code.  However, code never runs automatically.  Code execution
  requires clicking the "Codebraid" button or using the "Run code with
  Codebraid" command.


## Requirements

Install [Pandoc](https://pandoc.org/).  Version 2.17.1.1 or later is strongly
recommended.  Earlier versions may work but will have reduced functionality,
including scroll sync issues with YAML metadata.

For code execution, install the latest version of
[Codebraid](https://github.com/gpoore/codebraid/).


## Extension settings

* `codebraid.preview.minBuildInterval` [`1000`]:  Minimum interval between
  document builds in milliseconds.  Builds only occur when there are changes.

* `codebraid.preview.pandoc.fromFormat` [`commonmark_x`]:  Pandoc source
  format (`--from=FORMAT`).  Currently, only `commonmark_x` supports scroll
  sync.

* `codebraid.preview.pandoc.options` [none]:  Pandoc command-line options.  In
  the settings GUI, one option per line (for example, `--filter FILTER`).  In
  `settings.json`, an array with one option per element (for example,
  `["--filter FILTER"]`).  Pandoc is executed within a shell, so any spaces in
  option values must be quoted.  Depending on operating system, expansion
  and substitution are available.  Under Windows, any unquoted option value
  beginning with `~/` or `~\` will have the `~` expanded to the user home
  directory via `os.homedir()`.

* `codebraid.preview.pandoc.previewDefaultsFile` [`_codebraid_preview.yaml`]:
  Special [Pandoc defaults file](https://pandoc.org/MANUAL.html#defaults-files)
  in the document directory that is used for preview purposes.

  All Pandoc defaults options are supported with one exception.  If the
  defaults file includes additional external defaults files by setting
  `defaults`, then the following options in those additional external defaults
  files will be ignored:  `input-files`, `input-file`, `from`, `reader`, `to`,
  `writer`, and `file-scope`.  The preview must know the values of these
  options to function correctly, and it does not attempt to replicate Pandoc's
  system for locating and merging multiple defaults files.

  While essentially all defaults options are supported, keep in mind that some
  options or option values are irrelevant or inappropriate.  The preview is
  HTML, so avoid options that do not affect HTML, are incompatible with HTML,
  result in non-HTML output, or redirect the output.

  If the defaults file is modified within VS Code, the preview will
  automatically detect changes and update.  If the defaults file is modified
  in another editor, close and restart the preview for changes to be applied.

  If the defaults file exists and it defines `input-files`, then the preview
  will automatically work with all files in a multi-file document.  If the
  defaults file defines `input-files` (or `input-file`), then it will only be
  applied to the specified files; it will be ignored for other files.

  If the defaults file defines `input-files` (or `input-file`), all specified
  files must be in the same directory with the defaults file.  Document files
  in subdirectories are not supported.

* `codebraid.preview.pandoc.showRaw` [`true`]:  Display a verbatim
  representation of non-HTML raw content `{=format}` in the preview.


## A note on filters

Scroll sync is provided for CommonMark-based formats using Pandoc's
`sourcepos` extension.  This inserts `Div` and `Span` nodes into the Pandoc
AST that contain information about source file origin location in a `data-pos`
attribute.  If you use filters with your documents and want to make sure that
the preview is accurate while retaining scroll sync capabilities, make sure
that your filter skips these nodes and only removes them if empty.  For
example, in a Lua filter these nodes can be detected by checking
`node.attributes['data-pos'] ~= nil`.


## Codebraid configuration

When Codebraid is used to run code, the `codebraid` executable is found by
searching the following locations.

1. If a Python interpreter is set in VS Code, the interpreter installation is
   checked for a `codebraid` executable.

   Notice that a Python interpreter can be set at the file level or workspace
   level (`Ctrl+Shift+P`, then `Python: Select Interpreter`, or configure
   `python.defaultInterpreterPath` in a workspace `settings.json`).  A Python
   interpreter can also be configured in global User Settings (File,
   Preferences, Settings, `Python: Default Interpreter Path`).  Only the first
   Python interpreter that is set in the file/workspace/global sequence is
   checked for a `codebraid` executable.

   For more details about configuring Python in VS Code, see
   https://code.visualstudio.com/docs/python/environments.

2. If a Python interpreter is not set, or its installation does not include a
   `codebraid` executable, then the first `codebraid` executable on PATH is
   used.  There will be a warning message if a Python interpreter is set but
   does not include `codebraid`, so that `codebraid` on PATH is used as a
   fallback.

If the `codebraid` executable is part of an
[Anaconda](https://www.anaconda.com/products/distribution) installation, it is
launched via `conda run` so that the relevant conda environment is activated.
For other environments and installations, the `codebraid` executable is run
directly.


## Security

The HTML preview is displayed using a webview.  A content security policy is
used to restrict what is possible in the webview.  Inline scripts and styles
are allowed to support features like KaTeX math.  Loading external resources
not associated with the extension is disabled.

Code is never automatically executed with Codebraid.  Code is only ever
executed when a Codebraid class is added to a code block or inline code, and
then the "Codebraid" button is clicked (or the "Run code with Codebraid"
command is invoked).


## Supporting this project

Codebraid Preview is open-source software released under the BSD 3-Clause
License.  If you use it regularly, please consider supporting further
development through [GitHub Sponsors](https://github.com/sponsors/gpoore).
