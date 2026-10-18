# SyncnextAPI

GitHub Pages 靜態 JSON。發布地址由 [CNAME](CNAME) 定義；實際 payload 直接查
根目錄的 `appData.json`、`sources*.json`、`source_ali.json`、`domainInfo.json`
與 `safeline_hosts.json`。

[Download JSON workflow](.github/workflows/ci.yml) 透過本地 Bun 匯出工具讀取 Notion，
再自動提交產物；觸發方式、排程與額外 app-version 更新以 workflow 為準。
Notion 表與輸出檔案對應只維護於
[export-json.ts](notion-api-worker/src/export-json.ts)。正式來源資料依 owning Notion
表更新，不手動更動匯出成品。

需要明確刷新本機 JSON 時：

```sh
cd notion-api-worker
bun install --frozen-lockfile
bun run export-json -- --out-dir ..
```

這會連線 Notion 並改寫本機 payload。修改後逐檔以 `python3 -m json.tool <file>`
檢查格式，再檢閱差異。一般文件清理不執行匯出或 dispatch workflow。

Notion wrapper 的路由以 [src/index.ts](notion-api-worker/src/index.ts) 為準，
不沿用舊 splitbee hosted API 的部署說明。上游 credits：Timo Lins、Tobias Lins、
Travis Fischer；來源為 [splitbee/notion-api-worker](https://github.com/splitbee/notion-api-worker)。
