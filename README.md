# Syncnext API

[![CI Status](https://github.com/qoli/syncnext-api/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/qoli/syncnext-api/actions/workflows/ci.yml)

**Syncnext API** 是 [Syncnext 聚合媒體播放器](https://www.notion.so/Syncnext-app-821b80378be241149fa5e9a1bbf6cfdc) 的核心數據託管倉庫。此項目負責維護和提供應用程式運行所需的各類配置數據、視頻源列表以及更新檢測接口。

## 📖 項目簡介

Syncnext 是一款功能強大的聚合媒體播放器，致力於為用戶提供便捷、統一的觀影體驗。本倉庫作為其後端數據支撐（API Edge Cache），確保用戶能夠獲取到最新的影視源站點信息和應用配置。

更多關於 Syncnext 的功能介紹與使用指南，請參閱我們的 [Notion 官方文檔](https://www.notion.so/Syncnext-app-821b80378be241149fa5e9a1bbf6cfdc)。

## 🚀 API 資源列表

所有數據均通過 CDN 分發，確保高可用性與低延遲。

| 資源名稱 | 描述 | 鏈接 (JSON) |
| :--- | :--- | :--- |
| **AppData** | 應用全局配置、公告及元數據 | [appData.json](https://syncnext-api.5mlstudio.com/appData.json) |
| **Sources (Main)** | 標準影視源列表 (主要) | [sources.json](https://syncnext-api.5mlstudio.com/sources.json) |
| **Sources v2** | 影視源列表 (v2 結構) | [sourcesv2.json](https://syncnext-api.5mlstudio.com/sourcesv2.json) |
| **Sources v3** | 影視源列表 (v3 結構) | [sourcesv3.json](https://syncnext-api.5mlstudio.com/sourcesv3.json) |
| **Sources 18+** | 特殊分類源列表 | [sources18.json](https://syncnext-api.5mlstudio.com/sources18.json) |
| **Ali Sources** | 阿里雲盤資源列表 | [source_ali.json](https://syncnext-api.5mlstudio.com/source_ali.json) |

## 🔗 相關鏈接

- **[Syncnext 主頁 (Notion)](https://www.notion.so/Syncnext-app-821b80378be241149fa5e9a1bbf6cfdc)** - 官方主頁，包含詳細的功能介紹。
- **[更新日誌](https://www.notion.so/Syncnext-App-1-147-2e3c1b36c4018098babae678943c8d20)** - 查看 Syncnext App 的最新版本變化。
- **[使用條款](https://www.notion.so/75cb67aff57b42d2bebea12189cda4fc)** - 使用前請閱讀。

## 🛠 維護

本倉庫數據通常由維護者手動更新或通過自動化腳本生成。
如果您發現某個源站點失效，請聯繫開發者或在相關社群反饋。