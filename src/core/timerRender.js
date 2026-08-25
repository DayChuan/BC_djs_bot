import {ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder} from 'discord.js'
import {SKILLS, WARN_DISPLAY_SECONDS} from '@/config/horntail'

//customId 的格式是 ht:<動作>:<頻道id>[:<招式key>]。
//  ht:t:<channelId>:<skillKey>   切換某個招式(在跑就停、沒跑就開)
//  ht:stop:<channelId>           全部停止(計時器歸零停下，面板留著可以再開)
//  ht:end:<channelId>            結束面板(整個收掉、移除按鈕，要用得重下指令)
//一個頻道同時只有一個面板，所以 channelId 就足以認出是哪個面板，
//不必再塞訊息 id。最長約 31 字，離 Discord 的 100 字元上限很遠。
//
//重啟後記憶體裡沒有這個面板，但頻道裡那則舊訊息還在、按鈕也還在，
//所以解析出來的 channelId 找不到面板是**正常情況**，要回「面板已失效」而不是報錯。
export const HT_PREFIX = 'ht:'

const SKILL_KEYS = new Set(SKILLS.map((skill) => skill.key))

//Discord 的 snowflake 是一串數字。customId 是從用戶端送回來的，不可信任，
//解析後一定要驗格式，不能直接拿去查表或塞進 API 呼叫。
const SNOWFLAKE = /^\d{5,25}$/

const COLOR_ACTIVE = 0x5865F2
const COLOR_ENDED = 0x99AAB5

export const customId = (kind, channelId, skillKey) =>
    `${HT_PREFIX}${kind}:${channelId}${skillKey ? `:${skillKey}` : ''}`

//不是這個單元的元件就回 null，讓分派器交給下一個處理器。
export const parseHorntailCustomId = (raw) => {
    const text = String(raw || '')
    if(!text.startsWith(HT_PREFIX)) return null

    const [, kind, channelId, skillKey] = text.split(':')
    if(!channelId || !SNOWFLAKE.test(channelId)) return null

    if(kind === 'stop' || kind === 'end') return {kind, channelId, skillKey: null}
    if(kind !== 't') return null
    if(!SKILL_KEYS.has(skillKey)) return null

    return {kind, channelId, skillKey}
}

//按鈕的顏色表達「在跑 / 沒在跑」：在跑是綠色(進行中)，沒在跑是灰色。
//招式本身的顏色(紅/黃/藍)由 emoji 表達 —— 按鈕沒有黃色，用按鈕色會湊不齊。
const styleOf = (timer) => (timer.running ? ButtonStyle.Success : ButtonStyle.Secondary)

/**
 * 倒數一律用 Discord 的相對時間戳 `<t:秒:R>`（2026-08-24 改）。
 *
 * 那是**看的人自己的用戶端在算**，每秒自己跳，bot 完全不必編輯訊息。
 * 原本是 bot 每 2 秒重寫一次數字，網路一不穩（8/22、8/23 都發生過連線逾時與
 * TLS 驗證失敗）畫面就整個卡住，而卡住的當下正是最需要看秒數的時候。
 * 改成用戶端算之後，就算 bot 完全連不上 Discord，大家螢幕上的倒數還是準的。
 *
 * 後面補一個 `<t:秒:T>` 的絕對時間，是為了讓人一眼看出「幾點幾分幾秒結束」——
 * 相對時間在超過一分鐘時只會顯示「2 分鐘後」，不夠精確。
 */
const lineOf = (timer) => {
    if(!timer.running || timer.endsAt === null){
        return `${timer.emoji}　**${timer.label}**　${timer.seconds} 秒（未開始）`
    }

    const at = Math.floor(timer.endsAt / 1000)
    return `${timer.emoji}　**${timer.label}**　<t:${at}:R>（<t:${at}:T>）`
}

//面板上的計時器順序固定照設定檔的 SKILLS，不要用 Object.values 的順序去猜。
const timersOf = (panel) => SKILLS.map((skill) => panel.timers[skill.key]).filter(Boolean)

/**
 * 面板訊息。tick 迴圈每 EDIT_MS 毫秒拿這個結果去 message.edit()，
 * 三個招式合併成同一次編輯 —— 這是不撞 429 的關鍵，不要改成各自編輯。
 *
 * ended = true 時移除所有按鈕（總時限到、閒置太久、或被新面板取代）。
 */
