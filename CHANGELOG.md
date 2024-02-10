# Change Log


## v0.17.0 (dev)

* Added refresh button to preview (#24).

* Enabled the find widget in the preview webview.  This allows searching
  within the preview using `CTRL+F`.



## v0.16.0 (2024-01-16)

* Improved preview compatibility with custom Pandoc HTML templates.
  Eliminated dependence on the location and format of a `meta` tag with
  `charset` attribute.  Improved error messages for HTML that does not have
  expected format (#20).

* The preview now sets the Pandoc template variable `codebraid_preview` to
  `true`.  This makes it possible for custom HTML templates to adapt based on
  whether they are being used in the preview.

* Added setting `codebraid.preview.css.useMarkdownPreviewStyles`.  This causes
  the preview to inherit custom styles (CSS) from the built-in Markdown
  preview (`markdown.styles`), to maintain a similar appearance (#19).

* Added setting `codebraid.preview.pandoc.preferPandocSourcepos`.  This
  determines whether Pandoc's `sourcepos` is used (when available) to provide
  scroll sync instead of Codebraid Preview's `sourcepos`.  Pandoc's
  `sourcepos` is used by default (when available) because it is usually more
  accurate.  Codebraid Preview's `sourcepos` can be convenient when working
  with filters, since it makes fewer modifications to the AST.

* Improved display of stderr.  When the preview HTML has an unsupported format
  or is invalid, non-error stderr is no longer displayed.  When the input
  format is `markdown_github`, a deprecation warning is only displayed a
  single time when the preview initially starts.

* Updated KaTeX to v0.16.9.



## v0.15.0 (2023-04-20)

* Added setting `codebraid.preview.pandoc.executable` (#17).  This allows
  customizing the location of the Pandoc executable, or using a wrapper
  script.

* Added setting `codebraid.preview.pandoc.extraEnv` (#17).  This allows
  setting additional environment variables for the Pandoc subprocess.

* Added setting `codebraid.preview.pandoc.showStderr` (#17).  This allows the
  preview to display a notification when Pandoc completes without errors, but
  stderr is non-empty.

* Added setting
  `codebraid.preview.security.pandocDefaultDataDirIsResourceRoot` (#17).
  This allows the preview to load resources like images and CSS from
  the default Pandoc user data directory.

* The preview now automatically converts local `file:` URIs that point to the
  default Pandoc user data directory into VS Code webview URIs
  (`webview.asWebviewUri()`) that can be loaded within the webview.  This only
  works when `codebraid.preview.security.pandocDefaultDataDirIsResourceRoot`
  is enabled (default).

* The Pandoc option `--extract-media` is no longer used to create the preview,
  unless the document is a Jupyter notebook.  This option was added in v0.14.0
  to support Jupyter notebooks, but it creates unnecessary temp image files
  for non-notebook documents.

* The preview now provides partial support for the Pandoc option
  `--embed-resources`.  As part of this, added new settings
  `codebraid.preview.security.allowEmbedded*`.

* Added settings under `codebraid.preview.security`:  `allowEmbeddedFonts`,
  `allowEmbeddedImages`, `allowEmbeddedMedia`, `allowEmbeddedScripts`,
  `allowEmbeddedStyles`.  These determine whether the preview webview's
  content security policy allows `data:` URLs.  All are `true` by default
  except for `allowEmbeddedScripts`.  That is, the preview now automatically
  loads embedded fonts, images, media, and styles.

* Added details in README under Security about the implications of the Pandoc
  options `--embed-resources` and `--extract-media`.

* Updated KaTeX to v0.16.6.



## v0.14.0 (2023-04-08)

* The preview is now compatible with Jupyter notebooks (`ipynb`) (#16).
  Scroll sync is not supported.  VS Code opens notebooks with
  `vscode.NotebookEditor` rather than `vscode.TextEditor`, and the preview
  previously ignored `vscode.NotebookEditor`.



## v0.13.0 (2023-03-25)

* Pandoc 3.1.1 is now the minimum recommended version.  The Pandoc version is
  now checked when the extension loads, and there are warnings for older
  Pandoc versions that do not support all features.

* Added preview support (including scroll sync) for additional Pandoc input
  formats: `latex`, `org`, `rst`, and `textile`.  The preview displays any
  parse errors with a link that jumps to the corresponding source location,
  which is particularly useful for LaTeX.

* Added scroll sync support for Markdown variants that are not based on
  CommonMark:  `markdown`, `markdown_mmd`, `markdown_phpextra`, and
  `markdown_strict`.  Previously, scroll sync was restricted to `commonmark`,
  `commonmark_x`, and `gfm`.

* The preview is now compatible with any text-based document format supported
  by Pandoc (including custom Lua readers).  Scroll sync is now possible for
  any text-based format, regardless of whether Pandoc provides a `sourcepos`
  extension.  Scroll sync is automatically supported for all Markdown variants
  plus `latex`, `org`, `rst`, and `textile`.  Code execution via Codebraid is
  still currently limited to formats based on Markdown.

  For formats not based on CommonMark, scroll sync is enabled with the new
  library `sourceposlib.lua`.  This uses the AST produced by Pandoc and the
  document source to reconstruct a mapping between input and output.  It
  produces `sourcepos`-style data for arbitrary text-based document formats.
  In some cases, scroll sync may be slightly inaccurate due to the complexity
  of reconstructing a source map after parsing.  Scroll sync functionality
  will be degraded for documents primarily consisting of emoji or other code
  points outside the Basic Multilingual Plane (BMP), as well as for documents
  primarily consisting of punctuation and symbol code points.  Tables with
  multi-line cells and footnotes can also interfere with scroll sync under
  some circumstances.

  Support for additional input formats can be added by defining them in the
  new setting `codebraid.preview.pandoc.build`.  Scroll sync can be enabled
  for additional formats by creating a very short Lua reader that wraps the
  existing reader.  See `scripts/pandoc/readers` for example Lua wrapper
  scripts; see `scripts/pandoc/lib/readerlib.lua` and
  `scripts/pandoc/lib/sourceposlib.lua` for additional documentation.

* Document export now provides several default choices for export formats,
  instead of simply allowing Pandoc to guess export format based on file
  extension.  Additional export formats can be defined under the new
  setting `codebraid.preview.pandoc.build`.

* The preview now supports `--file-scope` for all Markdown variants, plus
  `latex`, `org`, `rst`, and `textile`.  This is enabled with the new Lua
  reader library `readerlib.lua`.  Previously, `--file-scope` was ignored in
  generating the preview.

* Reorganized settings to account for input formats that are not based on
  Markdown.  `codebraid.preview.pandoc.fromFormat` and
  `codebraid.preview.pandoc.options` are deprecated.  They are replaced by
  `codebraid.preview.pandoc.build`, under property `*.md`.
  `codebraid.preview.pandoc.build` allows each input format to define multiple
  preview formats and multiple export formats.  Each preview/export format can
  define command-line options and also defaults that are saved to a Pandoc
  defaults file.

* Setting `codebraid.preview.pandoc.previewDefaultsFile` is deprecated and
  replaced with `codebraid.preview.pandoc.defaultsFile`.  This makes it
  clearer that the defaults file is used for both preview and export.

* Fixed a bug that prevented a preview from starting when a document is open,
  but the Panel was clicked more recently than the document.

* Reimplemented configuration processing and updating.  Modifying
  configuration during preview update, Codebraid execution, or document export
  no longer has the potential to result in inconsistent state.

* Removed Julia syntax highlighting customization (#4), since it has been
  merged upstream
  (https://github.com/microsoft/vscode-markdown-tm-grammar/pull/111).



## v0.12.0 (2023-01-19)

* Pandoc 3.0 compatibility:  Updated Lua filters by replacing `pandoc.Null()`
  with `pandoc.Blocks{}`.  Minimum supported Codebraid version is now v0.10.3.

* Added new setting `codebraid.preview.css.useMarkdownPreviewFontSettings`.
  This causes the preview to inherit font settings (font family, font size,
  line height) from the built-in Markdown preview (settings under
  `markdown.preview`), to maintain a similar appearance.

* Updated preview CSS to include the most recent CSS used by the built-in VS
  Code Markdown preview.

* Fixed bug from v0.11.0 that caused error messages from Pandoc to be
  displayed incorrectly.



## v0.11.0 (2023-01-16)

* The preview panel now has access to local resources in the workspace
  folders, not just access to resources in the document directory.

* Added new setting `codebraid.preview.security.extraLocalResourceRoots`.
  This allows the preview panel to load resources such as images from
  locations other than the document directory and the workspace folders (#15).

* Reimplemented content security policy and added new related settings under
  `codebraid.preview.security` (#8, #13).

  - The webview content security policy now includes `media-src`.

  - There are new settings that determine whether fonts, images, media,
    styles, and scripts are allowed from local sources and from remote
    sources.  By default, local sources are enabled for everything except
    scripts.  Local access is restricted to the document directory, the
    workspace folders, and any additional locations specified under
    `security.extraLocalResourceRoots`.  By default, remote sources are
    disabled.  Inline scripts are also disabled by default.

  - Scripts are now more restricted by default. `script-src` no longer
    includes `unsafe-inline` or the document directory.  Only scripts bundled
    with the extension are enabled by default, plus inline scripts from
    Pandoc's HTML template (which are enabled via hash).  To re-enable inline
    scripts, use `security.allowInlineScripts`.  To re-enable local scripts,
    use `security.allowLocalScripts`.

* All preview customization to the Pandoc HTML output is now inserted after
  rather than before the charset meta tag.  This includes the base tag,
  content security policy meta tag, and Codebraid scripts.

* Updated KaTeX to v0.16.4.



## v0.10.0 (2022-12-04)

* Added new settings `codebraid.preview.css.useDefault` and
  `codebraid.preview.css.overrideDefault` for controlling whether the default
  preview CSS is loaded and whether it is overridden by document CSS.
  Document CSS now has precedence by default (#14).

* A Codebraid Preview defaults file now has precedence over the extension's
  Pandoc settings.

* Updated KaTeX to v0.16.3.



## v0.9.0 (2022-07-29)

* The preview Pandoc AST is now preprocessed before any user filters are
  applied.  Adjacent `Str` nodes that are wrapped in `data-pos` spans as a
  result of the `sourcepos` extension are now merged.  `sourcepos` splits text
  that normally would have been in a single `Str` node into multiple `Str`
  nodes, and then wraps each in a `data-pos` span.  The preprocessing makes
  user filters behave as closely as possible to the non-`sourcepos` case (#9).

* Added details about `commonmark_x`, including LaTeX macro expansion, to
  README (#10).

* When the Codebraid process fails and there is stderr output, the full
  details are now written to the Output log.



## v0.8.0 (2022-07-11)

* `_codebraid_preview.yaml` now supports essentially all
  [Pandoc defaults options](https://pandoc.org/MANUAL.html#defaults-files)
  and no longer limits the characters allowed in filter file names (#2).
  Previously, only `input-files`, `input-file`, `from`, and `filters` were
  supported.

* The "Codebraid Preview" button in the status bar now only appears when a
  Markdown document is open and visible, and does not yet have a preview.
  Previously, after the extension loaded, the button was visible for
  non-Markdown files and was also visible if the info panel was open.

* Fixed a bug that prevented YAML metadata from working with Codebraid.

* Fixed a bug that prevented identification of inherited languages (for
  example, with `.cb-paste`).



## v0.7.0 (2022-06-29)

* Added setting `codebraid.preview.pandoc.showRaw`.  This provides a verbatim
  representation of non-HTML raw content `{=format}` in the preview.

* Added more details and progress animations in the webview display that is
  shown before Pandoc finishes creating the initial preview.



## v0.6.0 (2022-06-25)

* Minimum supported Codebraid is now v0.9.0.  The preview now shows correct
  file names and line numbers for errors/warnings related to the Markdown
  source, rather than using file names like `<string>` and line numbers that
  are incorrect when multiple Markdown sources are concatenated.  The preview
  now shares cache files with normal Codebraid processing, rather than
  creating a separate cache entry.  All of this is based on the new Codebraid
  option `--stdin-json-header`.

* Fixed a bug that prevented `codebraid` executable from being located in
  Python installations with the `python` executable under `bin/` or `Scripts/`
  rather than at the root of the environment (#5).

* Improved and optimized process for finding `codebraid` executable.

* Updated KaTeX to v0.16.0.

* Improved display of Codebraid output in the preview.  Code chunks that have
  not yet been processed/executed by Codebraid and thus do not have output are
  indicated by placeholder boxes.  Output from modified code chunks or from
  stale cache is more clearly indicated.

* Improved responsiveness of progress animations for "Codebraid" button and
  preview.  There is no longer a significant, noticeable time delay between
  clicking the button and the start of button and preview progress animations.

* Added logging in VS Code's Output tab, under "Codebraid Preview".



## v0.5.1 (2022-06-11)

* Fixed scroll sync bug that could cause the editor to jump to the beginning
  of a document when the preview is scrolled to the very end of the
  document.



## v0.5.0 (2022-06-11)

* Minimum supported Codebraid is now v0.8.0.

* Improved process for locating `codebraid` executable.  If a Python
  interpreter is set in VS Code, then that Python installation is now checked
  for a `codebraid` executable.  If no executable is found, then PATH is
  checked for a `codebraid` executable.  A warning message is displayed when
  the Python installation set in VS Code lacks an executable and the extension
  falls back to an executable on PATH.  Previously, only PATH was checked
  for an executable (#5).

* If the `codebraid` executable is part of an Anaconda installation, it is now
  launched via `conda run` so that the relevant environment will be activated.

* Fixed a bug that prevented Codebraid output from being displayed for code
  chunks with a named `session` or `source`.



## v0.4.0 (2022-06-04)

* Added support for `--only-code-output` from Codebraid v0.7.0.  The preview
  now refreshes automatically for Codebraid documents, displaying all code
  output that is currently available.  The build process is now nearly as fast
  as plain Pandoc.  Code execution still requires clicking the "Codebraid"
  button or using the "Run code with Codebraid" command.

* Added basic support for `filters` in `_codebraid_preview.yaml` (#2).  Spaces
  and some other characters are not currently supported in filter names.

* When the extension loads, it now checks whether Codebraid is installed and
  determines the Codebraid version.  Loading a Codebraid-compatible document
  now results in an error message if Codebraid is not installed or if the
  version available is not compatible with Codebraid Preview.  Plain preview
  without code execution still works automatically in these cases.

* Added [Codicons](https://github.com/microsoft/vscode-codicons) for
  displaying messages in the preview webview.

* Fixed a bug that prevented error messages from stderr from being correctly
  converted to literal text in HTML.

* Scroll sync is now supported for all CommonMark-based formats (`commonmark`,
  `commonmark_x`, `gfm`), not just `commonmark_x`.



## v0.3.0 (2022-05-15)

* Extension setting `codebraid.preview.pandoc.options` now works (#3).

* Under Windows, Pandoc option values in `codebraid.preview.pandoc.options`
  that begin with unquoted `~/` or `~\` have the `~` expanded to the user home
  directory via `os.homedir()`.

* Document export now works with file names containing spaces.

* Added temporary support for syntax highlighting in Julia code blocks, until
  VS Code Markdown grammar is updated to support this (#4).

* Updated KaTeX to 0.15.3.



## v0.2.0 (2022-03-05)

* Fixed packaging of KaTeX so that equations are rendered correctly (#1).



## v0.1.0 (2022-02-22)

* Initial release.
