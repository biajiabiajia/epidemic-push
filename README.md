# 全自动疫情监测微信推送

每天早上8点自动抓取中疾控官方数据和大白话时事读者投票数据，通过微信（PushPlus）推送。

---

## 文件说明

| 文件 | 作用 |
|------|------|
| `.github/workflows/epidemic-push.yml` | GitHub Actions 定时任务配置 |
| `scripts/scrape-and-push.cjs` | 核心抓取和推送脚本 |
| `package.json` | 项目依赖配置 |

---

## 设置教程（只需设置一次，之后全自动）

### 第一步：创建 GitHub 仓库

1. 打开 https://github.com/new
2. 输入仓库名：**`epidemic-push`**（可以改成其他名字）
3. 选择 **Public**（公开仓库免费）
4. 勾选 **Add a README file**
5. 点击 **Create repository**

---

### 第二步：上传文件

进入你刚创建的仓库，点击 **Add file** → **Upload files**

上传这三个文件（保持目录结构）：

```
.github/workflows/epidemic-push.yml   ← 需要创建 .github/workflows 目录
scripts/scrape-and-push.cjs            ← 需要创建 scripts 目录
package.json
```

**怎么创建目录**：
- 在 GitHub 网页上点击 "Add file" → "Create new file"
- 文件名输入 `.github/workflows/epidemic-push.yml`
- GitHub 会自动创建中间的目录
- 把 `epidemic-push.yml` 的内容粘贴进去
- 同样的方式创建 `scripts/scrape-and-push.cjs` 和 `package.json`

---

### 第三步：设置 PushPlus Token

1. 在你的仓库页面，点击 **Settings**（设置）
2. 左侧菜单点击 **Secrets and variables** → **Actions**
3. 点击 **New repository secret**
4. Name 填：`PUSHPLUS_TOKEN`
5. Secret 填：`35eefe300b4348a98ba76995c2371849`
6. 点击 **Add secret**

---

### 第四步：手动测试运行

1. 在仓库页面，点击 **Actions** 标签
2. 你会看到 "疫情监测微信推送" 工作流
3. 点击它，然后点击 **Run workflow** → **Run workflow**
4. 等待1-2分钟
5. 刷新页面，点击最新的运行记录
6. 如果显示绿色 ✅，说明成功
7. 检查你的微信，应该收到了推送

---

### 第五步：完成

设置完成！之后每天早上8点（北京时间）会自动推送，你什么都不用做。

---

## 常见问题

### 1. 什么时候会推送？

每天早上8点（北京时间）自动推送。如果你想改时间：

打开 `.github/workflows/epidemic-push.yml`，修改这一行：
```yaml
- cron: '0 0 * * *'   # UTC 00:00 = 北京时间 8:00
```

时间格式说明：
- `0 22 * * *` = 北京时间 6:00
- `0 23 * * *` = 北京时间 7:00
- `0 1 * * *`  = 北京时间 9:00

### 2. 可以手动触发测试吗？

可以。进入 Actions 页面，点击 **Run workflow** 即可手动触发。

### 3. 推送失败了怎么办？

进入 Actions 页面，点击失败的运行记录，查看日志（显示为红色 ❌）。

常见原因：
- PushPlus Token 过期：重新获取 Token 并更新 Secret
- 网络问题：中疾控或腾讯新闻暂时无法访问，通常过几小时自动恢复

### 4. 数据从哪里来？

| 数据源 | 方式 | 更新频率 |
|--------|------|---------|
| 中疾控哨点监测 | HTTP直接抓取官网 | 每周更新 |
| 大白话时事 | Puppeteer模拟浏览器访问作者页 | 每周更新 |

### 5. 安全吗？

PushPlus Token 存储在 GitHub Secrets 中，只有仓库所有者能看到，安全。

---

## 技术原理

| 组件 | 说明 |
|------|------|
| **GitHub Actions** | 免费的云服务器，每天定时运行 |
| **Puppeteer** | 无头Chrome浏览器，能执行JavaScript |
| **中疾控抓取** | 直接HTTP请求，解析HTML表格 |
| **大白话抓取** | Puppeteer打开腾讯新闻作者页，从React内部属性提取文章列表，找到最新文章后提取投票数据 |
| **微信推送** | 调用PushPlus API发送 |

---

## 技术细节（供参考）

### 大白话抓取的难点

腾讯新闻作者页使用单页应用（SPA）架构：
- HTML骨架是空的，文章列表通过JavaScript异步加载
- Cloudflare Worker只能发HTTP请求，不能执行JavaScript，所以拿不到文章列表
- Puppeteer是真实Chrome浏览器，能执行JavaScript，能看到完整的文章列表
- 腾讯新闻使用React框架，文章数据存储在React fiber内部属性中
- 脚本通过读取React fiber属性获取文章ID、标题和发布时间

### 为什么不用 Cloudflare Worker

Worker的限制：
- 不能执行JavaScript（只能发HTTP请求）
- 没有浏览器环境（没有DOM、没有Cookie）
- 腾讯新闻的反爬机制要求JavaScript执行

GitHub Actions + Puppeteer 的优势：
- 完整的浏览器环境
- 能执行JavaScript
- 能处理SPA前端路由
- 免费且稳定
