# 发布到 GitHub

这份仓库已经 `git init`，26 个文件已经 staged，分支是 `main`，但还没有 commit，也没有 remote。下面任选一种方式发布。

## 先确认：哪些东西上传，哪些不上传

**上传到仓库：**

- `app.py`、`static/`、`bin/*.swift`
- `scripts/`、`docs/`、`dictionaries/README.md`
- `README.md`（中文主文档）、`README.en.md`
- `LICENSE`、`THIRD_PARTY_NOTICES.md`
- `requirements.txt`、`pyproject.toml`
- `start.command`、`Marginalia.command`
- `data/.gitkeep`

**不要上传：**

- `.venv/`：虚拟环境，别人电脑上不能用
- `data/reader.db`：包含你的阅读数据，且可能包含商业词典索引
- `data/dictionaries/`、任何 `.mdx` / `.mdd` / `.eubak`：版权内容
- `bin/dictlookup`、`bin/pdftext`：编译后的二进制，首次运行会自动编译
- `dist/`、`build/`、`*.spec`：构建产物
- `Marginalia-macOS-arm64.zip`：放到 GitHub **Releases**，不要提交进仓库

这些规则已经写在 `.gitignore` 里。正常 `git add .` 不会把它们加进去；不要用 `git add -f` 强制添加。

---

## 方法 A：网页版上传（你现在用这个）

GitHub 网页可以拖拽文件夹，但要注意三点：

1. **拖文件夹里面的内容，不要拖 `reader` 这个父文件夹**，否则仓库里会多一层 `reader/`。
2. 网页上传可能丢失 `.command` 的可执行权限；发布后在 README 里保留 `chmod +x` 的说明。
3. `.gitignore`、`.github`、`data/.gitkeep` 是隐藏文件，Finder 默认不显示；先按 `Cmd + Shift + .` 显示，或者上传后手动创建。

### 准备一个干净的上传文件夹

我已经在仓库外面准备好：

```text
/Users/ryanlee/Documents/deepseek-harness/default-workspace/GitHub-Upload-Marginalia/
```

这个文件夹只包含 Git 跟踪的 26 个文件，不含 `.venv`、`reader.db`、`.mdx`、编译后的 helper。**上传时只用这个文件夹，不要用 `reader/` 原目录。**

### 网页操作步骤

1. GitHub → **New repository**
   - Name：`marginalia`
   - Public
   - **不要**勾选 README、.gitignore、license
   - Create repository

2. 进入空仓库，点 **Add file → Upload files**。

3. 打开 Finder，进入：

   ```text
   /Users/ryanlee/Documents/deepseek-harness/default-workspace/GitHub-Upload-Marginalia
   ```

   按 `Cmd + Shift + .` 显示隐藏文件。选中**除下面三项之外**的所有内容：

   - `.github/`
   - `.gitignore`
   - `data/`

   然后拖进 GitHub 的 Upload files 页面。

   应该包含：`README.md`、`README.en.md`、`app.py`、`static/`、`bin/`、`scripts/`、`docs/`、`dictionaries/`、`LICENSE`、`start.command`、`Marginalia.command` 等。

4. 下方 Commit changes：
   - 填 `Initial release: Marginalia 1.1.0`
   - 选 **Commit directly to the main branch**
   - 点 **Commit changes**

5. 上传 `.gitignore`：
   - 回到仓库根目录 → **Add file → Upload files**
   - 在 Finder 里选中 `.gitignore`（已显示隐藏文件）
   - 拖进去，commit message 填 `Add .gitignore`

   如果网页不让上传隐藏文件，就点 **Add file → Create new file**，文件名填 `.gitignore`，把本地 `reader/.gitignore` 的内容复制进去。

6. 可选：创建 `data/.gitkeep`
   - **Add file → Create new file**
   - 文件名填 `data/.gitkeep`
   - 内容随便一行，例如 `# keep`
   - Commit

7. 可选：创建 CI
   - **Add file → Create new file**
   - 文件名填 `.github/workflows/ci.yml`
   - 把本地 `reader/.github/workflows/ci.yml` 的内容复制进去
   - Commit

8. 检查仓库根目录：
   - 应该直接看到 `README.md`、`app.py`、`static/` 等；
   - 不应该看到 `reader/` 这一层；
   - 不应该看到 `.venv/`、`reader.db`、`.mdx`、`dist/`。

### 网页上传后的可执行权限

网页上传通常会把 `start.command` 和 `Marginalia.command` 存成普通文本文件，别人下载后双击可能没反应。README 已经写了解决办法：

```bash
chmod +x start.command Marginalia.command
./start.command
```

这不会影响独立 App；App 用户不需要运行脚本。

---

## 方法 B：GitHub Desktop（适合不想用网页拖拽）

