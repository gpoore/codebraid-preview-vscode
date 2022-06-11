# Change Log


## v0.5.0 (dev)

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
