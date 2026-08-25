import {Events} from 'discord.js'
import {handleVoiceJoin} from '@/core/vmute'
import logger from '@/core/logger'

//有人被靜音後離開語音，伺服器靜音會一直掛在他身上，而 Discord 不讓我們改
//「不在語音」的人的語音狀態 —— 所以到期時解不掉的紀錄會標記成 pending，
//在這裡等他下次進語音時補解除。這是唯一能得知「他回來了」的時機。

export const event = {
    name: Events.VoiceStateUpdate,
    once: false,
}

export const action = async(oldState, newState) => {
    try{
        //只在「進入語音」與「換頻道」時處理。離開語音(channelId 為 null)不必做事，
        //而 bot 自己呼叫 setMute 也會觸發這個事件，那時前後頻道相同，會被這裡擋掉。
        if(!newState.channelId) return
        if(oldState.channelId === newState.channelId) return

        await handleVoiceJoin(newState.client, newState.guild.id, newState.id)
    }
    catch(e){
        //事件處理器的 rejection 沒人接得到，會終止整個行程(CLAUDE.md 技術重點第一條)。
        logger.error('voiceStateUpdate 處理失敗(已攔截，bot 繼續運行)：', e)
    }
}
