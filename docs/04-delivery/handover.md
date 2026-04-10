# 机器到期前交付指引

本文用于在算力机器回收前，快速导出可复现的 VinkoClaw 源码包。

## 导出源码包

在项目根目录执行：

```bash
./scripts/export-handover.sh
```

默认会在 `/home/xsuper/workspace/tmp` 生成两个文件：

- `vinkoclaw-source-<timestamp>.tar.gz`
- `vinkoclaw-source-<timestamp>.manifest.txt`

说明：

- 该导出包只包含可交付源码与文档。
- 默认排除目录：`node_modules`、`.data`、`.run`、`dist`、`coverage`。
- 默认排除文件：`.env`、`.env.local`、`*.log`。

## 新机器恢复

1. 解压源码包

```bash
tar -xzf vinkoclaw-source-<timestamp>.tar.gz
cd vinkoclaw
```

2. 安装依赖

```bash
npm install
```

3. 补齐环境变量

```bash
cp config/.env.example .env
```

4. 启动服务

```bash
npm run dev
```

5. 打开控制台

`http://127.0.0.1:8098`
