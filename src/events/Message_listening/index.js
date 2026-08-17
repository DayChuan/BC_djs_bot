import {Events, GatewayIntentBits } from 'discord.js'
import logger from '@/core/logger'

export const event = {
    name : Events.MessageCreate
}

//規則的順序、機率、文字都與原本完全一致，這次只補上兩件事：
//1. 每個 send / react 都加 await —— 未 await 的 Promise 若 reject(50013 沒有發言權限、
//   10008 訊息已被刪除、429 rate limit)，外層 try/catch 攔不到，會直接終止行程(ISSUES.md 的 C-02)
//2. 整個 handler 包一層 try/catch 交給 logger
export const action = async(message) => {
  try{
    // console.log(message.author.bot);
    //如果訊息是機器人，則不進行任何動作
    if(message.author.bot) return;

    if(message.content.includes('sip')){
        await message.channel.send('sip sip');
        return;
    }

    if(message.content.includes('確實')){
        if(Math.floor(Math.random()*2) == 0){
            await message.channel.send('確かに');
        }
        return;
    }

    if(message.content.includes('確') ){
        if(Math.floor(Math.random()*2) == 0){
            await message.channel.send(':thinking:');
        }
        return;
    }

    if(message.content == '絕對' ){
        const pttpttid = '<@780856075766857758>'
        if(Math.floor(Math.random()*2) == 0){
            await message.channel.send(pttpttid);
        }
        return;
    }

    if(message.content.includes('笑死') ){
        if(Math.floor(Math.random()*2) == 0){
            await message.channel.send('真的笑死');
        }
        return;
    }

    if(message.content.startsWith('?') || message.content.startsWith('？')){
        if(Math.floor(Math.random()*2) == 0){
            await message.channel.send('甚麼意思');
        }
        return;
    }

    if(message.content.includes('冷靜')){
            await message.channel.send('先不要冷靜');
        return;
    }

    if(message.content.includes('緊張')){
        if(Math.floor(Math.random()*5) == 0){
            await message.channel.send('我知道你很緊張，但你先不要緊張');
        }

        return;
    }

    if(message.content.includes('吐了')){
        await message.react('🤮');
        return;
    }

    if(message.content.includes('機器人')){
        await message.react('🤖');
        return;
    }

    if(message.content.includes('==')){
        const halreactoptions = ["眼睛怎麼連在一起啊", "= ="];
        const halreactrandom = halreactoptions[Math.floor(Math.random()*halreactoptions.length)];
        // const RandomNuber = Math.floor(Math.random()*5);
        // console.log(RandomNuber);
        if(Math.floor(Math.random()*4) == 0){
            await message.channel.send(halreactrandom);
        }
        return;
    }

    if(message.content.includes('= =')){
        const halreactoptions = ["(´･ω･`)", "(´～`)", "ʅ（´◔౪◔）ʃ", "( ˘•ω•˘ )", "ʕ•͡ᴥ•ʔ" ];
        const halreactrandom = halreactoptions[Math.floor(Math.random()*halreactoptions.length)];
        if(Math.floor(Math.random()*4) == 0){
            await message.channel.send(halreactrandom);
        }
        return;
    }

    if(message.content.includes('可')){
        if(Math.floor(Math.random()*5) == 0){
            await message.channel.send('要確餒~');
        }
        return;
    }

    if(message.content.includes('吧')){
        const halreactoptions = ["你要確餒?", "絕對", "下次一定", "真的嗎~"];
        const halreactrandom = halreactoptions[Math.floor(Math.random()*halreactoptions.length)];
        if(Math.floor(Math.random()*2) == 0){
            await message.channel.send(halreactrandom);
        }
        return;
    }

    if(message.content.includes('要不要')){
        if(Math.floor(Math.random()*2) == 0){
            await message.channel.send('梨子🍐');
        }
        return;
    }
    if(message.content.includes('我也要')){
        await message.react('➕');
        return;
    }
    if(message.content.includes('梨子')){
        await message.react('🍐');
        return;
    }

    // if(message.content.includes('おめでとう')){
    //     message.react(':clap:');
    //     return;
    // }
    // else{
    //     const halreactoptions = ["亂講", "真的假的", "", "", "", "", "", "" ];
    //     const halreactrandom = halreactoptions[Math.floor(Math.random()*halreactoptions.length)];
    //     if(halreactrandom != ""){
    //         message.channel.send(halreactrandom);
    //     }
    //     return;
    // }
  }
  catch(e){
    //最常見的是 50013(該頻道沒有發言或加反應權限)與 10008(原訊息已被刪除)。
    //記錄下來就好，不要讓一則訊息的失敗把整個 bot 帶走。
    logger.error(
        `關鍵字回覆失敗：channel=${message.channelId} author=${message.author && message.author.tag}`,
        e
    )
  }
}
const roll = async denominator => {

}
