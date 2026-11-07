# Local dictionaries

Marginalia does **not** bundle commercial dictionaries. The app reads the
Oxford Chinese Dictionary installed in macOS Dictionary and uses Wiktionary
(or a Merriam-Webster key you provide) for English.

## About `.eubak` files

A `.eubak` file is **not** a dictionary. It is a small XML backup from
Frhelper/欧路词典 that lists the paths of `.mdx` files on the phone. A typical
file is only a few hundred bytes:

```xml
<Frhelper_Backup BackupFileVersion="2.1">
  <Dicts>
    <Item libid="1344212299"
          path="/var/mobile/.../Documents/牛津高阶英汉双解词典(第8版).mdx" />
  </Dicts>
</Frhelper_Backup>
```

The actual dictionary content is in the `.mdx` file referenced by that path.
The `.eubak` alone contains no headwords or definitions.

## If you have the `.mdx` / `.mdd` files

1. On the iPhone, open the Frhelper/欧路词典 app and use its dictionary export
   or file-sharing feature; or connect the phone to the Mac and copy the
   `.mdx` and `.mdd` files from the app's Documents folder.
2. Keep them outside this repository, for example in
   `~/Documents/Dictionaries/`.
3. Do not commit `.mdx`, `.mdd`, or `.eubak` files to GitHub. They are
   licensed commercial content.
4. Put the `.mdx` files in the folder shown in **Settings → Local
   dictionaries**, then click **Index dictionaries**. The importer reads MDX
   2.0 headwords and HTML definitions into the local SQLite database.

## What works today

- Local MDX 2.0 dictionaries (Collins COBUILD, Oxford Advanced Learner's) via
  **Settings → Local dictionaries → Index dictionaries**.
- Chinese ↔ English: Oxford Chinese Dictionary via macOS DictionaryServices
  when no local bilingual dictionary is indexed.
- English → English: Wiktionary by default; Merriam-Webster Learner's with a
  free API key in Settings.
