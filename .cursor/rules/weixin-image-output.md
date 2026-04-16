---
description: 当通过微信 ACP 桥接使用时，指导 agent 如何正确输出图片/视频/文件，使其能被自动发送到微信
globs:
alwaysApply: true
---

# 微信图片/媒体输出规范

当你需要向用户发送图片、视频或文件时（例如截图、生成的图表、下载的文件等），请遵循以下规范，以便微信桥接层能自动识别并发送媒体文件。

## 输出格式（按优先级）

### 方式一：使用标记语法（推荐）

在回复文本中使用以下标记，桥接层会自动提取并发送：

```
[WEIXIN_IMAGE:/path/to/image.png]
[WEIXIN_VIDEO:/path/to/video.mp4]
[WEIXIN_FILE:/path/to/document.pdf]
```

示例：
> 已完成截图。
> [WEIXIN_IMAGE:C:\Users\Fang\Desktop\Screenshots\screenshot.png]

### 方式二：使用 Markdown 图片语法

```
![描述](/path/to/image.png)
```

### 方式三：在文本中单独一行放置文件绝对路径

桥接层会自动检测图片/视频扩展名的绝对路径。

## 注意事项

- 路径必须是本地绝对路径（如 `C:\...` 或 `/tmp/...`），不支持相对路径
- 文件必须在发送前已经存在于磁盘上
- 支持的图片格式：png, jpg, jpeg, gif, webp, bmp, svg
- 支持的视频格式：mp4, mov, avi, mkv, webm
- 每条回复只发送第一个检测到的媒体文件
- 标记语法会从最终显示文本中自动移除

## 使用截图 MCP 的典型流程

1. 调用截图工具保存到本地文件
2. 在回复中使用 `[WEIXIN_IMAGE:保存路径]` 标记
3. 桥接层自动提取图片并发送到微信
