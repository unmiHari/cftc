# 关于 Cftc 的说明
- 使用 Cloudflare 与 Telegram 作为基础的含直链云盘
- 支持 Web 与 Telegram Bot 进行操作

# 部署教程
- [直达链接](https://github.com/iawooo/cftc/blob/main/README.md)
- 以下是项目中需要在 Cloudflare 环境中绑定的变量及其说明：

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
| ~~`TG_CHAT_ID`~~           | ~~环境变量~~   | ~~**(可选，必填)** 允许使用机器人的 Telegram 用户（英文逗号分隔），限制访问权限。~~ 使用 TG_ADMIN_ID 随时修改用户访问权限 | `123456789,987654321`     |
| `UPDATE_TIME`              | 环境变量   | **(可选，必填)** 大文件上传的网页可用时长，分钟。                   | `20`                        |
| `TG_ADMIN_ID`              | 环境变量   | **(可选，必填)** 允许管理机器人的 Telegram 用户（英文逗号分隔），限制访问权限。      | `123456789`     |
| `ENABLE_AUTH`              | 环境变量   | **(可选，必填)** 是否启用网页管理界面的用户名/密码认证（`true` 或 `false`）。             | `true`                     |

# 声明
- **尊重原创，转载须知**  
  如需转载，请务必注明出处，感谢支持！严禁将本项目用于任何违法犯罪行为。[支持原项目](https://github.com/iawooo/cftc)
- **二次修改与发布**  
  欢迎基于本项目进行二次开发，但请在发布时注明原始出处，共同维护开源社区的良好氛围。
