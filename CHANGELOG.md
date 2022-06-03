# Change Log


## v0.4.0 (dev)

* Added [Codicons](https://github.com/microsoft/vscode-codicons) for
  displaying messages in the preview webview.



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
