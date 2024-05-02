import {Events, GatewayIntentBits } from 'discord.js'

export const event = {
    name : Events.MessageCreate
}

export const action = async(message) => {
    // console.log(message.author.bot);
    //如果訊息是機器人，則不進行任何動作
    if(message.author.bot) return;

    if(message.content.includes('sip')){
        message.channel.send('sip sip');
        return;
    }

    if(message.content.includes('確') ){
        if(Math.floor(Math.random()*5) == 0){
            message.channel.send(':thinking:');
        }
        return;
    }

    if(message.content.startsWith('?') || message.content.startsWith('？')){
        if(Math.floor(Math.random()*3) == 0){
            message.channel.send('甚麼意思');
        }
        return;
    }

    if(message.content.includes('冷靜')){
        if(Math.floor(Math.random()*2) == 0){
            message.channel.send('先不要冷靜');
        }
        return;
    }

    if(message.content.includes('緊張')){
        if(Math.floor(Math.random()*5) == 0){
            message.channel.send('我知道你很緊張，但你先不要緊張');
        }
        
        return;
    }

    if(message.content.includes('吐了')){
        message.react('🤮');
        return;
    }

    if(message.content.includes('機器人')){
        message.react('🤖');
        return;
    }

    if(message.content.includes('==')){
        const halreactoptions = ["眼睛怎麼連在一起啊", "= ="];
        const halreactrandom = halreactoptions[Math.floor(Math.random()*halreactoptions.length)];
        // const RandomNuber = Math.floor(Math.random()*5);
        // console.log(RandomNuber);
        if(Math.floor(Math.random()*4) == 0){
            message.channel.send(halreactrandom);
        }
        return;
    }

    if(message.content.includes('= =')){
        const halreactoptions = ["(´･ω･`)", "(´～`)", "ʅ（´◔౪◔）ʃ", "( ˘•ω•˘ )", "ʕ•͡ᴥ•ʔ" ];
        const halreactrandom = halreactoptions[Math.floor(Math.random()*halreactoptions.length)];
        if(Math.floor(Math.random()*4) == 0){
            message.channel.send(halreactrandom);
        }
        return;
    }

    if(message.content.includes('可')){
        if(Math.floor(Math.random()*5) == 0){
            message.channel.send('要確餒~');
        }
        return;
    }

    if(message.content.includes('吧')){
        message.channel.send('你要確餒?');
        return;
    }

    if(message.content.includes('要不要')){
        if(Math.floor(Math.random()*5) == 0){
            message.channel.send('梨子🍐');
        }
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