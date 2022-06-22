# Change Log


## v0.6.0 (dev)

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
