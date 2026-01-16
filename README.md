# ScoopDesk

ScoopDesk 是一个面向 Windows 的 **Scoop 桌面化管理器**，提供检测、安装、软件商店、环境迁移与高级自动化流程。支持 **单文件 portable EXE**，解压即用。

## 主要功能
- Scoop 自动检测与安装（自动 / 手动步骤）
- Bucket 管理（默认推荐 + 自定义 URL）
- 软件商店：搜索、安装、卸载
- 环境迁移：导出 / 恢复
- 高级模式：JSON 配置驱动多包管理器与命令行任务
- 队列执行：安装与恢复任务顺序执行，避免冲突

## 使用方式
### 开发调试
```bash
npm install
npm run start
```

### 打包单文件
```bash
npm run electron:build
```
输出在 `dist/` 目录中，为单文件 portable EXE。

## 持久化配置
配置文件默认保存在：
```
%USERPROFILE%\.scoopdesk
```
内容包含默认 bucket 与高级配置。

## 环境导出格式
导出文件为 JSON，例如：
```json
{
  "exportedAt": "2026-01-16T10:00:00.000Z",
  "buckets": [{ "name": "main" }],
  "apps": ["git", "nodejs"]
}
```

## 高级模式 JSON 格式
```json
{
  "title": "新机器环境配置",
  "steps": [
    {
      "type": "scoop-bucket",
      "name": "extras",
      "description": "添加常用 bucket"
    },
    {
      "type": "scoop-install",
      "name": "git",
      "description": "安装 Git"
    },
    {
      "type": "command",
      "name": "安装 fnm",
      "description": "示例：运行其他命令行安装流程",
      "command": "winget install Schniz.fnm"
    }
  ]
}
```

### 支持的 step 类型
- `scoop-bucket`：添加 bucket（可带 url）
- `scoop-install`：安装 scoop 包
- `command`：执行一条或多条命令（`command` 或 `commands` 数组）

## 注意事项
- 所有命令默认使用 PowerShell 执行。
- 建议以当前用户权限运行。
- PATH 相关变更需要重新打开终端或重启系统生效。
