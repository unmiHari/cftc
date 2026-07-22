# cftc-基于cloudflare部署的图床。[直达部署](https://github.com/iawooo/cftc/tree/main?tab=readme-ov-file#%E9%83%A8%E7%BD%B2%E6%95%99%E7%A8%8B)
- 支持telegram机器人管理和网页管理文件（包括上传，删除，分类，修改后缀等功能）

## 部署教程
#### 准备工作
**创建Telegram Bot**（获取`TG_BOT_TOKEN`变量）：
   - 在Telegram中找到`@BotFather`，发送`/newbot`创建新机器人。
   - 按照提示设置机器人名称和用户名，获取Bot Token（例如`123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`）。
**创建后台群组**（获取`TG_STORAGE_CHAT_ID`变量）：
   - 创建一个Telegram群组（按需设置是否公开），
   - 添加机器人为管理员。
   - 获取群组的Chat ID（例如`-100123456789`），可以通过`@getidsbot`获取（拉它进群）。

#### 创建D1 SQL数据库（获取`DATABASE`变量）
1. 登录[Cloudflare仪表板](https://dash.cloudflare.com/)。
2. 导航到 **存储和数据库 > D1 SQL数据库**，输入一个名称（例如`cftc`），点击 **创建**。

#### 创建R2存储桶（获取`BUCKET`变量）<可选>


### 部署到Cloudflare pages (推荐)
### **点个star，frok本项目**
#### 创建pages项目
1. 登录[Cloudflare仪表板](https://dash.cloudflare.com/)。
2. 导航到 **Workers和Pages > Workers和Pages**，点击 **创建**。
3. 点击 **Pages**，再点击 **连接到Git** 
4. 选择 **cftc** 存储库，点击**开始设置**，输入项目名称（例如`cftc`）
5. 点击 **保存并部署**，等待20秒左右，点击 **继续处理项目**
6. 点击**设置**，根据变量表添加或绑定变量，确保变量正确。
7. 点击**部署**，找到**重试部署**，点击**重试部署**

### 部署到Cloudflare Workers 
1. 登录[Cloudflare仪表板](https://dash.cloudflare.com/)。
2. 导航到 **Workers和Pages > Workers和Pages**，点击 **创建**。
3. 点击**Hello world**，命名后点击**部署**
4. 点击**编辑代码**，删除原来的代码再把该项目中的 **_worker.js**代码替换
5. 点击部署后根据变量表配置变量
## 🛠️ 使用说明

*   **网页界面**:
    *   访问 Worker/pages 的 URL (例如 `https://cftc.workers/pages.dev/` 或你的自定义域名)。
    *   如果启用了认证，需要先在 `/login` 页面登录。
    *   `/upload`: 文件上传页面，可选择分类和存储后端。
    *   `/admin`: 文件管理后台，可查看、搜索、筛选、分享、删除文件和管理分类。
*   **Telegram Bot**:
    *   向你的 Bot 发送 `/start` 开始交互。
    *   直接发送图片、视频、文档等文件给 Bot 进行上传。
    *   使用 Bot 提供的内联键盘按钮进行各种操作（切换存储、管理分类、查看文件、修改后缀、删除文件等）。
    *   按照 Bot 的提示回复消息以完成特定操作（如输入新分类名称、要删除的文件名、新后缀等）。

以下是项目中需要在 Cloudflare 环境中绑定的变量及其说明：

| **变量名**                  | **类型**   | **描述**                                                                 | **默认值/示例**            |
|-----------------------------|------------|--------------------------------------------------------------------------|----------------------------|
| `DATABASE`                 | D1 绑定    | **(必需)** Cloudflare D1 数据库绑定名称，用于存储文件元数据、用户设置和分类信息。   | `cftc-db`             |
| `DOMAIN`                   | 环境变量   | **(必需)** Cloudflare Workers/pages 部署域名，用于生成文件直链和设置 Telegram Webhook。    | `yourdomain.workers/pages.dev`   |
| `TG_BOT_TOKEN`             | 环境变量   | **(必需)** Telegram 机器人 Token，用于与 Telegram API 通信以处理文件上传和交互。    | `123456:ABC-DEF1234ghIkl` |
| `TG_STORAGE_CHAT_ID`       | 环境变量   | **(必需，如果使用 Telegram 存储)** 用于存储文件的 Telegram 群组或频道 ID。           | `-100123456789`            |
| `USERNAME`                 | 环境变量   | **(必需，如果 `ENABLE_AUTH` 为 `true`)** 管理面板的登录用户名。                          | `admin`                    |
| `PASSWORD`                 | 环境变量   | **(必需，如果 `ENABLE_AUTH` 为 `true`)** 管理面板的登录密码。                            | `your_secure_password`     |
| `MAX_SIZE_MB`              | 环境变量   | **(可选，必填)** 单个文件的最大大小限制（单位 MB），防止上传过大文件。                    | `20`                       |
| `BUCKET`                   | R2 绑定    | **(可选，必填)** Cloudflare R2 存储桶绑定名称，用于 R2 存储模式（若启用）。               | `cftc-bucket`         |
| `COOKIE`                   | 环境变量   | **(可选，必填)** 网页认证 Cookie 的有效期（单位天），控制登录会话时长。                   | `7`                        |
| ~~`TG_CHAT_ID`~~           | ~~环境变量~~   | ~~**(可选，必填)** 允许使用机器人的 Telegram 用户（英文逗号分隔），限制访问权限。~~ 使用 TG_ADMIN_ID 随时修改用户访问权限     | `123456789,987654321`     |
| `TG_ADMIN_ID`              | 环境变量   | **(可选，必填)** 允许管理机器人的 Telegram 用户（英文逗号分隔），限制访问权限。      | `123456789`     |
| `ENABLE_AUTH`              | 环境变量   | **(可选，必填)** 是否启用网页管理界面的用户名/密码认证（`true` 或 `false`）。             | `true`                     |


## 🌟 致谢
### [帖子](https://www.nodeseek.com/post-308544-1#1) 和[CF-tgfile](https://github.com/yutian81/CF-tgfile) 提供参考和灵感
### 感谢所有测试者、贡献者和社区支持！
###  [cloud flare](https://www.cloudflare.com/) - 提供强大的基础设施支持。
### [telegram](https://telegram.org/) - 便捷的 Bot API。
### 感谢 [xAI](https://x.ai/)   [claude](https://claude.ai/) 帮助我完成了本项目的开发和优化

## 声明

- **尊重原创，转载须知**  
  如需转载，请务必注明出处，感谢支持！严禁将本项目用于任何违法犯罪行为。  
- **二次修改与发布**  
  欢迎基于本项目进行二次开发，但请在发布时注明原始出处，共同维护开源社区的良好氛围。

# ⭐ 觉得项目不错点个star，谢谢您的star