//now 仍然留在參數裡但已經用不到：倒數改由用戶端的時間戳自己算之後，
//這裡不需要知道「現在幾點」。保留參數是為了不動 service 那三個呼叫點。
export const buildPanelMessage = (panel, now, {ended = false} = {}) => {
    const timers = timersOf(panel)

    const embed = new EmbedBuilder()
        .setColor(ended ? COLOR_ENDED : COLOR_ACTIVE)
        .setTitle(ended ? '🐉 闇黑龍王計時器（面板已結束）' : '🐉 闇黑龍王計時器')
        .setDescription(timers.map((timer) => lineOf(timer)).join('\n'))

    if(ended){
        embed.setFooter({text: '這個面板已經結束，需要的話重新輸入 /horntail'})
        return {embeds: [embed], components: []}
    }

    //這一行不能拿掉：TTS 是由「接收者的用戶端」朗讀的，而且預設是關的。
    //沒寫的話，聽不到的人會以為功能壞了。
    embed.setFooter({
        text: `剩 ${WARN_DISPLAY_SECONDS} 秒語音提醒 · 要在 Discord 設定開啟「文字轉語音」才聽得到`
            + '\n按一次開始、再按一次從頭重算 · 歸零後自動接下一輪'
            + '\n用完請按「結束面板」收起來',
    })

    const skillRow = new ActionRowBuilder().addComponents(
        timers.map((timer) => new ButtonBuilder()
            .setCustomId(customId('t', panel.channelId, timer.key))
            .setEmoji(timer.emoji)
            //按鈕標籤不能放時間戳（Discord 只在訊息內容與 embed 裡算），
            //所以這裡只放招式名。秒數在 embed 由用戶端自己跳，
            //硬要放進按鈕就等於逼 bot 每兩秒重編一次整則訊息。
            .setLabel(timer.running ? `${timer.label}（計時中）` : timer.label)
            .setStyle(styleOf(timer)))
    )

    //「全部停止」只是把三個計時器停下，面板留著可以再按開始；
    //「結束面板」才是整個收掉。兩顆分開是因為打王中途常常要全部暫停一下，
    //如果只有一顆而它會把面板收掉，暫停一次就要重下一次指令。
    const stopRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(customId('stop', panel.channelId))
            .setLabel('全部停止')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(customId('end', panel.channelId))
            .setLabel('結束面板')
            .setStyle(ButtonStyle.Danger)
    )

    return {embeds: [embed], components: [skillRow, stopRow]}
}

//語音提醒。內容只有招式短名，不唸秒數 ——
//Discord 唸出來是「<發訊者> 說 <內容>」，開場已經吃掉約兩秒，
//再加「還有五秒」就會唸到招式都放完了。提早在剩 7 秒發出來補這兩秒。
//allowedMentions 清空是純防呆：這則訊息每分鐘發好幾次，不該有任何一次會 @ 到人。
export const buildWarnMessage = (timer) => ({
    content: timer.voice,
    tts: true,
    allowedMentions: {parse: []},
})

//重啟後點舊面板按鈕時的回覆。記憶體裡已經沒有那個面板了。
export const PANEL_GONE_TEXT = '這個面板已經失效（bot 重新啟動過），請重新輸入 `/horntail`。'

//非 GM 操作時的回覆。面板是公開訊息，按鈕誰都看得到，所以這句會常常出現。
export const PANEL_DENY_TEXT = '這個計時器只有 GM 或伺服器管理員能操作。'

//只能開在語音頻道的文字聊天裡。
//理由是這個面板是打王現場用的，而 TTS 提醒是由「正在看該頻道的人」的用戶端朗讀的 ——
//開在一般文字頻道的話，人在語音、眼睛在別的頻道，提醒等於不存在。
export const PANEL_VOICE_ONLY_TEXT =
    '這個指令只能在**語音頻道的聊天室**裡使用。\n'
    + '請先進入語音頻道，點開它右側的聊天圖示，在那裡輸入 `/horntail`。'

export default {
    HT_PREFIX,
    customId,
    parseHorntailCustomId,
    buildPanelMessage,
    buildWarnMessage,
    PANEL_GONE_TEXT,
    PANEL_DENY_TEXT,
    PANEL_VOICE_ONLY_TEXT,
}
