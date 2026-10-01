import {Events} from 'discord.js'
import {handleVoiceJoin} from '@/core/vmute'
import {handleDynamicVoice} from '@/core/voiceRoom'
import logger from '@/core/logger'

//這個事件分派給兩個功能，各自 try/catch：其中一個失敗不該讓另一個不執行。
//  vmute(U04)     進入語音時補解除待解的伺服器靜音
//  voiceRoom(U13) 進入大廳開房、離開時清掉空房間
//各功能的進入條件寫在自己那一段裡，不要在最外層 return ——
//vmute 只看「進入」，voiceRoom 卻正好需要「離開」。

export const event = {
    name: Events.VoiceStateUpdate,
    once: false,
}

//有人被靜音後離開語音，伺服器靜音會一直掛在他身上，而 Discord 不讓我們改
//「不在語音」的人的語音狀態 —— 所以到期時解不掉的紀錄會標記成 pending，
//在這裡等他下次進語音時補解除。這是唯一能得知「他回來了」的時機。
const runVmute = async(oldState, newState) => {
    //只在「進入語音」與「換頻道」時處理。離開語音(channelId 為 null)不必做事，
    //而 bot 自己呼叫 setMute 也會觸發這個事件，那時前後頻道相同，會被這裡擋掉。
    if(!newState.channelId) return
    if(oldState.channelId === newState.channelId) return

    await handleVoiceJoin(newState.client, newState.guild.id, newState.id)
}

export const action = async(oldState, newState) => {
    //事件處理器的 rejection 沒人接得到，會終止整個行程(CLAUDE.md 技術重點第一條)。
    try{
        await runVmute(oldState, newState)
    }
    catch(e){
        logger.error('voiceStateUpdate(vmute) 處理失敗(已攔截，bot 繼續運行)：', e)
    }

    try{
        await handleDynamicVoice(oldState, newState)
    }
    catch(e){
        logger.error('voiceStateUpdate(動態語音) 處理失敗(已攔截，bot 繼續運行)：', e)
    }
}
