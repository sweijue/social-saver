拾集 v1.8.5 | 圖片辨識升級

部署：將 index.html、worker.js、wrangler.jsonc 三個檔案放到 sweijue/social-saver 儲存庫根目錄（同一層）。
Worker 仍名為 shiji-sync；原本的 DB 和 SJ_TOKEN Secret 保留，不需重建。
在 Cloudflare Workers & Pages > shiji-sync > Settings > Bindings 確認 AI（Workers AI）綁定存在，名稱一定是 AI。
有些帳戶可能需先同意 Meta Llama 3.2 Vision 模型授權，依 Cloudflare 官方介面完成。

Worker 健康檢查：https://shiji-sync.sweijue.workers.dev/health
更新完成應顯示 version 1.8.5、configured true、visionConfigured true。

開啟拾集中的文章，圖片下方可見「圖片內容辨識」。
捷徑新分享進來的圖片會先嘗試少量自動辨識，其餘圖片可點「開始辨識」。
辨識結果是候選資訊；商品、店名和地址須確認後才套用；不會自動從沒有取到的相簿圖片中創造內容。

Cloudflare Workers AI 免費方案有每日使用配額；超出免費額度將無法繼續推論，除非升級付費服務。
圖片可能因社群來源禁止讀取而失敗；可將有權保存的照片透過編輯上傳再試。
