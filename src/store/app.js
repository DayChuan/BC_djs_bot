//全域單例容器。原本是 Pinia store，但 bot 是純後端行程，
//整個 Vue/Pinia 執行期只為了存這三個變數(U02)。
//這裡就是一個匯出的物件：只在啟動時寫入一次，之後各處直接讀。
//不做 getter/setter —— 打錯欄位名會直接是 undefined，
//比 Pinia「允許寫入未宣告的鍵而且讀得回來」那種模糊地帶好抓。
export const appStore = {
    client: null,
    commandActionMap: null,
    //指令名稱 → autocomplete 處理函式。只有需要動態建議的指令才會登記，
    //所以這張表通常比 commandActionMap 小很多。
    autocompleteMap: null,
    //指令的 SlashCommandBuilder 清單。/help 靠它列出使用者能用的指令，
    //所以 loadCommands() 註冊完要順手放進來。
    commandList: null
}
