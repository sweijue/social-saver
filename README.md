# 拾集 v1.8.25｜收藏原始時間 + 新文章接收修復

## 此版解決

- **收藏時間固定**：捷徑送至 Worker 的 `received_at` 是第一次送入雲端的時間，`index.html` 會直接寫進新卡片 `createdAt`，不再以手機打開或同步完成時的時間代替。再次分享同一網址不會改動這個時間。分筆同步合併同一篇文章時，盡可能保留兩份紀錄中較早的有效收藏時間。
- **新文章優先**：Worker `/api/inbox` 按收件 ID 由新到舊列出；手機每次先讀最新 35 筆，再以 `before_id` 分頁補收舊的未接收文章。舊的 `pending` / `ready` 大量堆積也不會排擠今天新收藏。
- **擷取永遠 pending 的紀錄**：超過 3 分鐘仍未完成的背景擷取會變成「擷取逾時」，保留 URL 並讓手機記錄後使用既有機制補抓，不再無限等待。
- **明確診斷**：「雲端同步 → 檢查同步原因」會列出 Worker *最後收到捷徑分享*的時間、待收篇數、擷取中篇數，區分「捷徑沒傳到 Worker」與「Worker 收到但手機尚未收」。
- **找回已確認但未顯示的文章**：「雲端同步 → 補收最近 7 天文章」會列出雲端最近的收件歷史，僅在使用者確認後補入目前手機中缺漏的文章。此功能可能重新加入曾手動刪除的文章，因此**不會在背景自動執行**。

## 安裝方式（先備份，再依序更新）

1. 在舊版拾集按「匯出本機備份」，確認 JSON 已存到 iPhone「檔案」。此備份不需要匯入新版，只是保險。
2. 把 `worker.js` 的**完整內容**更新至原本 `shiji-sync.sweijue.workers.dev` 使用的 Cloudflare Worker，沿用 D1 綁定 `DB`、原本 `SJ_TOKEN`、AI/Browser 綁定，不重建、不清空資料庫。
3. 把 `index.html` 的**完整內容**覆蓋原本 GitHub Pages 網站的同名檔案，不改原本網址。
4. 在原本 iPhone 拾集開啟或重新整理，選單確認版本顯示 **v1.8.25**。不必重新輸入 Worker 網址/密鑰、不得清除 Safari／PWA 網站資料。
5. 從 iPhone 捷徑分享一篇新網址。卡片應先出現，即使圖片或文章內文還在補抓；卡片的「收藏於」應是分享送達 Worker 的時間，不應因後續同步而改變。
6. 若昨天已送入 Worker 的文章仍不見，進入「雲端同步 → 補收最近 7 天文章」，核對內容後再確認補收。
7. 如果仍沒有收到，在「雲端同步 → 檢查同步原因」查看 Worker 最後收到分享的時間。若沒有今天的時間，問題在捷徑 → Worker 請求，而非手機下載 D1。

## 資料與限制

- 仍使用既有 D1 分筆儲存；不使用 R2、不需要訂閱/信用卡，也不清除 `app_state`、`sync_documents` 或任何舊備份。新建的 `inbox_receipts` 僅記錄最後收件時間及次數；不包含密鑰。
- 新增的資料表/索引是**非破壞性**的；不刪除、覆寫既有收藏資料。
- 如果較舊版本已經把某筆 `createdAt` 或 D1 `received_at` 改成錯誤時間，而且沒有任何保留原始時間的舊備份，就無法精確推算當初實際收藏時間。**本版不會捏造舊時間**，但會保留仍可找到的最早有效時間，之後新增文章會正確紀錄。
- 若從 iOS 分享捷徑根本未成功呼叫 `/api/collect`，新文章不會存在 Worker 的收件匣；診斷頁能確認最後收到時間，但不能替未送達的網址自動生成文章。
- 開啟雲端收件診斷需要 Worker 也升級至 v1.8.25；**只有更新前端是不夠的**。

## 離線驗證

- `node tests/test-worker-inbox-integration.cjs`：SQLite D1 模擬、54 次分享／53 筆唯一網址、分頁、重複分享的原始時間保留、擷取逾時、ACK、歷史補收和診斷。
- `node tests/test-front-timestamps.cjs`：前端合併時間最小值、最新／歷史分頁。
- `node tests/test-client-inbox-flow.cjs`：pending 先顯示卡片、ready 補上內容仍保留收藏時間、本機失敗不 ACK。
- `node tests/test-auto-merge.cjs`、`node tests/test-bounded-sync.cjs`、`node tests/test-idle-fastpath.cjs`、`node tests/test-migration.cjs`：既有功能回歸。
- `node --check worker.js`：Worker 語法；前端以 HTML `<script>` 抽取後 `node --check`。

**這些是本機/模擬測試，不是對你的正式 D1 和 iPhone 的線上驗證。程式尚未被自動部署。**