1. 下载并安装 [GitHub Desktop](https://desktop.github.com/)，用你的 GitHub 账号登录。
2. 菜单 **File → Add Local Repository**。
3. 选择这个文件夹：

   ```text
   /Users/ryanlee/Documents/deepseek-harness/default-workspace/reader
   ```

4. GitHub Desktop 会显示 26 个 staged 文件。左下角 Summary 填：

   ```text
   Initial release: Marginalia 1.1.0
   ```

   点 **Commit to main**。
5. 点右上角 **Publish repository**：
   - Name 填 `marginalia`
   - 取消勾选 **Keep this code private**（要公开）
   - Description 可以填：

     ```text
     给中国学习者的本地英语精读工具：PDF/EPUB 阅读、选词查英英/中英释义、句子高亮、生词本与间隔复习。全部数据留在本机。
     ```

   - 点 **Publish Repository**。

6. 打开 `https://github.com/你的用户名/marginalia`，确认 README 和图片正常显示。

> 如果 GitHub Desktop 提示仓库里没有 commit，按上面的 Commit 步骤先提交；不要让它重新初始化仓库。

---

## 方法 C：命令行

### 1. 配置 Git 身份

只配置一次，填你自己的名字和邮箱：

```bash
cd /Users/ryanlee/Documents/deepseek-harness/default-workspace/reader
git config user.name "你的名字"
git config user.email "你的邮箱"
```

### 2. 创建第一个 commit

文件已经 staged，直接提交：

```bash
git commit -m "Initial release: Marginalia 1.1.0"
```

### 3. 在 GitHub 网页创建空仓库

打开 GitHub → **New repository**：

- Repository name：`marginalia`
- Description：

  ```text
  给中国学习者的本地英语精读工具：PDF/EPUB 阅读、选词查英英/中英释义、句子高亮、生词本与间隔复习。全部数据留在本机。
  ```

- 选择 **Public**
- **不要**勾选 Add a README file、Add .gitignore、Choose a license
- 点 **Create repository**

创建后复制仓库地址，例如：

```text
https://github.com/你的用户名/marginalia.git
```

### 4. 关联远程仓库并推送

```bash
git remote add origin https://github.com/你的用户名/marginalia.git
git branch -M main
git push -u origin main
```

如果提示 `remote origin already exists`，改用：

```bash
git remote set-url origin https://github.com/你的用户名/marginalia.git
git push -u origin main
```

### 5. 关于密码

GitHub 不接受账户密码作为 Git 密码。推荐两种方式：

- **最简单**：安装 GitHub Desktop，用它登录并推送；
- **命令行**：创建一个 Personal Access Token：
  GitHub → Settings → Developer settings → Personal access tokens →
  Tokens (classic) → Generate new token (classic)
  - Note：`marginalia`
  - Expiration：30 天或 90 天
  - Scope：勾选 `repo`
  - 生成后复制 token

当 `git push` 提示 `Password` 时，粘贴 token（不是你的 GitHub 登录密码）。macOS 可能会把它存进 Keychain。

---

## 发布独立 App（Release）

仓库只放源码；`.app` / `.zip` 作为 **Release 附件**。

1. 打开仓库页面 → 右侧 **Releases** → **Draft a new release**。
2. **Choose a tag** 填 `v1.1.0`，选择 **Create new tag on publish**。
3. Release title：

   ```text
   Marginalia 1.1.0 — 给中国学习者的本地英语精读工具
   ```

4. 描述可以直接用：

   ```markdown
   Marginalia 是一个本地英语精读工具，面向中国学习者。

   - 导入 PDF、DOCX、EPUB、TXT、Markdown、HTML
   - 选中单词查看英英 / 中英释义；支持本地 Collins / 牛津高阶 MDX 词库
   - 自动检查并修复硬换行、断词、页眉页脚、页码
   - 选中句子即可用荧光黄高亮，Excerpts 汇总整本书的摘录
   - 生词本保存原句，间隔重复复习
   - 所有数据保存在本机，没有账号和云同步

   **系统要求：** macOS，Apple Silicon（arm64）
   **注意：** App 未签名，首次打开请右键 → 打开。词库数据不包含在内，请在 Settings → Local dictionaries 中导入你自己合法持有的 `.mdx` 文件。
   ```

5. 附件上传：

   ```text
   /Users/ryanlee/Documents/deepseek-harness/default-workspace/Marginalia-macOS-arm64.zip
   ```

6. 点 **Publish release**。

---

## 发布后检查

- 仓库首页 README 的中文是否正常，`docs/reader.png` 和 `docs/excerpts.png` 是否显示。
- Actions 页面是否通过 `syntax` 检查。
- Releases 里的 zip 能否下载、解压、右键打开。
- 仓库 **About** 右侧点齿轮，填 Description 和 Topics：
  `english-learning` `chinese-learners` `reader` `dictionary` `pdf-reader` `epub` `macos` `spaced-repetition` `local-first` `vocabulary` `mdx`
- 确认仓库里没有 `reader.db`、`.mdx`、`.venv`、`dist/`。

## 如果推送失败

- `Author identity unknown`：回到第 1 步配置 `user.name` / `user.email`。
- `Authentication failed`：用 GitHub Desktop 登录，或使用上面的 Personal Access Token。
- `Updates were rejected`：说明远程仓库不是空的。新建的空仓库不要勾选 README；如果已经勾选，执行：

  ```bash
  git pull --rebase origin main
  git push -u origin main
  ```

- 分支名不是 `main`：

  ```bash
  git branch -M main
  ```
